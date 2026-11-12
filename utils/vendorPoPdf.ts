/**
 * The purchase order to a vendor — the document the vendor works from (plan §3.13 "PDFs").
 *
 * In one sentence: *please supply these lines, at these prices, by these dates, to this address,
 * on these terms.*
 *
 * A sibling of the outside-processing slip (utils/outsideShipmentPdf.ts) and built the same way,
 * on the packing slip's primitives, so every document a shop sends reads as coming from one shop:
 * the letterhead, the grid table, the footer. The recipe, in order:
 *
 *   1. The right-hand META column is measured FIRST, because it sets the header's height and so the
 *      room the logo may take (sizing the logo before knowing that is how the packing slip ended up
 *      with a 56pt box).
 *   2. The DRAFT / CLOSED banners.
 *   3. A divider, then the two party blocks — VENDOR and SHIP TO — from the PO's FROZEN copies. A PO
 *      is a document: editing the vendor's address book later must not reprint it differently.
 *   4. The lines from ONE declarative column spec, so a header can never drift from its cells.
 *   5. The total, then the notes to the vendor and the terms & conditions — the body font is set
 *      BEFORE `splitTextToSize`, which measures against the CURRENT font (the bug quotePdf.ts and
 *      outsideShipmentPdf.ts both document, and a mocked suite cannot see).
 *   6. The footer on every page, AFTER the content has paginated.
 *
 * WHAT NEVER PRINTS, by construction rather than by care: the internal notes and the promised
 * dates. This file does not read either field, so no layout change can leak them.
 */
import { jsPDF } from 'jspdf';
import autoTable, { type Styles } from 'jspdf-autotable';

import type { Company } from '@/utils/companyAccess';
import { readLogoIncludesName } from '@/lib/companyDefaults';
import { formatMoney } from '@/lib/money';
import { formatVendorPoAmount, formatVendorPoUnitPrice, vendorPoTotal } from '@/lib/purchasing/amount';
import { formatUnitQuantity, unitLabel } from '@/lib/purchasing/purchaseUnits';
import type { VendorPoDetail, VendorPoLine } from '@/types/vendorPo';
import {
  attributionLine,
  buildAddressBlockLines,
  drawShopHeaderBlock,
  formatDate,
  loadLogoAsDataUrl,
  metaColumnBottom,
  type SupabaseLike,
} from '@/utils/packingSlipPdf';

const MARGIN = 40;
const LINE_H = 13;

/** `PO-1042.pdf`, or `PO-1042-rev2.pdf` once the PO has been revised. */
export function vendorPoPdfFilename(poNumber: string, revision: number): string {
  return revision > 0 ? `${poNumber}-rev${revision}.pdf` : `${poNumber}.pdf`;
}

export interface VendorPoPdfContext {
  po: VendorPoDetail;
  company: Company;
  supabase?: SupabaseLike | null;
}

interface PoColumn {
  header: string;
  cell: (line: VendorPoLine) => string;
  style: Partial<Styles>;
}

/**
 * Everything the vendor needs to know about one line, in its Item cell: what it is, their part
 * number, the job it is for, the machine, and whether certs must ship with it.
 */
function itemCell(line: VendorPoLine): string {
  const parts = [line.description];
  if (line.lineKind === 'part' && line.partName && line.partName !== line.description) {
    parts.push(`Our part #: ${line.partName}`);
  }
  if (line.vendorPartNumber) parts.push(`Your part #: ${line.vendorPartNumber}`);
  // An outside line's description already names its job and operation.
  if (line.lineKind !== 'outside_service' && line.jobNumber) parts.push(`For job ${line.jobNumber}`);
  if (line.lineKind === 'other' && line.workCenterName) parts.push(`For machine: ${line.workCenterName}`);
  if (line.certRequired) parts.push('Certs required');
  if (line.closedAt) parts.push('Closed — nothing more expected on this line');
  return parts.join('\n');
}

const COLUMNS: PoColumn[] = [
  { header: '#', cell: (l) => String(l.lineNumber), style: { cellWidth: 26, halign: 'right' } },
  { header: 'Item', cell: itemCell, style: { cellWidth: 'auto' } },
  { header: 'Qty', cell: (l) => formatUnitQuantity(l.quantity), style: { cellWidth: 54, halign: 'right' } },
  { header: 'Unit', cell: (l) => unitLabel(l.unit), style: { cellWidth: 48 } },
  // The NEED-BY date: what we asked for. A promised date is internal and never prints.
  { header: 'Due', cell: (l) => (l.needByOn ? formatDate(l.needByOn) : '—'), style: { cellWidth: 74 } },
  { header: 'Unit price', cell: (l) => formatVendorPoUnitPrice(l.unitPrice), style: { cellWidth: 72, halign: 'right' } },
  {
    header: 'Amount',
    cell: (l) => formatVendorPoAmount(l.amount),
    style: { cellWidth: 72, halign: 'right', fontStyle: 'bold' },
  },
];

/**
 * Build the jsPDF document and return it unwritten. The caller chooses:
 *   doc.save(vendorPoPdfFilename(…))   -> download
 *   doc.output('bloburl').toString()   -> preview iframe src (jsPDF types it as a URL)
 */
export async function generateVendorPoPdf(ctx: VendorPoPdfContext): Promise<jsPDF> {
  const { po, company } = ctx;
  const { header, lines, summary } = po;

  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const contentWidth = pageWidth - MARGIN * 2;
  const footerTop = pageHeight - MARGIN - 30;
  const headerTop = MARGIN;

  // ---------- Header: meta column FIRST ----------
  const metaLines: string[] = [`PO #: ${header.poNumber}`];
  if (header.revision > 0) metaLines.push(`Rev: ${header.revision}`);
  metaLines.push(`Date: ${formatDate(header.orderedOn)}`);
  if (header.needByOn) metaLines.push(`Need by: ${formatDate(header.needByOn)}`);
  if (header.paymentTerms) metaLines.push(`Terms: ${header.paymentTerms}`);
  if (header.shipVia) metaLines.push(`Ship via: ${header.shipVia}`);
  const logoDataUrl = await loadLogoAsDataUrl(company.logo_url, ctx.supabase ?? null);
  // A PO prints 2 to 6 meta lines; with a logo the column measures a floor of rows, or a PO with
  // only its number and date would print the shop's logo as a speck, or not at all.
  const metaBlockBottom = metaColumnBottom(headerTop, metaLines.length, logoDataUrl !== null);

  const shopBlockBottom = drawShopHeaderBlock(doc, {
    company,
    logoDataUrl,
    logoIncludesName: readLogoIncludesName(company),
    x: MARGIN,
    y: headerTop,
    availableBottom: metaBlockBottom,
    nameSize: 14,
  });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(30);
  doc.text('PURCHASE ORDER', pageWidth - MARGIN, headerTop + 18, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(80);
  metaLines.forEach((line, i) => {
    doc.text(line, pageWidth - MARGIN, headerTop + 36 + i * 14, { align: 'right' });
  });

  let cursorY = Math.max(shopBlockBottom, metaBlockBottom) + 18;

  // ---------- Banners ----------
  // DRAFT only when the PO was never sent: a revision not yet sent is still a real order the
  // vendor holds, so it prints as Rev N, not as a draft. "Mark as sent & download" stamps the send
  // first, so the file that goes out never carries this band.
  const banners: Array<{ text: string; fill: [number, number, number]; color: [number, number, number] }> = [];
  if (header.issuedAt === null) {
    banners.push({ text: 'DRAFT — NOT YET SENT TO THE VENDOR', fill: [253, 243, 214], color: [140, 95, 0] });
  }
  if (summary.status === 'closed') {
    banners.push({
      text: header.closedAt
        ? `CLOSED ${formatDate(header.closedAt)} — NOTHING MORE EXPECTED`
        : 'CLOSED — NOTHING MORE EXPECTED',
      fill: [235, 235, 235],
      color: [70, 70, 70],
    });
  }
  for (const banner of banners) {
    const bandHeight = 26;
    doc.setFillColor(...banner.fill);
    doc.rect(MARGIN, cursorY, contentWidth, bandHeight, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(...banner.color);
    doc.text(banner.text, pageWidth / 2, cursorY + bandHeight / 2 + 4, { align: 'center' });
    cursorY += bandHeight + 8;
  }

  // ---------- Divider ----------
  doc.setDrawColor(210);
  doc.setLineWidth(0.75);
  doc.line(MARGIN, cursorY, pageWidth - MARGIN, cursorY);
  cursorY += 20;

  // ---------- Parties, from the frozen copies ----------
  const vendorLines = buildAddressBlockLines(
    header.vendorName,
    header.vendorAddress,
    header.vendorContact?.name ?? header.vendorAddress?.attention_to ?? null,
  );
  // The shared renderer's fallback only fires when it has NOTHING, and it always has the name, so a
  // vendor with no address would print as a lone name that reads like a truncation.
  if (!header.vendorAddress) vendorLines.push('(No address on file)');
  if (header.vendorContact?.email) vendorLines.push(header.vendorContact.email);
  if (header.vendorContact?.phone) vendorLines.push(header.vendorContact.phone);

  const shipToLines = buildAddressBlockLines(header.shipToName, header.shipToAddress, header.shipToAddress?.attention_to ?? null);
  if (!header.shipToAddress) shipToLines.push('(No address on file)');

  const gap = 24;
  const blockWidth = (contentWidth - gap) / 2;
  const drawBlock = (heading: string, blockLines: string[], x: number): number => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text(heading, x, cursorY);
    let rows = 0;
    for (const [i, line] of blockLines.entries()) {
      // Measured in the font it is DRAWN in: line 0 is bold. A legal name is long enough to need it.
      doc.setFont('helvetica', i === 0 ? 'bold' : 'normal');
      doc.setFontSize(11);
      doc.setTextColor(40);
      for (const part of doc.splitTextToSize(line, blockWidth) as string[]) {
        doc.text(part, x, cursorY + 16 + rows * LINE_H);
        rows += 1;
      }
    }
    return rows;
  };
  const vendorRows = drawBlock('VENDOR', vendorLines, MARGIN);
  const shipRows = drawBlock('SHIP TO', shipToLines, MARGIN + blockWidth + gap);
  cursorY += 16 + Math.max(vendorRows, shipRows) * LINE_H + 16;

  // ---------- Lines ----------
  // The end of the table comes back through autoTable's typed hook: `doc.lastAutoTable` is an
  // untyped property, and reading it would need a cast this codebase does not allow.
  let tableEndY = cursorY;
  autoTable(doc, {
    startY: cursorY,
    margin: { left: MARGIN, right: MARGIN, bottom: MARGIN + 30 },
    // A line never splits across pages: the default carries the tail of a long Item cell onto the
    // next page with no line number beside it, where the vendor reads it as a line of its own.
    rowPageBreak: 'avoid',
    head: [COLUMNS.map((c) => c.header)],
    body: lines.map((line) => COLUMNS.map((c) => c.cell(line))),
    styles: { font: 'helvetica', fontSize: 9.5, cellPadding: 6, textColor: [40, 40, 40], valign: 'top' },
    headStyles: {
      fillColor: [240, 240, 240],
      textColor: [30, 30, 30],
      fontStyle: 'bold',
      fontSize: 9,
      lineColor: [200, 200, 200],
      lineWidth: 0.5,
    },
    columnStyles: Object.fromEntries(COLUMNS.map((c, i) => [String(i), c.style])),
    theme: 'grid',
    didDrawPage: (data) => {
      if (data.cursor) tableEndY = data.cursor.y;
    },
  });
  cursorY = tableEndY + 20;

  // ---------- Total ----------
  if (cursorY + 40 > footerTop) {
    doc.addPage();
    cursorY = MARGIN;
  }
  const total = vendorPoTotal(lines.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice })));
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(30);
  doc.text('Total', pageWidth - MARGIN - 110, cursorY, { align: 'right' });
  doc.text(formatMoney(total.total), pageWidth - MARGIN, cursorY, { align: 'right' });
  cursorY += 16;
  if (total.unpricedLineCount > 0) {
    const n = total.unpricedLineCount;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text(`Plus ${n} line${n === 1 ? '' : 's'} to be confirmed (TBC)`, pageWidth - MARGIN, cursorY, { align: 'right' });
    cursorY += 14;
  }
  cursorY += 14;

  // ---------- Notes to the vendor, then the terms ----------
  const drawSection = (heading: string, text: string | null) => {
    const body = text?.trim();
    if (!body) return;
    if (cursorY + 30 > footerTop) {
      doc.addPage();
      cursorY = MARGIN;
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text(heading, MARGIN, cursorY);
    cursorY += 16;

    // SET THE BODY FONT BEFORE MEASURING: the heading just left it at bold 9.
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(40);
    // Split on the shop's own newlines first, so their line breaks survive.
    const wrapped = body.split('\n').flatMap((para) => doc.splitTextToSize(para, contentWidth) as string[]);
    for (const line of wrapped) {
      if (cursorY > footerTop) {
        doc.addPage();
        cursorY = MARGIN;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.setTextColor(40);
      }
      doc.text(line, MARGIN, cursorY);
      cursorY += LINE_H;
    }
    cursorY += 16;
  };
  drawSection('NOTES', header.notesToVendor);
  drawSection('TERMS AND CONDITIONS', header.termsAndConditions);

  // ---------- Footer (every page), AFTER everything has paginated ----------
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
    doc.text(attributionLine(), MARGIN, footerY);
    doc.text(`Page ${p} of ${pageCount}`, pageWidth - MARGIN, footerY, { align: 'right' });
  }

  return doc;
}
