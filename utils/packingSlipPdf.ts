/**
 * Generate a printable packing slip PDF for a shipment.
 *
 * Modeled on utils/quotePdf.ts. jsPDF + jspdf-autotable, same letter
 * format and margins. The PDF is generated client-side from a hydrated
 * shipment + the customer's billing address + the company profile.
 *
 * Layout (FR-8, PRD v2.1):
 *   - Header: company logo (top-left when present), company return
 *     address, PACKING SLIP title + PS# + ship date (top-right).
 *   - Bill-to (left) + Ship-to (right) blocks. Bill-to is resolved
 *     from the customer's default-billing address at render time; ship-to
 *     is the shipment.shipping_address_id snapshot. Ship-to surfaces
 *     ATTN: from customer_addresses.attention_to via resolveAttentionLine.
 *   - Line items table (JobBOSS pattern): Job # / Customer PO / Part /
 *     Description / Qty Shipped / Qty Remaining. The Qty Remaining
 *     *column* appears only when at least one line on the slip has
 *     qty_remaining > 0; when present, every cell shows the numeric
 *     value (0 for fully-shipped lines, not blanked). Every slip is a
 *     single job (shipments.job_id), so the per-row Job # / PO are
 *     constant — kept for the JobBOSS-style legibility receiving expects.
 *   - Shipment details block: shipping method label + carrier (carrier
 *     only present when the method is a true shipment), notes.
 *   - Signature lines at the bottom: Received By / Date / Signature.
 *
 * Voided shipments render the same content with a "VOIDED" watermark
 * banner — Phase 3 surfaces this; Phase 1 never reaches the void path.
 */

import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { Company } from '@/utils/companyAccess';
import type { AddressSnapshot } from '@/types/documentSnapshot';
import {
  SHIPPING_METHOD_LABELS,
  describeShipmentFreight,
  type ShipmentWithRelations,
} from '@/types/shipment';
import { resolveAttentionLine } from '@/utils/shipmentsAccess';

const MARGIN = 40;
const ADDRESS_COMBINE_MAX_CHARS = 50;

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  // ship_date is stored as a date scalar (YYYY-MM-DD). Parse the parts
  // directly so US-Pacific viewers don't see "1 day earlier" because of
  // UTC-midnight reinterpretation.
  const ymd = /^\d{4}-\d{2}-\d{2}$/.exec(value);
  if (ymd) {
    const [y, m, d] = value.split('-').map((n) => parseInt(n, 10));
    return new Date(y, m - 1, d).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }
  return new Date(value).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatNumber(value: number | null | undefined, fractionDigits = 2): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return Number(value).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: fractionDigits,
  });
}

export function buildShopHeaderLines(company: Company): string[] {
  const lines: string[] = [];
  const a1 = company.address_line1?.trim();
  const a2 = company.address_line2?.trim();
  if (a1 && a2) {
    const combined = `${a1}, ${a2}`;
    if (combined.length <= ADDRESS_COMBINE_MAX_CHARS) {
      lines.push(combined);
    } else {
      lines.push(a1);
      lines.push(a2);
    }
  } else if (a1) {
    lines.push(a1);
  } else if (a2) {
    lines.push(a2);
  }

  const cityStateZip = [company.city, company.state].filter(Boolean).join(', ');
  const cityStateZipFull = [cityStateZip, company.postal_code]
    .filter(Boolean)
    .join(' ')
    .trim();
  if (cityStateZipFull) lines.push(cityStateZipFull);
  if (company.country && company.country.toUpperCase() !== 'USA') {
    lines.push(company.country);
  }
  if (company.phone) lines.push(company.phone);

  return lines;
}

function buildAddressBlockLines(
  customerName: string | null | undefined,
  address: AddressSnapshot | null,
  attentionText: string | null,
): string[] {
  const lines: string[] = [];
  if (customerName) lines.push(customerName);
  if (attentionText) lines.push(`Attn: ${attentionText}`);
  if (address) {
    if (address.address_line1) lines.push(address.address_line1);
    if (address.address_line2) lines.push(address.address_line2);
    const cityStateZip = [address.city, address.state].filter(Boolean).join(', ');
    const cityStateZipFull = [cityStateZip, address.postal_code]
      .filter(Boolean)
      .join(' ')
      .trim();
    if (cityStateZipFull) lines.push(cityStateZipFull);
    if (address.country && address.country.toUpperCase() !== 'USA') {
      lines.push(address.country);
    }
  }
  if (lines.length === 0) lines.push('(No address on file)');
  return lines;
}

/**
 * Filename used both when downloading and when surfacing in dialogs.
 */
export function packingSlipPdfFilename(shipment: Pick<ShipmentWithRelations, 'packing_slip_number'>): string {
  return `PackingSlip-${shipment.packing_slip_number}.pdf`;
}

/**
 * Pull the company logo as a base64 image so jsPDF can embed it. Skips
 * silently on any failure — the layout falls back to the company name
 * in plain bold text (mirrors the quote PDF).
 */
export async function loadLogoAsDataUrl(
  logoPath: string | null | undefined,
  supabaseClient: SupabaseLike | null,
): Promise<string | null> {
  if (!logoPath || !supabaseClient) return null;
  try {
    const { data, error } = await supabaseClient.storage
      .from('logos')
      .createSignedUrl(logoPath, 60);
    if (error || !data?.signedUrl) return null;
    const resp = await fetch(data.signedUrl);
    if (!resp.ok) return null;
    const blob = await resp.blob();
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve((reader.result as string) ?? null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export interface SupabaseLike {
  storage: {
    from: (bucket: string) => {
      createSignedUrl: (path: string, expiresIn: number) => Promise<{
        data: { signedUrl: string } | null;
        error: { message: string } | null;
      }>;
    };
  };
}

export interface PackingSlipPdfContext {
  shipment: ShipmentWithRelations;
  company: Company;
  /** Optional Supabase client to resolve the logo signed URL. */
  supabase?: SupabaseLike | null;
}

/**
 * Build the jsPDF document for a shipment and return it without writing
 * to disk. Caller chooses how to consume:
 *   - doc.save(filename)              → download
 *   - doc.output('bloburl') as string → preview iframe src
 *   - doc.output('blob')              → Blob for upload
 */
export async function generatePackingSlipPdf(
  ctx: PackingSlipPdfContext,
): Promise<jsPDF> {
  const { shipment, company } = ctx;

  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  // ---------- Header ----------
  const headerTop = MARGIN;
  let logoBottom = headerTop;

  const logoDataUrl = await loadLogoAsDataUrl(company.logo_url, ctx.supabase ?? null);
  if (logoDataUrl) {
    try {
      const logoSize = 56;
      doc.addImage(logoDataUrl, 'PNG', MARGIN, headerTop, logoSize, logoSize, undefined, 'FAST');
      logoBottom = headerTop + logoSize;
    } catch {
      logoBottom = headerTop;
    }
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(30);
  const shopNameX = logoDataUrl ? MARGIN + 70 : MARGIN;
  doc.text(company.name, shopNameX, headerTop + 14);

  const shopLines = buildShopHeaderLines(company);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(80);
  shopLines.forEach((line, i) => {
    doc.text(line, shopNameX, headerTop + 30 + i * 12);
  });
  const shopBlockBottom = Math.max(
    logoBottom,
    headerTop + 30 + shopLines.length * 12,
  );

  // Top-right title + meta
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(26);
  doc.setTextColor(30);
  doc.text('PACKING SLIP', pageWidth - MARGIN, headerTop + 20, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(80);
  doc.text(
    `Packing Slip #: ${shipment.packing_slip_number}`,
    pageWidth - MARGIN,
    headerTop + 40,
    { align: 'right' },
  );
  doc.text(
    `Ship Date: ${formatDate(shipment.ship_date)}`,
    pageWidth - MARGIN,
    headerTop + 54,
    { align: 'right' },
  );

  // Surface job # context — packing slip rolls up by job_part, so list
  // distinct job numbers in the meta block to keep receiving anchored.
  const jobNumbers = Array.from(
    new Set(
      (shipment.shipment_line_items ?? [])
        .map((li) => li.job_part?.job?.job_number)
        .filter((n): n is string => Boolean(n)),
    ),
  );
  if (jobNumbers.length > 0) {
    doc.text(
      `Job${jobNumbers.length > 1 ? 's' : ''}: ${jobNumbers.join(', ')}`,
      pageWidth - MARGIN,
      headerTop + 68,
      { align: 'right' },
    );
  }
  const metaBlockBottom = headerTop + 68 + (jobNumbers.length > 0 ? 0 : -14);

  let cursorY = Math.max(shopBlockBottom, metaBlockBottom) + 18;

  // ---------- VOIDED banner ----------
  if (shipment.voided_at) {
    const bandHeight = 26;
    doc.setFillColor(250, 230, 230);
    doc.rect(MARGIN, cursorY, pageWidth - MARGIN * 2, bandHeight, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(180, 40, 40);
    doc.text(
      `VOIDED ${formatDate(shipment.voided_at)} — KEEP FOR RECORDS`,
      pageWidth / 2,
      cursorY + bandHeight / 2 + 4,
      { align: 'center' },
    );
    cursorY += bandHeight + 8;
  }

  // ---------- Divider ----------
  doc.setDrawColor(210);
  doc.setLineWidth(0.75);
  doc.line(MARGIN, cursorY, pageWidth - MARGIN, cursorY);
  cursorY += 20;

  // ---------- BILL TO (left) + SHIP TO (right) ----------
  // Bill-to resolves to the customer's default-billing customer_addresses
  // row at render time. Ship-to is the shipment.shipping_address_id
  // snapshot. ATTN: on the ship-to side surfaces from the address row.
  const colWidth = (pageWidth - MARGIN * 2) / 2;
  const leftX = MARGIN;
  const rightX = MARGIN + colWidth + 8;

  // Render the frozen snapshots captured on the shipment at issue time
  // (Document Snapshot Standard — snapshot_shipment_party trigger), not the live
  // address rows, so the slip is unchanged after the master address edits/deletes.
  const attention = resolveAttentionLine(shipment);
  const shipLines = buildAddressBlockLines(
    shipment.customer_name,
    shipment.ship_to_address,
    attention.text,
  );

  const billLines = buildAddressBlockLines(
    shipment.customer_name,
    shipment.bill_to_address,
    null,
  );

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text('BILL TO', leftX, cursorY);
  doc.text('SHIP TO', rightX, cursorY);

  // Left: bill-to address (same renderer as ship-to so the two columns
  // visually balance).
  billLines.forEach((line, i) => {
    doc.setFont('helvetica', i === 0 ? 'bold' : 'normal');
    doc.setFontSize(11);
    doc.setTextColor(40);
    doc.text(line, leftX, cursorY + 16 + i * 13);
  });

  // Right: ship-to address.
  shipLines.forEach((line, i) => {
    doc.setFont('helvetica', i === 0 ? 'bold' : 'normal');
    doc.setFontSize(11);
    doc.setTextColor(40);
    doc.text(line, rightX, cursorY + 16 + i * 13);
  });

  const blockLines = Math.max(billLines.length, shipLines.length);
  cursorY = cursorY + 16 + blockLines * 13 + 18;

  // ---------- Line items table ----------
  const lineItems = [...(shipment.shipment_line_items ?? [])];
  lineItems.sort((a, b) => {
    const ja = a.job_part?.job?.job_number ?? '';
    const jb = b.job_part?.job?.job_number ?? '';
    if (ja !== jb) return ja.localeCompare(jb);
    const pa = a.job_part?.part?.part_name ?? '';
    const pb = b.job_part?.part?.part_name ?? '';
    return pa.localeCompare(pb);
  });

  // Per-line remaining = qty_ordered minus this shipment's quantity.
  // Single-document number (not running total) so receiving can
  // reconcile against the PO. Clamped to zero — the FR-4 soft warning
  // already covered over-shipment confirmation upstream.
  const remainingByLine = lineItems.map((li) => {
    const ordered = Number(li.job_part?.quantity ?? 0);
    const shipped = Number(li.quantity);
    return Math.max(0, ordered - shipped);
  });
  // Show the Qty Remaining *column* whenever at least one line on the
  // slip has open backlog. When the column is hidden the whole slip is
  // a clean "everything ordered, everything shipped" document.
  const showRemaining = remainingByLine.some((r) => r > 0);

  // JobBOSS pattern: per-row Job # + Customer PO so a multi-job packing
  // slip is legible without restructuring into sections. Single-job
  // slips have the same value on every row — mildly redundant but
  // consistent with the multi-job case.
  const headRow = [
    'Job #',
    'Customer PO',
    'Part',
    'Description',
    'Qty Shipped',
  ];
  if (showRemaining) headRow.push('Qty Remaining');
  const head = [headRow];

  const body = lineItems.map((li, idx) => {
    const part = li.job_part?.part;
    const jobNumber = li.job_part?.job?.job_number ?? '';
    const po = li.job_part?.job?.customer_po_number ?? '';
    const partName = part?.part_name ?? '—';
    const description = part?.description?.trim() ?? '';
    const qtyShipped = formatNumber(Number(li.quantity));
    const remaining = remainingByLine[idx];
    const row = [
      jobNumber || '—',
      po || '—',
      partName,
      description,
      qtyShipped,
    ];
    // PRD v2.1 / FR-8: when the column is present, every cell shows
    // the numeric value including 0 — cells are not blanked.
    if (showRemaining) row.push(formatNumber(remaining));
    return row;
  });

  if (body.length === 0) {
    const emptyRow = ['—', '—', '—', '', '—'];
    if (showRemaining) emptyRow.push('—');
    body.push(emptyRow);
  }

  autoTable(doc, {
    startY: cursorY,
    margin: { left: MARGIN, right: MARGIN },
    head,
    body,
    styles: {
      font: 'helvetica',
      fontSize: 10,
      cellPadding: 7,
      textColor: [40, 40, 40],
    },
    headStyles: {
      fillColor: [240, 240, 240],
      textColor: [30, 30, 30],
      fontStyle: 'bold',
      lineColor: [200, 200, 200],
      lineWidth: 0.5,
    },
    columnStyles: showRemaining
      ? {
          0: { cellWidth: 70 },
          1: { cellWidth: 80 },
          2: { cellWidth: 90, fontStyle: 'bold' },
          3: { cellWidth: 'auto' },
          4: { cellWidth: 70, halign: 'right' },
          5: { cellWidth: 80, halign: 'right' },
        }
      : {
          0: { cellWidth: 80 },
          1: { cellWidth: 90 },
          2: { cellWidth: 110, fontStyle: 'bold' },
          3: { cellWidth: 'auto' },
          4: { cellWidth: 80, halign: 'right' },
        },
    theme: 'grid',
  });

  cursorY =
    (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ??
    cursorY + 60;
  cursorY += 18;

  // ---------- Shipment details ----------
  const methodLabel = shipment.shipping_method
    ? SHIPPING_METHOD_LABELS[shipment.shipping_method]
    : null;

  const details: Array<[string, string]> = [];
  if (methodLabel) details.push(['Shipping Method', methodLabel]);
  if (shipment.carrier) details.push(['Carrier', shipment.carrier]);
  // Freight, rendered from the FROZEN snapshot rather than the live account —
  // this slip must still say what it said a year from now, even if the account
  // is edited or archived (Document Snapshot Standard).
  //
  // REDACTED BY CONSTRUCTION: the snapshot only ever holds the last 4, because
  // this page rides in the box past carriers, docks and whoever opens the
  // carton. `has_account` is what distinguishes "billed to their account" from
  // "billed on the bill of lading" when nothing can be revealed — an account of
  // 4 characters or fewer has no last-4, since showing 3 of 4 is not redaction.
  const freightLine = describeShipmentFreight(shipment);
  if (freightLine) details.push(['Freight', freightLine]);

  if (details.length > 0) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text('SHIPMENT DETAILS', MARGIN, cursorY);
    cursorY += 14;

    doc.setFontSize(11);
    details.forEach(([label, value]) => {
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(120);
      doc.text(`${label}:`, MARGIN, cursorY);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(40);
      const wrapped = doc.splitTextToSize(value, pageWidth - MARGIN * 2 - 130);
      doc.text(wrapped, MARGIN + 130, cursorY);
      cursorY += Math.max(14, wrapped.length * 13);
    });
    cursorY += 6;
  }

  // ---------- Signature lines ----------
  const sigBlockHeight = 56;
  if (cursorY + sigBlockHeight > pageHeight - MARGIN - 30) {
    doc.addPage();
    cursorY = MARGIN;
  } else {
    cursorY += 10;
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text('RECEIVED BY', MARGIN, cursorY);
  cursorY += 28;

  doc.setDrawColor(160);
  doc.setLineWidth(0.5);
  const sigLineY = cursorY + 8;
  doc.line(MARGIN, sigLineY, MARGIN + 240, sigLineY);
  doc.line(MARGIN + 270, sigLineY, MARGIN + 430, sigLineY);
  doc.line(MARGIN + 460, sigLineY, pageWidth - MARGIN, sigLineY);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text('Signature', MARGIN, sigLineY + 11);
  doc.text('Print Name', MARGIN + 270, sigLineY + 11);
  doc.text('Date', MARGIN + 460, sigLineY + 11);

  // ---------- Footer (every page) ----------
  const pageCount = doc.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    const footerY = pageHeight - MARGIN;
    doc.setDrawColor(230);
    doc.setLineWidth(0.5);
    doc.line(MARGIN, footerY - 14, pageWidth - MARGIN, footerY - 14);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(130);
    doc.text(
      `Generated ${formatDate(new Date().toISOString())} · ${company.name}`,
      MARGIN,
      footerY,
    );
    doc.text(`Page ${p} of ${pageCount}`, pageWidth - MARGIN, footerY, { align: 'right' });
  }

  return doc;
}
