/**
 * docLinkCheck — turns two of the doc-writing standard's conventions into a CI
 * gate (issue #686). See docs/writing-docs.md, "What a build now falsifies".
 *
 *   1. Every code path a doc cites exists on disk. Deleting one file rots
 *      citations in docs nobody is editing: commit b6b912a removed the prod
 *      schema snapshot and left ten dangling citations across nine docs, caught
 *      by hand during a merge — which is not a process.
 *   2. Every relative markdown link resolves, and if it carries an `#anchor`,
 *      a heading in the TARGET file produces that slug. A heading another doc
 *      links to is an interface; renaming it breaks the inbound link silently.
 *
 * Mirrors scripts/interactionStandardsCheck.ts and scripts/schemaEmbedCheck.ts:
 * pure functions a vitest spec drives, plus a main() for `pnpm exec tsx`.
 *
 * TWO RESOLUTION BASES, and the difference is not cosmetic:
 *   - A markdown link target resolves against the DOC'S OWN DIRECTORY, because
 *     that is what a browser does with it.
 *   - An inline-code path (`utils/jobsAccess.ts`) resolves against the REPO
 *     ROOT, because that is the convention these docs are written in — it is
 *     prose naming a file, not a clickable link.
 *
 * SCOPE LIMITS, deliberate:
 *   - Fenced code blocks are skipped entirely. Their `#` lines are shell
 *     comments, not headings, and their paths carry globs and flags. This also
 *     means a citation that lives only inside a fence goes unchecked.
 *   - A citation inside a `COMMENT ON FUNCTION` or a pytest docstring is
 *     invisible here — that is issue #685, and the Markdown pass is the cheap
 *     80%.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

export interface DocIssue {
  file: string; // doc, relative to repo root
  line: number;
  kind: 'missing-path' | 'missing-anchor';
  target: string;
  message: string;
}

/**
 * Escape hatch for genuine exceptions, keyed `relativePath::snippet` — NOT
 * `path:line`, because line numbers shift under every edit and a stale key
 * silently stops suppressing.
 *
 * The legitimate case is a doc deliberately naming a file that no longer
 * exists, which is how this repo records history ("X was deleted because…").
 * A dangling citation to a file that was supposed to still be there is a BUG;
 * fix the doc rather than adding a row here.
 */
export const ALLOWLIST = new Map<string, string>([
  [
    'CLAUDE.md::supabase/schema.prod.sql',
    'Records that the cached prod schema snapshot was deleted (2026-08-03) — the absence is the point.',
  ],
  [
    'docs/runbooks/database-migrations.md::supabase/schema.prod.sql',
    'Same deletion, restated where the migration workflow used to tell you to regenerate it.',
  ],
  [
    'docs/architecture.md::supabase/schema.staging.sql',
    'Names the staging snapshot deleted when staging was retired for Supabase Branching.',
  ],
  [
    'docs/architecture.md::scripts/export_schema.py',
    'Names the exporter deleted alongside schema.prod.sql (2026-08-03).',
  ],
  [
    'docs/modules/parts.md::supabase/schema.prod.sql',
    'Historical note about what the old snapshot still showed; the snapshot is gone.',
  ],
  [
    'docs/modules/demo-mode.md::scripts/seed-demo-template.sql',
    'Known gap #550 — names the template that does NOT exist yet. Deleting the citation deletes the gap.',
  ],
  [
    'docs/README.md::docs/inventory-flow.md',
    'Names a journey doc that was folded into modules/inventory.md and deleted; the failure is the lesson.',
  ],
  [
    'docs/README.md::docs/operator-paperless-flow.md',
    'Same — folded into modules/operator-view.md and deleted.',
  ],
  [
    'docs/modules/inventory.md::docs/inventory-flow.md',
    'Records the split this doc was merged back from.',
  ],
  [
    'docs/modules/inventory.md::docs/build-sequence.md',
    'Superseded-docs table: 3,910 lines deleted, listed with what was wrong in them.',
  ],
  [
    'docs/modules/inventory.md::docs/modules/inventory-locations.md',
    'Superseded-docs table: promised by PR #414, never written, folded in here.',
  ],
  [
    'docs/modules/operator-view.md::docs/operator-paperless-flow.md',
    'Records the doc folded into this one and deleted, with its word count.',
  ],
  [
    'docs/modules/operator-view.md::docs/modules/partial-operation-completion-design.md',
    'Records a design doc folded into this one and deleted.',
  ],
]);

// ============== Fences ==============

/**
 * Blank out fenced code blocks, preserving line numbering (every removed line
 * becomes empty). Handles ``` and ~~~ fences of any length, and the info
 * string on the opening fence.
 */
export function stripFencedBlocks(source: string): string {
  const lines = source.split('\n');
  let fence: string | null = null;
  return lines
    .map((line) => {
      const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (fence === null) {
        if (m) {
          fence = m[1][0].repeat(m[1].length);
          return '';
        }
        return line;
      }
      // Inside a fence: only a closer of the same char and >= length ends it.
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      return '';
    })
    .join('\n');
}

// ============== GitHub heading slugs ==============

/**
 * GitHub's anchor slug, and the rule people get wrong: lowercase, strip every
 * character that is not a letter, number, mark, hyphen or underscore
 * (UNDERSCORES ARE KEPT), then replace EACH space with ONE hyphen.
 *
 * Do NOT collapse runs of whitespace. An em dash surrounded by spaces is
 * stripped and leaves the two spaces behind, so `## Foo — bar` really does
 * anchor at `#foo--bar` — a DOUBLE hyphen. Collapsing produces a slug that
 * looks right and 404s, which cost real time during #634.
 *
 * Known divergence: github-slugger keeps a handful of Latin-1 symbols this
 * drops (`£`, `¢`, …). No heading in this repo uses one; widen the keep-set if
 * that ever changes.
 */
export function slugify(heading: string): string {
  return (
    heading
      // `[text](url)` contributes only `text` — the URL is not part of the slug.
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      // Inline HTML (<br>, <sup>…) is markup, not text.
      .replace(/<[^>]*>/g, '')
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\p{M}\- _]/gu, '')
      .replace(/ /g, '-')
  );
}

/**
 * Every anchor a markdown file exposes, in GitHub's duplicate-heading scheme:
 * the first `## Foo` is `#foo`, the second `#foo-1`, the third `#foo-2`.
 */
export function headingSlugs(source: string): Set<string> {
  const out = new Set<string>();
  const seen = new Map<string, number>();
  for (const line of stripFencedBlocks(source).split('\n')) {
    const m = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = slugify(m[2]);
    if (!base) continue;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

// ============== Citation extraction ==============

export interface Citation {
  /** Exactly as written — this is the allowlist key's snippet half. */
  raw: string;
  /** Path portion: percent-decoded, `#anchor` / `::nodeid` stripped. */
  target: string;
  /** `#…` fragment on a markdown link, or null. */
  anchor: string | null;
  line: number;
  /** Which resolution base applies (see the file header). */
  base: 'doc-dir' | 'repo-root';
}

/**
 * Directory prefixes that make an inline-code span a repo path. Everything
 * else in backticks is a column name, a flag, an env var or prose.
 */
const CODE_PATH_PREFIXES = [
  '__tests__/',
  'e2e/',
  'api/',
  'utils/',
  'components/',
  'app/',
  'scripts/',
  'supabase/',
  'lib/',
  'types/',
  'hooks/',
  'docs/',
  '.github/',
];

/**
 * Characters that mean "this is a pattern, not a path": globs (`utils/*.ts`),
 * brace expansions (`__tests__/…/{A,B}.test.tsx`) and placeholders
 * (`utils/<entity>Access.ts`). `[` and `]` are NOT here — Next.js route
 * segments (`app/dashboard/[companyId]/`) are real directory names.
 */
const NOT_A_LITERAL_PATH = /[*{}<>|$…"']/;

/** Strip `#anchor`, `#L12-L20` and a pytest `::node_id` from a cited path. */
function splitFragment(raw: string): { target: string; anchor: string | null } {
  const noNodeId = raw.split('::')[0];
  const hash = noNodeId.indexOf('#');
  if (hash === -1) return { target: noNodeId, anchor: null };
  return { target: noNodeId.slice(0, hash), anchor: noNodeId.slice(hash + 1) || null };
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/**
 * Markdown links to something in this repo. External URLs, `mailto:` and
 * site-absolute (`/foo`) targets are skipped — the first two are not ours to
 * check and the third has no defined base here.
 *
 * A bare `#anchor` link is kept, with an empty target, so it is checked against
 * the doc's own headings.
 */
export function extractLinkCitations(source: string, _docRelPath: string): Citation[] {
  const out: Citation[] = [];
  const body = stripFencedBlocks(source);
  // [label](target) or [label](target "title").
  //
  // The label allows one level of nested brackets, because the labels here are
  // routinely inline-code paths carrying Next.js route segments —
  // [`app/operator/[companyId]/layout.tsx`](…). A plain `[^\]]*` label stops at
  // the first inner `]` and silently matches nothing, so those links (the ones
  // most likely to rot, since route folders get renamed) went unchecked.
  const re = /\[(?:[^[\]]|\[[^[\]]*\])*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const rawTarget = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(rawTarget)) continue; // http:, https:, mailto:, …
    if (rawTarget.startsWith('//') || rawTarget.startsWith('/')) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawTarget);
    } catch {
      decoded = rawTarget; // malformed escape — check what was written
    }
    const { target, anchor } = splitFragment(decoded);
    out.push({
      raw: rawTarget,
      target,
      anchor,
      line: lineOf(body, m.index),
      base: 'doc-dir',
    });
  }
  return out;
}

/** Inline-code spans that name a repo file, e.g. `` `utils/jobsAccess.ts` ``. */
export function extractCodePathCitations(source: string, _docRelPath: string): Citation[] {
  const out: Citation[] = [];
  const body = stripFencedBlocks(source);
  const re = /`([^`\n]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    // A citation may carry a trailing test name (`file.ts > describe`) or a
    // pytest node id; the path is the first whitespace-delimited token.
    const first = m[1].trim().split(/\s+/)[0];
    if (!CODE_PATH_PREFIXES.some((p) => first.startsWith(p))) continue;
    if (NOT_A_LITERAL_PATH.test(first)) continue;
    const { target } = splitFragment(first);
    if (!target.includes('/')) continue;
    out.push({
      raw: first,
      target,
      anchor: null, // `utils/jobsAccess.ts#deleteJob` names a symbol, not a heading
      line: lineOf(body, m.index),
      base: 'repo-root',
    });
  }
  return out;
}

export function extractCitations(source: string, docRelPath: string): Citation[] {
  return [
    ...extractLinkCitations(source, docRelPath),
    ...extractCodePathCitations(source, docRelPath),
  ];
}

// ============== Resolution ==============

/**
 * Extensions tried for an inline-code citation that names a MODULE rather than
 * a file — `components/common/DeleteIconButton`, `lib/unitPresets` — the same
 * extensionless form the imports use. Deliberately NOT applied to markdown
 * links: a link is a URL, and a URL that needs a guessed suffix is a 404.
 */
const MODULE_EXTENSIONS = ['.ts', '.tsx', '.py', '.sql', '.md'];

export function resolveCitation(repoRoot: string, docRelPath: string, c: Citation): string | null {
  if (c.target === '') return path.join(repoRoot, docRelPath); // bare `#anchor`
  const baseDir =
    c.base === 'doc-dir' ? path.dirname(path.join(repoRoot, docRelPath)) : repoRoot;
  const abs = path.resolve(baseDir, c.target);
  if (existsSync(abs)) return abs;
  if (c.base === 'repo-root') {
    for (const ext of MODULE_EXTENSIONS) {
      if (existsSync(abs + ext)) return abs + ext;
    }
  }
  return null;
}

// ============== Validation ==============

/** `#L12` / `#L12-L20` is a GitHub line range, not a heading. */
function isLineRef(anchor: string): boolean {
  return /^L\d+(-L\d+)?$/.test(anchor);
}

export interface DocScanResult {
  docsScanned: number;
  citationsChecked: number;
  /** Cross-doc + same-doc `#anchor`s actually resolved against a heading set. */
  anchorsChecked: number;
  issues: DocIssue[];
}

export interface ScanOptions {
  /** Set false to see what the allowlist is hiding — see unusedAllowlistEntries. */
  applyAllowlist?: boolean;
}

export function validateDoc(
  repoRoot: string,
  docRelPath: string,
  slugCache: Map<string, Set<string>> = new Map(),
  { applyAllowlist = true }: ScanOptions = {},
): { citationsChecked: number; anchorsChecked: number; issues: DocIssue[] } {
  const source = readFileSync(path.join(repoRoot, docRelPath), 'utf8');
  const issues: DocIssue[] = [];
  const citations = extractCitations(source, docRelPath);
  let anchorsChecked = 0;

  for (const c of citations) {
    if (applyAllowlist && ALLOWLIST.has(`${docRelPath}::${c.raw}`)) continue;

    const resolved = resolveCitation(repoRoot, docRelPath, c);
    if (resolved === null) {
      issues.push({
        file: docRelPath,
        line: c.line,
        kind: 'missing-path',
        target: c.raw,
        message: `cites "${c.raw}", which does not exist (resolved against ${
          c.base === 'doc-dir' ? path.dirname(docRelPath) || '.' : 'the repo root'
        })`,
      });
      continue;
    }

    if (!c.anchor || isLineRef(c.anchor)) continue;
    if (!resolved.endsWith('.md')) continue; // #fragment on a non-doc is a symbol/line hint

    let slugs = slugCache.get(resolved);
    if (!slugs) {
      slugs = headingSlugs(readFileSync(resolved, 'utf8'));
      slugCache.set(resolved, slugs);
    }
    anchorsChecked++;
    if (!slugs.has(c.anchor)) {
      issues.push({
        file: docRelPath,
        line: c.line,
        kind: 'missing-anchor',
        target: c.raw,
        message: `links to #${c.anchor} in ${path.relative(
          repoRoot,
          resolved,
        )}, which has no heading with that slug`,
      });
    }
  }

  return { citationsChecked: citations.length, anchorsChecked, issues };
}

// ============== File walking ==============

function walkMarkdown(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walkMarkdown(full, out);
    else if (name.endsWith('.md')) out.push(full);
  }
}

/** Every doc this check owns: `docs/**` plus the always-loaded CLAUDE.md. */
export function docFiles(repoRoot: string): string[] {
  const abs: string[] = [];
  try {
    walkMarkdown(path.join(repoRoot, 'docs'), abs);
  } catch {
    /* docs/ may be absent in a partial checkout */
  }
  const rel = abs.map((f) => path.relative(repoRoot, f)).sort();
  if (existsSync(path.join(repoRoot, 'CLAUDE.md'))) rel.unshift('CLAUDE.md');
  return rel;
}

export function scanProject(repoRoot: string, opts: ScanOptions = {}): DocScanResult {
  const docs = docFiles(repoRoot);
  const slugCache = new Map<string, Set<string>>();
  const issues: DocIssue[] = [];
  let citationsChecked = 0;
  let anchorsChecked = 0;
  for (const doc of docs) {
    const r = validateDoc(repoRoot, doc, slugCache, opts);
    citationsChecked += r.citationsChecked;
    anchorsChecked += r.anchorsChecked;
    issues.push(...r.issues);
  }
  return { docsScanned: docs.length, citationsChecked, anchorsChecked, issues };
}

/**
 * Allowlist entries that no longer suppress anything — the file they excuse has
 * come back, or the doc stopped citing it. A stale entry is not harmless: it is
 * a standing licence to break that exact citation again without a red build.
 * Asserted empty by __tests__/standards/docLinkCheck.test.ts, which is also
 * what proves the missing-path check fires on the real tree rather than being
 * trivially green.
 */
export function unusedAllowlistEntries(repoRoot: string): string[] {
  const raised = new Set(
    scanProject(repoRoot, { applyAllowlist: false }).issues.map((i) => `${i.file}::${i.target}`),
  );
  return [...ALLOWLIST.keys()].filter((k) => !raised.has(k));
}

// ============== CLI ==============

function main(): void {
  const repoRoot = path.resolve(__dirname, '..');
  const result = scanProject(repoRoot);

  console.log(
    `[doc-link-check] ${result.docsScanned} docs, ${result.citationsChecked} citations checked`,
  );

  if (result.issues.length === 0) {
    console.log('[doc-link-check] OK — every cited path and anchor resolves.');
    return;
  }

  console.error(`\n[doc-link-check] ${result.issues.length} dangling reference(s):\n`);
  for (const i of result.issues) {
    console.error(`  ${i.file}:${i.line} [${i.kind}] ${i.message}`);
  }
  console.error(
    '\nFix the doc. Only add an ALLOWLIST entry (scripts/docLinkCheck.ts) when the doc ' +
      'deliberately names a file that no longer exists — and give it a reason.\n',
  );
  process.exit(1);
}

// Run only when invoked directly (not when imported by the test).
if (require.main === module) main();
