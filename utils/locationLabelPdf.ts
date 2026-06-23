/**
 * Avery-style QR label sheet for inventory locations.
 *
 * Mirrors the batch-QR approach in jobTravelerPdf (QRCode.toDataURL up front,
 * level 'H' per the QR design decision) and lays the labels out in a grid. Each
 * label shows the QR (payload = the location UUID deep-link, so relabeling never
 * breaks it) plus the full human path and code — the physical label must match
 * the software's naming.
 */
import { jsPDF } from 'jspdf';
import QRCode from 'qrcode';

export interface LocationLabel {
  id: string;
  /** Full path, root → node, e.g. ['Cabinet 1', 'Row 3', 'Left']. */
  path: string[];
  code: string | null;
}

export interface LocationLabelSheetOptions {
  companyId: string;
  /** Absolute origin the scan URLs resolve against (window.location.origin). */
  baseUrl: string;
  labels: LocationLabel[];
  /** Optional heading printed once at the top of page 1. */
  heading?: string;
}

const A4 = { w: 210, h: 297 };
const MARGIN = 12;
const COLS = 2;
const ROWS = 5; // 10 labels per page
const QR_MM = 34;

export function buildLocationScanUrl(baseUrl: string, companyId: string, locationId: string): string {
  return `${baseUrl}/operator/${companyId}/login?location=${locationId}`;
}

export async function generateLocationLabelSheet(
  opts: LocationLabelSheetOptions,
): Promise<jsPDF> {
  const { companyId, baseUrl, labels, heading } = opts;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  const cellW = (A4.w - 2 * MARGIN) / COLS;
  const headingH = heading ? 10 : 0;
  const cellH = (A4.h - 2 * MARGIN - headingH) / ROWS;
  const perPage = COLS * ROWS;

  // Pre-render every QR as a PNG data URL (level H ≈ 30% damage tolerance).
  const dataUrls = await Promise.all(
    labels.map((l) =>
      QRCode.toDataURL(buildLocationScanUrl(baseUrl, companyId, l.id), {
        margin: 2,
        width: 320,
        errorCorrectionLevel: 'H',
      }).catch(() => null),
    ),
  );

  labels.forEach((label, i) => {
    const onPage = i % perPage;
    if (i > 0 && onPage === 0) doc.addPage();

    if (onPage === 0 && heading) {
      doc.setFontSize(12);
      doc.setTextColor(80);
      doc.text(heading, MARGIN, MARGIN);
    }

    const col = onPage % COLS;
    const row = Math.floor(onPage / COLS);
    const x = MARGIN + col * cellW;
    const y = MARGIN + headingH + row * cellH;

    const dataUrl = dataUrls[i];
    if (dataUrl) {
      try {
        doc.addImage(dataUrl, 'PNG', x, y + (cellH - QR_MM) / 2, QR_MM, QR_MM, undefined, 'FAST');
      } catch {
        /* skip image, keep text */
      }
    }

    const textX = x + QR_MM + 5;
    const textW = cellW - QR_MM - 8;
    let ty = y + cellH / 2 - 4;

    doc.setFontSize(11);
    doc.setTextColor(0);
    const pathLines = doc.splitTextToSize(label.path.join('  ›  ') || '(unnamed)', textW);
    doc.text(pathLines, textX, ty);
    ty += pathLines.length * 5 + 1;

    if (label.code) {
      doc.setFontSize(10);
      doc.setTextColor(90);
      doc.text(label.code, textX, ty);
    }
  });

  return doc;
}
