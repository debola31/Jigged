/**
 * Tracking-plan drift checker.
 *
 * Parses the registry table in `docs/telemetry.md` to learn the
 * canonical {event → properties} shape, then walks the source tree for
 * `posthog.capture('name', { … })` calls and asserts the two agree in both
 * directions:
 *
 *   - an event captured in code but missing from the doc  → undocumented-event
 *   - an event in the doc that nothing sends              → stale-doc-entry
 *   - a property passed but not documented                → undocumented-property
 *   - a property documented but never passed              → stale-doc-property
 *   - an event name that is not `[object] [verb]`         → bad-event-name
 *
 * WHY BOTH DIRECTIONS. A one-way check (code ⊆ doc) lets the doc accumulate
 * events that were renamed or deleted, which is the failure mode that makes a
 * registry untrustworthy: once one row is wrong, no reader believes any row.
 * The reverse direction is what keeps the table worth reading.
 *
 * WHAT THIS DELIBERATELY CANNOT DO, so nobody mistakes green for coverage:
 * it compares code against a document. A feature that is in NEITHER passes.
 * The operator notes feature shipped, went unmeasured, and this check would
 * have said nothing — see the "Known gap" section of the doc. The control for
 * that is review, not CI.
 *
 * PROPERTY EXTRACTION IS LITERAL-ONLY, and that is a real limit rather than a
 * shortcut. Keys are read from the object literal at the call site, so
 * `{ ...spreadProps }` or a computed `[key]:` contributes nothing and the
 * documented properties for that event become unverifiable. Every call site
 * today uses plain literal keys; if that changes, prefer splitting the capture
 * over silently losing the check.
 *
 * Driven through vitest like the repo's other source scanners —
 * `pnpm exec vitest run __tests__/standards/analyticsEvents.test.ts`. There is
 * a CLI block at the foot of this file, but note `tsx` is NOT a dependency of
 * this repo, so `pnpm exec tsx scripts/…` does not work here despite what the
 * header of docLinkCheck.ts claims. The vitest spec is the real entry point.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

// ============== Types ==============

export type ViolationKind =
  | 'undocumented-event'
  | 'stale-doc-entry'
  | 'undocumented-property'
  | 'stale-doc-property'
  | 'bad-event-name';

export interface EventViolation {
  kind: ViolationKind;
  event: string;
  detail: string;
  /** Repo-relative path, or the doc path for doc-side violations. */
  file: string;
  /** 1-indexed. 0 when the violation is "nothing in code sends this". */
  line: number;
}

export interface CaptureSite {
  event: string;
  properties: string[];
  file: string;
  line: number;
}

/** Documented event → its exhaustive property set. */
export type TrackingPlan = Map<string, Set<string>>;

// ============== Doc parsing ==============

/** Event names are `[object] [verb]`: lowercase words separated by spaces. */
const EVENT_CELL = /^`([a-z][a-z0-9 ]*)`$/;
/** Property names stay snake_case — they are code identifiers, not display labels. */
const BACKTICKED = /`([a-z][a-z0-9_]*)`/g;

export const REGISTRY_START = '<!-- registry:start -->';
export const REGISTRY_END = '<!-- registry:end -->';

/**
 * Reads the registry table out of the tracking plan.
 *
 * TWO GUARDS, AND BOTH ARE LOAD-BEARING NOW THAT THE REGISTRY LIVES INSIDE THE
 * TELEMETRY DOC. That doc contains other tables — notably the session
 * replay settings, whose first cells are backticked identifiers like
 * `session_recording_opt_in`. Parsing the whole file would silently invent
 * those as events:
 *
 *   1. Only content between the registry markers is considered.
 *   2. Within it, only rows whose first cell is exactly a backticked
 *      space-separated lowercase name count — which also excludes prose
 *      containing `code spans`.
 *
 * Guard 1 alone would be enough today and guard 2 alone would be enough while
 * every setting happens to be snake_case. Keeping both means neither a new
 * table nor a renamed setting can quietly poison the registry.
 */
export function parseTrackingPlan(markdown: string): TrackingPlan {
  const plan: TrackingPlan = new Map();

  const from = markdown.indexOf(REGISTRY_START);
  const to = markdown.indexOf(REGISTRY_END);
  if (from === -1 || to === -1 || to < from) {
    throw new Error(
      `Registry markers not found in the tracking plan. Expected ${REGISTRY_START} … ${REGISTRY_END}.`,
    );
  }
  const registry = markdown.slice(from + REGISTRY_START.length, to);

  for (const rawLine of registry.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;

    // Drop the empty leading/trailing cells produced by the outer pipes.
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) continue;

    const nameMatch = EVENT_CELL.exec(cells[0]);
    if (!nameMatch) continue;

    const properties = new Set<string>();
    // An em dash means "no properties" and is left as an empty set.
    for (const m of cells[2].matchAll(BACKTICKED)) properties.add(m[1]);

    plan.set(nameMatch[1], properties);
  }

  return plan;
}

// ============== Source parsing ==============

/**
 * Replaces the body of every `//` and block comment with spaces, leaving newlines in place.
 *
 * **Length is preserved exactly**, character for character, so every index and line number
 * computed against the result still points at the right place in the original file.
 *
 * WHY THIS EXISTS. `splitTopLevel` and `matchBrace` below both walk raw characters and track
 * string state, and neither knows what a comment is. That is not a cosmetic gap — prose inside a
 * properties object silently changes what the scanner believes was captured, in four distinct ways:
 *
 *   - a comma in a comment ("Whether they wrote a note, never what it says") splits a segment in
 *     half, and the real key that followed it stops being seen at all;
 *   - an apostrophe ("the shop's own wording") opens a string that never closes, swallowing every
 *     real comma until the next apostrophe and taking those keys with it;
 *   - a brace in a comment ("returns } when empty") ends the object early;
 *   - and prose shaped like `word: value` after a comma is read AS a key, so the check demands a
 *     registry row for a property that does not exist.
 *
 * The first three hide properties. Hiding is the dangerous direction: an undocumented property
 * that the scanner cannot see produces no `undocumented-property` violation, so a capture carrying
 * something it should not — a customer's email, say — ships green past the one check meant to
 * catch it. That is the whole point of this file, defeated by a comma.
 *
 * Blanking once here fixes every downstream walker at the same time, which is why it is not done
 * inside `splitTopLevel`: `matchBrace` and the event-name match need it too.
 *
 * Regex literals are NOT tracked, so `/a\/\/b/` would be read as starting a comment. No call site
 * has ever put a regex in a properties object, the pre-existing scanner mishandled them just as
 * badly, and `analyticsEvents.test.ts` asserts this pass leaves today's tree byte-identical.
 */
export function blankComments(source: string): string {
  let out = '';
  let quote: string | null = null;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];

    if (quote) {
      out += ch;
      if (ch === '\\') out += source[++i] ?? '';
      else if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }

    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i++;
      }
      // Loop exited on the newline (or end of file); put it back so line numbers survive.
      if (i < source.length) out += '\n';
      continue;
    }

    if (ch === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      const stop = close === -1 ? source.length : close + 2;
      for (let k = i; k < stop; k++) out += source[k] === '\n' ? '\n' : ' ';
      i = stop - 1;
      continue;
    }

    out += ch;
  }

  return out;
}

/**
 * Splits an object-literal body on top-level commas, stepping over nested
 * braces/brackets/parens and over string and template-literal contents so a
 * comma inside `` `a, b` `` or `f(x, y)` does not split a key off.
 *
 * Comments are already blank by the time this runs — `extractCaptures` puts the source through
 * `blankComments` first. Do not add comment handling here; it belongs in one place, because
 * `matchBrace` needs it just as much.
 */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];

    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

/** Finds the index just past the `}` matching an opening `{` at `open`. */
function matchBrace(source: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;

  for (let i = open; i < source.length; i++) {
    const ch = source[i];

    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const CALL = 'posthog.capture(';
// A leading-comment skip used to live in this pattern, and it was the tell that comments were
// meant to be supported here all along — it just could not help, because `splitTopLevel` had
// already severed the key from its comment before this ran. `blankComments` leaves whitespace
// where the prose was, so plain `\s*` covers it now.
const KEY = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::|$)/;

export function extractCaptures(rawSource: string, relPath: string): CaptureSite[] {
  // Everything below walks characters and tracks string state; none of it knows what a comment is.
  // Blanking first is what lets a call site explain itself in prose without changing what this
  // file believes was captured. Offsets and line numbers are unaffected — see `blankComments`.
  const source = blankComments(rawSource);

  const sites: CaptureSite[] = [];
  let idx = source.indexOf(CALL);

  while (idx !== -1) {
    const afterCall = idx + CALL.length;
    const nameMatch = /^\s*(['"`])([^'"`]+)\1/.exec(source.slice(afterCall));

    if (nameMatch) {
      const line = source.slice(0, idx).split('\n').length;
      const properties: string[] = [];

      // Optional second argument: an object literal of properties.
      const rest = source.slice(afterCall + nameMatch[0].length);
      const objStart = /^\s*,\s*\{/.exec(rest);
      if (objStart) {
        const openAbs = afterCall + nameMatch[0].length + objStart[0].length - 1;
        const closeAbs = matchBrace(source, openAbs);
        if (closeAbs !== -1) {
          for (const segment of splitTopLevel(source.slice(openAbs + 1, closeAbs))) {
            if (!segment.trim()) continue;
            const key = KEY.exec(segment);
            // A spread or computed key yields no name; see the header note.
            if (key) properties.push(key[1]);
          }
        }
      }

      sites.push({ event: nameMatch[2], properties, file: relPath, line });
    }

    idx = source.indexOf(CALL, idx + CALL.length);
  }

  return sites;
}

// ============== Project scan ==============

const SCAN_DIRS = ['app', 'components', 'lib', 'utils', 'hooks'];
const SCAN_EXT = ['.ts', '.tsx'];
const SKIP_DIRS = new Set(['node_modules', '.next', '__tests__', 'coverage']);

export const DOC_PATH = 'docs/telemetry.md';

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SCAN_EXT.some((e) => entry.endsWith(e)) && !entry.includes('.test.')) out.push(full);
  }
}

export function collectCaptures(root: string): CaptureSite[] {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) walk(join(root, dir), files);

  const sites: CaptureSite[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes(CALL)) continue;
    sites.push(...extractCaptures(source, relative(root, file)));
  }
  return sites;
}

export function compare(plan: TrackingPlan, sites: CaptureSite[]): EventViolation[] {
  const violations: EventViolation[] = [];
  const seen = new Map<string, Set<string>>();

  for (const site of sites) {
    if (!/^[a-z][a-z0-9 ]*$/.test(site.event)) {
      violations.push({
        kind: 'bad-event-name',
        event: site.event,
        detail: `"${site.event}" is not \`[object] [verb]\`: lowercase words separated by spaces, past tense.`,
        file: site.file,
        line: site.line,
      });
    }

    const documented = plan.get(site.event);
    if (!documented) {
      violations.push({
        kind: 'undocumented-event',
        event: site.event,
        detail: `Captured in code but absent from ${DOC_PATH}. Add a registry row.`,
        file: site.file,
        line: site.line,
      });
      continue;
    }

    // Union across call sites: the same event may be sent from more than one
    // place, and the doc describes the event, not any single call.
    const union = seen.get(site.event) ?? new Set<string>();
    for (const p of site.properties) {
      union.add(p);
      if (!documented.has(p)) {
        violations.push({
          kind: 'undocumented-property',
          event: site.event,
          detail: `Property "${p}" is passed here but not listed for ${site.event} in ${DOC_PATH}.`,
          file: site.file,
          line: site.line,
        });
      }
    }
    seen.set(site.event, union);
  }

  for (const [event, documented] of plan) {
    const actual = seen.get(event);
    if (!actual) {
      violations.push({
        kind: 'stale-doc-entry',
        event,
        detail: `Documented but nothing calls posthog.capture('${event}'). Remove the row, or fix the name.`,
        file: DOC_PATH,
        line: 0,
      });
      continue;
    }
    for (const p of documented) {
      if (!actual.has(p)) {
        violations.push({
          kind: 'stale-doc-property',
          event,
          detail: `Property "${p}" is documented for ${event} but no call site passes it.`,
          file: DOC_PATH,
          line: 0,
        });
      }
    }
  }

  return violations;
}

export function scanProject(root: string): EventViolation[] {
  const plan = parseTrackingPlan(readFileSync(join(root, DOC_PATH), 'utf8'));
  return compare(plan, collectCaptures(root));
}

// ============== CLI ==============

// `require.main === module` does not hold under tsx/ESM, so compare argv
// instead — the same shape the repo's other scanners use.
const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  process.argv[1].includes('analyticsEventsCheck');

if (invokedDirectly) {
  const root = resolve(__dirname, '..');
  const violations = scanProject(root);

  if (violations.length === 0) {
    console.log(`✓ Tracking plan matches code (${DOC_PATH})`);
  } else {
    console.error(`✗ ${violations.length} tracking-plan violation(s):\n`);
    for (const v of violations) {
      const where = v.line ? `${v.file}:${v.line}` : v.file;
      console.error(`  [${v.kind}] ${where}\n      ${v.detail}`);
    }
    console.error(`\nThe registry lives in ${DOC_PATH}.`);
    process.exit(1);
  }
}
