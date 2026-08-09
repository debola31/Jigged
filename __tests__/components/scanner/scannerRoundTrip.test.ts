import { describe, it, expect } from 'vitest';

import {
  buildScanUrl,
  foreignCompanyRejection,
  parseJiggedScan,
  scanDestination,
  type JiggedScan,
} from '@/lib/jiggedScan';
import { TRAVELER_QR_EC } from '@/utils/jobTravelerPdf';
import { LABEL_QR_EC } from '@/utils/locationLabelPdf';

const CO = '71000000-0000-0000-0000-000000000002';
const OTHER_CO = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const LOC = '8a3f9c1d-4b2e-4f6a-9c8d-0e1f2a3b4c5d';
const PART = '99999999-8888-7777-6666-555555555555';
const ORIGIN = 'https://www.jigged.app';

/**
 * The round trip: what we print, we can read, and it goes to the right place.
 *
 * `jiggedScan.test.ts` tests the string handling and `qrVersionCeiling.test.ts` tests the encoding
 * budget, but neither proves the *chain* — and the chain is what a scan actually is. If the printed
 * error-correction level, the payload or the charset ever stopped being decodable, both of those
 * would still pass while no label in the shop scanned. That is not hypothetical: the codes this
 * replaced encoded fine, parsed fine, and took 30+ seconds to read off fresh paper.
 *
 * So this runs the **real decoder** against the **real `.wasm` the app serves**, on codes generated
 * at the exact error-correction levels the two PDFs print at, and follows the decoded text all the
 * way to a route.
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

/** Encode with `qrcode`, decode with `zxing-wasm`, return exactly what the scanner would see. */
async function printAndScan(payload: string, errorCorrectionLevel: 'M' | 'H'): Promise<string[]> {
  const QRCode = (await import('qrcode')).default;
  const { readFile } = await import('node:fs/promises');
  const { prepareZXingModule, readBarcodes } = await import('zxing-wasm/reader');

  // The same file `scripts/copy-scanner-wasm.mjs` puts in public/ and the app loads at runtime.
  const wasmBinary = await readFile('public/wasm/zxing_reader.wasm');
  await prepareZXingModule({ overrides: { wasmBinary }, fireImmediately: true });

  const png = await QRCode.toBuffer(payload, { errorCorrectionLevel, scale: 4, margin: 4 });

  // The encoded bytes directly, not a Blob: jsdom's Blob shim has no `arrayBuffer()`, which the
  // decoder calls. `readBarcodes` accepts a Uint8Array of an encoded image just as happily.
  const results = await readBarcodes(new Uint8Array(png), { formats: ['QRCode'] });
  return results.map((r) => r.text);
}

const kinds: Array<{ what: string; scan: JiggedScan; ec: 'M' | 'H'; destination: string }> = [
  {
    what: 'location label',
    scan: { kind: 'location', companyId: CO, locationId: LOC },
    ec: LABEL_QR_EC,
    destination: `/operator/${CO}/inventory/locations/${LOC}`,
  },
  {
    what: 'job traveler',
    scan: { kind: 'traveler', companyId: CO, jobPartId: PART },
    ec: TRAVELER_QR_EC,
    destination: `/operator/${CO}/parts/${PART}`,
  },
];

describe.each(kinds)('$what: generate → decode → route', ({ scan, ec, destination }) => {
  it(
    'reads back and routes a code generated exactly as the PDF prints it',
    async () => {
      const payload = buildScanUrl(scan, ORIGIN);
      const decoded = await printAndScan(payload, ec);

      expect(decoded).toHaveLength(1);
      // Character-for-character, including the case — the uppercase is not cosmetic.
      expect(decoded[0]).toBe(payload);

      const parsed = parseJiggedScan(decoded[0]);
      expect(parsed).toEqual(scan);
      expect(scanDestination(parsed!)).toBe(destination);
    },
    30_000,
  );
});

describe('the cross-tenant check survives a real decode', () => {
  it(
    'refuses another company’s label off the page, before any navigation',
    async () => {
      const foreign: JiggedScan = { kind: 'location', companyId: OTHER_CO, locationId: LOC };
      const decoded = await printAndScan(buildScanUrl(foreign, ORIGIN), LABEL_QR_EC);

      const parsed = parseJiggedScan(decoded[0]);
      expect(parsed).not.toBeNull();
      // It decodes perfectly — that is the whole danger, and why the check is not a decode failure.
      expect(foreignCompanyRejection(parsed!, CO)).toMatch(/different company/i);
      expect(foreignCompanyRejection(parsed!, OTHER_CO)).toBeNull();
    },
    30_000,
  );
});
