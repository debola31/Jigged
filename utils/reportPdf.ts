/**
 * One page, from a ReportSpec: the shop's header, the AI-inferred title top-right,
 * a KPI band, then tables and charts -- deterministic, from stored figures, the same
 * way every other document in the product is drawn.
 *
 * THE GUARDRAILS LIVE HERE, NOT IN A PROMPT. The spec caps how much a report may
 * hold (models/report_spec.py); this file measures each block before drawing it and
 * stops at the footer, naming what it left out. `addPage` is never called -- a test
 * asserts it -- so "one page" is a property of the renderer, not a request made of
 * a model. The header follows the contract every document uses: measure the right
 * column first, then size the shop block into the space the header already pays for
 * (utils/quotePdf.ts explains why the order matters).
 *
 * Typography is the reference document's: a 22pt title, 8.5pt grey meta lines, a
 * 52pt band of 21pt figures over 7.5pt uppercase captions, 7.5pt uppercase section
 * titles, 9pt tables with a grey header row and a bold total, 7.5pt footer.
 */
import { jsPDF } from 'jspdf';
import autoTable, { type RowInput } from 'jspdf-autotable';
import type { Company } from '@/utils/companyAccess';
import { readLogoIncludesName } from '@/lib/companyDefaults';
import { formatKpi, formatValue, type ValueFormat } from '@/utils/chartFormat';
import {
  ATTRIBUTION_MARK,
  drawShopHeaderBlock,
  loadLogoAsDataUrl,
  type SupabaseLike,
} from '@/utils/packingSlipPdf';
import { PDF_PALETTE, chartFrameHeight, drawChartConfig, fitLabel } from '@/utils/pdfCharts';
import type { ReportBlock, ReportCell, ReportSpec, ReportTableBlock } from '@/utils/reportSpec';

const MARGIN = 40;
const FOOTER_RESERVE = 30;
/**
 * THE RULE: NOTHING THE MODEL WROTE IS DRAWN UNMEASURED. Every free string in the
 * spec -- title, headline, labels, captions, section titles, notes, cells -- is
 * fitted to the slot it lands in: an ellipsis, a wrap with a line cap, or a font
 * that steps down before a character is cut. The first live report captioned a
 * KPI tile with a sentence and the line ran through the next tile and off the
 * page; a mocked test cannot see that, so the renderer never trusts a length.
 */
const TITLE_SIZE = 22;
const TITLE_MIN_SIZE = 15;
/** Header points that belong to the logo, name and address whatever the title's length. */
const HEADER_LEFT_RESERVE = 200;
/** Header depth handed to the shop block when a logo exists: a ~38pt mark above name and address. */
const LOGO_HEADER_DEPTH = 96;
const KPI_BAND_HEIGHT = 52;
/** The band grows by one caption line when a tile needs its label and caption on two lines. */
const KPI_CAPTION_LINE_H = 9;
const BLOCK_GAP = 16;
/** A chart is drawn this short before it is dropped: a shorter chart still says what it says. */
const MIN_CHART_HEIGHT = 100;
const SECTION_TITLE_H = 14;
/** A 9pt single-line autoTable row: 9 × 1.15 line height plus 3pt padding above and below. */
const TABLE_ROW_H = 17;
const TABLE_HEAD_H = 17;
const TEXT_LINE_H = 12;
const NOTE_H = 12;
/** Two consecutive tables this narrow share a row, like the reference's Backlog + Quoting. */
const SIDE_BY_SIDE_MAX_COLUMNS = 3;

type Rgb = readonly [number, number, number];

function setInk(doc: jsPDF, rgb: Rgb, size: number, style: 'normal' | 'bold' = 'normal') {
  doc.setFont('helvetica', style);
  doc.setFontSize(size);
  doc.setTextColor(rgb[0], rgb[1], rgb[2]);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `Operations-Summary-2026-09-07.pdf`: the title as a slug, the LOCAL generation date. */
export function reportPdfFilename(spec: ReportSpec, generatedAt: Date): string {
  const slug =
    spec.title.trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'Report';
  return `${slug}-${generatedAt.getFullYear()}-${pad2(generatedAt.getMonth() + 1)}-${pad2(generatedAt.getDate())}.pdf`;
}

function formatGenerated(generatedAt: Date): string {
  return generatedAt.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** A date-only ISO string parsed from its parts (the UTC-midnight trap `formatLabel` documents). */
function localDate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

/**
 * "Jun 1 – Sep 3, 2026", the reference's period line, from the spec's dates.
 *
 * The dates are the truth and the label is the model's name for them. A label
 * that already carries a year ("Jun 1 – Sep 3, 2026") stands alone; any other
 * ("Q3", "Last 90 days", "June to September") is printed with the dates after
 * it. The second live report labelled its period "June to September" and dated
 * it 2023; a label without a year would have hidden that from the page.
 */
export function periodLine(spec: Pick<ReportSpec, 'period_start' | 'period_end' | 'period_label'>): string {
  const start = localDate(spec.period_start);
  const end = localDate(spec.period_end);
  const label = spec.period_label.trim();
  if (!start || !end) return label;
  const day = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const range =
    start.getFullYear() === end.getFullYear()
      ? `${day(start)} – ${day(end)}, ${end.getFullYear()}`
      : `${day(start)}, ${start.getFullYear()} – ${day(end)}, ${end.getFullYear()}`;
  const carriesYear = /\b(19|20)\d{2}\b/.test(label);
  return carriesYear ? label : `${label} · ${range}`;
}

function cellText(cell: ReportCell, format: ValueFormat): string {
  if (cell === null || cell === undefined) return '—';
  if (typeof cell === 'string') return cell;
  return formatValue(cell, format);
}

function isNarrowTable(block: ReportBlock): block is ReportTableBlock {
  return block.type === 'table' && block.columns.length <= SIDE_BY_SIDE_MAX_COLUMNS;
}

/** A conservative height estimate, for the fits-on-the-page decision. */
function estimateHeight(doc: jsPDF, block: ReportBlock, width: number): number {
  if (block.type === 'table') {
    const rows = block.rows.length + (block.total_row ? 1 : 0);
    return SECTION_TITLE_H + TABLE_HEAD_H + rows * TABLE_ROW_H + (block.note ? NOTE_H : 0);
  }
  if (block.type === 'chart') {
    return SECTION_TITLE_H + chartFrameHeight(block.chart_config.chart_type) + (block.note ? NOTE_H : 0);
  }
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  return (doc.splitTextToSize(block.body, width) as string[]).length * TEXT_LINE_H;
}

function drawSectionTitle(doc: jsPDF, title: string, x: number, y: number, width: number): number {
  setInk(doc, PDF_PALETTE.muted, 7.5, 'bold');
  doc.text(fitLabel(doc, title.toUpperCase(), width), x, y + 8);
  return y + SECTION_TITLE_H;
}

function drawNote(doc: jsPDF, note: string | null, x: number, y: number, width: number): number {
  if (!note) return y;
  setInk(doc, PDF_PALETTE.muted, 7.5);
  doc.text(fitLabel(doc, note, width), x, y + 8);
  return y + NOTE_H;
}

function drawTable(doc: jsPDF, block: ReportTableBlock, x: number, y: number, width: number): number {
  let cursor = drawSectionTitle(doc, block.title, x, y, width);
  const body: RowInput[] = block.rows.map((row) =>
    row.map((cell, i) => cellText(cell, block.columns[i].format)),
  );
  const foot: RowInput[] | undefined = block.total_row
    ? [block.total_row.map((cell, i) => cellText(cell, block.columns[i].format))]
    : undefined;
  const numericColumns = Object.fromEntries(
    block.columns.map((c, i) => [i, { halign: c.format === 'plain' ? 'left' : 'right' } as const]),
  );

  autoTable(doc, {
    startY: cursor,
    margin: { left: x, right: 0 },
    tableWidth: width,
    head: [block.columns.map((c) => c.label)],
    body,
    foot,
    theme: 'plain',
    styles: {
      font: 'helvetica',
      fontSize: 9,
      // Single-line cells: a wrapped cell grows its row past the height the
      // page was packed against, and autoTable would add a page to hold it.
      overflow: 'ellipsize',
      cellPadding: { top: 3, bottom: 3, left: 4, right: 4 },
      textColor: [...PDF_PALETTE.ink],
      lineColor: [...PDF_PALETTE.grid],
      lineWidth: 0.5,
    },
    headStyles: { fillColor: [240, 240, 240], textColor: [...PDF_PALETTE.ink], fontStyle: 'bold' },
    footStyles: { fillColor: [255, 255, 255], textColor: [...PDF_PALETTE.ink], fontStyle: 'bold' },
    columnStyles: numericColumns,
  });
  cursor = (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? cursor + TABLE_HEAD_H + body.length * TABLE_ROW_H;
  return drawNote(doc, block.note, x, cursor + 2, width);
}

function drawChart(
  doc: jsPDF,
  block: Extract<ReportBlock, { type: 'chart' }>,
  x: number,
  y: number,
  width: number,
  height = chartFrameHeight(block.chart_config.chart_type),
): number {
  const cursor = drawSectionTitle(doc, block.title, x, y, width);
  drawChartConfig(doc, block.chart_config, { x, y: cursor, width, height });
  return drawNote(doc, block.note, x, cursor + height + 2, width);
}

/** What a chart block costs beyond its frame: the section title, the gap, the note. */
function chartOverhead(block: Extract<ReportBlock, { type: 'chart' }>): number {
  return SECTION_TITLE_H + 2 + (block.note ? NOTE_H : 0);
}

function drawText(doc: jsPDF, body: string, x: number, y: number, width: number): number {
  // Set the font BEFORE measuring: splitTextToSize wraps against the current font.
  setInk(doc, PDF_PALETTE.ink, 9);
  const lines = doc.splitTextToSize(body, width) as string[];
  lines.forEach((line, i) => doc.text(line, x, y + 9 + i * TEXT_LINE_H));
  return y + lines.length * TEXT_LINE_H;
}

function drawBlock(doc: jsPDF, block: ReportBlock, x: number, y: number, width: number): number {
  if (block.type === 'table') return drawTable(doc, block, x, y, width);
  if (block.type === 'chart') return drawChart(doc, block, x, y, width);
  return drawText(doc, block.body, x, y, width);
}

/**
 * Build the one-page PDF and return it unwritten. Callers choose the sink:
 * `doc.output('bloburl')` for the preview iframe, `doc.save(filename)` to download.
 */
export async function generateReportPdf(
  spec: ReportSpec,
  company: Company,
  generatedAt: Date,
  supabase?: SupabaseLike | null,
): Promise<jsPDF> {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const usableWidth = pageWidth - MARGIN * 2;
  const footerTop = pageHeight - MARGIN - FOOTER_RESERVE;

  // ---------- Header: the right column first, then the shop block sized into it ----------
  const headerTop = MARGIN;
  const titleRoom = usableWidth - HEADER_LEFT_RESERVE;
  const title = spec.title.toUpperCase();
  let titleSize = TITLE_SIZE;
  setInk(doc, PDF_PALETTE.ink, titleSize, 'bold');
  while (doc.getTextWidth(title) > titleRoom && titleSize > TITLE_MIN_SIZE) {
    titleSize -= 1;
    setInk(doc, PDF_PALETTE.ink, titleSize, 'bold');
  }
  doc.text(fitLabel(doc, title, titleRoom), pageWidth - MARGIN, headerTop + 20, { align: 'right' });
  setInk(doc, PDF_PALETTE.secondary, 8.5);
  const meta = [`Period: ${periodLine(spec)}`, `Generated: ${formatGenerated(generatedAt)}`];
  meta.forEach((row, i) => doc.text(fitLabel(doc, row, titleRoom), pageWidth - MARGIN, headerTop + 38 + i * 12, { align: 'right' }));
  const metaBottom = headerTop + 38 + meta.length * 12;

  // A quote's right column runs four or five rows deep, so `drawShopHeaderBlock`
  // finds room for a logo in space that header already pays for. This right
  // column is a title and two lines -- 62pt -- which after the name and address
  // leaves a logo 4pt tall (measured on the real render, 2026-09-07). So when a
  // logo exists the header is given the depth a five-row quote reaches anyway,
  // paid out of the page: about 32pt of a one-pager for a mark the reader can see.
  const logoDataUrl = await loadLogoAsDataUrl(company.logo_url, supabase ?? null);
  const availableBottom = logoDataUrl ? Math.max(metaBottom, headerTop + LOGO_HEADER_DEPTH) : metaBottom;
  const shopBottom = drawShopHeaderBlock(doc, {
    company,
    logoDataUrl,
    logoIncludesName: readLogoIncludesName(company),
    x: MARGIN,
    y: headerTop,
    availableBottom,
    nameSize: 14,
  });

  let cursorY = Math.max(shopBottom, metaBottom) + 14;
  doc.setDrawColor(PDF_PALETTE.grid[0], PDF_PALETTE.grid[1], PDF_PALETTE.grid[2]);
  doc.setLineWidth(0.75);
  doc.line(MARGIN, cursorY, pageWidth - MARGIN, cursorY);
  cursorY += 16;

  // ---------- Headline: the one line of prose ----------
  setInk(doc, PDF_PALETTE.ink, 10);
  const headline = doc.splitTextToSize(spec.headline, usableWidth) as string[];
  const shown = headline.slice(0, 2);
  if (headline.length > 2) shown[1] = fitLabel(doc, `${shown[1]} ${headline.slice(2).join(' ')}`, usableWidth);
  shown.forEach((line, i) => doc.text(line, MARGIN, cursorY + i * 13));
  cursorY += shown.length * 13 + 8;

  // ---------- KPI band ----------
  if (spec.kpis.length > 0) {
    const tileWidth = usableWidth / spec.kpis.length;
    const inner = tileWidth - 24;
    // The caption line is fitted to its tile, never trusted to be short. The
    // first live report captioned a tile "Total jobs in progress or active" and
    // the line ran through the next tile and off the page. `LABEL · CAPTION` on
    // one line when it fits; otherwise the label above the caption, each cut with
    // an ellipsis to the tile, and the band one line taller.
    setInk(doc, PDF_PALETTE.secondary, 7.5, 'bold');
    const captionLines = spec.kpis.map((kpi) => {
      const label = kpi.label.toUpperCase();
      if (!kpi.caption) return [fitLabel(doc, label, inner)];
      const joined = `${label} · ${kpi.caption.toUpperCase()}`;
      if (doc.getTextWidth(joined) <= inner) return [joined];
      return [fitLabel(doc, label, inner), fitLabel(doc, kpi.caption.toUpperCase(), inner)];
    });
    const bandHeight = KPI_BAND_HEIGHT + (captionLines.some((l) => l.length > 1) ? KPI_CAPTION_LINE_H : 0);
    doc.setFillColor(PDF_PALETTE.tileFill[0], PDF_PALETTE.tileFill[1], PDF_PALETTE.tileFill[2]);
    doc.setDrawColor(PDF_PALETTE.tileStroke[0], PDF_PALETTE.tileStroke[1], PDF_PALETTE.tileStroke[2]);
    doc.setLineWidth(0.9);
    doc.rect(MARGIN, cursorY, usableWidth, bandHeight, 'FD');
    spec.kpis.forEach((kpi, i) => {
      const x = MARGIN + i * tileWidth + 12;
      setInk(doc, PDF_PALETTE.ink, 21, 'bold');
      doc.text(formatKpi(kpi.value, kpi.format), x, cursorY + 30);
      setInk(doc, PDF_PALETTE.secondary, 7.5, 'bold');
      captionLines[i].forEach((line, row) => doc.text(line, x, cursorY + 44 + row * KPI_CAPTION_LINE_H));
    });
    cursorY += bandHeight + BLOCK_GAP;
  }

  // ---------- Blocks: pack down the page, never onto a second one ----------
  // Each block gets its chance in order: two narrow tables share a row, a chart
  // that does not fit at full height is drawn shorter (down to MIN_CHART_HEIGHT),
  // and a block that still does not fit is named below -- but the blocks after
  // it are still tried, because a one-line note after a chart that did not fit
  // is worth printing. The first live render dropped a 12pt note beside 140pt
  // of empty page because the chart before it had overflowed.
  const notShown: string[] = [];
  const blocks = [...spec.blocks];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    const next = blocks[i + 1];
    if (next && isNarrowTable(block) && isNarrowTable(next)) {
      const half = (usableWidth - BLOCK_GAP) / 2;
      const height = Math.max(estimateHeight(doc, block, half), estimateHeight(doc, next, half));
      if (cursorY + height <= footerTop) {
        const leftBottom = drawBlock(doc, block, MARGIN, cursorY, half);
        const rightBottom = drawBlock(doc, next, MARGIN + half + BLOCK_GAP, cursorY, half);
        cursorY = Math.max(leftBottom, rightBottom) + BLOCK_GAP;
        i += 2;
        continue;
      }
    }
    const room = footerTop - cursorY;
    if (estimateHeight(doc, block, usableWidth) <= room) {
      cursorY = drawBlock(doc, block, MARGIN, cursorY, usableWidth) + BLOCK_GAP;
    } else if (block.type === 'chart' && room - chartOverhead(block) - 4 >= MIN_CHART_HEIGHT) {
      cursorY = drawChart(doc, block, MARGIN, cursorY, usableWidth, room - chartOverhead(block) - 4) + BLOCK_GAP;
    } else {
      notShown.push(block.type === 'text' ? 'a note' : block.title);
    }
    i += 1;
  }

  // ---------- What did not fit, said out loud ----------
  if (notShown.length > 0) {
    setInk(doc, PDF_PALETTE.muted, 7.5);
    doc.text(fitLabel(doc, `Not shown (one page): ${notShown.join(', ')}`, usableWidth), MARGIN, footerTop + 9);
  }

  // ---------- Footer ----------
  const footerY = pageHeight - MARGIN;
  doc.setDrawColor(PDF_PALETTE.grid[0], PDF_PALETTE.grid[1], PDF_PALETTE.grid[2]);
  doc.setLineWidth(0.5);
  doc.line(MARGIN, footerY - 14, pageWidth - MARGIN, footerY - 14);
  // No page number: a document that is one page by construction has nothing to
  // count, and "Page 1 of 1" only invited the reader to look for a second.
  setInk(doc, PDF_PALETTE.muted, 7.5);
  doc.text(ATTRIBUTION_MARK, MARGIN, footerY);

  return doc;
}
