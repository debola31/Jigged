/**
 * interactionStandardsCheck — a source scanner that turns two documented-but-
 * unenforced design rules into a CI gate. Both rules drifted in real PRs because
 * docs alone don't stop hand-rolled regressions:
 *
 *   1. Misleading placeholders — a placeholder that looks like real data (bare
 *      number, currency, `e.g. 5.50`) reads as a pre-filled value to our
 *      non-technical users. See docs/design-system.md "Placeholders".
 *   2. Grey delete controls — a destructive trash icon must be error-colored at
 *      rest, never grey (`color: 'text.secondary'`). See
 *      docs/interaction-standards.md "Destructive actions". Use the shared
 *      components/common/DeleteIconButton so the color can't be set wrong.
 *
 * Mirrors scripts/schemaEmbedCheck.ts: a pure scan function the test drives,
 * plus a main() for `pnpm exec tsx`.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

export interface StandardsViolation {
  file: string; // relative to repo root
  line: number;
  rule: 'placeholder' | 'grey-delete';
  message: string;
}

// Escape hatch for genuine exceptions, keyed by `relativePath:line` is too
// brittle (line numbers shift); key by `relativePath::snippet` instead.
const ALLOWLIST = new Set<string>([]);

/**
 * A placeholder string is "value-like" (banned) when it could be mistaken for
 * entered data: it starts with a digit or `$`, or is an `e.g. <number>` hint.
 * Deliberately conservative — instructional text ("Search…", "customer@…") and
 * word hints ("Qty") are allowed and must not trip this.
 */
export function isValueLikePlaceholder(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^\$?\s*\d/.test(t)) return true; // "1", "25", "$0.00", "0.00", "25%"
  if (/^e\.g\.\s*\$?\s*\d/i.test(t)) return true; // "e.g. 5.50", "e.g. 50"
  return false;
}

/** Find value-like placeholder literals. Dynamic `placeholder={expr}` is left to review. */
export function findPlaceholderViolations(source: string, relPath: string): StandardsViolation[] {
  const out: StandardsViolation[] = [];
  // placeholder="..." | placeholder='...' | placeholder={`...`} (no interpolation)
  const re = /placeholder=(?:"([^"]*)"|'([^']*)'|\{`([^`$]*)`\})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const text = m[1] ?? m[2] ?? m[3] ?? '';
    if (!isValueLikePlaceholder(text)) continue;
    if (ALLOWLIST.has(`${relPath}::${text}`)) continue;
    const line = source.slice(0, m.index).split('\n').length;
    out.push({
      file: relPath,
      line,
      rule: 'placeholder',
      message: `Value-like placeholder "${text}" reads as pre-filled data. Remove it (the field has a label/header) — see docs/design-system.md "Placeholders".`,
    });
  }
  return out;
}

/**
 * Find hand-rolled grey delete icons: an <IconButton> element that both signals
 * "delete/remove" (a Delete icon or a delete/remove aria-label) and sets
 * `color: 'text.secondary'`. The fix is components/common/DeleteIconButton.
 */
export function findGreyDeleteViolations(source: string, relPath: string): StandardsViolation[] {
  const out: StandardsViolation[] = [];
  // Match a single IconButton element (self-closing or paired). IconButtons
  // don't nest, so non-greedy is safe.
  const re = /<IconButton\b[\s\S]*?(?:\/>|<\/IconButton>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const chunk = m[0];
    const isDelete =
      /Delete(Outline)?Icon/.test(chunk) ||
      /aria-label=["'][^"']*(delete|remove)/i.test(chunk);
    const isGrey = /color:\s*['"]text\.secondary['"]/.test(chunk);
    if (!isDelete || !isGrey) continue;
    if (ALLOWLIST.has(`${relPath}::grey-delete`)) continue;
    const line = source.slice(0, m.index).split('\n').length;
    out.push({
      file: relPath,
      line,
      rule: 'grey-delete',
      message:
        "Delete icon is grey (color: 'text.secondary'). Destructive controls are error-colored at rest — use components/common/DeleteIconButton (see docs/interaction-standards.md).",
    });
  }
  return out;
}

// Note on icon shape: the app uses a two-tier delete glyph — solid DeleteIcon
// for whole-record/entity deletes (headers, list rows, dialog confirms), hollow
// DeleteOutlineIcon for low-emphasis editor sub-rows (BOM, tiers, ops, notes).
// Both are always error-colored (red); emphasis scales by fill, not by color.
// We intentionally do NOT enforce a single glyph here — that's a per-call-site
// judgment. We DO enforce that no delete is grey (findGreyDeleteViolations).

export function scanSource(source: string, relPath: string): StandardsViolation[] {
  return [
    ...findPlaceholderViolations(source, relPath),
    ...findGreyDeleteViolations(source, relPath),
  ];
}

// ============== File walking ==============

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith('.tsx')) out.push(full);
  }
}

export function scanProject(
  repoRoot: string,
  scanDirs: string[] = ['components', 'app'],
): StandardsViolation[] {
  const files: string[] = [];
  for (const dir of scanDirs) {
    const full = path.join(repoRoot, dir);
    try {
      walk(full, files);
    } catch {
      /* dir may not exist in some checkouts */
    }
  }
  const violations: StandardsViolation[] = [];
  for (const file of files) {
    const rel = path.relative(repoRoot, file);
    // Don't flag the shared component's own internals.
    if (rel.endsWith(path.join('common', 'DeleteIconButton.tsx'))) continue;
    violations.push(...scanSource(readFileSync(file, 'utf8'), rel));
  }
  return violations;
}

function main(): void {
  const repoRoot = path.resolve(__dirname, '..');
  const violations = scanProject(repoRoot);
  if (violations.length === 0) {
    console.log('interactionStandardsCheck: no violations.');
    return;
  }
  for (const v of violations) {
    console.error(`${v.file}:${v.line} [${v.rule}] ${v.message}`);
  }
  console.error(`\n${violations.length} interaction-standards violation(s).`);
  process.exit(1);
}

// Run only when invoked directly (not when imported by the test).
if (require.main === module) main();
