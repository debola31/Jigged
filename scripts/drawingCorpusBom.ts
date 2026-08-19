/**
 * BOM (cut-list) arm — deterministic vs deterministic + AI.
 *
 * The title-block experiment measured seven scalar fields. This measures the
 * TABLE, which is a different problem: not "which string plays which role" but
 * "which strings form a row".
 *
 * THE TEST THAT MATTERS IS PRECISION, NOT RECALL. Only 2 of the 31 customer
 * drawings carry a BOM at all, so the interesting question is not whether a model
 * can read those two — it is whether it invents a table on the other 29. A
 * fabricated bill of materials silently creates parts that do not exist, which is
 * far worse than missing one.
 *
 * Run: pnpm dlx tsx scripts/drawingCorpusBom.ts [--model=ID]
 * Out: ~/Downloads/jigged-drawing-corpus/bom.MODEL.json
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { extractDxfText, decodeDxfBytes } from '../lib/dxfTextExtract';
import { extractCutList } from '../lib/drawingCutList';

const CORPUS = join(homedir(), 'Downloads', 'jigged-drawing-corpus');
const CUSTOMER = join(homedir(), 'Downloads', 'PARTS PACKAGE FOR DATA ENTRY FROM PRINTS');
const MAX_PDF_BYTES = 3_000_000;

const argv = process.argv.slice(2);
const MODEL = argv.find((a) => a.startsWith('--model='))?.split('=')[1] ?? 'claude-sonnet-4-6';

function apiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const env = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
  const m = env.match(/^ANTHROPIC_API_KEY\s*=\s*"?([^"\n\r]+)"?/m);
  if (!m) throw new Error('ANTHROPIC_API_KEY not found');
  return m[1].trim();
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['has_table', 'rows'],
  properties: {
    has_table: { type: 'boolean' },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'quantity', 'description', 'length', 'material'],
        properties: {
          item: { type: ['string', 'null'] },
          quantity: { type: ['string', 'null'] },
          description: { type: ['string', 'null'] },
          length: { type: ['string', 'null'] },
          material: { type: ['string', 'null'] },
        },
      },
    },
  },
} as const;

const PROMPT = `You are reading an engineering drawing to find its BILL OF MATERIALS — the parts table a weldment drawing carries, sometimes headed "cut list".

You are given (a) the drawing and (b) the COMPLETE list of text strings on it from the CAD file, each with position and text height.

MOST DRAWINGS HAVE NO SUCH TABLE. A single machined part is drawn with dimensions and a title block and nothing else. If there is no parts table, set has_table false and return an empty rows array. That is the correct and common answer — do not manufacture a table out of dimensions, tolerance blocks, revision history, or general notes.

If there IS a table, return one entry per row, copying each cell character-for-character from the supplied strings. Never re-type or normalise. Use null for a cell the row leaves blank.

Do not include the header row itself as a row.

A row whose LENGTH cell is blank is a part made from its own drawing rather than stock cut to length — still return it, with length null.`;

interface Row { item: string | null; quantity: string | null; description: string | null; length: string | null; material: string | null }
interface Out {
  file: string;
  deterministic: { hasTable: boolean; rows: number; descriptions: string[] };
  ai: { hasTable: boolean; rows: Row[]; ghostCells: string[] };
  usage?: { input: number; output: number };
  error?: string;
}

async function ask(pdf: Buffer | null, bag: string, key: string) {
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
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8192,
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content }],
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const text = body.content.find((b: { type: string }) => b.type === 'text')?.text ?? '{}';
  return { parsed: JSON.parse(text), usage: body.usage };
}

const fold = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

async function main() {
  const key = apiKey();
  const files = readdirSync(CUSTOMER).filter((f) => f.toLowerCase().endsWith('.dxf')).sort();
  console.log(`BOM arm — ${MODEL} — ${files.length} customer drawings\n`);

  const out: Out[] = [];
  for (const [i, f] of files.entries()) {
    const dxf = join(CUSTOMER, f);
    const pdfPath = dxf.replace(/\.dxf$/i, '.pdf');
    const items = extractDxfText(decodeDxfBytes(readFileSync(dxf)));
    const det = extractCutList(items);
    const row: Out = {
      file: f,
      deterministic: {
        hasTable: !!det,
        rows: det?.rows.length ?? 0,
        descriptions: det?.rows.map((r) => r.description ?? '') ?? [],
      },
      ai: { hasTable: false, rows: [], ghostCells: [] },
    };
    try {
      const bag = items
        .slice(0, 400)
        .map((it) => `${JSON.stringify(it.text)} @(${it.x.toFixed(0)},${it.y.toFixed(0)}) h=${it.height.toFixed(1)}`)
        .join('\n');
      let pdf: Buffer | null = null;
      if (existsSync(pdfPath) && statSync(pdfPath).size <= MAX_PDF_BYTES) pdf = readFileSync(pdfPath);
      const { parsed, usage } = await ask(pdf, bag, key);
      const bagFolded = items.map((it) => fold(it.text));
      const rows: Row[] = parsed.rows ?? [];
      row.ai.hasTable = !!parsed.has_table;
      row.ai.rows = rows;
      // Same faithfulness discipline as the title-block arm: every cell must be
      // text that is actually on the drawing.
      for (const r of rows) {
        for (const v of Object.values(r)) {
          if (!v) continue;
          const fv = fold(String(v));
          if (!bagFolded.some((b) => b.includes(fv))) row.ai.ghostCells.push(String(v));
        }
      }
      row.usage = { input: usage.input_tokens, output: usage.output_tokens };
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err);
    }
    out.push(row);
    if ((i + 1) % 5 === 0 || i === files.length - 1) console.log(`  ${i + 1}/${files.length}`);
  }

  const outPath = join(CORPUS, `bom.${MODEL}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 1));

  const detTables = out.filter((r) => r.deterministic.hasTable);
  const aiTables = out.filter((r) => r.ai.rows.length > 0);
  const invented = out.filter((r) => !r.deterministic.hasTable && r.ai.rows.length > 0);
  const missed = out.filter((r) => r.deterministic.hasTable && r.ai.rows.length === 0);
  const ghosts = out.flatMap((r) => r.ai.ghostCells);
  const inTok = out.reduce((a, r) => a + (r.usage?.input ?? 0), 0);
  const outTok = out.reduce((a, r) => a + (r.usage?.output ?? 0), 0);

  console.log(`\nerrors: ${out.filter((r) => r.error).length}`);
  console.log(`deterministic found a table on: ${detTables.map((r) => r.file.split('-_')[0]).join(', ')}`);
  console.log(`AI found rows on:               ${aiTables.map((r) => r.file.split('-_')[0]).join(', ')}`);
  console.log(`\nAI invented a table where there is none: ${invented.length}` +
    (invented.length ? ` -> ${invented.map((r) => `${r.file.split('-_')[0]}(${r.ai.rows.length} rows)`).join(', ')}` : ''));
  console.log(`AI missed a table that exists:           ${missed.length}`);
  console.log(`AI cells not present on the drawing:     ${ghosts.length}`);
  ghosts.slice(0, 8).forEach((g) => console.log(`    ${JSON.stringify(g)}`));
  console.log(`\nrow counts  det vs ai:`);
  for (const r of out.filter((x) => x.deterministic.hasTable || x.ai.rows.length)) {
    console.log(`  ${r.file.split('-_')[0]}  det=${r.deterministic.rows}  ai=${r.ai.rows.length}`);
  }
  const rate = MODEL.includes('opus') ? [5, 25] : MODEL.includes('haiku') ? [1, 5] : [3, 15];
  console.log(`\ntokens ${inTok} in / ${outTok} out  ~$${((inTok / 1e6) * rate[0] + (outTok / 1e6) * rate[1]).toFixed(2)}`);
  console.log(`Wrote ${outPath}`);
}

void main();
