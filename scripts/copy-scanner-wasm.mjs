/**
 * Put the barcode decoder's WebAssembly next to the app that loads it.
 *
 * `zxing-wasm` ships `zxing_reader.wasm` beside its JS, and by default the library fetches that file
 * **from a CDN at runtime**. That's the wrong trade for us twice over: the surface that needs it is
 * the operator's phone on a shop floor with unreliable wifi, and a scanner that fails because
 * jsdelivr is unreachable is indistinguishable from a scanner that's broken.
 *
 * So it's served from our own origin. Copied at install time rather than committed, because the
 * `.wasm` and the JS that drives it are one unit — a committed binary silently drifts on the next
 * dependency bump, and a decoder loading a mismatched module fails in ways nobody would connect to
 * a version number.
 *
 * Wired to `postinstall`, so it runs on every `pnpm install` including Vercel's. It throws rather
 * than warning: a missing file here means the scanner is dead, and a red build says so immediately.
 */
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

const DEST_DIR = join(process.cwd(), 'public', 'wasm');
const DEST = join(DEST_DIR, 'zxing_reader.wasm');

// Resolve through the package's own export map, so the path stays correct if the layout changes.
const src = require.resolve('zxing-wasm/reader/zxing_reader.wasm');

await mkdir(DEST_DIR, { recursive: true });
await copyFile(src, DEST);

const { size } = await stat(DEST);
console.log(`[scanner] zxing_reader.wasm → public/wasm/ (${Math.round(size / 1024)} KB)`);
