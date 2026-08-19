/**
 * How big is the request this feature actually sends?
 *
 * The endpoint takes the drawing's TEXT, never the drawing. This measures the real
 * payload for every drawing in the corpus against Vercel's ~4.5 MB body ceiling,
 * so the margin is a number rather than an assumption.
 *
 * Run: pnpm dlx tsx scripts/drawingPayloadProbe.mts
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { extractDxfText, decodeDxfBytes } from '../lib/dxfTextExtract';
import { titleBlockRegion } from '../lib/drawingText';

const CORPUS = join(homedir(), 'Downloads', 'jigged-drawing-corpus');
const CUSTOMER = join(homedir(), 'Downloads', 'PARTS PACKAGE FOR DATA ENTRY FROM PRINTS');
const VERCEL_BODY_LIMIT = 4.5 * 1024 * 1024;

const dirs = [CUSTOMER, ...readdirSync(CORPUS)
  .map((d) => join(CORPUS, d))
  .filter((p) => existsSync(p) && statSync(p).isDirectory())];

let worst = { name: '', bytes: 0, strings: 0 };
let total = 0;
let count = 0;
let overCap = 0;

for (const dir of dirs) {
  for (const f of readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.dxf'))) {
    const items = extractDxfText(decodeDxfBytes(new Uint8Array(readFileSync(join(dir, f)))));

    // Exactly what `assistRows` posts — the title-block region, capped.
    const sent = titleBlockRegion(items);
    const body = JSON.stringify({
      company_id: '00000000-0000-0000-0000-000000000000',
      strings: sent.map((i) => ({ text: i.text, x: i.x, y: i.y, height: i.height })),
    });
    const bytes = Buffer.byteLength(body, 'utf8');

    count += 1;
    total += bytes;
    if (bytes > worst.bytes) worst = { name: f, bytes, strings: sent.length };
    if (bytes > VERCEL_BODY_LIMIT) overCap += 1;
  }
}

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
console.log(`drawings measured : ${count}`);
console.log(`mean payload      : ${kb(total / count)}`);
console.log(`largest payload   : ${kb(worst.bytes)}  (${worst.name}, ${worst.strings} strings)`);
console.log(`Vercel body limit : ${kb(VERCEL_BODY_LIMIT)}`);
console.log(`over the limit    : ${overCap}`);
console.log(
  `headroom on worst : ${(VERCEL_BODY_LIMIT / worst.bytes).toFixed(0)}x  ` +
    `(${((100 * worst.bytes) / VERCEL_BODY_LIMIT).toFixed(2)}% of the ceiling)`,
);

// The server also caps strings per request; check the real data against it.
const MAX_STRINGS = 1000; // matches api/routes/drawing_routes.py
console.log(
  `\nworst drawing has ${worst.strings} strings against the route's MAX_STRINGS=${MAX_STRINGS}` +
    (worst.strings > MAX_STRINGS ? '  <-- CAP IS TOO LOW' : '  — within the cap'),
);
