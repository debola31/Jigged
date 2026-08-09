/**
 * Generate a printable, customer-facing PDF for a quote.
 *
 * Intentionally excludes internal details (routing, operations, cost breakdown,
 * markup %). The customer sees what they're buying, what it costs, when they
 * can get it, and how to accept — nothing more.
 */
import { jsPDF } from 'jspdf';
import autoTable, { type RowInput } from 'jspdf-autotable';
import type { QuoteWithRelations } from '@/types/quote';
import type { AddressSnapshot } from '@/types/documentSnapshot';
import type { Company } from '@/utils/companyAccess';
import { isQuoteExpired, daysUntilExpiration } from '@/types/quote';
import { quantityUnitSuffix } from '@/lib/standardUnits';
import { attributionLine } from '@/utils/packingSlipPdf';

const MARGIN = 40;

function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Lines of text for the top-left "shop header".
 * Targets a 2-line address: address_line1 + address_line2 combined onto one line
 * when short enough, then city/state/zip on a second line. Phone goes underneath.
 * Email and website are intentionally omitted from the header — clutter on a printed
 * customer-facing document.
 */
const ADDRESS_COMBINE_MAX_CHARS = 50;

function buildShopHeaderLines(company: Company): string[] {
  const lines: string[] = [];

  // Combine address line 1 and 2 onto one line when reasonably short; otherwise stack.
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
  const cityStateZipFull = [cityStateZip, company.postal_code].filter(Boolean).join(' ').trim();
  if (cityStateZipFull) lines.push(cityStateZipFull);
  if (company.country && company.country.toUpperCase() !== 'USA') lines.push(company.country);

  if (company.phone) lines.push(company.phone);

  return lines;
}

// The customer/address/contact block is now read from the quote's frozen
// snapshot columns (see generateQuotePdf), not resolved from the live joined
// customer rows — so editing or deleting the master never rewrites a past quote.

/**
 * The address-only lines (line1, line2, city/state/zip, non-US country) for a
 * customer address — no customer name, no attention_to. Used directly for the
 * SHIP TO column (the customer name already heads the CUSTOMER column) and as
 * the address half of the Customer block.
 */
function buildAddressOnlyLines(address: AddressSnapshot | null): string[] {
  if (!address) return [];
  const lines: string[] = [];
  const cityStateZip = [address.city, address.state].filter(Boolean).join(', ');
  const cityStateZipFull = [cityStateZip, address.postal_code].filter(Boolean).join(' ').trim();
  if (address.address_line1) lines.push(address.address_line1);
  if (address.address_line2) lines.push(address.address_line2);
  if (cityStateZipFull) lines.push(cityStateZipFull);
  if (address.country && address.country.toUpperCase() !== 'USA') {
    lines.push(address.country);
  }
  return lines;
}

/**
 * Build the printed address lines for the Customer block (customer name +
 * billing address). The address's attention_to is intentionally NOT
 * surfaced here — the Customer Contact has its own column. No contact lines
 * or contact info either.
 */
function buildBillingAddressLines(
  customerName: string | null,
  address: AddressSnapshot | null,
): string[] {
  const lines: string[] = [];
  if (customerName) lines.push(customerName);
  lines.push(...buildAddressOnlyLines(address));
  return lines.length > 0 ? lines : ['(No customer)'];
}

/**
 * Filename used both when downloading and when attaching to email.
 * Single source of truth so the preview dialog, download button, and email
 * route all label the PDF the same way.
 */
export function quotePdfFilename(quote: QuoteWithRelations): string {
  return `Quote-${quote.quote_number}.pdf`;
}

/**
 * Build the jsPDF document for a quote and return it without writing
 * anything to disk. Callers choose how to consume it:
 *   - doc.save(filename)              → download
 *   - doc.output('bloburl') as string → URL for <iframe src> previews
 *   - doc.output('blob')              → Blob for upload (e.g., email attach)
 *
 * Returning the doc instead of saving means one rendering path serves all
 * three product entry points (download, preview, email-attach).
 */
export async function generateQuotePdf(
  quote: QuoteWithRelations,
  company: Company,
): Promise<jsPDF> {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  const expired = isQuoteExpired(quote);
  const daysLeft = daysUntilExpiration(quote.expiration_date);

  // ---------- Header: company block (top-left) + QUOTE + meta (top-right) ----------
  const headerTop = MARGIN;

  // Top-left: company name (bold) then address / contact lines.
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(30);
  doc.text(company.name, MARGIN, headerTop + 12);

  const shopLines = buildShopHeaderLines(company);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(80);
  shopLines.forEach((line, i) => {
    doc.text(line, MARGIN, headerTop + 28 + i * 12);
  });
  const shopBlockBottom = headerTop + 28 + shopLines.length * 12;

  // Top-right: QUOTE title + stacked meta (no box, right-aligned).
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(26);
  doc.setTextColor(30);
  doc.text('QUOTE', pageWidth - MARGIN, headerTop + 20, { align: 'right' });

  // When any line carries its own lead time, we show lead time per item in the
  // line-items table below, so the single quote-level lead-time meta row here is
  // omitted (avoids a header value that contradicts the per-item rows).
  const hasPerItemLeadTimes = (quote.line_items ?? []).some(
    (li) => (li.lead_time_text ?? '').trim() !== '',
  );

  const metaRows: Array<{ text: string; color?: [number, number, number] }> = [];
  metaRows.push({ text: `Quote #: ${quote.quote_number}` });
  metaRows.push({ text: `Date: ${formatDate(quote.created_at)}` });
  if (quote.expiration_date) {
    const expiredOrSoon = expired || (daysLeft !== null && daysLeft <= 0);
    metaRows.push({
      text: `Valid Until: ${formatDate(quote.expiration_date)}`,
      color: expiredOrSoon ? [180, 40, 40] : undefined,
    });
  }
  if (quote.lead_time_text && !hasPerItemLeadTimes) {
    metaRows.push({ text: `Lead Time: ${quote.lead_time_text} ARO` });
  }
  if (quote.payment_terms) {
    metaRows.push({ text: `Payment Terms: ${quote.payment_terms}` });
  }
  // FOB point — where title and risk transfer. Printed as its own row, never
  // merged with a freight-payment term, because a customer reading
  // "FOB Destination, Freight Collect" as one phrase is the classic
  // misunderstanding this separation exists to prevent.
  if (quote.fob_point) {
    metaRows.push({ text: `FOB: ${quote.fob_point}` });
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  metaRows.forEach((row, i) => {
    const [r, g, b] = row.color ?? [80, 80, 80];
    doc.setTextColor(r, g, b);
    doc.text(row.text, pageWidth - MARGIN, headerTop + 40 + i * 14, { align: 'right' });
  });
  const metaBlockBottom = headerTop + 40 + metaRows.length * 14;

  let cursorY = Math.max(shopBlockBottom, metaBlockBottom) + 16;

  // ---------- EXPIRED banner ----------
  if (expired) {
    const bandHeight = 26;
    doc.setFillColor(250, 230, 230);
    doc.rect(MARGIN, cursorY, pageWidth - MARGIN * 2, bandHeight, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(180, 40, 40);
    doc.text(
      'THIS QUOTE HAS EXPIRED — PRICES SUBJECT TO REQUOTE',
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

  // ---------- CUSTOMER · SHIP TO (if different) · CUSTOMER CONTACT ----------
  // Render the frozen customer/address/contact snapshot captured on the quote at
  // issue time (Document Snapshot Standard — snapshot_document_party trigger;
  // legacy rows backfilled in 20260623021524). The printed quote shows what the
  // customer originally saw even if the master address/customer/contact is later
  // edited or deleted. "Prepared by" is not a column here — it lives in the
  // acceptance block now that a quote is accepted by returning a PO.
  const shippingAddress = quote.ship_to_address;
  const contact = quote.contact_snapshot ?? null;
  const billingLines = buildBillingAddressLines(quote.customer_name, quote.bill_to_address);

  // Shipping is its own column only when a distinct shipping address snapshot is
  // set (compared by value, so it survives the master address being deleted).
  const shippingDiffers =
    shippingAddress !== null &&
    JSON.stringify(shippingAddress) !== JSON.stringify(quote.bill_to_address);

  const customerBody: Array<{ text: string; bold: boolean }> = billingLines.map(
    (line: string, i: number) => ({ text: line, bold: i === 0 }),
  );
  const shippingBody: Array<{ text: string; bold: boolean }> = buildAddressOnlyLines(
    shippingAddress,
  ).map((line: string, i: number) => ({ text: line, bold: i === 0 }));

  const contactLines: Array<{ text: string; bold: boolean }> = [];
  if (contact) {
    if (contact.name) contactLines.push({ text: contact.name, bold: true });
    if (contact.email) contactLines.push({ text: contact.email, bold: false });
    if (contact.phone) contactLines.push({ text: contact.phone, bold: false });
  }

  // Ordered columns: Customer, [Ship to if different], Contact. X positions are
  // derived from the count so the two-column case stays evenly balanced.
  const infoColumns: Array<{
    label: string;
    lines: Array<{ text: string; bold: boolean }>;
  }> = [{ label: 'CUSTOMER', lines: customerBody }];
  if (shippingDiffers && shippingBody.length > 0) {
    infoColumns.push({ label: 'SHIP TO', lines: shippingBody });
  }
  if (contactLines.length > 0) {
    infoColumns.push({ label: 'CUSTOMER CONTACT', lines: contactLines });
  }

  const usableWidth = pageWidth - MARGIN * 2;
  const colWidth = usableWidth / infoColumns.length;
  const columnsWithX = infoColumns.map((col, i) => ({ ...col, x: MARGIN + i * colWidth }));

  // Column labels on one row.
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(120);
  for (const col of columnsWithX) {
    doc.text(col.label, col.x, cursorY);
  }

  // Column bodies; advance the cursor past the tallest column.
  let maxInfoLines = 0;
  for (const col of columnsWithX) {
    col.lines.forEach((ln, i) => {
      doc.setFont('helvetica', ln.bold ? 'bold' : 'normal');
      doc.setFontSize(11);
      doc.setTextColor(40);
      doc.text(ln.text, col.x, cursorY + 16 + i * 13);
    });
    maxInfoLines = Math.max(maxInfoLines, col.lines.length);
  }

  cursorY = cursorY + 16 + maxInfoLines * 13 + 16;

  // ---------- Line items ----------
  const lineItems = [...(quote.line_items ?? [])].sort((a, b) => a.sequence - b.sequence);

  // Group by part (first-appearance order). Both firm and price-options quotes
  // render as ONE table; a part with 2+ quantities spans its name/description
  // across its quantity rows. Firm quotes (every part one quantity) add a grand
  // total; price-options quotes omit it (the customer picks a quantity).
  const partGroups: {
    part_name: string;
    description: string;
    unit: string | null;
    // Effective lead time for this part (its own value, else the quote-level
    // lead time). Only rendered when hasPerItemLeadTimes.
    lead_time: string;
    items: typeof lineItems;
  }[] = [];
  const groupIndex = new Map<string, number>();
  for (const li of lineItems) {
    let gi = groupIndex.get(li.part_id);
    if (gi === undefined) {
      gi = partGroups.length;
      groupIndex.set(li.part_id, gi);
      partGroups.push({
        part_name: li.parts?.part_name ?? 'Part',
        description: li.parts?.description?.trim() ?? '',
        // Labels a fractional quantity ("0.32 in"); null for count parts.
        unit: quantityUnitSuffix(li.parts?.primary_unit),
        // Lead time is per-part, so the group's first item carries it; fall
        // back to the quote-level lead time when this item has none.
        lead_time: (li.lead_time_text ?? '').trim() || (quote.lead_time_text ?? ''),
        items: [],
      });
    }
    partGroups[gi].items.push(li);
  }
  const isFirmQuote = partGroups.length > 0 && partGroups.every((g) => g.items.length === 1);

  // One table for the whole quote. A part with several quantities shows its
  // name + description once (a cell spanning its quantity rows) and one line
  // per quantity; a single-quantity part is a plain one-line row.
  const body: RowInput[] = [];
  if (lineItems.length > 0) {
    for (const group of partGroups) {
      const rows = [...group.items].sort((a, b) => a.quantity - b.quantity);
      // When items differ in lead time, show each item's effective lead time as
      // a second line under its description (keeps the fixed 5-column layout).
      const descriptionCell =
        hasPerItemLeadTimes && group.lead_time
          ? `${group.description}${group.description ? '\n' : ''}Lead time: ${group.lead_time}`
          : group.description;
      rows.forEach((li, i) => {
        const qtyCells = [
          group.unit ? `${li.quantity} ${group.unit}` : String(li.quantity),
          formatCurrency(li.unit_price),
          formatCurrency(li.total_price ?? li.unit_price * li.quantity),
        ];
        if (rows.length === 1) {
          body.push([group.part_name, descriptionCell, ...qtyCells]);
        } else if (i === 0) {
          body.push([
            { content: group.part_name, rowSpan: rows.length },
            { content: descriptionCell, rowSpan: rows.length },
            ...qtyCells,
          ]);
        } else {
          body.push(qtyCells);
        }
      });
    }
  } else {
    body.push(['', '', '', '', '']);
  }

  autoTable(doc, {
    startY: cursorY,
    margin: { left: MARGIN, right: MARGIN },
    head: [['Part', 'Description', 'Order qty', 'Unit price', 'Total']],
    body,
    styles: {
      font: 'helvetica',
      fontSize: 10,
      cellPadding: 7,
      textColor: [40, 40, 40],
      valign: 'top',
    },
    headStyles: {
      fillColor: [240, 240, 240],
      textColor: [30, 30, 30],
      fontStyle: 'bold',
      lineColor: [200, 200, 200],
      lineWidth: 0.5,
    },
    columnStyles: {
      0: { cellWidth: 90, fontStyle: 'bold' },
      1: { cellWidth: 'auto' },
      2: { cellWidth: 60, halign: 'right' },
      3: { cellWidth: 80, halign: 'right' },
      4: { cellWidth: 90, halign: 'right' },
    },
    theme: 'grid',
  });

  const afterTableY =
    (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ??
    cursorY + 60;

  // ---------- Grand total (firm quotes only) ----------
  cursorY = afterTableY + 20;
  if (isFirmQuote && lineItems.length > 0) {
    const grandTotal = lineItems.reduce(
      (sum, li) => sum + (li.total_price ?? li.unit_price * li.quantity),
      0,
    );
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(30);
    doc.text('Total', pageWidth - MARGIN - 100, cursorY, { align: 'right' });
    doc.text(formatCurrency(grandTotal), pageWidth - MARGIN, cursorY, { align: 'right' });
    cursorY += 20;
  }

  // ---------- Footer (every page) ----------
  // The company name and quote dates already sit in the header, so the footer carries where the
  // document came from on the left and the page number on the right.
  //
  // The preparer credit (relocated from the old top "CREATED BY" column) is NOT displaced by the
  // attribution line — it moves one line up instead. This footer is the only place a quote records
  // who prepared it, so dropping it to make room would lose a fact the customer may need to call
  // someone about; the attribution line only ever restates something we already know.
  const preparedName = quote.created_by_member?.name ?? null;
  const preparedEmail = quote.created_by_member?.email ?? null;
  const preparedText = [preparedName, preparedEmail].filter(Boolean).join(' · ');
  const preparedLine = preparedText ? `Prepared by ${preparedText}` : '';

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
    if (preparedLine) {
      doc.text(preparedLine, MARGIN, footerY - 11);
    }
    doc.text(attributionLine(), MARGIN, footerY);
    doc.text(`Page ${p} of ${pageCount}`, pageWidth - MARGIN, footerY, { align: 'right' });
  }

  return doc;
}
