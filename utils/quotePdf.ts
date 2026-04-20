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
import { downloadFileFromStorage } from '@/utils/storageHelpers';
import { isQuoteExpired, daysUntilExpiration } from '@/types/quote';

const MARGIN = 40;

type ImageFormat = 'PNG' | 'JPEG' | 'WEBP';

interface LoadedLogo {
  dataUrl: string;
  format: ImageFormat;
  width: number;
  height: number;
}

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

function imageFormatFromMime(mime: string): ImageFormat | null {
  const m = mime.toLowerCase();
  if (m.includes('png')) return 'PNG';
  if (m.includes('jpeg') || m.includes('jpg')) return 'JPEG';
  if (m.includes('webp')) return 'WEBP';
  return null; // SVG and others: unsupported by jsPDF.addImage
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function loadImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = dataUrl;
  });
}

async function loadCompanyLogo(path: string | null | undefined): Promise<LoadedLogo | null> {
  if (!path) return null;
  try {
    const blob = await downloadFileFromStorage(path);
    const format = imageFormatFromMime(blob.type || '');
    if (!format) return null;
    const dataUrl = await blobToDataUrl(blob);
    const { width, height } = await loadImageDimensions(dataUrl);
    return { dataUrl, format, width, height };
  } catch (err) {
    console.warn('Quote PDF: failed to load company logo, using text-only header.', err);
    return null;
  }
}

function buildFromLines(company: Company, preparedBy: string | null): string[] {
  const lines: string[] = [];
  if (company.name) lines.push(company.name);

  if (company.address_line1) lines.push(company.address_line1);
  if (company.address_line2) lines.push(company.address_line2);

  const cityStateZip = [company.city, company.state].filter(Boolean).join(', ');
  const cityStateZipFull = [cityStateZip, company.postal_code].filter(Boolean).join(' ').trim();
  if (cityStateZipFull) lines.push(cityStateZipFull);
  if (company.country && company.country.toUpperCase() !== 'USA') lines.push(company.country);

  if (company.phone) lines.push(company.phone);
  if (company.email) lines.push(company.email);
  if (company.website) lines.push(company.website);

  if (preparedBy) lines.push(`Prepared by: ${preparedBy}`);

  return lines;
}

function buildBillToLines(customer: QuoteWithRelations['customers']): string[] {
  if (!customer) return ['(No customer)'];
  const lines: string[] = [];
  if (customer.name) lines.push(customer.name);
  if (customer.contact_name) lines.push(customer.contact_name);

  const cityStateZip = [customer.city, customer.state].filter(Boolean).join(', ');
  const cityStateZipFull = [cityStateZip, customer.postal_code].filter(Boolean).join(' ').trim();

  if (customer.address_line1) lines.push(customer.address_line1);
  if (customer.address_line2) lines.push(customer.address_line2);
  if (cityStateZipFull) lines.push(cityStateZipFull);
  if (customer.country && customer.country.toUpperCase() !== 'USA') lines.push(customer.country);

  if (customer.contact_phone) lines.push(customer.contact_phone);
  if (customer.contact_email) lines.push(customer.contact_email);
  return lines;
}

/**
 * Generate and download a PDF for the given quote.
 * Returns a promise that resolves once `doc.save()` has been triggered.
 */
export async function generateQuotePdf(
  quote: QuoteWithRelations,
  company: Company
): Promise<void> {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  const logo = await loadCompanyLogo(company.logo_url ?? null);
  const expired = isQuoteExpired(quote);
  const daysLeft = daysUntilExpiration(quote.expiration_date);

  // ---------- Header ----------
  const headerTop = MARGIN;
  const logoMaxSize = 60;
  let companyNameX = MARGIN;

  if (logo) {
    const scale = Math.min(logoMaxSize / logo.width, logoMaxSize / logo.height, 1);
    const w = logo.width * scale;
    const h = logo.height * scale;
    doc.addImage(logo.dataUrl, logo.format, MARGIN, headerTop, w, h);
    companyNameX = MARGIN + w + 12;
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(30);
  doc.text(company.name, companyNameX, headerTop + 22);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(26);
  doc.setTextColor(30);
  doc.text('QUOTE', pageWidth - MARGIN, headerTop + 20, { align: 'right' });

  // Meta rows — drop internal status, add Valid Until and Lead Time.
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

  // Base below header is the taller of logo / meta stack
  const metaBlockBottom = headerTop + 40 + metaRows.length * 14;
  let cursorY = Math.max(headerTop + (logo ? logoMaxSize : 30), metaBlockBottom) + 12;

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
      { align: 'center' }
    );
    cursorY += bandHeight + 8;
  }

  // ---------- Divider ----------
  doc.setDrawColor(210);
  doc.setLineWidth(0.75);
  doc.line(MARGIN, cursorY, pageWidth - MARGIN, cursorY);
  cursorY += 24;

  // ---------- FROM / BILL TO (two columns) ----------
  const colWidth = (pageWidth - MARGIN * 2) / 2;
  const fromX = MARGIN;
  const billToX = MARGIN + colWidth + 8;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text('FROM', fromX, cursorY);
  doc.text('BILL TO', billToX, cursorY);

  const preparedBy = quote.created_by_member?.name ?? null;
  const fromLines = buildFromLines(company, preparedBy);
  const billToLines = buildBillToLines(quote.customers);

  doc.setFontSize(11);
  doc.setTextColor(40);
  fromLines.forEach((line, i) => {
    doc.setFont('helvetica', i === 0 ? 'bold' : 'normal');
    doc.text(line, fromX, cursorY + 18 + i * 14);
  });
  billToLines.forEach((line, i) => {
    doc.setFont('helvetica', i === 0 ? 'bold' : 'normal');
    doc.text(line, billToX, cursorY + 18 + i * 14);
  });

  const blockBottom = cursorY + 18 + Math.max(fromLines.length, billToLines.length) * 14;
  cursorY = blockBottom + 24;

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
    head: [['Part', 'Description', 'Qty', 'Unit Price', 'Total']],
    body,
    styles: {
      font: 'helvetica',
      fontSize: 10,
      cellPadding: 8,
      textColor: [40, 40, 40],
    },
    headStyles: {
      fillColor: [30, 30, 46],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
    },
    columnStyles: {
      0: { cellWidth: 120, fontStyle: 'bold' },
      1: { cellWidth: 'auto' },
      2: { cellWidth: 40, halign: 'right' },
      3: { cellWidth: 80, halign: 'right' },
      4: { cellWidth: 80, halign: 'right' },
    },
    theme: 'grid',
  });

  const afterTableY =
    (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? cursorY + 60;

  // ---------- Totals ----------
  // Show a grand total only when the quote has exactly one line item.
  // Multi-tier quotes omit the total — the customer hasn't picked a quantity yet.
  cursorY = afterTableY + 24;
  if (lineItems.length === 1) {
    const only = lineItems[0];
    const grandTotal = only.total_price ?? only.unit_price * only.quantity;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(30);
    doc.text('Total', pageWidth - MARGIN - 90, cursorY, { align: 'right' });
    doc.text(formatCurrency(grandTotal), pageWidth - MARGIN, cursorY, { align: 'right' });
  } else if (lineItems.length > 1) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(10);
    doc.setTextColor(90);
    doc.text(
      'Select a quantity per part to confirm total.',
      pageWidth - MARGIN,
      cursorY,
      { align: 'right' },
    );
  }

  cursorY += 40;

  // ---------- Acceptance block ----------
  const acceptanceHeight = 110;
  const footerReserve = 50; // footer sits at pageHeight - MARGIN

  if (cursorY + acceptanceHeight > pageHeight - MARGIN - footerReserve) {
    doc.addPage();
    cursorY = MARGIN;
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text('ACCEPTANCE', MARGIN, cursorY);
  cursorY += 18;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(60);
  const acceptCopy = quote.expiration_date
    ? `To accept, sign below or reply with a PO referencing this quote. Prices valid until ${formatDate(quote.expiration_date)}.`
    : 'To accept, sign below or reply with a PO referencing this quote.';
  const wrappedCopy = doc.splitTextToSize(acceptCopy, pageWidth - MARGIN * 2);
  doc.text(wrappedCopy, MARGIN, cursorY);
  cursorY += wrappedCopy.length * 12 + 18;

  // Signature line
  doc.setDrawColor(160);
  doc.setLineWidth(0.5);
  const sigLineY = cursorY + 14;
  doc.line(MARGIN, sigLineY, MARGIN + 240, sigLineY);
  doc.line(MARGIN + 270, sigLineY, MARGIN + 430, sigLineY);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text('Signature', MARGIN, sigLineY + 12);
  doc.text('Date', MARGIN + 270, sigLineY + 12);

  // PO # line
  const poLineY = sigLineY + 40;
  doc.line(MARGIN, poLineY, MARGIN + 430, poLineY);
  doc.text('PO #', MARGIN, poLineY + 12);

  // ---------- Footer (on every page) ----------
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
      footerY
    );
    doc.text(`Page ${p} of ${pageCount}`, pageWidth - MARGIN, footerY, { align: 'right' });
  }

  doc.save(`Quote-${quote.quote_number}.pdf`);
}
