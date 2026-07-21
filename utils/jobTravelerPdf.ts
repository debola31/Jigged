/**
 * Generate a printable per-part job traveler PDF.
 *
 * Modeled on utils/packingSlipPdf.ts — same jsPDF + jspdf-autotable
 * letter format, margins, logo embedding, and footer. One traveler is
 * unique to a single job_part. Each OPERATION row carries its own QR code,
 * which deep-links the operator straight to that exact step's action view
 * (a per-operation "scan to complete"). There is no single whole-job QR.
 *
 * Layout:
 *   - Header: company logo (top-left) + return address; "JOB TRAVELER"
 *     title + Job # (top-right).
 *   - Info block: Customer / Part Number / Description / Quantity /
 *     Customer PO / Order Date (jobs.created_at) / Due Date.
 *   - Operations table: Step / Work Center / Operation · Instructions /
 *     Setup (min) / Cycle (min/pc) / Scan (per-operation QR).
 *   - Footer (every page): generated date + page numbers.
 */

import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import QRCode from 'qrcode';
import type { Company } from '@/utils/companyAccess';
import type { JobTraveler } from '@/types/operator';
import type { BomLineWithChildPart } from '@/types/bom';
import {
  buildShopHeaderLines,
  formatDate,
  loadLogoAsDataUrl,
  type SupabaseLike,
} from '@/utils/packingSlipPdf';

const MARGIN = 40;
// Side of the per-operation QR drawn inside each table row (points). Sized
// generously and paired with a quiet zone (toDataURL margin) + tall rows
// (bodyStyles.minCellHeight) so adjacent QR codes are far enough apart that a
// phone camera locks onto a single one instead of getting confused by neighbors.
const OP_QR_SIZE = 56;

function formatMinutes(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  if (n === 0) return '0';
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function formatQty(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return Number(value).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
}

/** Sanitize job/part identifiers for use in a download filename. */
function sanitizeForFilename(value: string | null | undefined): string {
  return (value ?? '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '_').trim() || 'part';
}

export function jobTravelerPdfFilename(
  jobNumber: string,
  partName: string | null | undefined,
): string {
  return `Traveler-${sanitizeForFilename(jobNumber)}-${sanitizeForFilename(partName)}.pdf`;
}

export interface JobTravelerPdfContext {
  traveler: JobTraveler;
  company: Company;
  /** The part's bill of materials (parts_bom), quantities per unit. */
  bom: BomLineWithChildPart[];
  /** Company id — used to build each operation's deep-link QR URL. */
  companyId: string;
  /** Absolute origin (e.g. window.location.origin) the scan URLs resolve against. */
  baseUrl: string;
  /** Optional Supabase client to resolve the logo signed URL. */
  supabase?: SupabaseLike | null;
}

export async function generateJobTravelerPdf(
  ctx: JobTravelerPdfContext,
): Promise<jsPDF> {
  const { traveler, company, bom, companyId, baseUrl } = ctx;

  // One QR per operation: scanning it deep-links to that exact step's action
  // view (via the operator login passthrough). Generated up front as PNG data
  // URLs and drawn into each row by the autotable didDrawCell hook below.
  const qrByOpId = new Map<string, string>();
  await Promise.all(
    traveler.operations.map(async (op) => {
      const url =
        `${baseUrl}/operator/${companyId}/login` +
        `?job=${traveler.job_id}&part=${traveler.job_part_id}&operation=${op.id}`;
      try {
        // margin: 2 = a white quiet zone baked into the image so the scanner
        // can isolate this code from its neighbors on the sheet.
        qrByOpId.set(op.id, await QRCode.toDataURL(url, { margin: 2, width: 220, errorCorrectionLevel: 'M' }));
      } catch {
        // Skip this row's QR; the rest of the traveler is still useful.
      }
    }),
  );

  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  // ---------- Header: shop block (left) ----------
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
  const shopBlockBottom = Math.max(logoBottom, headerTop + 30 + shopLines.length * 12);

  // ---------- Header: title + QR (right) ----------
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(24);
  doc.setTextColor(30);
  doc.text('JOB TRAVELER', pageWidth - MARGIN, headerTop + 18, { align: 'right' });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(60);
  doc.text(`Job ${traveler.job_number}`, pageWidth - MARGIN, headerTop + 36, { align: 'right' });

  // No whole-job QR — each operation row carries its own scan-to-complete QR.
  let cursorY = Math.max(shopBlockBottom, headerTop + 36) + 18;

  // ---------- Divider ----------
  doc.setDrawColor(210);
  doc.setLineWidth(0.75);
  doc.line(MARGIN, cursorY, pageWidth - MARGIN, cursorY);
  cursorY += 20;

  // ---------- Info block ----------
  // Short label/value pairs in two columns; each row advances by the taller
  // of its two cells. Description spans the full width below the grid so a
  // long description wraps cleanly instead of colliding with the next row.
  const colWidth = (pageWidth - MARGIN * 2) / 2;
  const lineHeight = 13;
  const labelGap = 80;

  const drawPair = (label: string, value: string, x: number, y: number, maxWidth: number): number => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(120);
    doc.text(`${label}:`, x, y);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(40);
    const wrapped = doc.splitTextToSize(value, maxWidth);
    doc.text(wrapped, x + labelGap, y);
    return wrapped.length;
  };

  const cellWidth = colWidth - labelGap - 8;
  const gridRows: Array<[[string, string], [string, string]]> = [
    [
      ['Customer', traveler.customer_name ?? '—'],
      ['Part Number', traveler.part_name ?? '—'],
    ],
    [
      ['Quantity', traveler.quantity != null ? String(traveler.quantity) : '—'],
      ['Customer PO', traveler.customer_po_number ?? '—'],
    ],
    [
      ['Order Date', formatDate(traveler.order_date)],
      ['Due Date', formatDate(traveler.due_date)],
    ],
  ];
  gridRows.forEach(([left, right]) => {
    const ll = drawPair(left[0], left[1], MARGIN, cursorY, cellWidth);
    const rl = drawPair(right[0], right[1], MARGIN + colWidth, cursorY, cellWidth);
    cursorY += Math.max(ll, rl) * lineHeight + 4;
  });

  // Description — full width so it never overlaps the adjacent column.
  const descLines = drawPair(
    'Description',
    traveler.part_description ?? '—',
    MARGIN,
    cursorY,
    pageWidth - MARGIN * 2 - labelGap,
  );
  cursorY += descLines * lineHeight + 16;

  // ---------- Operations table ----------
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(30);
  doc.text('Operations', MARGIN, cursorY);
  cursorY += 10;

  // "Good (of N)" is a blank write-in column so the floor can tally good pieces
  // per operation on paper (the offline-capture fallback for partial completion).
  const head = [[
    'Step', 'Work Center', 'Operation / Instructions', 'Setup (min)', 'Cycle (min/pc)',
    `Good (of ${traveler.quantity})`, 'Scan',
  ]];
  const body = traveler.operations.map((op) => {
    const workCenter = op.work_center_name ?? op.operation_name ?? '—';
    const detail = [op.operation_name, op.instructions]
      .filter((s): s is string => Boolean(s && s.trim()))
      // Drop a redundant operation_name when it equals the work-center label.
      .filter((s, idx) => !(idx === 0 && s === op.work_center_name))
      .join(' — ') || '—';
    return [
      String(op.sequence),
      workCenter,
      detail,
      formatMinutes(op.setup_minutes),
      formatMinutes(op.cycle_minutes),
      '', // Good made — blank write-in
      '', // Scan — QR drawn in didDrawCell
    ];
  });

  if (body.length === 0) {
    body.push(['—', 'No operations on this part', '', '—', '—', '', '']);
  }

  const SCAN_COL = 6;
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
      valign: 'middle',
    },
    headStyles: {
      fillColor: [240, 240, 240],
      textColor: [30, 30, 30],
      fontStyle: 'bold',
      lineColor: [200, 200, 200],
      lineWidth: 0.5,
    },
    bodyStyles: {
      // Tall rows put vertical whitespace between adjacent QR codes so a phone
      // camera doesn't see two codes at once.
      minCellHeight: OP_QR_SIZE + 30,
    },
    columnStyles: {
      0: { cellWidth: 38, halign: 'center' },
      1: { cellWidth: 100, fontStyle: 'bold' },
      2: { cellWidth: 'auto' },
      3: { cellWidth: 54, halign: 'right' },
      4: { cellWidth: 60, halign: 'right' },
      5: { cellWidth: 58, halign: 'center' },
      6: { cellWidth: OP_QR_SIZE + 18, halign: 'center' },
    },
    // Draw each operation's QR centered in its Scan cell.
    didDrawCell: (data) => {
      if (data.section !== 'body' || data.column.index !== SCAN_COL) return;
      const op = traveler.operations[data.row.index];
      const dataUrl = op ? qrByOpId.get(op.id) : undefined;
      if (!dataUrl) return;
      const x = data.cell.x + (data.cell.width - OP_QR_SIZE) / 2;
      const y = data.cell.y + (data.cell.height - OP_QR_SIZE) / 2;
      try {
        doc.addImage(dataUrl, 'PNG', x, y, OP_QR_SIZE, OP_QR_SIZE);
      } catch {
        // Skip silently — the row's text is still printed.
      }
    },
    theme: 'grid',
  });

  cursorY =
    (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? cursorY;
  cursorY += 24;

  // ---------- Bill of materials ----------
  // Keep the heading and at least the first row together — start a new page
  // if the section would be orphaned at the very bottom.
  if (cursorY + 70 > pageHeight - MARGIN) {
    doc.addPage();
    cursorY = MARGIN;
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(30);
  doc.text('Bill of Materials', MARGIN, cursorY);
  cursorY += 10;

  if (bom.length === 0) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(120);
    doc.text("No materials on this part's BOM.", MARGIN, cursorY + 10);
  } else {
    autoTable(doc, {
      startY: cursorY,
      margin: { left: MARGIN, right: MARGIN },
      head: [['Material', 'Description', 'Qty / unit', 'Unit', 'Job needs']],
      body: bom.map((line) => {
        // Whole-order draw for the shop floor: ceil for discrete stock (a strip
        // you can't cut a fraction of), else the fractional total. Avoids
        // printing a bare "0.05 strips" that means nothing to someone pulling
        // material.
        const orderQty = traveler.quantity;
        let jobNeeds = '—';
        if (orderQty != null && orderQty > 0) {
          const needed = line.consume_whole_units
            ? Math.ceil(orderQty * line.quantity)
            : orderQty * line.quantity;
          jobNeeds = `${formatQty(needed)} ${line.unit ?? ''}`.trim();
        }
        return [
          line.child_part?.part_name ?? '—',
          line.child_part?.description?.trim() || '—',
          formatQty(line.quantity),
          line.unit ?? '—',
          jobNeeds,
        ];
      }),
      styles: {
        font: 'helvetica',
        fontSize: 10,
        cellPadding: 7,
        textColor: [40, 40, 40],
        valign: 'middle',
      },
      headStyles: {
        fillColor: [240, 240, 240],
        textColor: [30, 30, 30],
        fontStyle: 'bold',
        lineColor: [200, 200, 200],
        lineWidth: 0.5,
      },
      columnStyles: {
        0: { cellWidth: 150, fontStyle: 'bold' },
        1: { cellWidth: 'auto' },
        2: { cellWidth: 70, halign: 'right' },
        3: { cellWidth: 55 },
        4: { cellWidth: 80, halign: 'right', fontStyle: 'bold' },
      },
      theme: 'grid',
    });
  }

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
    doc.text(`${company.name} · Job ${traveler.job_number}`, MARGIN, footerY);
    doc.text(`Page ${p} of ${pageCount}`, pageWidth - MARGIN, footerY, { align: 'right' });
  }

  return doc;
}
