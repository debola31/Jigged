/**
 * A request for quotation, as ONE vendor receives it (plan §3.9, §3.13 "PDFs"; criterion Q1).
 *
 * In one sentence: *please price these things, at these quantities, by this date.*
 *
 * It is a sibling of the packing slips and reads like one — the same letterhead primitive, the same
 * grid table, the same footer — so a shop's paperwork looks like it came from one shop. Three rules
 * make it an RFQ rather than a copy of the PO:
 *
 *   - **Addressed to one vendor.** Each invited vendor gets its own copy, and nothing on it names
 *     another invited vendor. Shops ask several vendors at once; telling Acme that Beta was asked
 *     too is the shop's business, not the paper's.
 *   - **That vendor's part numbers only.** "Your part #" is THIS vendor's number for the part — from
 *     its approved-vendor row, else from its own quote — never another vendor's. A part number is
 *     how a vendor finds the item in its catalogue; another supplier's number is noise at best and a
 *     leak at worst.
 *   - **No prices, ever.** The RFQ asks for prices. Printing one — a quote already in from another
 *     vendor, a last price paid — tells the vendor what to beat. There is no price column and nothing
 *     here reads a price.
 *
 * Internal notes never print. Notes to vendors do.
 *
 * WRAP HAZARD, which a mocked suite cannot see: `splitTextToSize` measures in whatever font the
 * document is CURRENTLY in, so every block sets its font before measuring (the same bug
 * utils/outsideShipmentPdf.ts and utils/quotePdf.ts document).
 */
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { Styles } from 'jspdf-autotable';

import type { Company } from '@/utils/companyAccess';
import type { ContactSnapshot } from '@/types/documentSnapshot';
import { readLogoIncludesName } from '@/lib/companyDefaults';
import { formatUnitQuantity } from '@/lib/purchasing/purchaseUnits';
import type { VendorRfqDetail, VendorRfqLine } from '@/types/vendorRfq';
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

/** What the vendor is asked for. Printed on every copy, and the sentence the tests hold to. */
export const RFQ_QUOTE_REQUEST =
  'Please quote your unit price at each quantity, your lead time, your minimum order, and how long the price is good for.';

/** A part's number at a vendor — from the approved-vendor list (`part_vendors.vendor_part_number`). */
export interface RfqVendorPartNumber {
  partId: string;
  vendorId: string;
  vendorPartNumber: string | null;
}

export interface RfqPdfContext {
  rfq: Pick<VendorRfqDetail, 'header' | 'lines' | 'invitations' | 'responses'>;
  /** The invitation this copy is for. Every vendor gets its own. */
  invitationId: string;
  company: Company;
  /**
   * Part numbers by vendor. May hold any vendor's: this file keeps only the addressed vendor's, so
   * the "only that vendor's numbers" rule lives here, where its test is.
   */
  vendorPartNumbers: readonly RfqVendorPartNumber[];
  supabase?: SupabaseLike | null;
}

/**
 * The email that carries one vendor's copy — "PDF plus mailto, like quotes" (plan §2). A mailto
 * cannot attach a file, so the body says the RFQ is attached and the person attaches the download.
 * `null` when the frozen contact has no email: a link to nobody is worse than no link.
 */
export function rfqEmailHref(args: {
  rfqNumber: string;
  title: string | null;
  respondByOn: string | null;
  /** Our shop, as frozen on the RFQ (`ship_to_name`). */
  shopName: string;
  contact: ContactSnapshot | null;
}): string | null {
  const email = args.contact?.email?.trim();
  if (!email) return null;
  const firstName = args.contact?.name?.trim().split(/\s+/)[0] ?? '';
  const title = args.title?.trim();
  const body = [
    firstName ? `Hello ${firstName},` : 'Hello,',
    '',
    `Our request for quote ${args.rfqNumber}${title ? ` (${title})` : ''} is attached.`,
    RFQ_QUOTE_REQUEST,
    args.respondByOn ? `Please reply by ${formatDate(args.respondByOn)}.` : null,
    '',
    'Thank you,',
    args.shopName,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
  const subject = `${args.rfqNumber} — request for quote from ${args.shopName}`;
  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** `RFQ-0007-Acme-Steel-Inc.pdf` — the RFQ, then who it is for, so two copies never collide. */
export function rfqPdfFilename(rfqNumber: string, vendorName: string): string {
  const vendor = vendorName
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return vendor ? `${rfqNumber}-${vendor}.pdf` : `${rfqNumber}.pdf`;
}

interface RfqColumn {
  header: string;
  style: Partial<Styles>;
  cell: (line: VendorRfqLine) => string;
}

/** The line's item text: the description, then "Certs required" and the line note, one per row. */
function itemText(line: VendorRfqLine): string {
  const parts = [line.description.trim()];
  if (line.certRequired) parts.push('Certs required');
  const note = line.notes?.trim();
  if (note) parts.push(`Note: ${note}`);
  return parts.filter(Boolean).join('\n');
}

/**
 * Build the jsPDF document for one invited vendor and return it unwritten. The caller chooses:
 *   doc.save(filename)                       -> download
 *   doc.output('bloburl').toString()         -> preview iframe src
 */
export async function generateRfqPdf(ctx: RfqPdfContext): Promise<jsPDF> {
  const { rfq, company } = ctx;
  const invitation = rfq.invitations.find((i) => i.id === ctx.invitationId);
  if (!invitation) throw new Error('That vendor is not on this RFQ.');

  // THIS vendor's numbers only: its approved-vendor row first, then what it wrote on its own quote.
  const ownNumbers = new Map<string, string>();
  for (const r of rfq.responses) {
    if (r.invitationId !== invitation.id || !r.vendorPartNumber?.trim()) continue;
    const line = rfq.lines.find((l) => l.id === r.lineId);
    if (line && !ownNumbers.has(line.id)) ownNumbers.set(line.id, r.vendorPartNumber.trim());
  }
  const listNumbers = new Map<string, string>();
  for (const n of ctx.vendorPartNumbers) {
    if (n.vendorId !== invitation.vendorId || !n.vendorPartNumber?.trim()) continue;
    listNumbers.set(n.partId, n.vendorPartNumber.trim());
  }
  const yourPartNumber = (line: VendorRfqLine) =>
    (line.partId ? listNumbers.get(line.partId) : undefined) ?? ownNumbers.get(line.id) ?? '';

  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const headerTop = MARGIN;
  const contentWidth = pageWidth - MARGIN * 2;

  // ---------- Header ----------
  // The RIGHT column is measured first: it sets the header's height and so the room the logo gets.
  const metaLines: string[] = [`RFQ #: ${rfq.header.rfqNumber}`, `Date: ${formatDate(rfq.header.createdAt)}`];
  if (rfq.header.respondByOn) metaLines.push(`Respond by: ${formatDate(rfq.header.respondByOn)}`);
  if (rfq.header.neededByOn) metaLines.push(`Needed by: ${formatDate(rfq.header.neededByOn)}`);
  const logoDataUrl = await loadLogoAsDataUrl(company.logo_url, ctx.supabase ?? null);
  // 2 to 4 meta lines; with a logo the column measures a floor of rows (see metaColumnBottom).
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

  // 20pt: "REQUEST FOR QUOTE" is longer than "PACKING SLIP", and the meta line under it is the
  // widest thing in this column, so the title sits with it rather than reaching into the letterhead.
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(30);
  doc.text('REQUEST FOR QUOTE', pageWidth - MARGIN, headerTop + 18, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(80);
  metaLines.forEach((line, i) => {
    doc.text(line, pageWidth - MARGIN, headerTop + 36 + i * 14, { align: 'right' });
  });

  let cursorY = Math.max(shopBlockBottom, metaBlockBottom) + 18;

  // ---------- Divider ----------
  doc.setDrawColor(210);
  doc.setLineWidth(0.75);
  doc.line(MARGIN, cursorY, pageWidth - MARGIN, cursorY);
  cursorY += 20;

  // ---------- TO (the one vendor) + SHIP TO (our shop, frozen on the RFQ) ----------
  const colWidth = contentWidth / 2 - 8;
  const leftX = MARGIN;
  const rightX = MARGIN + contentWidth / 2 + 8;

  const contact = invitation.vendorContact;
  const toLines: string[] = [invitation.vendorName];
  if (contact?.name?.trim()) toLines.push(`Attn: ${contact.name.trim()}`);
  if (contact?.email?.trim()) toLines.push(contact.email.trim());
  if (contact?.phone?.trim()) toLines.push(contact.phone.trim());

  const shipLines = buildAddressBlockLines(rfq.header.shipToName, rfq.header.shipToAddress, null);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text('TO', leftX, cursorY);
  doc.text('SHIP TO', rightX, cursorY);

  /**
   * Both blocks WRAP. A vendor's name here is its legal name and those run long — the outside-slip
   * suite found one at 270pt against a half-width column. Each line is measured in the font it is
   * DRAWN in (the first line is bold), or the heading wraps against body metrics and still overruns.
   */
  const drawBlock = (lines: string[], x: number): number => {
    let rows = 0;
    for (const [i, line] of lines.entries()) {
      doc.setFont('helvetica', i === 0 ? 'bold' : 'normal');
      doc.setFontSize(11);
      doc.setTextColor(40);
      for (const part of doc.splitTextToSize(line, colWidth) as string[]) {
        doc.text(part, x, cursorY + 16 + rows * 13);
        rows += 1;
      }
    }
    return rows;
  };
  const toRows = drawBlock(toLines, leftX);
  const shipRows = drawBlock(shipLines, rightX);
  cursorY += 16 + Math.max(toRows, shipRows) * 13 + 14;

  // ---------- What we are asking ----------
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(40);
  const ask = [
    rfq.header.title?.trim() ? `${rfq.header.title.trim()}.` : null,
    RFQ_QUOTE_REQUEST,
    rfq.header.respondByOn ? `Please reply by ${formatDate(rfq.header.respondByOn)}.` : null,
  ]
    .filter((s): s is string => Boolean(s))
    .join(' ');
  for (const line of doc.splitTextToSize(ask, contentWidth) as string[]) {
    doc.text(line, MARGIN, cursorY);
    cursorY += 13;
  }
  cursorY += 8;

  // ---------- The lines (one declarative spec drives head, body and column styles) ----------
  const columns: RfqColumn[] = [
    { header: '#', style: { cellWidth: 24, halign: 'right' }, cell: (l) => String(l.lineNumber) },
    { header: 'Part', style: { cellWidth: 96, fontStyle: 'bold' }, cell: (l) => l.partName ?? '—' },
    // 104pt holds a 16-character vendor number in capitals; at 84 "ACME-6061-RB1" broke mid-token.
    { header: 'Your part #', style: { cellWidth: 104 }, cell: (l) => yourPartNumber(l) || '—' },
    { header: 'Description', style: { cellWidth: 'auto' }, cell: itemText },
    {
      header: 'Quantities',
      style: { cellWidth: 92, halign: 'right' },
      cell: (l) => l.quantities.map((q) => formatUnitQuantity(q)).join(', '),
    },
    { header: 'Unit', style: { cellWidth: 50 }, cell: (l) => l.unit },
  ];
  const lines = [...rfq.lines].sort((a, b) => a.lineNumber - b.lineNumber);

  autoTable(doc, {
    startY: cursorY,
    // The bottom margin keeps a long table clear of the footer drawn on every page below.
    margin: { left: MARGIN, right: MARGIN, bottom: MARGIN + 30 },
    // A line never splits across pages (see vendorPoPdf.ts): its tail would read as a line of its own.
    rowPageBreak: 'avoid',
    head: [columns.map((c) => c.header)],
    body: lines.length > 0 ? lines.map((l) => columns.map((c) => c.cell(l))) : [columns.map(() => '—')],
    styles: { font: 'helvetica', fontSize: 10, cellPadding: 7, textColor: [40, 40, 40] },
    headStyles: {
      fillColor: [240, 240, 240],
      textColor: [30, 30, 30],
      fontStyle: 'bold',
      // 9pt, not the body's 10, so "Your part #" and "Quantities" fit their own columns.
      fontSize: 9,
      lineColor: [200, 200, 200],
      lineWidth: 0.5,
    },
    columnStyles: Object.fromEntries(columns.map((c, i) => [String(i), c.style])),
    theme: 'grid',
  });

  cursorY = (doc as jsPDF & { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? cursorY;
  cursorY += 22;

  // ---------- Notes to vendors ----------
  const footerTop = pageHeight - MARGIN - 30;
  const drawSection = (heading: string, text: string | null | undefined) => {
    const body = text?.trim();
    if (!body) return;
    if (cursorY > footerTop - 30) {
      doc.addPage();
      cursorY = MARGIN;
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text(heading, MARGIN, cursorY);
    cursorY += 16;

    // SET THE BODY FONT BEFORE MEASURING: the heading above left the document in bold 9.
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(40);
    // Split on the shop's own newlines first so their line breaks survive.
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
      cursorY += 13;
    }
    cursorY += 14;
  };
  drawSection('NOTES', rfq.header.notesToVendors);

  // ---------- Footer (every page, AFTER the text has paginated) ----------
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
    // The dated form: this footer's left slot is empty, like the slips'.
    doc.text(attributionLine(), MARGIN, footerY);
    doc.text(`Page ${p} of ${pageCount}`, pageWidth - MARGIN, footerY, { align: 'right' });
  }

  return doc;
}
