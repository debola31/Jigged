/**
 * Static schema/embed drift checker.
 *
 * Parses `types/database.ts` to learn the canonical {table → columns}
 * shape, then walks `utils/*.ts` (and any other paths passed in) looking for
 * PostgREST embed strings inside `.select(...)` calls and top-level
 * `const SELECT_FIELDS = \`...\`` constants. For every `relation(col1, col2)`
 * pattern (including nested embeds and alias hints like `alias:relation!left`),
 * verifies that the relation exists and every column exists on it.
 *
 * Born from the May 2026 jobs.status prod incident: migration 20260523
 * dropped jobs.status, but two PostgREST embeds in quotesAccess.ts still
 * referenced it. No unit test caught it (they mock supabase), tsc didn't —
 * the access layer ran on the UNTYPED client then, so the select string really
 * was opaque to TypeScript — and the one E2E spec that would have failed was
 * runtime-skipping. This check would have flagged the embed on the PR that
 * dropped the column.
 *
 * WHY THIS FILE STILL EXISTS, re-measured 2026-08-07. The previous answer here
 * was wrong and is worth stating plainly, because it was recorded as "measured,
 * not assumed" and would otherwise keep being believed.
 *
 * WITHDRAWN: that past some breadth/depth supabase-js's type-level parser
 * "stops resolving and silently widens instead of erroring", and that this is
 * why QUOTE_DETAIL_SELECT went unchecked. It does not widen. Ask the parser
 * directly — index into the query's inferred type instead of casting the row —
 * and QUOTE_DETAIL_SELECT resolves correctly and yields, three levels down:
 *
 *   SelectQueryError<"column 'x' does not exist on 'customer_contacts'.">[]
 *
 * The old observation (jobsAccess errors, quotesAccess does not) reproduces
 * exactly. The inference from it did not survive. What actually decides it:
 *
 *   1. SelectQueryError<M> = { error: true } & M is a TYPE, not a compile
 *      error. It fails a build only where type-checked code READS that field.
 *   2. Both sites cast the row with a plain `as`. Whether that surfaces the
 *      error depends on the HAND-WRITTEN TARGET TYPE's permissiveness, not on
 *      the query: JobWithRelations declares its relations required, so the bad
 *      row fails comparability and tsc errors; QuoteWithRelations declares
 *      every relation optional (`customers?`, `customer_contacts?`), so the
 *      same bad row still "sufficiently overlaps" and the cast is allowed.
 *      One `?` is the entire difference. An `as unknown as` erases it always.
 *
 * SO WHAT KEEPS THIS FILE ALIVE IS NOT THE COLUMN CHECK. Deriving result types
 * from the query (`QueryData<typeof q>`) instead of hand-writing them makes tsc
 * cover the column class natively — see docs/runbooks/typed-select-drift.md.
 * Two classes survive that migration, and they are the real mandate here:
 *
 *   - FK HINTS ARE NOT TYPE-CHECKED AT ALL. `notes!totally_made_up_fk(id, body)`
 *     infers a plausible, fully readable type with no error even when every
 *     field is read: on a hint miss postgrest-js falls back to matching by
 *     relation NAME rather than erroring. PostgREST 400s on it at runtime.
 *     16 live non-keyword hints in utils/, across two naming conventions
 *     (`_fkey` on older tables, `_fk` on newer), and a fabricated one has
 *     already reached a preview deploy. The `unknown-constraint` reason below
 *     is the only thing in the repo covering this class.
 *   - A DERIVED TYPE IS A DERIVATION, NOT AN ASSERTION. A SelectQueryError in
 *     one still only errors at a type-checked read. Reading a sibling field,
 *     JSON.stringify, or .length all stay silent — and `__tests__` is excluded
 *     from tsconfig, so a test-only read never counts.
 *
 * Do not delete this file on the grounds that the typed client covers it. Do
 * delete the column-existence half once every embed column has a type-checked
 * reader AND the FK-hint class has a replacement — neither is true today.
 *
 * Scope:
 * - Validates EMBED columns (inside `relation(...)`). Bare top-level columns
 *   are intentionally not validated — they'd require knowing the outer
 *   table from a possibly-distant `.from('xxx')` call, which is brittle.
 *   Embeds are where every drift incident we've seen has lived.
 * - Resolves `${IDENT}` template-literal interpolations against
 *   `const IDENT = \`...\`` declarations in the same file. If an
 *   interpolation can't be resolved, the embed is skipped (with a
 *   warning) rather than treated as an unknown column.
 *
 * Run via `pnpm exec tsx scripts/schemaEmbedCheck.ts` or programmatically
 * from a vitest spec — see __tests__/schema/embedCheck.test.ts.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

// ============== Schema parsing ==============

export type Schema = Map<string, Set<string>>;

/**
 * Parse `types/database.ts` into a {table → Set<columns>} map, reading the
 * `Row` shape of every entry under the `public` schema's `Tables`.
 *
 * WHY THIS SOURCE. This used to parse `supabase/schema.prod.sql`, a snapshot
 * exported from production. That file was deleted because it could — and did —
 * lie: it was hand-edited in a feature PR to add
 * `customer_contacts.is_billing_default` while production had no such column,
 * its `Generated:` header untouched, and it asserted that for two days through
 * an outage. A schema reference that can be confidently wrong is worse than none.
 *
 * `types/database.ts` cannot drift the same way. It is generated from the
 * migration-replayed schema and CI fails on any diff (issue #406), so it can
 * neither go stale nor be hand-edited without a red build. It is also the right
 * reference for a PR-time check: it describes what the code will run against
 * once merged, whereas production legitimately lags main, making drift against
 * it ambiguous.
 *
 * Views are excluded, preserving this check's previous scope — the old parser
 * matched only `CREATE TABLE`, so an embed targeting a view was already
 * reported as an unknown relation.
 */
export function parseSchema(ts: string): Schema {
  const out: Schema = new Map();
  const lines = ts.split('\n');

  // The generator emits the schema type first and a trailing `Constants` object
  // last, and BOTH contain a `public:` key. Anchor on the type declaration so
  // the constants block is never mistaken for the schema.
  const start = lines.findIndex((l) => /^export type Database = \{/.test(l));
  if (start === -1) {
    throw new Error('types/database.ts: no `export type Database = {` declaration found');
  }

  // Indentation is load-bearing here, and safe to rely on: the file is emitted
  // by `supabase gen types` and CI asserts it byte-for-byte, so its formatting
  // cannot drift without a failing build.
  let inPublic = false;
  let inTables = false;
  let table: string | null = null;
  let inRow = false;

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];

    if (!inPublic) {
      if (/^ {2}public: \{$/.test(line)) inPublic = true;
      continue;
    }

    // Leaving the public schema block entirely.
    if (/^ {2}\}/.test(line)) break;

    if (!inTables) {
      if (/^ {4}Tables: \{$/.test(line)) inTables = true;
      continue;
    }

    // A sibling key at Tables' own depth (Views, Functions, Enums, …) ends it.
    if (table === null && /^ {4}\w+: [{[]$/.test(line)) break;

    if (table === null) {
      const m = /^ {6}"?([A-Za-z0-9_]+)"?: \{$/.exec(line);
      if (m) {
        table = m[1];
        out.set(table, new Set());
      }
      continue;
    }

    if (!inRow) {
      if (/^ {8}Row: \{$/.test(line)) inRow = true;
      else if (/^ {6}\}$/.test(line)) table = null;
      continue;
    }

    if (/^ {8}\}$/.test(line)) {
      // Row closed. Skip Insert/Update/Relationships — Row is the full column
      // set, and the others merely re-state it with different optionality plus
      // generator-only keys.
      inRow = false;
      table = null;
      continue;
    }

    const col = /^ {10}"?([A-Za-z0-9_]+)"?\??: /.exec(line);
    if (col) out.get(table)!.add(col[1]);
  }

  return out;
}

/**
 * Every foreign key in `types/database.ts`, in the two forms PostgREST accepts
 * as an embed disambiguation hint (`alias:relation!<hint>(...)`):
 *
 * - `names` — the constraint name, e.g. `notes!notes_job_fk(...)`.
 * - `columnsByTarget` — the referencing COLUMN, keyed by the table it points at, e.g.
 *   `customer_addresses!shipping_address_id(...)`. The column lives on the source table,
 *   which this parser cannot resolve (the outer `.from()` may be far away), so the target
 *   is what makes it checkable: `shipping_address_id` is a legal hint for an embed of
 *   `customer_addresses` because some FK on that column references it.
 *
 * Worth parsing because a hint that resolves to neither is a 400 on every call, and this
 * schema gives no rule to guess from: older tables carry Postgres' default
 * `<table>_<col>_fkey` while newer ones use a hand-written `<table>_<col>_fk`.
 */
export interface ForeignKeys {
  names: Set<string>;
  columnsByTarget: Map<string, Set<string>>;
}

export function parseForeignKeys(ts: string): ForeignKeys {
  const names = new Set<string>();
  const columnsByTarget = new Map<string, Set<string>>();

  // Reads the `Relationships` entries the generator emits under every table:
  //
  //     {
  //       foreignKeyName: "quotes_contact_id_fkey"
  //       columns: ["contact_id"]
  //       isOneToOne: false
  //       referencedRelation: "customer_contacts"
  //       referencedColumns: ["id"]
  //     },
  //
  // isOneToOne is optional because it is absent on some entries. The pattern is
  // otherwise anchored field-to-field rather than using a lazy `[\s\S]*?`, so it
  // cannot run past the end of one object and pair a name with the NEXT entry's
  // target — which would invent a foreign key that does not exist and let a bad
  // hint through.
  const re =
    /foreignKeyName:\s*"([^"]+)"\s*columns:\s*\[([^\]]*)\]\s*(?:isOneToOne:\s*\w+\s*)?referencedRelation:\s*"([^"]+)"/g;

  let m: RegExpExecArray | null;
  while ((m = re.exec(ts)) !== null) {
    names.add(m[1]);
    const target = m[3];
    let cols = columnsByTarget.get(target);
    if (!cols) columnsByTarget.set(target, (cols = new Set()));
    for (const c of m[2].split(',')) {
      const col = c.trim().replace(/"/g, '');
      if (col) cols.add(col);
    }
  }
  return { names, columnsByTarget };
}

// ============== Select-string parsing ==============

interface ColumnRef {
  raw: string;
  alias: string | null;
  name: string;
}

interface ParsedEmbed extends ColumnRef {
  hint: string | null; // 'left' | 'inner' | a foreign-key constraint name
  inner: string;
}

interface ParsedSelect {
  columns: ColumnRef[];
  embeds: ParsedEmbed[];
}

/** Split a comma-separated PostgREST select string at top-level commas only
 *  (commas inside parentheses belong to embedded relations). */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of s) {
    if (ch === '(') {
      depth++;
      buf += ch;
    } else if (ch === ')') {
      depth--;
      buf += ch;
    } else if (ch === ',' && depth === 0) {
      const t = buf.trim();
      if (t) out.push(t);
      buf = '';
    } else {
      buf += ch;
    }
  }
  const t = buf.trim();
  if (t) out.push(t);
  return out;
}

export function parseSelect(s: string): ParsedSelect {
  const columns: ColumnRef[] = [];
  const embeds: ParsedEmbed[] = [];
  for (const tok of splitTopLevel(s)) {
    const parenIdx = tok.indexOf('(');
    if (parenIdx !== -1) {
      const head = tok.substring(0, parenIdx);
      // lastIndexOf(')') handles trailing whitespace + parens cleanly.
      const lastClose = tok.lastIndexOf(')');
      const inner = lastClose > parenIdx ? tok.substring(parenIdx + 1, lastClose) : '';
      let alias: string | null = null;
      let rest = head.trim();
      const colonIdx = rest.indexOf(':');
      if (colonIdx !== -1) {
        alias = rest.substring(0, colonIdx).trim();
        rest = rest.substring(colonIdx + 1).trim();
      }
      let hint: string | null = null;
      let name = rest;
      const bangIdx = rest.indexOf('!');
      if (bangIdx !== -1) {
        name = rest.substring(0, bangIdx).trim();
        hint = rest.substring(bangIdx + 1).trim();
      }
      embeds.push({ raw: tok, alias, name, hint, inner });
    } else {
      let alias: string | null = null;
      let name = tok.trim();
      const colonIdx = name.indexOf(':');
      if (colonIdx !== -1) {
        alias = name.substring(0, colonIdx).trim();
        name = name.substring(colonIdx + 1).trim();
      }
      columns.push({ raw: tok, alias, name });
    }
  }
  return { columns, embeds };
}

// ============== Source extraction ==============

interface SelectCandidate {
  source: string; // human-readable origin: "inline" or const name
  text: string;
}

/** Substitute `${IDENT}` placeholders with their `const IDENT = '...'` values
 *  from the same file. One pass is enough for the convention in this codebase
 *  (constants don't nest deeply). Unresolved placeholders remain as `${IDENT}`
 *  so the caller can detect and skip.
 *
 *  ALL THREE QUOTE STYLES, and the single quotes are the load-bearing ones.
 *  This matched only backticks until 2026-08-07, so a select constant written
 *  with `'…'` never resolved — and because `validateEmbed` bails on an
 *  unresolved `${…}` BEFORE it reaches the FK-hint check, that silently
 *  disabled hint validation for the embed it sat in. `parts_bom_child_part_id_fkey`
 *  and `parts_bom_parent_part_id_fkey` were checked by nothing at all as a
 *  result: a fabricated hint there produced no violation, and PostgREST 400s on
 *  one at runtime. Nothing else in the repo checks FK hints — `tsc` does not
 *  (a bogus hint infers a plausible type, see docs/architecture.md §6.1).
 *
 *  Kept as three separate alternatives rather than one character class so an
 *  apostrophe inside a backtick constant cannot terminate the match early. */
function resolveInterpolations(text: string, sourceFile: string): string {
  return text.replace(/\$\{(\w+)\}/g, (orig, name) => {
    const re = new RegExp(
      `const\\s+${name}\\s*=\\s*(?:\`([^\`]+)\`|'([^']+)'|"([^"]+)")`,
    );
    const m = re.exec(sourceFile);
    return m ? (m[1] ?? m[2] ?? m[3]) : orig;
  });
}

/**
 * Read the FIRST argument of a `.select(` starting at the index of its `(`, then glue
 * together every string literal in it.
 *
 * A select is often built by concatenation across lines:
 *
 *     .select(
 *       'created_at, kind, ' +
 *         'reactor:user_company_access!note_reactions_reactor_fk(name), ' +
 *         'note:notes!inner(id, body)',
 *     )
 *
 * The original extractor matched one quoted literal and stopped, so it saw
 * `created_at, kind, ` and NOTHING ELSE — every embed in a concatenated select went
 * unchecked. That is not a hypothetical gap: it is why a fabricated foreign-key hint in
 * `getNewHelpful` reached a preview deployment through a green run of this very check.
 *
 * Stops at the first top-level comma so a second argument (`{ count: 'exact' }`) does not
 * contribute `exact` as a phantom column.
 */
function readSelectLiterals(source: string, openIdx: number): string | null {
  let depth = 0;
  let out = '';
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i];

    // Skip comments before the quote check. A `//` note inside the argument routinely
    // contains backticks (`\`<table>_<col>_fkey\``) or apostrophes, and treating those as
    // string delimiters silently corrupts the rest of the select — which is how the very
    // embed this check was extended to catch stayed invisible one revision longer.
    if (ch === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i);
      if (i === -1) return out;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) return out;
      i = end + 1;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      for (; i < source.length && source[i] !== quote; i++) {
        if (source[i] === '\\') {
          out += source[i + 1] ?? '';
          i++;
          continue;
        }
        out += source[i];
      }
      continue;
    }

    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return out;
    } else if (ch === ',' && depth === 1) return out;
  }
  return null;
}

export function extractSelects(source: string): SelectCandidate[] {
  const out: SelectCandidate[] = [];

  // Inline: .select('...'), including selects concatenated across several literals.
  const inlineRe = /\.select\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = inlineRe.exec(source)) !== null) {
    const text = readSelectLiterals(source, m.index + m[0].length - 1);
    if (text && text.trim()) {
      out.push({ source: 'inline .select()', text: resolveInterpolations(text, source) });
    }
  }

  // Top-level template-literal constants that look like PostgREST selects.
  // Restrict to SCREAMING_SNAKE_CASE identifiers — the established
  // convention in this codebase for select-string consts (QUOTE_LIST_SELECT,
  // PART_SELECT_COLUMNS, etc.). Lowercase consts like `newNumber` or
  // `autoName` are general-purpose templates and shouldn't be parsed as
  // PostgREST.
  const constRe = /(?:^|\n)\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*`([^`]+)`/g;
  while ((m = constRe.exec(source)) !== null) {
    const text = resolveInterpolations(m[2], source);
    if (text.includes('(')) {
      out.push({ source: `const ${m[1]}`, text });
    }
  }

  return out;
}

// ============== Validation ==============

export interface Violation {
  file: string;
  source: string;
  context: string;
  reason:
    | 'unknown-table'
    | 'unknown-column'
    | 'unknown-constraint'
    | 'unresolved-interpolation';
  table?: string;
  column?: string;
  detail?: string;
}

/** Hints that select a join type rather than naming a relationship. */
const HINT_KEYWORDS = new Set(['left', 'inner']);

function validateEmbed(
  embed: ParsedEmbed,
  schema: Schema,
  file: string,
  sourceLabel: string,
  context: string,
  out: Violation[],
  fks?: ForeignKeys | null,
): void {
  // Skip embeds whose inner contains unresolved `${...}` — we can't tell
  // whether the missing piece names valid columns. Surfaces as a warning
  // so the developer can fix the constant resolution if it matters.
  if (embed.inner.includes('${')) {
    out.push({
      file,
      source: sourceLabel,
      context: `${context} > ${embed.name}(...)`,
      reason: 'unresolved-interpolation',
      detail: embed.inner.trim().substring(0, 60),
    });
    return;
  }

  if (!schema.has(embed.name)) {
    out.push({
      file,
      source: sourceLabel,
      context: `${context} > ${embed.name}(...)`,
      reason: 'unknown-table',
      table: embed.name,
    });
    return;
  }

  // A hint that is neither `left`/`inner` nor a column name must be a foreign-key
  // constraint name, and PostgREST 400s if it does not resolve. Only checked when the
  // caller supplied the constraint set — `validateFile(path, schema)` stays valid.
  // Hints chain — `parts!parts_bom_parent_part_id_fkey!inner` names the relationship AND
  // the join type — so each segment is checked on its own. A segment that is not a join
  // keyword has to resolve to a real relationship: a constraint name, a referencing column
  // pointing at this table, or a column on the table itself.
  if (fks && embed.hint) {
    for (const seg of embed.hint.split('!').map((s) => s.trim())) {
      if (!seg || HINT_KEYWORDS.has(seg)) continue;
      if (
        fks.names.has(seg) ||
        fks.columnsByTarget.get(embed.name)?.has(seg) ||
        schema.get(embed.name)!.has(seg)
      ) {
        continue;
      }
      out.push({
        file,
        source: sourceLabel,
        context: `${context} > ${embed.name}(...)`,
        reason: 'unknown-constraint',
        table: embed.name,
        detail: seg,
      });
    }
  }

  const cols = schema.get(embed.name)!;
  const sub = parseSelect(embed.inner);
  for (const col of sub.columns) {
    if (col.name === '*') continue;
    if (!cols.has(col.name)) {
      out.push({
        file,
        source: sourceLabel,
        context: `${context} > ${embed.name}(...)`,
        reason: 'unknown-column',
        table: embed.name,
        column: col.name,
      });
    }
  }
  for (const nested of sub.embeds) {
    validateEmbed(nested, schema, file, sourceLabel, `${context} > ${embed.name}`, out, fks);
  }
}

export function validateFile(
  filePath: string,
  schema: Schema,
  fks?: ForeignKeys | null,
): Violation[] {
  const source = readFileSync(filePath, 'utf8');
  const out: Violation[] = [];
  for (const cand of extractSelects(source)) {
    const parsed = parseSelect(cand.text);
    for (const embed of parsed.embeds) {
      validateEmbed(embed, schema, filePath, cand.source, cand.source, out, fks);
    }
  }
  return out;
}

// ============== File walking ==============

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(full);
  }
}

export interface ProjectScanResult {
  filesScanned: number;
  schemaTables: number;
  violations: Violation[];
}

export function scanProject(repoRoot: string, scanDirs: string[] = ['utils']): ProjectScanResult {
  // One read, two parsers: the generated types carry both the column shape and
  // every foreign key (as each table's `Relationships` array).
  const schemaPath = join(repoRoot, 'types/database.ts');
  const schemaTs = readFileSync(schemaPath, 'utf8');
  const schema = parseSchema(schemaTs);
  const fks = parseForeignKeys(schemaTs);

  const files: string[] = [];
  for (const dir of scanDirs) {
    const full = join(repoRoot, dir);
    try {
      walk(full, files);
    } catch {
      // Directory doesn't exist — skip silently. Callers pick the scan list.
    }
  }

  const violations: Violation[] = [];
  for (const f of files) {
    violations.push(...validateFile(f, schema, fks));
  }

  return { filesScanned: files.length, schemaTables: schema.size, violations };
}

// ============== CLI ==============

function formatViolation(v: Violation, repoRoot: string): string {
  const rel = relative(repoRoot, v.file);
  switch (v.reason) {
    case 'unknown-table':
      return `  ${rel} [${v.context}]: relation "${v.table}" not in schema`;
    case 'unknown-column':
      return `  ${rel} [${v.context}]: ${v.table}.${v.column} does not exist`;
    case 'unknown-constraint':
      return `  ${rel} [${v.context}]: no foreign key named "${v.detail}" (PostgREST returns 400)`;
    case 'unresolved-interpolation':
      return `  ${rel} [${v.context}]: unresolved \${…} interpolation in embed (${v.detail})`;
  }
}

function main(): void {
  const repoRoot = resolve(__dirname, '..');
  const result = scanProject(repoRoot);

  console.log(
    `[schema-embed-check] ${result.schemaTables} tables, ${result.filesScanned} files scanned`,
  );

  // Separate hard errors from warnings (unresolved interpolations are warnings).
  const errors = result.violations.filter((v) => v.reason !== 'unresolved-interpolation');
  const warnings = result.violations.filter((v) => v.reason === 'unresolved-interpolation');

  for (const w of warnings) {
    console.warn('[warn] ' + formatViolation(w, repoRoot));
  }

  if (errors.length === 0) {
    console.log('[schema-embed-check] OK — no schema/embed drift detected.');
    return;
  }

  console.error(`\n[schema-embed-check] ${errors.length} violation(s):\n`);
  for (const v of errors) {
    console.error(formatViolation(v, repoRoot));
  }
  console.error(
    '\nIf a migration changed the schema, regenerate the types it is checked ' +
      'against:\n    supabase start && pnpm gen:db-types\n',
  );
  process.exit(1);
}

// Run when invoked directly via `tsx`/`node`. The check `require.main === module`
// works under tsx because it shims commonjs `require`.
if (require.main === module) {
  main();
}
