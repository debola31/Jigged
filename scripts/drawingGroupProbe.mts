/**
 * How many rows does the real customer package actually produce?
 *
 * The answer changed the grouping rule: before models could join their drawing,
 * 93 files became 62 rows — 31 parts plus 31 step-only rows nobody wants.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { groupDrawingFiles } from '../lib/drawingFileGroups';

const DIR = join(homedir(), 'Downloads', 'PARTS PACKAGE FOR DATA ENTRY FROM PRINTS');

// Node has no File from disk, so build one per entry with the real byte length —
// grouping reads `name` and `size` only.
const files = readdirSync(DIR)
  .filter((n) => statSync(join(DIR, n)).isFile())
  .map((n) => new File([readFileSync(join(DIR, n))], n));

const groups = groupDrawingFiles(files);
const withModel = groups.filter((g) => g.files.some((f) => f.kind === 'step'));
const readable = groups.filter((g) => g.files.some((f) => f.kind === 'dxf' || f.kind === 'pdf'));

console.log(`files in the package : ${files.length}`);
console.log(`rows produced        : ${groups.length}`);
console.log(`rows with a drawing  : ${readable.length}`);
console.log(`rows with a model    : ${withModel.length}`);
console.log(`rows with NO drawing : ${groups.length - readable.length}`);
console.log('\nfirst three rows:');
for (const g of groups.slice(0, 3)) {
  console.log(`  ${g.stem}`);
  for (const file of g.files) console.log(`      ${file.kind.padEnd(5)} ${file.name}`);
}
