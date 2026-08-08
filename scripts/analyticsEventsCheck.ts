/**
 * Tracking-plan drift checker.
 *
 * Parses the registry table in `docs/observability.md` to learn the
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
 * OBSERVABILITY DOC. That doc contains other tables — notably the session
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
 * Splits an object-literal body on top-level commas, stepping over nested
 * braces/brackets/parens and over string and template-literal contents so a
 * comma inside `` `a, b` `` or `f(x, y)` does not split a key off.
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
const KEY = /^\s*(?:\/\/[^\n]*\n\s*)*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::|$)/;

export function extractCaptures(source: string, relPath: string): CaptureSite[] {
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

export const DOC_PATH = 'docs/observability.md';

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
