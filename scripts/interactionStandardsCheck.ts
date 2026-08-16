/**
 * interactionStandardsCheck — a source scanner that turns documented-but-
 * unenforced design rules into a CI gate. Each rule drifted in real PRs because
 * docs alone don't stop hand-rolled regressions:
 *
 *   1. Misleading placeholders — a placeholder that looks like real data (bare
 *      number, currency, `e.g. 5.50`) reads as a pre-filled value to our
 *      non-technical users. See docs/design-system.md "Placeholders".
 *   2. Grey delete controls — a destructive trash icon must be error-colored at
 *      rest, never grey (`color: 'text.secondary'`). See
 *      docs/interaction-standards.md "Destructive actions". Use the shared
 *      components/common/DeleteIconButton so the color can't be set wrong.
 *   3. Semantic-color button fills — a filled (contained) action <Button> may
 *      only be primary (blue) or error (red). success/warning/info are status-
 *      chip colors; on a button fill they mislead (a green button reads as
 *      "already done"). See docs/design-system.md "Buttons". This is exactly
 *      how the green "Complete"/"Mark Received" one-offs crept in.
 *   4. Silent busy buttons — a control that only greys out during a third-party
 *      round trip reads as a dropped click. Three live bug reports from one shop
 *      before the rule existed. See docs/interaction-standards.md §5; use the
 *      shared components/common/BusyButton, which makes the label mandatory.
 *
 * Mirrors scripts/schemaEmbedCheck.ts: a pure scan function the test drives,
 * plus a main() for `pnpm exec tsx`.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

export interface StandardsViolation {
  file: string; // relative to repo root
  line: number;
  rule: 'placeholder' | 'grey-delete' | 'button-color' | 'silent-busy-button';
  message: string;
}

/**
 * Surfaces whose buttons cross to a THIRD PARTY, so their round trips are
 * reliably over Nielsen's 1-second "no feedback needed" limit — Conductor's Web
 * Connector hop to a PC in the shop is 3-10s cold, longer when QuickBooks is shut.
 *
 * Scoped by PATH, not by import. Importing a slow client says nothing about any
 * individual button: the job page imports quickbooksAccess to list invoice links,
 * and nine of its ten buttons are sub-second Supabase writes. Matching the
 * integration surfaces themselves is the closest honest proxy for "this control
 * calls out", and it is why the first draft of this rule was wrong.
 *
 * Deliberately narrow. `disabled={busy}` appears ~260 times across ~77 files and
 * the overwhelming majority are fast local writes where a spinner is noise, not
 * help. A check that flags those is a check nobody trusts and an allowlist that
 * swallows the rule. Widen this only for a surface whose latency is known to
 * exceed a second.
 */
const THIRD_PARTY_SURFACES = /quickbooks/i;

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

/**
 * Slice a JSX opening tag that starts at `source[start]` (the `<`), returning the
 * text up to and including the tag's own closing `>`. Skips any `>` inside {expr}
 * braces and string / template literals, so `onClick={() => fn()}` and `sx={{…}}`
 * don't end the tag early. Heuristic (no escaped-quote handling) — same spirit as
 * this file's other regex scanners. Returns null if no closer is found.
 */
function sliceOpeningTag(source: string, start: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') {
      if (depth > 0) depth--;
    } else if (c === '>' && depth === 0) {
      return source.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Find action buttons that carry a semantic FILL color. We flag only
 * `variant="contained"` with `color="success|warning|info"` — that is the one
 * case that actually renders the misleading color, because the theme re-colors
 * outlined (white) and text (primary.light) buttons regardless of the `color`
 * prop. So the sanctioned outlined exception ("Mark Sent Out" = outlined warning)
 * passes automatically, and `color="error"` (destructive red) and primary/omitted
 * stay allowed. Only literal string props are checked; `color={expr}` is left to
 * review. Matches `<Button` exactly (not ButtonBase / IconButton / ToggleButton).
 */
export function findButtonColorViolations(source: string, relPath: string): StandardsViolation[] {
  const out: StandardsViolation[] = [];
  const re = /<Button\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const tag = sliceOpeningTag(source, m.index);
    if (!tag) continue;
    if (!/\bvariant=["']contained["']/.test(tag)) continue;
    const cm = tag.match(/\bcolor=["'](success|warning|info)["']/);
    if (!cm) continue;
    if (ALLOWLIST.has(`${relPath}::button-color`)) continue;
    const line = source.slice(0, m.index).split('\n').length;
    out.push({
      file: relPath,
      line,
      rule: 'button-color',
      message: `Contained <Button> uses color="${cm[1]}" — a status-chip color. A filled action button is primary (blue) or, if destructive, error (red). See docs/design-system.md "Buttons".`,
    });
  }
  return out;
}

/**
 * Find buttons that go silent during a third-party round trip.
 *
 * Scoped to the THIRD_PARTY_SURFACES paths, where a wait over a second is the
 * norm rather than the exception. Inside those files a `<Button>` carrying a
 * busy-ish `disabled` is flagged: `disabled` greys the control and says nothing,
 * which is the same defect docs/interaction-standards.md §4 already bans for
 * unavailable actions. Use components/common/BusyButton so the pending label
 * cannot be forgotten — it makes `pendingLabel` required.
 *
 * Only the busy-ish names are matched (`disabled={saving}`, `{busy}`, …), not
 * every `disabled`: a genuinely unavailable action — no rows selected, lapsed
 * subscription — is §4's business and must NOT grow a spinner.
 */
export function findSilentBusyButtonViolations(
  source: string,
  relPath: string,
): StandardsViolation[] {
  if (!THIRD_PARTY_SURFACES.test(relPath)) return [];

  const out: StandardsViolation[] = [];
  const re = /<Button\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const tag = sliceOpeningTag(source, m.index);
    if (!tag) continue;
    // `busy`, `saving`, `isLoading`, `actionLoading`, `submitting`, `pending`…
    if (!/\bdisabled=\{[^}]*\b\w*(?:busy|Busy|loading|Loading|saving|Saving|submitting|Submitting|pending|Pending)\w*\b[^}]*\}/.test(tag))
      continue;
    // A button that only flips local state — `onClick={() => setDisconnectOpen(true)}`
    // — opens a dialog; it does not call out, so it waits for nothing and must
    // not grow a spinner. It is still disabled during other work, which is right.
    if (/onClick=\{\(\)\s*=>\s*set[A-Z]\w*\(/.test(tag)) continue;
    if (ALLOWLIST.has(`${relPath}::silent-busy-button`)) continue;
    const line = source.slice(0, m.index).split('\n').length;
    out.push({
      file: relPath,
      line,
      rule: 'silent-busy-button',
      message:
        '<Button disabled={…busy…}> in a file that calls a third-party client. A control that only greys out for a multi-second round trip reads as a dropped click. Use components/common/BusyButton (pendingLabel is required) — see docs/interaction-standards.md §5.',
    });
  }
  return out;
}

export function scanSource(source: string, relPath: string): StandardsViolation[] {
  return [
    ...findPlaceholderViolations(source, relPath),
    ...findGreyDeleteViolations(source, relPath),
    ...findButtonColorViolations(source, relPath),
    ...findSilentBusyButtonViolations(source, relPath),
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
    // Don't flag the shared components' own internals — they ARE the fix.
    if (rel.endsWith(path.join('common', 'DeleteIconButton.tsx'))) continue;
    if (rel.endsWith(path.join('common', 'BusyButton.tsx'))) continue;
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
