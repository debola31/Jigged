/**
 * Draw a QR code into a PDF as **vector modules** rather than as an embedded bitmap.
 *
 * ## Why not a PNG
 *
 * Both generators used to embed `QRCode.toDataURL(..., { width: 320 })`. On a 34 mm location label
 * that is ~239 dpi, so every module edge landed mid-pixel and printed soft — on the one artifact
 * that gets stuck to a shelf and read for years. Vector modules have no resolution at all: the
 * printer rasterises them at whatever it natively does, and a module edge is a module edge.
 *
 * **This uses no more toner than the bitmap did.** It paints the same black squares in the same
 * places; only the description changes. Worth stating because "no fills" is a rule on this codebase
 * — that rule is about decorative fills and bars, and a QR code's dark modules are the data.
 *
 * ## Two details that are easy to get wrong
 *
 * **The quiet zone is not drawn here.** `QRCode.create()` returns the bare matrix with no margin,
 * which is correct: the surrounding white of the page IS the quiet zone, and encoding it as part of
 * the image only shrinks the modules at a fixed physical size. Callers must leave ≥ 4 modules of
 * clear space on every side — `QR_QUIET_MODULES` is here so they can compute it rather than guess,
 * and both callers assert it in their tests.
 *
 * **Runs are merged and overlapped.** Consecutive dark modules on a row become one rectangle. That
 * is worth less than it sounds — a QR's data region is high-entropy by design, so runs average
 * under two modules and a version-4 code goes from 553 rectangles to 288, not to a handful. It is
 * still half the operators for four lines of code.
 *
 * The overlap is the part that matters: each rectangle is grown by a hair so adjacent fills
 * overlap instead of abutting. PDF renderers antialias the seam between two exactly-adjacent fills,
 * which shows up as faint white hairlines through the code — noise to a decoder, not just to a
 * human.
 */
import QRCode from 'qrcode';

/**
 * The QR specification's quiet zone: 4 modules of clear space on every side. Callers supply it from
 * the page around the code; nothing in this module draws it.
 */
export const QR_QUIET_MODULES = 4;

/**
 * Fraction of a module by which each drawn run is grown, to close antialiasing seams between
 * adjacent fills. 2% is well under a printer's dot and cannot merge two modules that should be
 * distinct, since the gap it closes is zero-width by construction.
 */
const SEAM_OVERLAP = 0.02;

export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H';

/** The minimum a jsPDF document must expose to be drawn into. Keeps this unit-testable. */
export interface QrDrawTarget {
  setFillColor: (r: number, g: number, b: number) => void;
  rect: (x: number, y: number, w: number, h: number, style?: string) => void;
}

export interface QrMatrix {
  /** Modules per side, excluding the quiet zone. */
  size: number;
  /** QR symbol version, 1–40. The printed-size guard asserts on this. */
  version: number;
  isDark: (row: number, col: number) => boolean;
}

/**
 * The module matrix for `text`, or null if it cannot be encoded.
 *
 * Exported separately from the drawing so the version-ceiling test can assert on a payload without
 * standing up a PDF, and so a caller can compute its own layout from `size`.
 */
export function qrMatrix(text: string, errorCorrectionLevel: QrErrorCorrection): QrMatrix | null {
  try {
    const qr = QRCode.create(text, { errorCorrectionLevel });
    const { size, data } = qr.modules;
    return {
      size,
      version: qr.version,
      isDark: (row, col) => Boolean(data[row * size + col]),
    };
  } catch {
    // Over capacity, or an empty payload. Callers skip the code and keep the rest of the document —
    // a traveler without its QR is still a usable sheet.
    return null;
  }
}

export interface DrawQrOptions {
  /** Top-left of the code itself. The quiet zone lives OUTSIDE this box, in the caller's layout. */
  x: number;
  y: number;
  /** Side length of the code, in the document's units. */
  size: number;
  errorCorrectionLevel: QrErrorCorrection;
}

/**
 * Draw `text` as a QR code and return the matrix that was drawn, or null if it could not be
 * encoded (in which case nothing is drawn and the caller carries on without it).
 */
export function drawQrCode(
  doc: QrDrawTarget,
  text: string,
  { x, y, size, errorCorrectionLevel }: DrawQrOptions,
): QrMatrix | null {
  const matrix = qrMatrix(text, errorCorrectionLevel);
  if (!matrix) return null;

  const modulePt = size / matrix.size;
  const overlap = modulePt * SEAM_OVERLAP;

  doc.setFillColor(0, 0, 0);

  for (let row = 0; row < matrix.size; row++) {
    let runStart = -1;
    // One past the end, so a run that reaches the right edge is flushed by the same branch as any
    // other rather than needing a copy of the flush after the loop.
    for (let col = 0; col <= matrix.size; col++) {
      const dark = col < matrix.size && matrix.isDark(row, col);
      if (dark && runStart === -1) runStart = col;
      if (!dark && runStart !== -1) {
        doc.rect(
          x + runStart * modulePt,
          y + row * modulePt,
          (col - runStart) * modulePt + overlap,
          modulePt + overlap,
          'F',
        );
        runStart = -1;
      }
    }
  }

  return matrix;
}
