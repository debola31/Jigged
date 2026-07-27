/**
 * Generate a printable per-part job traveler PDF.
 *
 * Modeled on utils/packingSlipPdf.ts — same jsPDF + jspdf-autotable
 * letter format, margins, logo embedding, and footer. One traveler is
 * unique to a single job_part and carries exactly ONE QR code, in the header:
 * scanning it opens that part's traveler page, where every step is listed and
 * the operator taps the one they're working. Earlier revisions printed a QR on
 * every operation row; a column of codes an inch apart left operators unsure
 * which one they were pointing at, so the sheet is back to a single
 * unambiguous target.
 *
 * Layout — kept tight on purpose. The header used to stack title over QR over a
 * caption and ran ~165pt, pushing the Operations table 40% down the page with a
 * void beside it for any shop that hasn't filled in an address:
 *   - Header (~82pt): company logo (top-left) + return address; the traveler QR
 *     at the far right, top-aligned, with "JOB TRAVELER" + Job # right-aligned
 *     to ITS left — so header height is the QR, not the sum of the stack.
 *   - Info block: Customer / Part Number / Quantity / Customer PO / Order Date
 *     (jobs.created_at) / Due Date, in two label/value columns, closed by a
 *     divider. Description spans full width beneath.
 *   - Operations table: Step / Work Center / Operation · Instructions / Notes
 *     (setup·cycle for internal, "OUTSIDE — ship to {vendor}" for outside) /
 *     Done (blank write-in). Outside rows are flagged with a heavy black
 *     outline + bold text (border only, low ink).
 *   - Footer (every page): page numbers.
 */

import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import QRCode from 'qrcode';
import type { Company } from '@/utils/companyAccess';
import type { JobTraveler, JobTravelerOperation } from '@/types/operator';
import type { BomLineWithChildPart } from '@/types/bom';
import {
  buildShopHeaderLines,
  formatDate,
  loadLogoAsDataUrl,
  type SupabaseLike,
} from '@/utils/packingSlipPdf';

const MARGIN = 40;
/**
 * Side of the single header QR (points).
 *
 * The scan URL is ~156 chars (origin + two UUIDs), which lands the code at
 * version 8 — 49x49 modules, plus a 2-module quiet zone a side = 53 across. At
 * 56pt (19.8mm) that works out to ~0.37mm per module.
 *
 * That number is set by precedent, not by a generic spec: the per-operation QRs
 * this sheet used to print were also 56pt but carried a THIRD uuid (203 chars,
 * version 9, 53x53) for ~0.35mm per module. This code is strictly less dense
 * than what the traveler already shipped, at the same physical size. Caveat
 * worth keeping in mind — the paperless operator flow was built but paper won by
 * habit, so 0.35mm is an accepted precedent rather than a proven field result.
 *
 * If a shop ever reports a scan failing off a greasy or smudged sheet, do NOT
 * just enlarge this. Shorten the URL instead: a `/t/{jobPartId}` redirect route
 * (~60 chars) drops the code to version 4 / 33x33, which at this same 56pt is
 * ~0.53mm per module — nearly half again more robust, with no layout change.
 */
const QR_SIZE = 56;

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
  /** Company id — used to build the traveler's deep-link QR URL. */
  companyId: string;
  /** Absolute origin (e.g. window.location.origin) the scan URL resolves against. */
  baseUrl: string;
  /** Optional Supabase client to resolve the logo signed URL. */
  supabase?: SupabaseLike | null;
}

export async function generateJobTravelerPdf(
  ctx: JobTravelerPdfContext,
): Promise<jsPDF> {
  const { traveler, company, bom, companyId, baseUrl } = ctx;

  // The one QR on the sheet: it opens this job_part's traveler page (via the
  // operator login passthrough), which lists every step for the operator to
  // pick from. No `operation=` param — the sheet no longer targets a step.
  const travelerUrl =
    `${baseUrl}/operator/${companyId}/login` +
    `?job=${traveler.job_id}&part=${traveler.job_part_id}`;
  let travelerQrDataUrl: string | null = null;
  try {
    travelerQrDataUrl = await QRCode.toDataURL(travelerUrl, {
      margin: 2,
      width: 320,
      errorCorrectionLevel: 'M',
    });
  } catch {
    // Skip the QR; the printed traveler is still useful without it.
  }

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
  doc.setFontSize(9.5);
  doc.setTextColor(90);
  shopLines.forEach((line, i) => {
    doc.text(line, shopNameX, headerTop + 30 + i * 11.5);
  });
  const shopBlockBottom = Math.max(
    logoBottom,
    headerTop + (shopLines.length ? 30 + shopLines.length * 11.5 : 18),
  );

  // ---------- Header: the traveler QR (far right, top-aligned) ----------
  // The QR sits BESIDE the title, not under it, so header height is one element
  // tall rather than title + QR + caption stacked to ~165pt. No caption — a QR
  // already reads as "scan me", and the old line just cost a row of paper.
  const qrX = pageWidth - MARGIN - QR_SIZE;
  const qrY = headerTop;
  let qrBlockBottom = headerTop;
  if (travelerQrDataUrl) {
    try {
      doc.addImage(travelerQrDataUrl, 'PNG', qrX, qrY, QR_SIZE, QR_SIZE);
      qrBlockBottom = qrY + QR_SIZE;
    } catch {
      // Skip silently — the rest of the traveler is still useful.
    }
  }

  // ---------- Header: title + Job # (right, left of the QR) ----------
  // Right-aligned to the QR's left edge so the two never collide.
  const titleRight = qrX - 16;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(21);
  doc.setTextColor(30);
  doc.text('JOB TRAVELER', titleRight, headerTop + 18, { align: 'right' });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(70);
  doc.text(`Job ${traveler.job_number}`, titleRight, headerTop + 36, { align: 'right' });

  // ---------- HOT stamp (under the Job #, left of the QR) ----------
  // The paperless equivalent of Contour's pink paper / "HOT" in red pen. Drawn as
  // an OUTLINED "rubber stamp" — a heavy black border with bold black "HOT" on
  // white, NO filled background. That mirrors the physical HOT rubber stamp,
  // reads unmistakably in grayscale (no reliance on color), and uses a fraction
  // of the toner a solid-black fill would (the earlier reversed-white-on-black
  // version was flagged as too ink-heavy). A double rule gives it stamp presence
  // without adding meaningful ink.
  let hotStampBottom = headerTop;
  if (traveler.is_hot) {
    const stampW = 82;
    const stampH = 26;
    // Tucked into the gap under the Job #, right-aligned to the title.
    const stampX = titleRight - stampW;
    const stampY = headerTop + 46;
    hotStampBottom = stampY + stampH;
    doc.setDrawColor(0);
    doc.setLineWidth(2);
    doc.roundedRect(stampX, stampY, stampW, stampH, 4, 4, 'S');
    doc.setLineWidth(0.6);
    doc.roundedRect(stampX + 3.2, stampY + 3.2, stampW - 6.4, stampH - 6.4, 2.5, 2.5, 'S');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(0);
    doc.text('HOT', stampX + stampW / 2, stampY + stampH / 2 + 5.2, { align: 'center' });
    // Restore stroke/text state for the elements drawn afterwards (divider, etc.).
    doc.setTextColor(30);
    doc.setLineWidth(0.75);
  }

  // Header height is whichever column runs longest. The HOT stamp MUST be in
  // this max: its bottom sits 16pt below a 56pt QR, so leaving it out draws the
  // divider straight through the stamp on every hot job.
  let cursorY = Math.max(shopBlockBottom, qrBlockBottom, hotStampBottom) + 16;

  // ---------- Divider ----------
  doc.setDrawColor(205);
  doc.setLineWidth(0.75);
  doc.line(MARGIN, cursorY, pageWidth - MARGIN, cursorY);
  cursorY += 20;

  // ---------- Info block ----------
  // Short label/value pairs in two columns; each row advances by the taller
  // of its two cells. Description spans the full width below the grid so a
  // long description wraps cleanly instead of colliding with the next row.
  // labelGap is the label -> value gutter: wide enough that values line up in a
  // column, narrow enough not to leave a channel of white down the page.
  const colWidth = (pageWidth - MARGIN * 2) / 2;
  const lineHeight = 13;
  const labelGap = 66;

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
    // Single-line rows advance 16pt; a wrapped value still gets its full height.
    cursorY += Math.max(ll, rl) * lineHeight + 3;
  });

  // Description — full width so it never overlaps the adjacent column.
  const descLines = drawPair(
    'Description',
    traveler.part_description ?? '—',
    MARGIN,
    cursorY,
    pageWidth - MARGIN * 2 - labelGap,
  );
  cursorY += descLines * lineHeight + 4;

  // ---------- Divider ----------
  // Closes the info block so it reads as a band rather than trailing off into
  // the Operations heading.
  doc.setDrawColor(205);
  doc.setLineWidth(0.75);
  doc.line(MARGIN, cursorY, pageWidth - MARGIN, cursorY);
  cursorY += 22;

  // ---------- Operations table ----------
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(30);
  doc.text('Operations', MARGIN, cursorY);
  cursorY += 10;

  // One "Notes" column carries the setup/cycle estimates for internal steps and
  // the "ship to {vendor}" instruction for outside steps (which have no times) —
  // so the space isn't wasted on a 0/0 for outside ops. "Completed (of N)" is a
  // blank write-in for the floor to tally good pieces or tick off the step.
  // "Done" (not "Completed (of N)", which wrapped) — a short, single-line write-in
  // for a good-piece count or a tick; the order qty already sits in the header.
  const head = [[
    'Step', 'Work Center', 'Operation / Instructions', 'Notes', 'Done',
  ]];
  // Explicit row -> operation map, built alongside `body` so the external-op
  // restyle resolves the op by identity, never by a fragile positional index
  // into traveler.operations (the empty-ops placeholder row maps to null).
  const rowOps: (JobTravelerOperation | null)[] = [];
  const body = traveler.operations.map((op) => {
    rowOps.push(op);
    const isExternal = op.work_center_kind === 'external';
    const workCenter = op.work_center_name ?? op.operation_name ?? '—';
    const detail = [op.operation_name, op.instructions]
      .filter((s): s is string => Boolean(s && s.trim()))
      // Drop a redundant operation_name when it equals the work-center label.
      .filter((s, idx) => !(idx === 0 && s === op.work_center_name))
      .join(' — ') || '—';
    // Notes: outside steps get "OUTSIDE — ship to {vendor}" (the actionable cue);
    // internal steps get their setup/cycle estimates.
    let notes: string;
    if (isExternal) {
      notes = `OUTSIDE — ship to ${op.vendor_name || 'the vendor'}`;
    } else {
      const t: string[] = [];
      if (op.setup_minutes > 0) t.push(`Setup ${formatMinutes(op.setup_minutes)} min`);
      if (op.cycle_minutes > 0) t.push(`Cycle ${formatMinutes(op.cycle_minutes)} min/pc`);
      notes = t.length ? t.join(' · ') : '—';
    }
    return [
      String(op.sequence),
      workCenter,
      detail,
      notes,
      '', // Done — blank write-in
    ];
  });

  if (body.length === 0) {
    body.push(['—', 'No operations on this part', '', '', '']);
    rowOps.push(null);
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
      // Enough row height to hand-write a piece count in the Done column,
      // without the QR-spacing bloat the per-operation codes used to need.
      minCellHeight: 32,
    },
    columnStyles: {
      0: { cellWidth: 38, halign: 'center' },
      1: { cellWidth: 110, fontStyle: 'bold' },
      2: { cellWidth: 'auto' },
      3: { cellWidth: 140 },
      4: { cellWidth: 60, halign: 'center' },
    },
    // Flag external (outside-vendor) rows with a heavy black OUTLINE + bold black
    // text only — no fill. Unmistakable and grayscale-safe (contrast, not hue),
    // and uses essentially no extra toner (the earlier gray/solid fills drew a
    // shop-owner ink complaint). The "OUTSIDE — ship to {vendor}" cue lives in the
    // Notes column.
    didParseCell: (data) => {
      if (data.section !== 'body') return;
      const op = rowOps[data.row.index];
      if (op?.work_center_kind !== 'external') return;
      data.cell.styles.fontStyle = 'bold';
      data.cell.styles.textColor = [20, 20, 20];
      data.cell.styles.lineWidth = 1.2;
      data.cell.styles.lineColor = [20, 20, 20];
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

    // Page numbers only. The company name + Job # already head the document, so
    // repeating them here was redundant.
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(130);
    doc.text(`Page ${p} of ${pageCount}`, pageWidth - MARGIN, footerY, { align: 'right' });
  }

  return doc;
}
