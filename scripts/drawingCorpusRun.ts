/**
 * Corpus runner for the drawing-extraction experiment.
 *
 * Not a CI gate and not shipped code — this exists to produce the measurement
 * that decides whether the extractor needs an AI arm at all. It drives the SAME
 * modules the app would use (lib/dxfTextExtract, lib/drawingText) so the numbers
 * describe real behaviour rather than a throwaway prototype.
 *
 * Run:  pnpm dlx tsx scripts/drawingCorpusRun.ts
 * Out:  ~/Downloads/jigged-drawing-corpus/armA.json  (+ a console summary)
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import {
  extractDxfText,
  classifyTitleBlock,
  decodeDxfBytes,
  type TitleBlockStructure,
} from '../lib/dxfTextExtract';
import { extractDrawingFields, type ExtractedFields } from '../lib/drawingText';

const CORPUS = join(homedir(), 'Downloads', 'jigged-drawing-corpus');
const CUSTOMER = join(homedir(), 'Downloads', 'PARTS PACKAGE FOR DATA ENTRY FROM PRINTS');

interface Row {
  source: string;
  /** True only for the customer package the matcher was tuned on. */
  tuned: boolean;
  file: string;
  structure: TitleBlockStructure | 'unreadable';
  entityCount: number;
  fields: ExtractedFields;
  /** Every string in the sheet-corner region — the raw material for hand-checking truth. */
  cornerText: string[];
  error?: string;
}

function dxfFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.dxf'))
    .map((f) => join(dir, f))
    .filter((p) => statSync(p).isFile());
}

/**
 * The densest cluster of text in the bottom-right of the sheet. ISO 5457 puts
 * the title block there for A0–A3; this is only used to give a human a short
 * list to read when establishing truth, never to drive extraction.
 */
function cornerText(items: Array<{ text: string; x: number; y: number }>): string[] {
  if (items.length === 0) return [];
  const xs = items.map((i) => i.x);
  const ys = items.map((i) => i.y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const w = Math.max(...xs) - x0 || 1;
  const h = Math.max(...ys) - y0 || 1;
  return items
    .filter((i) => i.x > x0 + 0.5 * w && i.y < y0 + 0.3 * h)
    .sort((a, b) => b.y - a.y || a.x - b.x)
    .map((i) => i.text.replace(/\n/g, ' ⏎ '))
    .slice(0, 60);
}

function run(dir: string, source: string, tuned: boolean): Row[] {
  return dxfFilesIn(dir).map((path) => {
    const file = basename(path);
    try {
      const items = extractDxfText(decodeDxfBytes(readFileSync(path)));
      return {
        source,
        tuned,
        file,
        structure: classifyTitleBlock(items),
        entityCount: items.length,
        fields: extractDrawingFields(items, { filenameStem: file }),
        cornerText: cornerText(items),
      };
    } catch (err) {
      return {
        source,
        tuned,
        file,
        structure: 'unreadable' as const,
        entityCount: 0,
        fields: {},
        cornerText: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

const rows: Row[] = [
  ...run(CUSTOMER, 'customer-sw-technology', true),
  ...readdirSync(CORPUS)
    .filter((d) => statSync(join(CORPUS, d)).isDirectory())
    .flatMap((d) => run(join(CORPUS, d), d, false)),
];

writeFileSync(join(CORPUS, 'armA.json'), JSON.stringify(rows, null, 1));

/* ---------------------------- summary ---------------------------- */

const ROLES = [
  'part_number', 'drawing_number', 'description', 'material',
  'finish', 'revision', 'weight',
] as const;

const pct = (n: number, d: number) => (d === 0 ? '  – ' : `${Math.round((100 * n) / d)}%`.padStart(4));

function summarise(label: string, subset: Row[]) {
  if (subset.length === 0) return;
  const struct = subset.reduce<Record<string, number>>((a, r) => {
    a[r.structure] = (a[r.structure] ?? 0) + 1;
    return a;
  }, {});
  console.log(`\n${label}  (${subset.length} drawings)`);
  console.log(`  structure: ${Object.entries(struct).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  const cells = ROLES.map((r) => {
    const hit = subset.filter((s) => s.fields[r]).length;
    return `${r.replace('_number', '_no').padEnd(14)}${pct(hit, subset.length)} (${hit}/${subset.length})`;
  });
  cells.forEach((c) => console.log(`    ${c}`));
}

console.log('='.repeat(64));
console.log('ARM A — deterministic only.  Fields POPULATED (not yet accuracy).');
console.log('='.repeat(64));
summarise('TUNED — customer package', rows.filter((r) => r.tuned));
summarise('UNTUNED — everything else', rows.filter((r) => !r.tuned));

console.log('\nPer untuned source:');
for (const src of [...new Set(rows.filter((r) => !r.tuned).map((r) => r.source))].sort()) {
  const s = rows.filter((r) => r.source === src);
  const any = s.filter((r) => Object.keys(r.fields).length > 0).length;
  const st = [...new Set(s.map((r) => r.structure))].join(',');
  console.log(
    `  ${src.padEnd(34)} ${String(s.length).padStart(2)} drawings  ` +
      `${String(any).padStart(2)} with any field  [${st}]`,
  );
}
console.log(`\nWrote ${join(CORPUS, 'armA.json')}`);
