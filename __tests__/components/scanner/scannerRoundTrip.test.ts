import { describe, it, expect } from 'vitest';

import { locationIdFromScan } from '@/lib/jiggedScan';

const UUID = '71000000-0000-0000-0000-000000000002';

/**
 * The round trip: what we print, we can read.
 *
 * `LocationScanner.test.tsx` tests the two ends in isolation — `qrcode` writes the label,
 * `zxing-wasm` reads a code, `locationIdFromScan` parses the text. None of that proves the *chain*
 * holds, and the chain is what a scan actually is. If the printed error-correction level, size or
 * payload ever stopped being decodable, every one of those tests would still pass while no label in
 * the shop scanned.
 *
 * Uses the real decoder against the real `.wasm` the app serves, and the same `errorCorrectionLevel`
 * and width `locationLabelPdf` prints at.
 *
 * ## Why this lives in its own file
 *
 * It used to sit at the bottom of `LocationScanner.test.tsx`, whose camera suite `vi.doMock`s
 * `zxing-wasm/reader` with a `readBarcodes` that returns `[]`. The component imports that module
 * dynamically mid-render, so the mocked copy lands in the module registry — and `vi.doUnmock` does
 * not evict a module that has already been imported. This test could therefore decode with the mock
 * and fail on `expected [] to have a length of 1`, which is the mock's own return value rather than
 * a decode failure.
 *
 * It was a race, not a certainty: it passed locally every time and failed on CI, where slower,
 * contended workers let the mocked import land first. `doUnmock` + `resetModules` would only shorten
 * the odds; vitest isolates the module registry **per file**, so moving it here removes the race
 * instead of narrowing it. Keep it in its own file, and keep it free of `vi.mock`.
 *
 * ## Requires `pnpm install` to have run
 *
 * It reads `public/wasm/zxing_reader.wasm`, which `scripts/copy-scanner-wasm.mjs` writes on
 * postinstall (the file is gitignored). An install with `--ignore-scripts` will fail this with
 * ENOENT — which is the correct failure, since the app would have no decoder either.
 */
describe('printed label → decoder → location id', () => {
  it('reads back a label generated exactly as the PDF prints it', async () => {
    const QRCode = (await import('qrcode')).default;
    const { readFile } = await import('node:fs/promises');
    const { prepareZXingModule, readBarcodes } = await import('zxing-wasm/reader');

    // The same file `scripts/copy-scanner-wasm.mjs` puts in public/ and the app loads at runtime.
    const wasmBinary = await readFile('public/wasm/zxing_reader.wasm');
    await prepareZXingModule({ overrides: { wasmBinary }, fireImmediately: true });

    const url = `http://localhost:3000/operator/co1/login?location=${UUID}`;
    // errorCorrectionLevel 'H' and 320px match utils/locationLabelPdf.ts.
    const png = await QRCode.toBuffer(url, { errorCorrectionLevel: 'H', width: 320 });

    // The encoded bytes directly, not a Blob: jsdom's Blob shim has no `arrayBuffer()`, which the
    // decoder calls. `readBarcodes` accepts a Uint8Array of an encoded image just as happily.
    const results = await readBarcodes(new Uint8Array(png), { formats: ['QRCode'] });

    expect(results).toHaveLength(1);
    expect(results[0].text).toBe(url);
    // And the parser gets the id back out of what the decoder actually returned.
    expect(locationIdFromScan(results[0].text)).toBe(UUID);
  }, 30_000);
});
