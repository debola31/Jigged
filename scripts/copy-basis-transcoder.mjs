/**
 * Put three.js's Basis Universal transcoder next to the app that loads it.
 *
 * The showcase's realistic shop models carry KTX2 textures, which `KTX2Loader` transcodes in a
 * worker running `basis_transcoder.js` + `.wasm`, fetched at runtime from a path it is given. Served
 * from our own origin rather than a CDN, as the scanner's decoder is (scripts/copy-scanner-wasm.mjs),
 * and copied at install time from the installed three, so the transcoder always matches the loader.
 *
 * Wired to `postinstall`. It throws rather than warning: without these the realistic models can't
 * load, and the page quietly keeps its light ones.
 */
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

const DEST_DIR = join(process.cwd(), 'public', 'wasm', 'basis');
// Resolved through the package's own export map, so the path stays correct if the layout changes.
const SRC_DIR = dirname(require.resolve('three/examples/jsm/libs/basis/basis_transcoder.js'));

await mkdir(DEST_DIR, { recursive: true });
let total = 0;
for (const file of ['basis_transcoder.js', 'basis_transcoder.wasm']) {
  await copyFile(join(SRC_DIR, file), join(DEST_DIR, file));
  total += (await stat(join(DEST_DIR, file))).size;
}
console.log(`[showcase] basis transcoder → public/wasm/basis/ (${Math.round(total / 1024)} KB)`);
