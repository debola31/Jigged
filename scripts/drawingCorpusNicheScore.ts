/**
 * Niche-only comparison: deterministic (Arm A) vs deterministic+AI, across models.
 *
 * WHY A SEPARATE SCORER
 * The full corpus was assembled adversarially — bare-geometry panels, a PCB solar
 * tracker, an art installation — to BREAK the extractor. Scoring on it answers
 * "how robust is this". It does NOT answer "what will a small precision shop
 * see", and reporting one number for both questions is how a measurement misleads.
 * This script answers only the second question.
 *
 * Truth comes from two files, both MODEL-GENERATED and neither hand-checked:
 *   truth.candidate.json  — the 32 niche drawings inside the public corpus
 *   truth.customer.json   — customer #2's 31-drawing package
 * Scoring an AI arm against a model's truth is circular and favours the AI arms.
 * The customer package carries an independent check the corpus cannot: its
 * FILENAMES encode part number and drawing number, so those two columns are
 * objective regardless of what any model said.
 *
 * Run: pnpm dlx tsx scripts/drawingCorpusNicheScore.ts
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CORPUS = join(homedir(), 'Downloads', 'jigged-drawing-corpus');
const ROLES = [
  'part_number', 'drawing_number', 'description', 'material',
  'finish', 'revision', 'weight',
] as const;
type Role = (typeof ROLES)[number];

const NICHE = new Set([
  'customer-sw-technology',
  'SkyentificGit__SmallRobotArm',
  'Stephen-Arsenault__HDI-45',
  'rt-net__crane_x7_Hardware',
  'rt-net__sciurus17_Hardware',
  'hgrobotics__pinto-robot',
  'pwnage101__cargo_bike',
]);

interface ArmRow {
  source: string; tuned: boolean; file: string; structure?: string;
  fields: Partial<Record<Role, { value?: string | null }>>;
  usage?: { input: number; output: number };
  error?: string;
}
interface TruthField { value: string | null; caption: string | null; status: string }
interface TruthSrc {
  drawings: Array<{ file: string; has_title_block: boolean; note: string }>;
  fields: Record<string, Record<Role, TruthField>>;
}

const stem = (f: string) => f.replace(/\.(dxf|pdf)$/i, '').trim().toLowerCase();
/**
 * Folds the diameter glyphs to one character before comparing. CAD files encode
 * it as `%%c`, our MTEXT decoder emits `Ø`, and a model may return `⌀` (U+2300) —
 * three spellings of the same symbol. Without folding, `Ø37.0 X 1.6 4130 tube`
 * and `⌀37.0 X 1.6 4130 tube` score as different values.
 */
const norm = (v: string | null | undefined) =>
  (v ?? '').normalize('NFKC').replace(/[⌀Ø∅]/g, 'D').trim().replace(/\s+/g, ' ').toLowerCase();

function same(a: string, b: string): boolean {
  const x = norm(a); const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const sx = x.replace(/[^a-z0-9.]/g, ''); const sy = y.replace(/[^a-z0-9.]/g, '');
  if (sx && sx === sy) return true;
  return sx.length >= 3 && sy.length >= 3 && (sx.includes(sy) || sy.includes(sx));
}

/* ------------------------------ truth ------------------------------ */

const truth: Record<string, TruthSrc> = {};
for (const f of ['truth.candidate.json', 'truth.customer.json']) {
  const p = join(CORPUS, f);
  if (!existsSync(p)) { console.error(`missing ${f} — skipping`); continue; }
  const parsed = JSON.parse(readFileSync(p, 'utf8'));
  for (const [k, v] of Object.entries(parsed.sources ?? {})) {
    if (NICHE.has(k)) truth[k] = v as TruthSrc;
  }
}
if (!Object.keys(truth).length) { console.error('no niche truth found'); process.exit(1); }

/* ------------------------------- arms ------------------------------ */

interface Arm { name: string; rows: Map<string, ArmRow>; usage: { input: number; output: number } }

function loadArm(name: string, file: string): Arm | null {
  const p = join(CORPUS, file);
  if (!existsSync(p)) return null;
  const rows: ArmRow[] = JSON.parse(readFileSync(p, 'utf8'));
  const ok = rows.filter((r) => !r.error && NICHE.has(r.source));
  return {
    name,
    rows: new Map(ok.map((r) => [`${r.source}/${stem(r.file)}`, r])),
    usage: ok.reduce(
      (a, r) => ({ input: a.input + (r.usage?.input ?? 0), output: a.output + (r.usage?.output ?? 0) }),
      { input: 0, output: 0 },
    ),
  };
}

const arms: Arm[] = [loadArm('A · deterministic', 'armA.json')!];
for (const f of readdirSync(CORPUS).filter((f) => /^armB[.\w-]*\.json$/.test(f)).sort()) {
  const model = f === 'armB.json' ? 'claude-opus-5' : f.replace(/^armB\./, '').replace(/\.json$/, '');
  const arm = loadArm(`B · ${model}`, f);
  if (arm?.rows.size) arms.push(arm);
}

/* ------------------------------ scoring ---------------------------- */

type Outcome = 'hit' | 'wrong' | 'miss' | 'correct_reject' | 'false_positive' | 'role_swap';

function judge(t: TruthField, got: string, all: Partial<Record<Role, TruthField>>): Outcome {
  if (t.status !== 'present' || !t.value) {
    if (!got) return 'correct_reject';
    const elsewhere = ROLES.some((r) => {
      const o = all[r];
      return o?.status === 'present' && o.value && same(o.value, got);
    });
    return elsewhere ? 'role_swap' : 'false_positive';
  }
  if (!got) return 'miss';
  return same(t.value, got) ? 'hit' : 'wrong';
}

interface Tally { hit: number; wrong: number; miss: number; fp: number; swap: number; cr: number }
const blank = (): Tally => ({ hit: 0, wrong: 0, miss: 0, fp: 0, swap: 0, cr: 0 });

/** Only drawings EVERY arm produced a row for, so the arms are compared like for like. */
const universe: string[] = [];
for (const [src, blk] of Object.entries(truth)) {
  for (const d of blk.drawings ?? []) {
    const key = `${src}/${stem(d.file)}`;
    if (arms.every((a) => a.rows.has(key))) universe.push(key);
  }
}

function tally(arm: Arm, keys: string[], role?: Role): Tally {
  const t = blank();
  for (const key of keys) {
    const [src, ...rest] = key.split('/');
    const st = rest.join('/');
    const blk = truth[src];
    const file = (blk.drawings ?? []).find((d) => stem(d.file) === st)?.file;
    const all: Partial<Record<Role, TruthField>> = (file && blk.fields?.[file]) || {};
    const row = arm.rows.get(key);
    if (!row) continue;
    for (const r of role ? [role] : ROLES) {
      const tf = all[r] ?? { value: null, caption: null, status: 'absent' };
      const got = String(row.fields?.[r]?.value ?? '').trim();
      t[({ hit: 'hit', wrong: 'wrong', miss: 'miss', correct_reject: 'cr', false_positive: 'fp', role_swap: 'swap' } as const)[
        judge(tf, got, all)
      ]] += 1;
    }
  }
  return t;
}

const prec = (t: Tally) => (t.hit + t.wrong + t.fp ? t.hit / (t.hit + t.wrong + t.fp) : null);
const rec = (t: Tally) => (t.hit + t.wrong + t.miss ? t.hit / (t.hit + t.wrong + t.miss) : null);
const pc = (v: number | null) => (v === null ? '–' : `${Math.round(100 * v)}%`);

const RATES: Record<string, [number, number]> = {
  'claude-opus-5': [5, 25], 'claude-sonnet-5': [3, 15],
  'claude-sonnet-4-6': [3, 15], 'claude-haiku-4-5-20251001': [1, 5],
};
function cost(arm: Arm, n: number) {
  const model = arm.name.replace(/^B · /, '');
  const r = RATES[model];
  if (!r || !arm.usage.input) return '—';
  const total = (arm.usage.input / 1e6) * r[0] + (arm.usage.output / 1e6) * r[1];
  return `$${(total / n).toFixed(4)}`;
}

const customerKeys = universe.filter((k) => k.startsWith('customer-sw-technology/'));
const publicKeys = universe.filter((k) => !k.startsWith('customer-sw-technology/'));

/** Filenames encode both identifiers — objective, independent of any model. */
function filenameCheck(arm: Arm) {
  let pn = 0; let dn = 0;
  for (const key of customerKeys) {
    const row = arm.rows.get(key)!;
    const s = row.file.replace(/\.dxf$/i, '');
    const wantPn = s.split('-_')[0];
    const wantDn = s.replace(/^[^-]*-_/, '').replace(/-0000$/, '');
    if (String(row.fields.part_number?.value ?? '') === wantPn) pn += 1;
    if (String(row.fields.drawing_number?.value ?? '') === wantDn) dn += 1;
  }
  return { pn, dn, n: customerKeys.length };
}

function block(label: string, keys: string[]) {
  if (!keys.length) return '';
  let out = `\n### ${label} — ${keys.length} drawings\n\n`;
  out += '| arm | recall | precision | hit | wrong | miss | false-pos | role-swap | $/drawing |\n|---|---|---|---|---|---|---|---|---|\n';
  for (const arm of arms) {
    const t = tally(arm, keys);
    out += `| ${arm.name} | **${pc(rec(t))}** | ${pc(prec(t))} | ${t.hit} | ${t.wrong} | ${t.miss} | ${t.fp} | ${t.swap} | ${cost(arm, keys.length)} |\n`;
  }
  out += '\n| field | ' + arms.map((a) => `${a.name} rec`).join(' | ') + ' |\n|---|' + arms.map(() => '---').join('|') + '|\n';
  for (const r of ROLES) {
    const cells = arms.map((a) => {
      const t = tally(a, keys, r);
      return t.hit + t.wrong + t.miss === 0 ? '–' : pc(rec(t));
    });
    if (cells.every((c) => c === '–')) continue;
    out += `| ${r} | ${cells.join(' | ')} |\n`;
  }
  return out;
}

const md = `# Niche-only: deterministic vs deterministic + AI

> Scored ONLY on drawings resembling what a small precision shop quotes — machined or fabricated
> metal carrying a title block. The rest of the corpus was assembled adversarially to break the
> extractor and is excluded here on purpose.
>
> **Truth is model-generated and not hand-checked**, so the AI arms are flattered. The customer
> package's identifier columns are the exception — those come from the filenames.

Arms compared: ${arms.map((a) => a.name).join(', ')}.
Drawings every arm covered: **${universe.length}**.

## Objective check — customer package identifiers from filenames

No model involved on either side of this comparison.

| arm | part_number | drawing_number |
|---|---|---|
${arms.map((a) => { const f = filenameCheck(a); return `| ${a.name} | ${f.pn}/${f.n} | ${f.dn}/${f.n} |`; }).join('\n')}
${block('Customer package (real commercial machined parts)', customerKeys)}
${block('Public niche drawings', publicKeys)}
${block('All niche drawings', universe)}
`;

writeFileSync(join(CORPUS, 'niche-scored.md'), md);
console.log(md);
console.log(`Wrote ${join(CORPUS, 'niche-scored.md')}`);
