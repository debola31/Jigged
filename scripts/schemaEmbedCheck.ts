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

export function extractSelects(source: string): SelectCandidate[] {
  const out: SelectCandidate[] = [];

  // Inline: .select('...') | .select("...") | .select(`...`)
  // The lookbehind avoids matching method-chain calls inside larger
  // expressions accidentally — we anchor on `.select(`.
  // Use [\s\S] in place of . + s-flag so this compiles under ES2017 target.
  const inlineRe = /\.select\(\s*(['"`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = inlineRe.exec(source)) !== null) {
    out.push({ source: 'inline .select()', text: resolveInterpolations(m[2], source) });
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
  reason: 'unknown-table' | 'unknown-column' | 'unresolved-interpolation';
  table?: string;
  column?: string;
  detail?: string;
}

function validateEmbed(
  embed: ParsedEmbed,
  schema: Schema,
  file: string,
  sourceLabel: string,
  context: string,
  out: Violation[],
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
    validateEmbed(nested, schema, file, sourceLabel, `${context} > ${embed.name}`, out);
  }
}

export function validateFile(filePath: string, schema: Schema): Violation[] {
  const source = readFileSync(filePath, 'utf8');
  const out: Violation[] = [];
  for (const cand of extractSelects(source)) {
    const parsed = parseSelect(cand.text);
    for (const embed of parsed.embeds) {
      validateEmbed(embed, schema, filePath, cand.source, cand.source, out);
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
  const schema = parseSchema(readFileSync(schemaPath, 'utf8'));

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
    violations.push(...validateFile(f, schema));
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
    case 'unresolved-interpolation':
      return `  ${rel} [${v.context}]: unresolved \${…} interpolation in embed (${v.detail})`;
  }
}

function main(): void {
  const repoRoot = resolve(__dirname, '..');
  const result = scanProject(repoRoot);

  // eslint-disable-next-line no-console
  console.log(
    `[schema-embed-check] ${result.schemaTables} tables, ${result.filesScanned} files scanned`,
  );

  // Separate hard errors from warnings (unresolved interpolations are warnings).
  const errors = result.violations.filter((v) => v.reason !== 'unresolved-interpolation');
  const warnings = result.violations.filter((v) => v.reason === 'unresolved-interpolation');

  for (const w of warnings) {
    // eslint-disable-next-line no-console
    console.warn('[warn] ' + formatViolation(w, repoRoot));
  }

  if (errors.length === 0) {
    // eslint-disable-next-line no-console
    console.log('[schema-embed-check] OK — no schema/embed drift detected.');
    return;
  }

  // eslint-disable-next-line no-console
  console.error(`\n[schema-embed-check] ${errors.length} violation(s):\n`);
  for (const v of errors) {
    // eslint-disable-next-line no-console
    console.error(formatViolation(v, repoRoot));
  }
  // eslint-disable-next-line no-console
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
