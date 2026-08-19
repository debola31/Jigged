/**
 * Arm B of the drawing-extraction experiment — deterministic + AI.
 *
 * The point of this arm is NOT "ask a model to read a drawing". It is to test a
 * specific hybrid: the deterministic pass supplies the drawing's LITERAL strings
 * and their coordinates, and the model only has to say which string plays which
 * role. It never transcribes, so the failure mode the published benchmarks
 * punish (title-block F1 0.533 with a 0.478 hallucination rate on raw raster)
 * is largely designed out — and every returned value is checked back against the
 * bag, so a fabricated one is detectable rather than merely unlikely.
 *
 * The dictionary owns the field names. The model is never asked to invent one.
 *
 * Run:  pnpm dlx tsx scripts/drawingCorpusArmB.ts [--model=ID] [--niche] [--no-pdf] [--out=FILE] [limit]
 * Out:  ~/Downloads/jigged-drawing-corpus/armB[.MODEL].json
 *
 *   --niche   restrict to sources resembling the parts a precision shop quotes
 *   --no-pdf  send only the DXF strings, no rendered page — isolates how much of
 *             the model's advantage needs the image at all
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { extractDxfText, decodeDxfBytes } from '../lib/dxfTextExtract';

const CORPUS = join(homedir(), 'Downloads', 'jigged-drawing-corpus');
const CUSTOMER = join(homedir(), 'Downloads', 'PARTS PACKAGE FOR DATA ENTRY FROM PRINTS');
const MAX_PDF_BYTES = 3_000_000;

/**
 * Sources whose drawings resemble the parts a small precision shop actually
 * quotes: machined or fabricated metal, carrying a title block of some kind.
 *
 * The rest of the corpus is deliberately hostile input — bare-geometry panels,
 * a PCB solar tracker, a French art installation — and it was assembled to BREAK
 * the extractor, not to represent the customer base. Scoring on it answers
 * "how robust is this", which is a different question from "what will a shop
 * see", and the two must not be reported as one number.
 */
const NICHE_SOURCES = new Set([
  'customer-sw-technology',
  'SkyentificGit__SmallRobotArm',
  'Stephen-Arsenault__HDI-45',
  'rt-net__crane_x7_Hardware',
  'rt-net__sciurus17_Hardware',
  'hgrobotics__pinto-robot',
  'pwnage101__cargo_bike',
]);

interface Args { model: string; out: string; niche: boolean; noPdf: boolean; limit: number }

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  const has = (name: string) => argv.includes(`--${name}`);
  const model = flag('model') ?? 'claude-opus-5';
  return {
    model,
    // Default output is keyed by model so two runs never overwrite each other.
    out: flag('out') ?? (model === 'claude-opus-5' ? 'armB.json' : `armB.${model}.json`),
    niche: has('niche'),
    noPdf: has('no-pdf'),
    limit: Number(argv.find((a) => /^\d+$/.test(a)) ?? '0') || Infinity,
  };
}

function apiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const env = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
  const m = env.match(/^ANTHROPIC_API_KEY\s*=\s*"?([^"\n\r]+)"?/m);
  if (!m) throw new Error('ANTHROPIC_API_KEY not found in env or .env.local');
  return m[1].trim();
}

const ROLES = [
  'part_number', 'drawing_number', 'description', 'material',
  'finish', 'revision', 'weight',
] as const;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['fields'],
  properties: {
    fields: {
      type: 'object',
      additionalProperties: false,
      required: [...ROLES],
      properties: Object.fromEntries(
        ROLES.map((r) => [
          r,
          {
            type: 'object',
            additionalProperties: false,
            required: ['value', 'caption'],
            properties: {
              value: { type: ['string', 'null'], description: 'Exact string from the list, or null' },
              caption: { type: ['string', 'null'], description: 'The printed caption, or null' },
            },
          },
        ]),
      ),
    },
  },
} as const;

const PROMPT = `You are reading the title block of an engineering drawing.

You are given (a) the drawing itself and (b) the COMPLETE list of text strings that appear on it, taken directly from the CAD file, each with its position and text height.

Your job is ASSIGNMENT, not transcription. For each field below, choose which of the supplied strings is its value — or null if the drawing genuinely does not state it.

RULES, in order of importance:
1. A value MUST be copied character-for-character from the supplied list. Never re-type, correct, complete or normalise it. If the right value is not in the list, return null.
2. Return null freely. Most drawings leave most fields blank, and a blank is correct. A wrong value is far worse than a missing one.
3. Do not infer a value from the filename, from the geometry, or from what would be reasonable. Only from what is printed.
4. A caption alone is not a value. If "MATERIAL:" is printed but no material follows it, that field is null.
5. Some strings fuse a caption to its value ("SCALE:20:1"). In that case return the whole string as the value.
6. A revision is a short letter or code from a revision block. Sheet-border grid labels (single digits or letters around the frame edge) are never field values.

Also report the printed caption you read each value against, or null if the drawing has no caption for it (some drawings print a value with no label at all — that is common and worth recording).

Fields: part_number, drawing_number, description, material, finish, revision, weight.`;

interface Item {
  text: string;
  x: number;
  y: number;
  height: number;
}
/**
 * How closely a returned value matches text actually in the file.
 *   exact     — a whole text entity, character for character
 *   substring — inside one, e.g. the "STOCK: ..." line trimmed out of a
 *               multi-line MTEXT block. Legitimate, and the strict check used to
 *               flag it as invention.
 *   variant   — matches once glyphs are folded (⌀ vs Ø) or whitespace collapsed.
 *               Faithful in substance, re-typed in form.
 *   ghost     — not in the file at all. The only real hallucination.
 */
type Fidelity = 'exact' | 'substring' | 'variant' | 'ghost';

interface ArmBRow {
  source: string;
  tuned: boolean;
  file: string;
  fields: Record<string, { value: string | null; caption: string | null; fidelity: Fidelity }>;
  usage?: { input: number; output: number };
  error?: string;
}

const foldGlyphs = (s: string) =>
  s.normalize('NFKC').replace(/[⌀Ø∅]/g, 'D').replace(/\s+/g, ' ').trim().toLowerCase();

function fidelityOf(value: string, bag: string[]): Fidelity {
  if (bag.includes(value)) return 'exact';
  if (bag.some((b) => b.includes(value))) return 'substring';
  const v = foldGlyphs(value);
  if (bag.some((b) => foldGlyphs(b).includes(v))) return 'variant';
  return 'ghost';
}

/** Bottom-right corner of the sheet — the region ISO 5457 puts the title block in. */
function corner(items: Item[]): Item[] {
  if (!items.length) return [];
  const xs = items.map((i) => i.x);
  const ys = items.map((i) => i.y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const w = Math.max(...xs) - x0 || 1;
  const h = Math.max(...ys) - y0 || 1;
  const inCorner = items.filter((i) => i.x > x0 + 0.4 * w && i.y < y0 + 0.35 * h);
  // Some drawings put their strip across the full width; fall back to everything
  // rather than hand the model an empty list.
  return inCorner.length >= 4 ? inCorner : items;
}

async function ask(pdf: Buffer | null, items: Item[], key: string, model: string) {
  const bag = corner(items)
    .slice(0, 200)
    .map((i) => `${JSON.stringify(i.text)} @(${i.x.toFixed(0)},${i.y.toFixed(0)}) h=${i.height.toFixed(1)}`)
    .join('\n');

  const content: unknown[] = [];
  if (pdf) {
    content.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') },
    });
  }
  content.push({ type: 'text', text: `${PROMPT}\n\nSTRINGS ON THIS DRAWING:\n${bag}` });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      // 8192, not 2048. At 2048 Sonnet 5 truncated on 13 of 63 niche drawings —
      // it reasons at length before emitting the JSON, so the response died
      // mid-object and scored as "found nothing". That is a harness bug wearing
      // the costume of a model-quality result, and it made the cheaper model look
      // better. Every model must run at the same limit for the comparison to mean
      // anything. Sonnet 4.6 never exceeded 168 output tokens, so this costs it
      // nothing.
      max_tokens: 8192,
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content }],
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  if (body.stop_reason === 'refusal') throw new Error('refusal');
  const text = body.content.find((b: { type: string }) => b.type === 'text')?.text ?? '{}';
  return { parsed: JSON.parse(text), usage: body.usage };
}

/* ---------------------------------------------------------------- */

async function main() {
  const key = apiKey();
  const args = parseArgs();

  interface Job { dir: string; source: string; tuned: boolean; file: string }
  const jobs: Job[] = [];
  const push = (dir: string, source: string, tuned: boolean) => {
    if (!existsSync(dir)) return;
    if (args.niche && !NICHE_SOURCES.has(source)) return;
    for (const f of readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.dxf'))) {
      jobs.push({ dir, source, tuned, file: f });
    }
  };
  push(CUSTOMER, 'customer-sw-technology', true);
  for (const d of readdirSync(CORPUS).filter((d) => statSync(join(CORPUS, d)).isDirectory())) {
    push(join(CORPUS, d), d, false);
  }

  const selected = jobs.slice(0, args.limit);

  // Resume: a run that dies partway (credit exhaustion, network) must not make us
  // pay a second time for the drawings it already got. Only SUCCESSFUL rows are
  // kept — an errored row is retried.
  const outPath = join(CORPUS, args.out);
  const previous: ArmBRow[] = existsSync(outPath)
    ? JSON.parse(readFileSync(outPath, 'utf8'))
    : [];
  const keep = new Map(
    previous.filter((r) => !r.error).map((r) => [`${r.source}/${r.file}`, r]),
  );

  const cachedInSelection = selected.filter((j) => keep.has(`${j.source}/${j.file}`)).length;
  console.log(`Arm B — ${args.model}${args.niche ? ' — NICHE ONLY' : ''}${args.noPdf ? ' — NO PDF' : ''} — ${selected.length} drawings`);
  if (cachedInSelection) {
    console.log(`resuming: ${cachedInSelection} cached, ${selected.length - cachedInSelection} to fetch`);
  }
  console.log('');

  const out: ArmBRow[] = [];
  let done = 0;

  /**
   * Writes selection + everything already done that this selection does not cover.
   * Without the merge, running with a `limit` would truncate the file to the
   * slice and throw away results we paid for.
   */
  const selectedKeys = new Set(selected.map((j) => `${j.source}/${j.file}`));
  const save = () => {
    const untouched = previous.filter(
      (r) => !r.error && !selectedKeys.has(`${r.source}/${r.file}`),
    );
    writeFileSync(outPath, JSON.stringify([...out, ...untouched], null, 1));
  };

  for (const j of selected) {
    const cached = keep.get(`${j.source}/${j.file}`);
    if (cached) {
      out.push(cached);
      done += 1;
      continue;
    }
    const dxfPath = join(j.dir, j.file);
    const pdfPath = dxfPath.replace(/\.dxf$/i, '.pdf');
    const row: ArmBRow = { source: j.source, tuned: j.tuned, file: j.file, fields: {} };
    try {
      const items = extractDxfText(decodeDxfBytes(readFileSync(dxfPath)));
      let pdf: Buffer | null = null;
      if (!args.noPdf && existsSync(pdfPath) && statSync(pdfPath).size <= MAX_PDF_BYTES) {
        pdf = readFileSync(pdfPath);
      }

      const { parsed, usage } = await ask(pdf, items, key, args.model);
      const bag = items.map((i) => i.text.trim());
      for (const r of ROLES) {
        const got = parsed.fields?.[r] ?? { value: null, caption: null };
        const v = got.value == null ? null : String(got.value).trim();
        row.fields[r] = {
          value: v || null,
          caption: got.caption ?? null,
          // The load-bearing check: did the model return something the drawing
          // actually contains, or did it invent one?
          fidelity: v ? fidelityOf(v, bag) : 'exact',
        };
      }
      row.usage = { input: usage.input_tokens, output: usage.output_tokens };
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err);
    }
    out.push(row);
    done += 1;
    if (done % 5 === 0 || done === selected.length) {
      console.log(`  ${done}/${selected.length}`);
      save();
    }
  }

  save();

  const errs = out.filter((r) => r.error);
  const inTok = out.reduce((a, r) => a + (r.usage?.input ?? 0), 0);
  const outTok = out.reduce((a, r) => a + (r.usage?.output ?? 0), 0);
  const fid = out.flatMap((r) =>
    Object.entries(r.fields).filter(([, f]) => f.value).map(([, f]) => f.fidelity),
  );
  const count = (k: Fidelity) => fid.filter((x) => x === k).length;

  console.log(`\nerrors: ${errs.length}`);
  if (errs.length) console.log(`  e.g. ${errs[0].error?.slice(0, 160)}`);
  console.log(`tokens: ${inTok} in / ${outTok} out`);
  // Published per-million rates, in/out. Kept beside the run so a cost figure is
  // never quoted at the wrong model's price.
  const RATES: Record<string, [number, number]> = {
    'claude-opus-5': [5, 25],
    'claude-sonnet-5': [3, 15],
    'claude-sonnet-4-6': [3, 15],
    'claude-haiku-4-5-20251001': [1, 5],
  };
  const [rIn, rOut] = RATES[args.model] ?? [0, 0];
  const cost = (inTok / 1e6) * rIn + (outTok / 1e6) * rOut;
  console.log(
    rIn
      ? `cost:   ~$${cost.toFixed(2)} at ${args.model} rates ($${rIn}/$${rOut} per M)`
      : `cost:   unknown rates for ${args.model}`,
  );
  console.log(`per drawing: ${Math.round(inTok / out.length)} in / ${Math.round(outTok / out.length)} out` + (rIn ? `  ~$${(cost / out.length).toFixed(4)}` : ''));
  console.log(
    `fidelity: ${count('exact')} exact / ${count('substring')} substring / ` +
      `${count('variant')} glyph-variant / ${count('ghost')} GHOST (invented)`,
  );
  console.log(`\nWrote ${outPath}`);

}

void main();
