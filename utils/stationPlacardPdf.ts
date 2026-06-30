/**
 * Multi-page station-QR placard PDF — one full A4 page per work center.
 *
 * Mirrors the single-placard layout in components/operations/StationQRCode.tsx
 * (company name, big centered QR, station name header, optional code, scan
 * instruction) but batches every station into one printable document so a shop
 * can print, laminate, and post the whole floor in one pass instead of
 * downloading one PDF per work center.
 *
 * QR generation follows locationLabelPdf (QRCode.toDataURL up front, level 'H'
 * for ~30% damage tolerance so a scuffed shop-floor placard still scans). The
 * payload is the work-center deep-link into the operator login, identical to the
 * single-placard component — scanning it selects the station and lands the
 * operator on that station's job list.
 */
import { jsPDF } from 'jspdf';
import QRCode from 'qrcode';

export interface StationPlacard {
  /** Work center id — encoded into the scan URL. */
  id: string;
  /** Station name, printed as the page header. */
  name: string;
  /** Optional short code (e.g. metadata.code), printed under the QR. */
  code: string | null;
}

export interface StationPlacardOptions {
  companyId: string;
  /** Absolute origin the scan URLs resolve against (window.location.origin). */
  baseUrl: string;
  placards: StationPlacard[];
  /** Printed at the top of each placard, e.g. the shop name. */
  companyName?: string;
}

export function buildStationScanUrl(
  baseUrl: string,
  companyId: string,
  workCenterId: string,
): string {
  return `${baseUrl}/operator/${companyId}/login?station=${workCenterId}`;
}

export async function generateStationPlacards(
  opts: StationPlacardOptions,
): Promise<jsPDF> {
  const { companyId, baseUrl, placards, companyName } = opts;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();

  // Layout matches the single placard: 80mm QR, centered, near the top.
  const qrSize = 80;
  const qrX = (pageWidth - qrSize) / 2;
  const qrY = 60;

  // Pre-render every QR as a PNG data URL (level H ≈ 30% damage tolerance).
  const dataUrls = await Promise.all(
    placards.map((p) =>
      QRCode.toDataURL(buildStationScanUrl(baseUrl, companyId, p.id), {
        margin: 2,
        width: 320,
        errorCorrectionLevel: 'H',
      }).catch(() => null),
    ),
  );

  placards.forEach((placard, i) => {
    if (i > 0) doc.addPage();

    // Company name at top (optional).
    if (companyName) {
      doc.setFontSize(14);
      doc.setTextColor(100);
      doc.text(companyName, pageWidth / 2, 30, { align: 'center' });
    }

    // Station name header.
    doc.setFontSize(24);
    doc.setTextColor(0);
    doc.text(placard.name || '(unnamed station)', pageWidth / 2, companyName ? 45 : 35, {
      align: 'center',
    });

    // QR code.
    const dataUrl = dataUrls[i];
    if (dataUrl) {
      try {
        doc.addImage(dataUrl, 'PNG', qrX, qrY, qrSize, qrSize, undefined, 'FAST');
      } catch {
        /* skip the image, keep the text so the page is still usable */
      }
    }

    // Optional code below the QR.
    if (placard.code) {
      doc.setFontSize(16);
      doc.setTextColor(50);
      doc.text(placard.code, pageWidth / 2, qrY + qrSize + 15, { align: 'center' });
    }

    // Scan instruction.
    doc.setFontSize(12);
    doc.setTextColor(100);
    doc.text(
      'Scan this QR code to open the Operator View for this station',
      pageWidth / 2,
      qrY + qrSize + (placard.code ? 30 : 15),
      { align: 'center' },
    );
  });

  return doc;
}
