/**
 * The outside-processing slip — the paperwork that travels in the box.
 *
 * In one sentence: *these N pieces of this part, on our job, are going to you
 * for this process, and we need them back by this date.*
 *
 * It is a sibling of the customer packing slip and deliberately reads like one:
 * same header primitive, same grid table, same footer. Two things differ, and
 * both are the point.
 *
 *   - There is ONE address block, SHIP TO. The shop's own details are the
 *     letterhead `drawShopHeaderBlock` already draws; a SHIP FROM block below it
 *     repeated the name, address and phone verbatim, six lines lower.
 *   - The title is **22pt, not the customer slip's 26**, sized to sit with the
 *     meta line under it rather than tower over it. Both documents say
 *     "PACKING SLIP": that is what each one is, and the reader who matters --
 *     a plater's receiving clerk -- has no idea what "outside processing" is
 *     from where they stand. The vendor and the process are named below.
 *
 * WRAP HAZARD, and the suite cannot see it: `splitTextToSize` measures against
 * whatever font the document is CURRENTLY in. The details block leaves it at
 * bold 11 and the instructions draw at normal 10, so the font is set BEFORE the
 * first split. utils/quotePdf.ts carries the same comment for the same bug,
 * which shipped once and survived a mocked suite. Only a real render shows it.
 */
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { Styles } from 'jspdf-autotable';

import type { Company } from '@/utils/companyAccess';
import { readLogoIncludesName } from '@/lib/companyDefaults';
import type { OutsideShipmentWithRelations } from '@/types/outsideShipment';
import {
  attributionLine,
  buildAddressBlockLines,
  drawShopHeaderBlock,
  formatDate,
  loadLogoAsDataUrl,
  type SupabaseLike,
} from '@/utils/packingSlipPdf';

const MARGIN = 40;

export function outsideShipmentPdfFilename(
  shipment: Pick<OutsideShipmentWithRelations, 'slip_number'>,
): string {
  return `OutsideProcessing-${shipment.slip_number}.pdf`;
}

export interface OutsideShipmentPdfContext {
  shipment: OutsideShipmentWithRelations;
  company: Company;
  /**
   * How much went out on the slips issued BEFORE this one. Required, not
   * defaulted: the column it feeds answers "what was still open as of this
   * slip", and a silent 0 would print a second slip claiming nothing had gone
   * out yet. `getSentBeforeShipment` is the only correct source.
   */
  sentBefore: number;
  supabase?: SupabaseLike | null;
}

interface SlipColumn {
  header: string;
  cell: () => string;
  style: Partial<Styles>;
}

/**
 * Build the jsPDF document and return it unwritten. The caller chooses:
 *   doc.save(filename)              -> download
 *   doc.output('bloburl') as string -> preview iframe src
 */
export async function generateOutsideShipmentPdf(
  ctx: OutsideShipmentPdfContext,
): Promise<jsPDF> {
  const { shipment, company, sentBefore } = ctx;

  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const headerTop = MARGIN;

  // ---------- Header ----------
  // The RIGHT column is measured FIRST, because it sets the header's height and
  // therefore the vertical room the logo may occupy. Sizing the logo before
  // knowing that is how the packing slip ended up with a 56pt box.
  const metaLines: string[] = [
    `Slip #: ${shipment.slip_number}`,
    `Ship Date: ${formatDate(shipment.shipped_at)}`,
  ];
  if (shipment.due_back_on) metaLines.push(`Due Back: ${formatDate(shipment.due_back_on)}`);
  if (shipment.job?.job_number) metaLines.push(`Job: ${shipment.job.job_number}`);
  const metaBlockBottom = headerTop + 20 + metaLines.length * 14;

  const logoDataUrl = await loadLogoAsDataUrl(company.logo_url, ctx.supabase ?? null);
  const shopBlockBottom = drawShopHeaderBlock(doc, {
    company,
    logoDataUrl,
    logoIncludesName: readLogoIncludesName(company),
    x: MARGIN,
    y: headerTop,
    availableBottom: metaBlockBottom,
    nameSize: 14,
  });

  // "PACKING SLIP", the same words the customer document uses, because that is
  // what this IS -- a list of what is in the box, for whoever opens it. The
  // vendor and the process are named below; the title does not need to carry
  // them, and "OUTSIDE PROCESSING" described our routing rather than the
  // document, to a reader who does not have our routing.
  //
  // 22pt, not the customer slip's 26: SHOP_LOGO_MAX_W lets the header's left
  // block reach x=230, and "PACKING SLIP" at 26pt bold starts near x=372, which
  // is comfortable -- but the meta line below it ("Slip #: VPS-0141-2") is the
  // widest thing in this column, so the title is sized to sit with it rather
  // than tower over it.
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(30);
  doc.text('PACKING SLIP', pageWidth - MARGIN, headerTop + 18, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(80);
  metaLines.forEach((line, i) => {
    doc.text(line, pageWidth - MARGIN, headerTop + 36 + i * 14, { align: 'right' });
  });

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
      `VOIDED ${formatDate(shipment.voided_at)} — PARTS NOT SENT — KEEP FOR RECORDS`,
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

  // ---------- SHIP TO ----------
  // ONE address block, not two. `drawShopHeaderBlock` above already prints the
  // shop's name, address and phone — a SHIP FROM block underneath it repeated
  // all three, in the same order, six lines lower. The letterhead IS the
  // ship-from, which is how every packing slip has worked since long before
  // any of this was software.
  const toLines = buildAddressBlockLines(
    shipment.vendor_name,
    shipment.ship_to_address,
    shipment.ship_to_contact?.name ?? shipment.ship_to_address?.attention_to ?? null,
  );
  // The shared renderer only emits its "(No address on file)" fallback when it
  // has NOTHING, and here it always has the vendor name, so a vendor with no
  // address on file would print as a lone name that reads like a truncation.
  // Say it plainly instead: the dock should know the line is missing, not
  // wonder whether it got cut off.
  if (!shipment.ship_to_address) toLines.push('(No address on file)');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text('SHIP TO', MARGIN, cursorY);

  /**
   * WRAPS, unlike the customer packing slip's equivalent, and it has to.
   *
   * A vendor's name here is its legal name, and those are long: measured at
   * 11pt bold, "PerformCoat of Michigan Limited Liability Company" is 270pt
   * against the half-width column this used to sit in, so it ran past the
   * margin and off the page. Nothing errored and no test could see it — the
   * suite mocks jsPDF — so it was found by rendering one and measuring.
   *
   * Now that SHIP FROM is gone the block has the full content width, which
   * makes an overrun far less likely; the wrap stays because "less likely" is
   * not a guarantee and the failure is silent.
   *
   * Each line is measured in the font it will be DRAWN in (line 0 is bold), or
   * splitTextToSize wraps the heading against the body metrics and the first
   * line still overruns.
   */
  const blockWidth = pageWidth - MARGIN * 2;
  let toRows = 0;
  for (const [i, line] of toLines.entries()) {
    doc.setFont('helvetica', i === 0 ? 'bold' : 'normal');
    doc.setFontSize(11);
    doc.setTextColor(40);
    for (const part of doc.splitTextToSize(line, blockWidth) as string[]) {
      doc.text(part, MARGIN, cursorY + 16 + toRows * 13);
      toRows += 1;
    }
  }

  cursorY += 16 + toRows * 13 + 14;

  // ---------- What is in the box ----------
  // One shipment is one operation, so there is only ever one row. A table
  // anyway: it inherits the packing slip's grid theme so the two documents read
  // as coming from one shop, and autoTable owns the part/operation wrap.
  const partName = shipment.job_part?.part?.part_name ?? '—';
  const ordered = Number(shipment.job_part?.quantity ?? 0);

  // ONE declarative spec drives head, body and columnStyles together. Built by
  // hand, the conditional column drifts out of alignment with its header — the
  // defect the packing slip's quantity table shipped with.
  const columns: SlipColumn[] = [
    { header: 'Job', cell: () => shipment.job?.job_number ?? '—', style: { cellWidth: 78 } },
    { header: 'Part', cell: () => partName, style: { cellWidth: 104 } },
    { header: 'Operation', cell: () => shipment.service_name, style: { cellWidth: 'auto' } },
    {
      header: 'Qty Sent',
      cell: () => String(shipment.quantity),
      style: { cellWidth: 60, halign: 'right', fontStyle: 'bold' },
    },
  ];
  // Only when there IS a backlog. On slip 1 the column is noise.
  if (sentBefore > 0) {
    columns.push({
      header: 'Prev Sent',
      cell: () => String(sentBefore),
      style: { cellWidth: 60, halign: 'right' },
    });
  }
  columns.push({
    header: 'Qty Ordered',
    cell: () => String(ordered),
    style: { cellWidth: 60, halign: 'right' },
  });

  autoTable(doc, {
    startY: cursorY,
    margin: { left: MARGIN, right: MARGIN },
    head: [columns.map((c) => c.header)],
    body: [columns.map((c) => c.cell())],
    styles: { font: 'helvetica', fontSize: 10, cellPadding: 7, textColor: [40, 40, 40] },
    headStyles: {
      fillColor: [240, 240, 240],
      textColor: [30, 30, 30],
      fontStyle: 'bold',
      // 9pt, not the body's 10: "Qty Ordered" wraps mid-word at 10 in a 60pt column.
      fontSize: 9,
      lineColor: [200, 200, 200],
      lineWidth: 0.5,
    },
    columnStyles: Object.fromEntries(columns.map((c, i) => [String(i), c.style])),
    theme: 'grid',
  });

  cursorY =
    (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? cursorY;
  cursorY += 26;

  // ---------- Sending details ----------
  const detailRows: [string, string][] = [];
  if (shipment.due_back_on) detailRows.push(['Due back', formatDate(shipment.due_back_on)]);
  if (shipment.carrier) detailRows.push(['Carrier', shipment.carrier]);
  if (shipment.shipped_by_member?.name) {
    detailRows.push(['Sent by', shipment.shipped_by_member.name]);
  }

  if (detailRows.length > 0) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text('SENDING DETAILS', MARGIN, cursorY);
    cursorY += 16;

    const valueX = MARGIN + 130;
    const valueWidth = pageWidth - MARGIN * 2 - 130;
    for (const [label, value] of detailRows) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(110);
      doc.text(label, MARGIN, cursorY);

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(40);
      const wrapped = doc.splitTextToSize(value, valueWidth) as string[];
      wrapped.forEach((line, i) => doc.text(line, valueX, cursorY + i * 13));
      cursorY += Math.max(16, wrapped.length * 13 + 3);
    }
    cursorY += 10;
  }

  // ---------- Instructions ----------
  const instructions = shipment.notes?.trim();
  if (instructions) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text('INSTRUCTIONS', MARGIN, cursorY);
    cursorY += 16;

    // SET THE BODY FONT BEFORE MEASURING. splitTextToSize wraps against the
    // font the document is currently in, and the details block above left it at
    // bold 11. Measuring there would wrap every line about a third short —
    // nothing overflows, which is exactly why it survives a mocked suite.
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(40);

    const footerTop = pageHeight - MARGIN - 30;
    // Split on the shop's own newlines first so their line breaks survive.
    const lines = instructions
      .split('\n')
      .flatMap((para) => doc.splitTextToSize(para, pageWidth - MARGIN * 2) as string[]);
    for (const line of lines) {
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
    cursorY += 16;
  }

  // ---------- Received at vendor by ----------
  const sigLineY = Math.min(cursorY + 30, pageHeight - MARGIN - 40);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text('RECEIVED AT VENDOR BY', MARGIN, sigLineY - 14);

  doc.setDrawColor(180);
  doc.setLineWidth(0.5);
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
  // AFTER the instructions have paginated, or a page they added prints bare.
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
    // The dated form: this footer's left slot is empty, unlike the quote's.
    doc.text(attributionLine(), MARGIN, footerY);
    doc.text(`Page ${p} of ${pageCount}`, pageWidth - MARGIN, footerY, { align: 'right' });
  }

  return doc;
}
