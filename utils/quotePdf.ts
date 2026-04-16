/**
 * Generate a printable, customer-facing PDF for a quote.
 *
 * Intentionally excludes internal details (routing, operations, cost breakdown,
 * markup %). The customer sees what they're buying and what it costs — nothing
 * more.
 */
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { QuoteWithRelations } from '@/types/quote';
import type { Company } from '@/utils/companyAccess';
import { downloadFileFromStorage } from '@/utils/storageHelpers';
import { QUOTE_STATUS_CONFIG } from '@/types/quote';

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

  // ---------- Header ----------
  const headerTop = MARGIN;
  const logoMaxSize = 60;
  let companyNameX = MARGIN;

  if (logo) {
    // Preserve aspect ratio, cap by logoMaxSize.
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

  // Right side: QUOTE title + meta
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(26);
  doc.setTextColor(30);
  doc.text('QUOTE', pageWidth - MARGIN, headerTop + 20, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(80);
  const metaLines = [
    `Quote #: ${quote.quote_number}`,
    `Date: ${formatDate(quote.created_at)}`,
    `Status: ${QUOTE_STATUS_CONFIG[quote.status]?.label ?? quote.status}`,
  ];
  metaLines.forEach((line, i) => {
    doc.text(line, pageWidth - MARGIN, headerTop + 40 + i * 14, { align: 'right' });
  });

  // ---------- Divider ----------
  const dividerY = headerTop + Math.max(logoMaxSize, 90) + 10;
  doc.setDrawColor(210);
  doc.setLineWidth(0.75);
  doc.line(MARGIN, dividerY, pageWidth - MARGIN, dividerY);

  // ---------- Bill To ----------
  const billToY = dividerY + 28;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text('BILL TO', MARGIN, billToY);

  const billToLines = buildBillToLines(quote.customers);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(40);
  billToLines.forEach((line, i) => {
    const weight = i === 0 ? 'bold' : 'normal';
    doc.setFont('helvetica', weight);
    doc.text(line, MARGIN, billToY + 18 + i * 14);
  });

  const billToBottom = billToY + 18 + billToLines.length * 14;

  // ---------- Line items ----------
  const partName = quote.parts?.part_name ?? 'Ad-hoc part';
  const lineDescription = quote.description?.trim() || quote.parts?.description?.trim() || '';
  const qty = quote.quantity;
  const unitPrice = quote.unit_price ?? 0;
  const lineTotal = quote.total_price ?? unitPrice * qty;

  autoTable(doc, {
    startY: billToBottom + 24,
    margin: { left: MARGIN, right: MARGIN },
    head: [['Part', 'Description', 'Qty', 'Unit Price', 'Total']],
    body: [
      [
        partName,
        lineDescription,
        String(qty),
        formatCurrency(unitPrice),
        formatCurrency(lineTotal),
      ],
    ],
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

  // autoTable attaches lastAutoTable to the doc in jspdf-autotable v5.
  const afterTableY =
    (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ??
    billToBottom + 60;

  // ---------- Totals ----------
  const totalsY = afterTableY + 24;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(30);
  doc.text('Total', pageWidth - MARGIN - 90, totalsY, { align: 'right' });
  doc.text(formatCurrency(lineTotal), pageWidth - MARGIN, totalsY, { align: 'right' });

  // ---------- Notes ----------
  let cursorY = totalsY + 40;
  if (quote.description && quote.description.trim()) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text('NOTES', MARGIN, cursorY);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(60);
    const wrapped = doc.splitTextToSize(quote.description.trim(), pageWidth - MARGIN * 2);
    doc.text(wrapped, MARGIN, cursorY + 16);
    cursorY += 16 + wrapped.length * 12 + 20;
  }

  // ---------- Footer ----------
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
  doc.text('Page 1 of 1', pageWidth - MARGIN, footerY, { align: 'right' });

  doc.save(`Quote-${quote.quote_number}.pdf`);
}
