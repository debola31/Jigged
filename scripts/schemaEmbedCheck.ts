/**
 * Static schema/embed drift checker.
 *
 * Parses `supabase/schema.prod.sql` to learn the canonical {table → columns}
 * shape, then walks `utils/*.ts` (and any other paths passed in) looking for
 * PostgREST embed strings inside `.select(...)` calls and top-level
 * `const SELECT_FIELDS = \`...\`` constants. For every `relation(col1, col2)`
 * pattern (including nested embeds and alias hints like `alias:relation!left`),
 * verifies that the relation exists and every column exists on it.
 *
 * Born from the May 2026 jobs.status prod incident: migration 20260523
 * dropped jobs.status, but two PostgREST embeds in quotesAccess.ts still
 * referenced it. No unit test caught it (they mock supabase), tsc didn't
 * (the select string is opaque to TypeScript), and the one E2E spec that
 * would have failed was runtime-skipping. This check would have flagged
 * the embed on the PR that dropped the column.
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
 * Parse a `CREATE TABLE IF NOT EXISTS "public"."<name>" (...);` dump into
 * a {table → Set<columns>} map. Iterates char-by-char tracking paren depth
 * so column-type expressions like `numeric(12,4)` and inline CHECK
 * constraints don't confuse the boundary detection.
 */
export function parseSchema(sql: string): Schema {
  const out: Schema = new Map();
  const lines = sql.split('\n');
  let currentTable: string | null = null;
  let depth = 0;
  let cols: Set<string> | null = null;

  for (const line of lines) {
    if (currentTable === null) {
      const m = /CREATE TABLE (?:IF NOT EXISTS )?"public"\."([^"]+)"/.exec(line);
      if (m) {
        currentTable = m[1];
        cols = new Set();
        depth = 0;
      }
    }
    if (currentTable === null) continue;

    let closed = false;
    for (const ch of line) {
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          out.set(currentTable, cols!);
          currentTable = null;
          cols = null;
          closed = true;
          break;
        }
      }
    }
    if (closed) continue;

    if (currentTable !== null && depth > 0) {
      const t = line.trim();
      if (t.startsWith('CONSTRAINT')) continue;
      const m = /^"([^"]+)"\s+\S/.exec(t);
      if (m) cols!.add(m[1]);
    }
  }
  return out;
}

/**
 * Every foreign key in the dump, in the two forms PostgREST accepts as an embed
 * disambiguation hint (`alias:relation!<hint>(...)`):
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

export function parseForeignKeys(sql: string): ForeignKeys {
  const names = new Set<string>();
  const columnsByTarget = new Map<string, Set<string>>();
  const re =
    /ADD CONSTRAINT "?([A-Za-z0-9_]+)"?\s+FOREIGN KEY\s*\(([^)]*)\)\s*REFERENCES\s+(?:"?public"?\.)?"?([A-Za-z0-9_]+)"?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    names.add(m[1]);
    const target = m[3];
    let cols = columnsByTarget.get(target);
    if (!cols) columnsByTarget.set(target, (cols = new Set()));
    for (const c of m[2].split(',')) cols.add(c.trim().replace(/"/g, ''));
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

/** Substitute `${IDENT}` placeholders with their `const IDENT = \`...\``
 *  values from the same file. One pass is enough for the convention in
 *  this codebase (constants don't nest deeply). Unresolved placeholders
 *  remain as `${IDENT}` so the caller can detect and skip. */
function resolveInterpolations(text: string, sourceFile: string): string {
  return text.replace(/\$\{(\w+)\}/g, (orig, name) => {
    const re = new RegExp(`const\\s+${name}\\s*=\\s*\`([^\`]+)\``);
    const m = re.exec(sourceFile);
    return m ? m[1] : orig;
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
  const schemaPath = join(repoRoot, 'supabase/schema.prod.sql');
  const schemaSql = readFileSync(schemaPath, 'utf8');
  const schema = parseSchema(schemaSql);
  const fks = parseForeignKeys(schemaSql);

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
    '\nIf the schema was regenerated, refresh ' +
      'supabase/schema.prod.sql via scripts/export_schema.py.\n',
  );
  process.exit(1);
}

// Run when invoked directly via `tsx`/`node`. The check `require.main === module`
// works under tsx because it shims commonjs `require`.
if (require.main === module) {
  main();
}
