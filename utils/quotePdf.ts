/**
 * Generate a printable, customer-facing PDF for a quote.
 *
 * Intentionally excludes internal details (routing, operations, cost breakdown,
 * markup %). The customer sees what they're buying, what it costs, when they
 * can get it, and how to accept — nothing more.
 */
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { QuoteWithRelations } from '@/types/quote';
import type { Company } from '@/utils/companyAccess';
import type { PartPricingTier } from '@/types/partPricing';
import { isQuoteExpired, daysUntilExpiration } from '@/types/quote';
import { getTiersForPart } from '@/utils/partPricingTiersAccess';

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

type QuoteCustomer = NonNullable<QuoteWithRelations['customers']>;
type QuoteCustomerAddress = NonNullable<QuoteCustomer['addresses']>[number];
type QuoteCustomerContact = NonNullable<QuoteCustomer['customer_contacts']>[number];

/**
 * Resolve an embedded customer_addresses row by id. The quote carries
 * shipping_address_id (rendered on the PDF) and billing_address_id (stored
 * for downstream invoicing, not rendered) — both point at the address rows
 * joined under quote.customers.addresses. Returns null when the FK is null
 * or the lookup misses (e.g. address was deleted after the quote was issued).
 */
function findAddressById(
  addresses: QuoteCustomerAddress[] | undefined,
  addressId: string | null | undefined,
): QuoteCustomerAddress | null {
  if (!addressId || !addresses || addresses.length === 0) return null;
  return addresses.find((a) => a.id === addressId) ?? null;
}

/**
 * Resolve an embedded customer_contacts row by id. Used for the Customer
 * Contact section rendered below the metadata block. Returns null when
 * the FK is null or the lookup misses.
 */
function findContactById(
  contacts: QuoteCustomerContact[] | undefined,
  contactId: string | null | undefined,
): QuoteCustomerContact | null {
  if (!contactId || !contacts || contacts.length === 0) return null;
  return contacts.find((c) => c.id === contactId) ?? null;
}

/**
 * Human-readable label for a contact role. Single source of truth shared
 * with the quote form's option label so the form and the PDF can't drift.
 */
function formatContactRoleLabel(role: string): string {
  switch (role) {
    case 'accounts_payable':
      return 'Accounts Payable';
    case 'shipping_receiving':
      return 'Shipping & Receiving';
    case 'buyer':
      return 'Buyer';
    case 'engineering':
      return 'Engineering';
    case 'quality':
      return 'Quality';
    default:
      return 'Other';
  }
}

/**
 * Build the printed address lines for the Shipping Address block.
 * Surfaces ATTN: from customer_addresses.attention_to when set. No
 * contact lines or contact info — the Customer Contact has its own
 * section below the metadata block.
 */
function buildShippingAddressLines(
  customer: QuoteCustomer | null | undefined,
  address: QuoteCustomerAddress | null,
): string[] {
  if (!customer) return ['(No customer)'];

  const lines: string[] = [];
  if (customer.name) lines.push(customer.name);
  if (address?.attention_to) lines.push(`Attn: ${address.attention_to}`);

  if (address) {
    const cityStateZip = [address.city, address.state].filter(Boolean).join(', ');
    const cityStateZipFull = [cityStateZip, address.postal_code].filter(Boolean).join(' ').trim();
    if (address.address_line1) lines.push(address.address_line1);
    if (address.address_line2) lines.push(address.address_line2);
    if (cityStateZipFull) lines.push(cityStateZipFull);
    if (address.country && address.country.toUpperCase() !== 'USA') {
      lines.push(address.country);
    }
  }

  return lines;
}

/** Pre-fetch master tier lists for every part that appears on the quote. */
async function loadTiersForQuote(
  quote: QuoteWithRelations,
): Promise<Record<string, PartPricingTier[]>> {
  const partIds = Array.from(new Set((quote.line_items ?? []).map((li) => li.part_id)));
  const out: Record<string, PartPricingTier[]> = {};
  await Promise.all(
    partIds.map(async (id) => {
      try {
        out[id] = await getTiersForPart(id);
      } catch (err) {
        console.warn('Quote PDF: failed to load tiers for part', id, err);
        out[id] = [];
      }
    }),
  );
  return out;
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

  const tiersByPart = await loadTiersForQuote(quote);
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
  if (quote.lead_time_days !== null && quote.lead_time_days !== undefined) {
    metaRows.push({
      text: `Lead Time: ${quote.lead_time_days} day${quote.lead_time_days === 1 ? '' : 's'} ARO`,
    });
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

  // ---------- CREATED BY (left) + BILL TO (right) ----------
  const colWidth = (pageWidth - MARGIN * 2) / 2;
  const leftX = MARGIN;
  const rightX = MARGIN + colWidth + 8;

  const createdByName = quote.created_by_member?.name ?? null;
  const createdByEmail = quote.created_by_member?.email ?? null;

  // Resolve the shipping address + customer contact from the quote's FKs.
  // These are set at quote creation (legacy quotes were backfilled in
  // migrations 20260520 + 20260522) so the printed quote always renders
  // what the customer originally saw, even if the customer's defaults
  // change later. The billing address is captured on the quote for the
  // future invoicing flow but is NOT rendered on the quote document.
  const shippingAddress = findAddressById(quote.customers?.addresses, quote.shipping_address_id);
  const contact = findContactById(quote.customers?.customer_contacts, quote.contact_id);

  const shippingLines = buildShippingAddressLines(quote.customers ?? null, shippingAddress);

  // Section labels — left: CREATED BY, right: SHIPPING ADDRESS.
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(120);
  if (createdByName || createdByEmail) {
    doc.text('CREATED BY', leftX, cursorY);
  }
  doc.text('SHIPPING ADDRESS', rightX, cursorY);

  // Left column: Created by name + email
  doc.setFontSize(11);
  doc.setTextColor(40);
  let leftLineCount = 0;
  if (createdByName) {
    doc.setFont('helvetica', 'bold');
    doc.text(createdByName, leftX, cursorY + 16 + leftLineCount * 13);
    leftLineCount += 1;
  }
  if (createdByEmail) {
    doc.setFont('helvetica', 'normal');
    doc.text(createdByEmail, leftX, cursorY + 16 + leftLineCount * 13);
    leftLineCount += 1;
  }

  // Right column: Shipping address. First line is the customer name
  // (bold); subsequent lines (Attn:, address, city/state/zip, country)
  // render plain.
  shippingLines.forEach((line: string, i: number) => {
    doc.setFont('helvetica', i === 0 ? 'bold' : 'normal');
    doc.setFontSize(11);
    doc.setTextColor(40);
    doc.text(line, rightX, cursorY + 16 + i * 13);
  });

  const rightBlockLines = shippingLines.length;
  const blockLines = Math.max(leftLineCount, rightBlockLines);
  cursorY = cursorY + 16 + blockLines * 13 + 16;

  // ---------- Customer Contact section ----------
  // Sourced from quotes.contact_id. Defaults at quote creation to the
  // customer's primary contact (see migration 20260522). Renders name,
  // role, email, phone — only the fields the contact actually has.
  if (contact) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text('CUSTOMER CONTACT', MARGIN, cursorY);
    cursorY += 14;

    doc.setFontSize(11);
    doc.setTextColor(40);
    doc.setFont('helvetica', 'bold');
    doc.text(contact.name, MARGIN, cursorY);
    cursorY += 13;

    doc.setFont('helvetica', 'normal');
    doc.text(formatContactRoleLabel(contact.role), MARGIN, cursorY);
    cursorY += 13;

    if (contact.email) {
      doc.text(contact.email, MARGIN, cursorY);
      cursorY += 13;
    }
    if (contact.phone) {
      doc.text(contact.phone, MARGIN, cursorY);
      cursorY += 13;
    }

    cursorY += 6;
  }

  // ---------- Line items ----------
  const lineItems = [...(quote.line_items ?? [])].sort((a, b) => a.sequence - b.sequence);

  const body =
    lineItems.length > 0
      ? lineItems.map((li) => [
          li.parts?.part_name ?? 'Part',
          li.parts?.description?.trim() ?? '',
          String(li.quantity),
          formatCurrency(li.unit_price),
          formatCurrency(li.total_price ?? li.unit_price * li.quantity),
        ])
      : [['', '', '', '', '']];

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
    (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? cursorY + 60;

  // ---------- Grand total ----------
  cursorY = afterTableY + 20;
  if (lineItems.length > 0) {
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

  // ---------- Pricing tiers (separate appendix-style table) ----------
  const partsWithTiers = lineItems.filter((li) => {
    if (li.is_quote_override) return false;
    const tiers = tiersByPart[li.part_id] ?? [];
    return tiers.length > 1;
  });

  if (partsWithTiers.length > 0) {
    cursorY += 10;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text('PRICING TIERS', MARGIN, cursorY);
    cursorY += 12;

    for (const li of partsWithTiers) {
      // Page-break guard.
      const reservedBottom = 160;
      if (cursorY + 50 > pageHeight - reservedBottom) {
        doc.addPage();
        cursorY = MARGIN;
      }

      const tiers = [...(tiersByPart[li.part_id] ?? [])].sort(
        (a, b) => a.quantity - b.quantity,
      );
      const matchedId = li.source_tier_id;

      // Part header
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(50);
      const partLabel = li.parts?.part_name ?? 'Part';
      const desc = li.parts?.description?.trim();
      doc.text(desc ? `${partLabel}  —  ${desc}` : partLabel, MARGIN, cursorY + 10);
      cursorY += 16;

      // Tier sub-table: marker / order qty / unit price (with "each") / note.
      const tierBody = tiers.map((tier) => {
        const isMatched = tier.id === matchedId;
        return [
          isMatched ? '>' : '',
          String(tier.quantity),
          `${formatCurrency(tier.unit_price)} each`,
          isMatched ? `your order of ${li.quantity}` : '',
        ];
      });

      autoTable(doc, {
        startY: cursorY,
        margin: { left: MARGIN + 8, right: MARGIN },
        body: tierBody,
        styles: {
          font: 'helvetica',
          fontSize: 9,
          cellPadding: { top: 3, bottom: 3, left: 4, right: 4 },
          textColor: [80, 80, 80],
          lineColor: [240, 240, 240],
          lineWidth: 0.4,
        },
        columnStyles: {
          0: { cellWidth: 14, halign: 'center', fontStyle: 'bold', textColor: [30, 30, 30] },
          1: { cellWidth: 60, halign: 'right' },
          2: { cellWidth: 100, halign: 'right' },
          3: { cellWidth: 'auto', textColor: [120, 120, 120], fontStyle: 'italic' },
        },
        didParseCell: (data) => {
          const markerCell = data.row.cells[0];
          if (markerCell && markerCell.raw === '>') {
            data.cell.styles.fontStyle = 'bold';
            data.cell.styles.textColor = [30, 30, 30];
          }
        },
        theme: 'plain',
      });

      const tierEndY =
        (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? cursorY;
      cursorY = tierEndY + 10;
    }
  }

  // ---------- Acceptance block (compact) ----------
  const acceptanceHeight = 70;
  const footerReserve = 50;

  if (cursorY + acceptanceHeight > pageHeight - MARGIN - footerReserve) {
    doc.addPage();
    cursorY = MARGIN;
  } else {
    cursorY += 10;
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text('ACCEPTANCE', MARGIN, cursorY);
  cursorY += 14;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(60);
  const acceptCopy = 'To accept, sign below or reply with a PO referencing this quote.';
  const wrappedCopy = doc.splitTextToSize(acceptCopy, pageWidth - MARGIN * 2);
  doc.text(wrappedCopy, MARGIN, cursorY);
  cursorY += wrappedCopy.length * 12 + 14;

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
  doc.text('Date', MARGIN + 270, sigLineY + 11);
  doc.text('PO #', MARGIN + 460, sigLineY + 11);

  // ---------- Footer (every page) ----------
  // Created-by info now lives in the body (left of BILL TO), so the footer is
  // generated-on/page-of only.
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
