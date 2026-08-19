/**
 * Scores both arms against truth.candidate.json — per-field precision and recall.
 *
 * The distinction this script exists to preserve: **absent is not missed.** Most
 * fields on most drawings are genuinely blank, and counting a correctly-empty
 * field as a miss makes both arms look far worse than they are, while counting it
 * as a hit makes both look far better. So a blank truth cell is scored as a
 * correct *rejection*, and only a non-blank truth cell can be recalled.
 *
 * The number that decides the experiment is FALSE POSITIVES — a value emitted
 * where truth says absent, or a wrong value where truth says something else. The
 * whole review UI rests on "empty rather than wrong", so an arm that lifts recall
 * by inventing values has not helped.
 *
 * CAVEAT, and it is load-bearing: truth.candidate.json is MODEL-GENERATED. Scoring
 * Arm B (a model) against a model's truth is circular and biased toward Arm B.
 * Treat every number here as provisional until the contested cells are confirmed by
 * a human — which is what --contested prints.
 *
 * Run: pnpm dlx tsx scripts/drawingCorpusTruthScore.ts [--contested]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CORPUS = join(homedir(), 'Downloads', 'jigged-drawing-corpus');
const ROLES = [
  'part_number', 'drawing_number', 'description', 'material',
  'finish', 'revision', 'weight',
] as const;
type Role = (typeof ROLES)[number];

interface ArmRow {
  source: string; tuned: boolean; file: string; structure?: string;
  fields: Partial<Record<Role, { value?: string | null }>>;
  error?: string;
}
interface TruthField { value: string | null; caption: string | null; status: 'present' | 'absent' | 'unreadable' }
interface TruthDrawing { file: string; has_title_block: boolean; note: string }
interface TruthSource {
  drawings: TruthDrawing[];
  /** Keyed by PDF filename; every drawing carries all seven roles. */
  fields: Record<string, Record<Role, TruthField>>;
}
interface TruthFile { sources: Record<string, TruthSource> }

const stem = (f: string) => f.replace(/\.(dxf|pdf)$/i, '').trim().toLowerCase();
const norm = (v: string | null | undefined) =>
  (v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Lenient equality. Drawings state the same fact in different amounts of text —
 * "3.26 KG" vs "APPROX. WEIGHT = 3.26 KG" is the same reading, and scoring the
 * shorter one wrong would measure verbosity rather than correctness.
 */
function same(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const sx = x.replace(/[^a-z0-9.]/g, '');
  const sy = y.replace(/[^a-z0-9.]/g, '');
  if (sx && sx === sy) return true;
  return sx.length >= 3 && sy.length >= 3 && (sx.includes(sy) || sy.includes(sx));
}

const truthPath = join(CORPUS, 'truth.candidate.json');
if (!existsSync(truthPath)) {
  console.error(`No ${truthPath} yet — run the truth workflow first.`);
  process.exit(1);
}
const truth: TruthFile = JSON.parse(readFileSync(truthPath, 'utf8'));
const A: ArmRow[] = JSON.parse(readFileSync(join(CORPUS, 'armA.json'), 'utf8'));
const B: ArmRow[] = JSON.parse(readFileSync(join(CORPUS, 'armB.json'), 'utf8'));

const armIndex = (rows: ArmRow[]) =>
  new Map(rows.filter((r) => !r.error).map((r) => [`${r.source}/${stem(r.file)}`, r]));
const AI = armIndex(A);
const BI = armIndex(B);
const structOf = new Map(A.map((r) => [`${r.source}/${stem(r.file)}`, r.structure ?? '?']));

type Outcome =
  | 'hit' | 'wrong' | 'miss' | 'correct_reject' | 'false_positive' | 'role_swap' | 'skipped';

interface Cell { key: string; source: string; role: Role; truth: TruthField; a: string; b: string; oa: Outcome; ob: Outcome }

/**
 * `role_swap` is NOT a false positive, and separating it is what keeps this
 * comparison honest. The rt-net sheets print a part name in an UNCAPTIONED cell.
 * Truth is read from the PDF, so it can only call that a description. Arm A reads
 * the DXF, where the attribute is literally tagged 部品番号 — "part number" — and
 * files it there. Both point at the same characters; only the label differs, and
 * Arm A is arguably the better informed of the two. Counting those 11 cells as
 * invented values understated Arm A's precision by more than thirty points.
 */
function judge(t: TruthField, got: string, allRoles: Partial<Record<Role, TruthField>>): Outcome {
  if (t.status === 'unreadable') return 'skipped';
  if (t.status === 'absent' || !t.value) {
    if (!got) return 'correct_reject';
    const elsewhere = ROLES.some((r) => {
      const other = allRoles[r];
      return other?.status === 'present' && other.value && same(other.value, got);
    });
    return elsewhere ? 'role_swap' : 'false_positive';
  }
  if (!got) return 'miss';
  return same(t.value, got) ? 'hit' : 'wrong';
}

const cells: Cell[] = [];
/**
 * Sheets where truth records NO field in any role. Deliberately NOT
 * `has_title_block: false` — those are different sets. `bitbyt3r__light-fixture`
 * has no title block at all yet still names its stock as a free leader note, so
 * six blockless sheets do carry a field. Only the all-absent sheets are a pure
 * precision test.
 */
const blankSheets = new Set<string>();
let unmatched = 0;
for (const [source, blk] of Object.entries(truth.sources ?? {})) {
  for (const d of blk.drawings ?? []) {
    const key = `${source}/${stem(d.file)}`;
    const a = AI.get(key);
    const b = BI.get(key);
    if (!a && !b) { unmatched += 1; continue; }
    const roles = blk.fields?.[d.file] ?? blk.fields?.[stem(d.file)];
    if (ROLES.every((r) => (roles?.[r]?.status ?? 'absent') !== 'present')) blankSheets.add(key);
    for (const role of ROLES) {
      const t = roles?.[role] ?? { value: null, caption: null, status: 'absent' as const };
      const av = norm(a?.fields?.[role]?.value ?? '') ? String(a!.fields[role]!.value) : '';
      const bv = norm(b?.fields?.[role]?.value ?? '') ? String(b!.fields[role]!.value) : '';
      cells.push({
        key, source, role, truth: t, a: av, b: bv,
        oa: a ? judge(t, av, roles ?? {}) : 'skipped',
        ob: b ? judge(t, bv, roles ?? {}) : 'skipped',
      });
    }
  }
}

function stats(sub: Cell[], arm: 'oa' | 'ob') {
  const c = (o: Outcome) => sub.filter((x) => x[arm] === o).length;
  const hit = c('hit'), wrong = c('wrong'), miss = c('miss');
  const fp = c('false_positive'), cr = c('correct_reject'), swap = c('role_swap');
  // A role swap is excluded from both numerator and denominator: the value is
  // real, so calling it a false positive is wrong, but the role is disputed, so
  // calling it a hit would be generous.
  const emitted = hit + wrong + fp;
  const present = hit + wrong + miss;
  return {
    hit, wrong, miss, fp, cr, swap, emitted, present,
    precision: emitted ? hit / emitted : null,
    recall: present ? hit / present : null,
    // Every value the arm put on screen that a human would have to delete.
    fpRate: emitted ? (wrong + fp) / emitted : null,
  };
}

const pc = (v: number | null) => (v === null ? '  –  ' : `${(100 * v).toFixed(0)}%`.padStart(5));
const scored = cells.filter((x) => x.oa !== 'skipped' && x.ob !== 'skipped');

function table(label: string, sub: Cell[]) {
  if (!sub.length) return '';
  let out = `\n### ${label}  (${new Set(sub.map((s) => s.key)).size} drawings, ${sub.length} field slots)\n\n`;
  out += '| field | truth present | A hit | A wrong | A miss | A false-pos | A prec | A rec | B hit | B wrong | B miss | B false-pos | B prec | B rec |\n';
  out += '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n';
  for (const role of ROLES) {
    const r = sub.filter((s) => s.role === role);
    if (!r.length) continue;
    const a = stats(r, 'oa');
    const b = stats(r, 'ob');
    out += `| ${role} | ${a.present} | ${a.hit} | ${a.wrong} | ${a.miss} | ${a.fp} | ${pc(a.precision)} | ${pc(a.recall)} | ${b.hit} | ${b.wrong} | ${b.miss} | ${b.fp} | ${pc(b.precision)} | ${pc(b.recall)} |\n`;
  }
  const a = stats(sub, 'oa');
  const b = stats(sub, 'ob');
  out += `| **ALL** | **${a.present}** | **${a.hit}** | **${a.wrong}** | **${a.miss}** | **${a.fp}** | **${pc(a.precision)}** | **${pc(a.recall)}** | **${b.hit}** | **${b.wrong}** | **${b.miss}** | **${b.fp}** | **${pc(b.precision)}** | **${pc(b.recall)}** |\n`;
  return out;
}

const all = stats(scored, 'oa');
const allB = stats(scored, 'ob');
const recallLift = (allB.recall ?? 0) - (all.recall ?? 0);
const fpLift = (allB.fpRate ?? 0) - (all.fpRate ?? 0);
const verdict =
  recallLift >= 0.15 && fpLift <= 0
    ? 'ARM B SHIPS — recall lift ≥15pp with no increase in false-positive rate.'
    : recallLift >= 0.15
      ? 'ARM B FAILS THE RULE — it lifts recall but also raises the false-positive rate.'
      : 'ARM B FAILS THE RULE — recall lift is below the 15pp bar.';

const md = `# Scored against candidate truth — untuned drawings

> **Truth here is MODEL-GENERATED** (\`truth.candidate.json\`), produced by a reader agent per source
> plus an adversarial second pass. Scoring Arm B — itself a model — against it is circular and biased
> **in Arm B's favour**. Every number below is provisional until the contested cells are confirmed by
> a human. Run with \`--contested\` to print exactly which cells those are.

- Field slots scored: **${scored.length}** (both arms present; ${cells.length - scored.length} skipped)
- Drawings with no match in an arm's output: ${unmatched}

## The pre-stated decision rule

> Arm B ships only if, on the untuned drawings, it lifts per-field recall by **≥15 percentage points**
> without increasing the false-positive rate.

| | Arm A | Arm B | delta |
|---|---|---|---|
| recall | ${pc(all.recall)} | ${pc(allB.recall)} | ${((recallLift) * 100).toFixed(1)}pp |
| precision | ${pc(all.precision)} | ${pc(allB.precision)} | ${(((allB.precision ?? 0) - (all.precision ?? 0)) * 100).toFixed(1)}pp |
| false-positive rate | ${pc(all.fpRate)} | ${pc(allB.fpRate)} | ${((fpLift) * 100).toFixed(1)}pp |
| role swaps (excluded) | ${all.swap} | ${allB.swap} | |

**${verdict}**

Role swaps are cells where the arm reported a string truth records under a DIFFERENT role on the
same drawing. They are excluded from precision and recall rather than counted against either arm —
the value is real, but which field it belongs to is genuinely disputed. Counting them as invented
values is what made Arm A look far less precise than it is.

## Per-field
${table('All untuned', scored)}
${['named_tags', 'exploded', 'auto_tags']
  .map((s) => table(`structure: ${s}`, scored.filter((c) => structOf.get(c.key) === s)))
  .join('')}
## The precision test — sheets that carry NO field at all

${blankSheets.size} sheets have nothing to find: truth records every one of the seven roles as absent.
Nothing can be recalled, so **every value reported here is a false positive**. This is the cleanest
measure of "empty rather than wrong", and it is the number the review UI depends on.

Note this is a smaller set than "sheets with no title block" — \`bitbyt3r__light-fixture\` has no block
whatsoever yet still names its stock as a free leader note, so a blockless sheet is not a blank one.

| | Arm A | Arm B |
|---|---|---|
${(() => {
  const sub = scored.filter((c) => blankSheets.has(c.key));
  const a = stats(sub, 'oa');
  const b = stats(sub, 'ob');
  return `| values emitted | ${a.emitted} | ${b.emitted} |\n| correctly silent | ${a.cr} | ${b.cr} |`;
})()}

${(() => {
  const bad = scored.filter(
    (c) => blankSheets.has(c.key) && (c.oa === 'false_positive' || c.ob === 'false_positive'),
  );
  if (!bad.length) return '_Neither arm emitted anything on a blank sheet._';
  return `| drawing | field | arm | emitted |\n|---|---|---|---|\n${bad
    .flatMap((c) => [
      ...(c.oa === 'false_positive' ? [`| \`${c.key}\` | ${c.role} | A | ${c.a} |`] : []),
      ...(c.ob === 'false_positive' ? [`| \`${c.key}\` | ${c.role} | B | ${c.b} |`] : []),
    ])
    .join('\n')}`;
})()}

## Where the two arms disagree about a field truth says is PRESENT

These are the cells worth a human eye first — truth says there is something there, and the arms
do not agree on what.

| drawing | field | truth | Arm A | Arm B |
|---|---|---|---|---|
${scored
  .filter((c) => c.truth.status === 'present' && c.truth.value && !same(c.a, c.b))
  .slice(0, 60)
  .map((c) => `| \`${c.key}\` | ${c.role} | ${c.truth.value} | ${c.a || '—'} | ${c.b || '—'} |`)
  .join('\n') || '| _none_ | | | | |'}

## False positives — a value emitted where truth says the field is absent

The class that matters most. Every row here is something a user would have to notice and delete.

| drawing | field | arm | emitted |
|---|---|---|---|
${scored
  .flatMap((c) => [
    ...(c.oa === 'false_positive' ? [`| \`${c.key}\` | ${c.role} | A | ${c.a} |`] : []),
    ...(c.ob === 'false_positive' ? [`| \`${c.key}\` | ${c.role} | B | ${c.b} |`] : []),
  ])
  .slice(0, 80)
  .join('\n') || '| _none_ | | | |'}
`;

writeFileSync(join(CORPUS, 'truth-scored.md'), md);

if (process.argv.includes('--contested')) {
  const contested = scored.filter(
    (c) => c.oa !== c.ob || (c.truth.status === 'present' && (c.oa === 'wrong' || c.ob === 'wrong')),
  );
  console.log(`\nCONTESTED CELLS NEEDING HUMAN CONFIRMATION: ${contested.length}\n`);
  for (const c of contested) {
    console.log(
      `${c.key}\n   ${c.role}: truth=${JSON.stringify(c.truth.value)} [${c.truth.status}]  A=${JSON.stringify(c.a)} (${c.oa})  B=${JSON.stringify(c.b)} (${c.ob})`,
    );
  }
}

console.log(md.split('## Per-field')[0]);
console.log(`Wrote ${join(CORPUS, 'truth-scored.md')}`);
