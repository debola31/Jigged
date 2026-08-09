/**
 * Adhesive QR label sheet for inventory locations — **Avery 5163**, 2" × 4", ten to a Letter page.
 *
 * ## Why a real label stock, and why this one
 *
 * The previous sheet was a 2 × 5 grid on A4 that a shop had to cut out with scissors, which is a
 * step nobody does twice. 5163 is the commonest 2×4 shipping-label stock in any US office supply
 * cupboard, it is ten-up like the old grid, and the label peels off and sticks to a shelf. The same
 * PDF still prints acceptably on plain paper — the grid is self-evident from the white gutters —
 * so nothing is lost by targeting the stock.
 *
 * Geometry is Avery's, in points: 4" × 2" labels, 0.15625" side margins, 0.1875" between the
 * columns, 0.5" top and bottom, and **rows that touch** (5 × 2" + 0.5" + 0.5" = 11").
 *
 * ## The inset is a scanning requirement, not a taste
 *
 * `LABEL_CONTENT_INSET` does two jobs at once, and the larger of the two demands set it:
 *
 *   - it absorbs printer misregistration, which runs 1/16"–1/8" on the office lasers this targets;
 *   - it **is the QR quiet zone**. `drawQrCode` renders no margin, because encoding whitespace
 *     into the image only shrinks the modules at a fixed physical size. On a page the surrounding
 *     paper supplies the clear space — but a sticker on a dark steel shelf has no white beyond its
 *     own edge, so the label's own inset has to carry it. 14pt is 4.9 modules at this QR size,
 *     against the spec's 4. `qrVersionCeiling.test.ts` computes that rather than trusting it.
 *
 * That is also why **no border or trim rule is drawn**. The die-cut is the boundary; a printed
 * border would eat into the quiet zone, make every misregistration visible, and cost toner on a
 * sheet where the whole point is that a shop prints hundreds.
 *
 * ## What each label says
 *
 * The QR encodes ids (`buildScanUrl`), so renaming a place never breaks a printed label. Beside it,
 * the **name** is the primary line because that is what someone standing at the shelf reads, with
 * the parent path under it in smaller grey for when two shelves share a name. A `jigged.app`
 * micro-line sits at the foot at footer weight.
 *
 * There is no company-name heading. It used to print at the top of page 1, which on die-cut stock
 * lands in the middle of label 1.
 */
import { jsPDF } from 'jspdf';

import { buildScanUrl, scanOrigin } from '@/lib/jiggedScan';
import { drawQrCode, type QrErrorCorrection } from '@/lib/qrVector';

export interface LocationLabel {
  id: string;
  /** Full path, root → node, e.g. ['Cabinet 1', 'Row 3', 'Left']. */
  path: string[];
}

export interface LocationLabelSheetOptions {
  companyId: string;
  labels: LocationLabel[];
  /**
   * Absolute origin the scan URLs resolve against. Defaults to the pinned production origin — a
   * label printed from a preview deployment would otherwise encode that preview's hostname for the
   * life of the sticker.
   */
  baseUrl?: string;
}

// ---------- Avery 5163 on Letter (612 × 792 pt), in points at 72 per inch ----------
const LABEL_W = 288; // 4"
const LABEL_H = 144; // 2"
const COLS = 2;
const ROWS = 5;
const SHEET_LEFT = 11.25; // 0.15625"
const SHEET_TOP = 36; // 0.5"
const COL_GUTTER = 13.5; // 0.1875"

/** Clear space inside each die-cut label. Printer slop *and* the QR quiet zone — see the header. */
export const LABEL_CONTENT_INSET = 14;

/** The QR fills the label's full content height. */
export const LABEL_QR_SIZE = LABEL_H - LABEL_CONTENT_INSET * 2;

/**
 * Gap between the QR and the text column — the quiet zone on that side, so it is not free to shrink
 * for layout reasons. Asserted in `qrVersionCeiling.test.ts`.
 */
export const LABEL_QR_TEXT_GAP = 16;

/**
 * Level H (~30% recoverable) because a shelf label lives for years and collects grease, dust and
 * scuffs, unlike a traveler sheet that is filed with the job. It is the reason this code runs a
 * version higher than the traveler at the same payload length.
 */
export const LABEL_QR_EC: QrErrorCorrection = 'H';

const TEXT_COL_W = LABEL_W - LABEL_CONTENT_INSET * 2 - LABEL_QR_SIZE - LABEL_QR_TEXT_GAP;
const LABELS_PER_PAGE = COLS * ROWS;

/** Deepest ancestry we print before eliding. Two lines of parents is already more than anyone reads. */
const MAX_PATH_LINES = 2;

/** Top-left of the nth label on a page, in points. */
export function labelOrigin(indexOnPage: number): { x: number; y: number } {
  const col = indexOnPage % COLS;
  const row = Math.floor(indexOnPage / COLS);
  return {
    x: SHEET_LEFT + col * (LABEL_W + COL_GUTTER),
    y: SHEET_TOP + row * LABEL_H,
  };
}

/**
 * Split a location path into the line a person reads first and the line that disambiguates it.
 * A root-level place has no parents, and an empty path is a naming bug we surface rather than hide.
 */
export function splitLabelPath(path: string[]): { name: string; parents: string } {
  const cleaned = path.map((p) => p?.trim()).filter(Boolean) as string[];
  if (cleaned.length === 0) return { name: '(unnamed)', parents: '' };
  return {
    name: cleaned[cleaned.length - 1],
    parents: cleaned.slice(0, -1).join('  ›  '),
  };
}

export async function generateLocationLabelSheet(
  opts: LocationLabelSheetOptions,
): Promise<jsPDF> {
  const { companyId, labels } = opts;
  const baseUrl = opts.baseUrl ?? scanOrigin();
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });

  labels.forEach((label, i) => {
    const onPage = i % LABELS_PER_PAGE;
    if (i > 0 && onPage === 0) doc.addPage();

    const { x, y } = labelOrigin(onPage);
    const contentTop = y + LABEL_CONTENT_INSET;
    const contentBottom = y + LABEL_H - LABEL_CONTENT_INSET;

    drawQrCode(
      doc,
      buildScanUrl({ kind: 'location', companyId, locationId: label.id }, baseUrl),
      {
        x: x + LABEL_CONTENT_INSET,
        y: contentTop,
        size: LABEL_QR_SIZE,
        errorCorrectionLevel: LABEL_QR_EC,
      },
    );

    const textX = x + LABEL_CONTENT_INSET + LABEL_QR_SIZE + LABEL_QR_TEXT_GAP;
    const { name, parents } = splitLabelPath(label.path);

    // Name and path are laid out as one block and centred against the QR, so a one-line label and a
    // three-line one both read as belonging to the code beside them.
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    const nameLines = doc.splitTextToSize(name, TEXT_COL_W);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    let pathLines: string[] = parents ? doc.splitTextToSize(parents, TEXT_COL_W) : [];
    if (pathLines.length > MAX_PATH_LINES) {
      pathLines = pathLines.slice(0, MAX_PATH_LINES);
      pathLines[MAX_PATH_LINES - 1] = `${pathLines[MAX_PATH_LINES - 1].trimEnd()}…`;
    }

    const nameLeading = 15;
    const pathLeading = 11;
    const blockH = nameLines.length * nameLeading + pathLines.length * pathLeading;
    let ty = contentTop + (LABEL_QR_SIZE - blockH) / 2 + 11;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(0);
    nameLines.forEach((line: string) => {
      doc.text(line, textX, ty);
      ty += nameLeading;
    });

    if (pathLines.length) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(110);
      pathLines.forEach((line: string) => {
        doc.text(line, textX, ty);
        ty += pathLeading;
      });
    }

    // Footer weight, pinned to the foot of the label rather than following the text block, so it
    // sits on the same line across every label on the sheet.
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6);
    doc.setTextColor(150);
    doc.text('jigged.app', textX, contentBottom);
  });

  return doc;
}
