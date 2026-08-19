/**
 * Trim a real DXF down to what the extractor actually reads.
 *
 * The customer's drawings are ~390 KB each, almost all of it LINE/ARC/POLYLINE
 * geometry that `extractDxfText` never looks at. Committing two of them whole put
 * 152,000 lines into a PR.
 *
 * So the e2e fixtures keep every TEXT, MTEXT, ATTDEF and ATTRIB entity — real
 * strings, real coordinates, real attribute tags, including the group-3 prompts and
 * the wrapped cut-list cells that caused actual bugs — and drop the geometry. What
 * the extractor sees is bit-for-bit what it saw before; the file is ~5% the size.
 *
 * Verified by re-running the extractor over the trimmed file and comparing fields.
 *
 * Run: pnpm dlx tsx scripts/drawingFixtureTrim.mts <in.dxf> <out.dxf>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { extractDxfText, decodeDxfBytes } from '../lib/dxfTextExtract';
import { extractDrawingFields } from '../lib/drawingText';
import { extractCutList } from '../lib/drawingCutList';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: drawingFixtureTrim.mts <in.dxf> <out.dxf>');
  process.exit(1);
}

const KEEP = new Set(['TEXT', 'MTEXT', 'ATTDEF', 'ATTRIB']);

const source = decodeDxfBytes(new Uint8Array(readFileSync(input)));
const lines = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

// Walk the group-code/value pairs, keeping only entities we care about. Everything
// between one `0` marker and the next belongs to that entity.
const kept: string[] = ['0', 'SECTION', '2', 'ENTITIES'];
let current: string[] = [];
let keeping = false;

for (let i = 0; i + 1 < lines.length; i += 2) {
  const code = lines[i].trim();
  const value = lines[i + 1];
  if (code === '0') {
    if (keeping) kept.push(...current);
    current = [];
    keeping = KEEP.has(value.trim().toUpperCase());
    if (keeping) current.push(code, value);
    continue;
  }
  if (keeping) current.push(code, value);
}
if (keeping) kept.push(...current);
kept.push('0', 'ENDSEC', '0', 'EOF');

writeFileSync(output, kept.join('\n') + '\n', 'utf8');

// The whole point is that nothing the extractor sees changed. Prove it.
const before = extractDxfText(source);
const after = extractDxfText(decodeDxfBytes(new Uint8Array(readFileSync(output))));
const fieldsBefore = JSON.stringify(extractDrawingFields(before));
const fieldsAfter = JSON.stringify(extractDrawingFields(after));
const cutBefore = JSON.stringify(extractCutList(before));
const cutAfter = JSON.stringify(extractCutList(after));

const sizeBefore = readFileSync(input).length;
const sizeAfter = readFileSync(output).length;
console.log(`${input} -> ${output}`);
console.log(`  bytes    : ${sizeBefore} -> ${sizeAfter} (${Math.round((100 * sizeAfter) / sizeBefore)}%)`);
console.log(`  entities : ${before.length} -> ${after.length}`);
console.log(`  fields   : ${fieldsBefore === fieldsAfter ? 'IDENTICAL' : 'CHANGED'}`);
console.log(`  cut list : ${cutBefore === cutAfter ? 'IDENTICAL' : 'CHANGED'}`);
if (fieldsBefore !== fieldsAfter || cutBefore !== cutAfter) process.exit(1);
