/**
 * Throwaway probe: does pdf.js ever hand us a whitespace-only text run?
 *
 * `lib/pdfTextExtract.ts` skips them, and a mutant deleting that skip survived the
 * unit suite. Either the guard is unreachable (dead defensive code) or the suite
 * simply cannot construct the case with jsPDF. Real drawings decide it.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CORPUS = join(homedir(), 'Downloads', 'jigged-drawing-corpus');
const CUSTOMER = join(homedir(), 'Downloads', 'PARTS PACKAGE FOR DATA ENTRY FROM PRINTS');

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

const dirs = [CUSTOMER, ...readdirSync(CORPUS)
  .map((d) => join(CORPUS, d))
  .filter((p) => existsSync(p) && statSync(p).isDirectory())];

let files = 0;
let blankRuns = 0;
let filesWithBlanks = 0;
const samples: string[] = [];

for (const dir of dirs) {
  for (const f of readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pdf'))) {
    const task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(join(dir, f))) });
    try {
      const doc = await task.promise;
      let here = 0;
      for (let p = 1; p <= doc.numPages; p += 1) {
        const content = await (await doc.getPage(p)).getTextContent();
        for (const item of content.items) {
          if (!('str' in item)) continue;
          if (item.str.length > 0 && item.str.trim().length === 0) {
            here += 1;
            if (samples.length < 5) samples.push(`${f}: ${JSON.stringify(item.str)}`);
          }
        }
      }
      files += 1;
      blankRuns += here;
      if (here > 0) filesWithBlanks += 1;
    } catch {
      /* unreadable — not what this probe is about */
    } finally {
      await task.destroy().catch(() => undefined);
    }
  }
}

console.log(`PDFs read              : ${files}`);
console.log(`whitespace-only runs   : ${blankRuns}`);
console.log(`files containing them  : ${filesWithBlanks}`);
samples.forEach((s) => console.log(`   ${s}`));
