/**
 * Builds the regression fixture from the customer #2 drawing package.
 *
 * WHY THE FIXTURE EMBEDS TEXT ENTITIES RATHER THAN THE DRAWINGS
 * The .dxf files are a third party's property and must not enter the repo. What
 * the matcher actually consumes is a `(text, x, y, height)[]` array, so the
 * fixture stores that — the test then exercises `extractDrawingFields` end to end
 * in CI with no proprietary CAD file present.
 *
 * ⚠️ IT DOES EMBED THE THIRD PARTY'S PART NUMBERS AND DESCRIPTIONS. The package came
 * to us from a customer's customer. Committing it was an explicit decision, not an
 * accident of this script — do not redistribute the file.
 *
 * The identifier expectations are derived from the FILENAME, which encodes both
 * numbers independently of anything the extractor does — so the fixture cannot
 * simply enshrine whatever the code currently happens to output. Descriptions are
 * carried over from the current extraction and flagged for review, because nothing
 * outside the drawing corroborates them.
 *
 * Run: pnpm dlx tsx scripts/drawingFixtureBuild.ts
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { extractDxfText, decodeDxfBytes } from '../lib/dxfTextExtract';
import { extractDrawingFields } from '../lib/drawingText';

const CUSTOMER = join(homedir(), 'Downloads', 'PARTS PACKAGE FOR DATA ENTRY FROM PRINTS');
const OUT = join(process.cwd(), '__tests__', 'fixtures', 'drawing-extraction-truth.json');

if (!existsSync(CUSTOMER)) {
  console.error(`Customer package not found at ${CUSTOMER}`);
  process.exit(1);
}

interface FixtureDrawing {
  file: string;
  items: Array<{ text: string; x: number; y: number; height: number; kind?: string; tag?: string }>;
  expect: { part_number: string; drawing_number: string; description: string | null };
}

const drawings: FixtureDrawing[] = [];
const mismatches: string[] = [];

for (const file of readdirSync(CUSTOMER).filter((f) => f.toLowerCase().endsWith('.dxf')).sort()) {
  const items = extractDxfText(decodeDxfBytes(readFileSync(join(CUSTOMER, file))));

  // `1011770-_314-092-60082-10-0000.dxf` -> part 1011770, drawing 314-092-60082-10
  const s = file.replace(/\.dxf$/i, '');
  const part_number = s.split('-_')[0];
  const drawing_number = s.replace(/^[^-]*-_/, '').replace(/-0000$/, '');

  const got = extractDrawingFields(items, { filenameStem: s });
  if (got.part_number?.value !== part_number) {
    mismatches.push(`${file}: part_number expected ${part_number}, extractor gives ${got.part_number?.value ?? '(none)'}`);
  }
  if (got.drawing_number?.value !== drawing_number) {
    mismatches.push(`${file}: drawing_number expected ${drawing_number}, extractor gives ${got.drawing_number?.value ?? '(none)'}`);
  }

  drawings.push({
    file,
    items: items.map((i) => ({
      text: i.text,
      x: Number(i.x.toFixed(3)),
      y: Number(i.y.toFixed(3)),
      height: Number(i.height.toFixed(3)),
      ...(i.kind ? { kind: i.kind } : {}),
      ...(i.tag ? { tag: i.tag } : {}),
    })),
    expect: {
      part_number,
      drawing_number,
      description: got.description?.value ?? null,
    },
  });
}

const fixture = {
  _what: 'Text entities extracted from customer #2\'s 31-drawing package, with expected field values.',
  _identifiers:
    'part_number and drawing_number are derived from the FILENAME, which encodes both independently '
    + 'of the extractor. These are real expectations, not a snapshot of current behaviour.',
  _descriptions:
    'description is carried over from the current extractor output — nothing outside the drawing '
    + 'corroborates it, so it is a CHANGE DETECTOR, not verified truth. Confirm by eye before trusting.',
  _provenance:
    'Third-party drawings received via a customer. Contains their part numbers and descriptions. '
    + 'Do not redistribute.',
  drawings,
};

/**
 * ONE LINE PER DRAWING, not pretty-printed.
 *
 * Pretty-printing 5,365 text entities at one field per line makes a 38,000-line
 * file, which buries a PR and makes every regeneration look like a rewrite. Keyed
 * per drawing instead: a changed drawing is a one-line diff, and the file is still
 * greppable by part number.
 */
const { drawings: rows, ...header } = fixture;
writeFileSync(
  OUT,
  [
    '{',
    ...Object.entries(header).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)},`),
    '"drawings": [',
    ...rows.map((d, i) => JSON.stringify(d) + (i === rows.length - 1 ? '' : ',')),
    ']',
    '}',
  ].join('\n') + '\n',
);

console.log(`${drawings.length} drawings, ${drawings.reduce((a, d) => a + d.items.length, 0)} text entities`);
console.log(`Wrote ${OUT} (${(readFileSync(OUT).length / 1024).toFixed(0)} KB)`);
if (mismatches.length) {
  console.log(`\n⚠️  ${mismatches.length} identifier mismatches — the extractor disagrees with the filename:`);
  mismatches.forEach((m) => console.log(`   ${m}`));
} else {
  console.log('\nAll 31 identifiers match the filename-derived expectation.');
}
