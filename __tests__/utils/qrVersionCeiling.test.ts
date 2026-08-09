import { describe, it, expect } from 'vitest';

import { buildScanUrl, type JiggedScan } from '@/lib/jiggedScan';
import { qrMatrix, QR_QUIET_MODULES } from '@/lib/qrVector';
import { TRAVELER_QR_SIZE, TRAVELER_QR_EC } from '@/utils/jobTravelerPdf';
import { LABEL_QR_SIZE, LABEL_QR_EC, LABEL_CONTENT_INSET, LABEL_QR_TEXT_GAP } from '@/utils/locationLabelPdf';

/**
 * **This is the guard the whole redesign exists to install.**
 *
 * A Contour operator spent 30+ seconds failing to scan a printed traveler off fresh paper. The
 * cause was payload length: 157 characters put the code at QR version 8 (49×49 modules) inside a
 * 56pt square, which is 0.37 mm per module. Nothing failed, nothing was logged, and no test went
 * red — the first signal was a person on a shop floor giving up.
 *
 * So the ceiling is asserted here rather than trusted to a comment. If a future change lengthens a
 * payload, lowercases part of a URL, or shrinks a printed code, **this fails in CI instead of on
 * paper**. When it does fail, the fix is to shorten the payload — not to raise the numbers.
 *
 * The three assertions are three different ways the same failure arrives:
 *   1. charset  — one lowercase character drops a segment out of QR alphanumeric mode, which costs
 *                 ~45% of the payload budget and usually a whole version. It is silent.
 *   2. version  — the direct ceiling.
 *   3. mm/module — what a phone camera actually has to resolve, which is the only number the shop
 *                 floor experiences. Version alone would let a later "let's make the QR smaller to
 *                 fit another column" change through.
 */

const CO = '11111111-2222-3333-4444-555555555555';
const LOC = '99999999-8888-7777-6666-555555555555';
const PART = '8a3f9c1d-4b2e-4f6a-9c8d-0e1f2a3b4c5d';

/**
 * The canonical production origin, pinned here rather than read from the environment.
 *
 * A preview deployment's hostname is much longer and would push these codes a version or two
 * higher; that is fine on a preview (nobody sticks those labels to a shelf) but it must not be able
 * to make this test pass or fail. What ships is measured against what production prints.
 */
const CANONICAL_ORIGIN = 'https://www.jigged.app';

/** The QR alphanumeric charset: the only characters that get the cheap encoding mode. */
const QR_ALPHANUMERIC = /^[0-9A-Z $%*+\-./:]+$/;

const PT_PER_MM = 72 / 25.4;

const traveler: JiggedScan = { kind: 'traveler', companyId: CO, jobPartId: PART };
const location: JiggedScan = { kind: 'location', companyId: CO, locationId: LOC };

const cases = [
  {
    what: 'job traveler',
    scan: traveler,
    ec: TRAVELER_QR_EC,
    maxVersion: 4,
    printedPt: TRAVELER_QR_SIZE,
    /**
     * 0.55 mm. Below the 0.60 the current design achieves, so a small layout tweak does not trip
     * it, and far above the 0.37 that failed at Contour.
     */
    minModuleMm: 0.55,
  },
  {
    what: 'location label',
    scan: location,
    ec: LABEL_QR_EC,
    maxVersion: 6,
    printedPt: LABEL_QR_SIZE,
    /** 0.90 mm, against the 1.00 the Avery layout achieves and the 0.56 it replaced. */
    minModuleMm: 0.9,
  },
] as const;

describe.each(cases)('$what QR stays scannable', ({ scan, ec, maxVersion, printedPt, minModuleMm }) => {
  const payload = buildScanUrl(scan, CANONICAL_ORIGIN);

  it('is entirely inside the QR alphanumeric charset', () => {
    expect(payload).toMatch(QR_ALPHANUMERIC);
  });

  it(`encodes at version ${maxVersion} or below at error correction ${ec}`, () => {
    const matrix = qrMatrix(payload, ec);
    expect(matrix).not.toBeNull();
    expect(
      matrix!.version,
      `payload is ${payload.length} chars; shorten it rather than raising this ceiling`,
    ).toBeLessThanOrEqual(maxVersion);
  });

  it(`prints at ${minModuleMm} mm per module or larger`, () => {
    const matrix = qrMatrix(payload, ec)!;
    const moduleMm = printedPt / matrix.size / PT_PER_MM;
    expect(moduleMm).toBeGreaterThanOrEqual(minModuleMm);
  });
});

describe('printed layouts leave a real quiet zone', () => {
  /**
   * `drawQrCode` deliberately renders no margin — the page's own white is the quiet zone. That only
   * works if the layout actually leaves 4 modules of it, and "4 modules" is a different number of
   * points on every sheet, so it is computed rather than eyeballed.
   */
  it('the Avery label insets far enough for four modules on every side', () => {
    const matrix = qrMatrix(buildScanUrl(location, CANONICAL_ORIGIN), LABEL_QR_EC)!;
    const modulePt = LABEL_QR_SIZE / matrix.size;
    const needed = QR_QUIET_MODULES * modulePt;

    // Left, top and bottom clear space is the die-cut inset; to the right it is the gap before the
    // text column. A sticker on a dark shelf has no white beyond its own edge, so the inset — not
    // the page — has to carry this.
    expect(LABEL_CONTENT_INSET).toBeGreaterThanOrEqual(needed);
    expect(LABEL_QR_TEXT_GAP).toBeGreaterThanOrEqual(needed);
  });
});
