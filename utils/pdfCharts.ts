import type { jsPDF } from 'jspdf';
import type { ChartConfig } from '@/utils/insightsAccess';
import { formatCompact, formatLabel, temporalKey } from '@/utils/chartFormat';

/**
 * Charts drawn into a PDF as vectors, from the same `chart_config` the dashboard
 * renders with MUI X Charts.
 *
 * WHY NOT A SCREENSHOT. The on-screen chart is styled by emotion CSS classes that
 * do not travel with a serialised SVG, so an SVG→canvas→PNG capture arrives with
 * the axes unstyled and the fonts wrong -- and a raster on a printed page is soft
 * where a vector is crisp. A few hundred lines of geometry is the honest cost.
 *
 * WHAT THE CHART FOLLOWS (the dataviz method, applied to print): one hue for a
 * single series and a fixed categorical order for pie slices -- validated for a
 * white surface, adjacent-pair CVD ΔE 9.1, normal-vision 19.6 -- thin marks with a
 * rounded data-end and a square baseline, a hairline recessive grid, text in ink
 * tokens never in the series colour, direct labels only where they earn it, and a
 * white gap between touching marks. Three slice hues sit under 3:1 on white, so the
 * pie's legend carries visible labels: that is the relief the validator requires.
 */

/** Named once. No other RGB literal appears in a report file. */
export const PDF_PALETTE = {
  ink: [26, 26, 26],
  secondary: [120, 120, 120],
  muted: [138, 138, 138],
  grid: [230, 229, 225],
  surface: [255, 255, 255],
  tileFill: [245, 247, 250],
  tileStroke: [204, 204, 204],
  /** Categorical slot 1 (blue) -- every single-series mark. */
  accent: [42, 120, 214],
  /** The sequential ramp's lightest step -- the area wash, never a saturated block. */
  accentWash: [205, 226, 251],
  /** Categorical slots 1–6 in their validated order, for pie slices only. */
  series: [
    [42, 120, 214],
    [235, 104, 52],
    [27, 175, 122],
    [237, 161, 0],
    [232, 123, 164],
    [0, 131, 0],
  ],
} as const;

type Rgb = readonly [number, number, number];

/** The jsPDF surface a chart needs. A `Pick`, so a test can hand in a recording fake. */
export type ChartDoc = Pick<
  jsPDF,
  | 'setFont' | 'setFontSize' | 'setTextColor' | 'setDrawColor' | 'setFillColor' | 'setLineWidth'
  | 'text' | 'line' | 'rect' | 'roundedRect' | 'circle' | 'lines' | 'getTextWidth'
>;

export interface ChartFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

const FULL_HEIGHT = 170;
const SPARKLINE_HEIGHT = 60;
const MAX_BAR = 18;
const BAR_END_RADIUS = 4;
const MAX_PIE_SLICES = 6;
const TICK_COUNT = 4;

/** How tall a block of this chart type is, so the layout can measure before drawing. */
export function chartFrameHeight(chartType: ChartConfig['chart_type']): number {
  return chartType === 'sparkline' ? SPARKLINE_HEIGHT : FULL_HEIGHT;
}

/**
 * Clean tick values from zero to just past the maximum: steps of 1, 2, 2.5, 5 or 10
 * times a power of ten, about four of them. Exported for its test.
 */
export function niceTicks(maxValue: number, count = TICK_COUNT): number[] {
  if (!(maxValue > 0)) return [0, 1];
  const raw = maxValue / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  const top = Math.ceil(maxValue / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 1e6; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

function fill(doc: ChartDoc, rgb: Rgb) {
  doc.setFillColor(rgb[0], rgb[1], rgb[2]);
}
function stroke(doc: ChartDoc, rgb: Rgb, width: number) {
  doc.setDrawColor(rgb[0], rgb[1], rgb[2]);
  doc.setLineWidth(width);
}
function ink(doc: ChartDoc, rgb: Rgb, size: number, style: 'normal' | 'bold' = 'normal') {
  doc.setFont('helvetica', style);
  doc.setFontSize(size);
  doc.setTextColor(rgb[0], rgb[1], rgb[2]);
}

/** Shorten a label until it fits `maxWidth` at the current font, with an ellipsis. */
export function fitLabel(doc: ChartDoc, label: string, maxWidth: number): string {
  if (doc.getTextWidth(label) <= maxWidth) return label;
  let text = label;
  while (text.length > 1 && doc.getTextWidth(`${text}…`) > maxWidth) text = text.slice(0, -1);
  return `${text.trimEnd()}…`;
}

interface Point {
  label: string;
  value: number;
}

/**
 * The rows as label/value pairs. Labels are formatted but never cut here -- each
 * drawer fits them to the room it actually has. A time axis (ISO dates, month
 * names, quarters) is put in calendar order whatever order the rows arrived in;
 * a nominal axis is value-sorted when the drawer asks for it. "Mar, Feb, Jan,
 * Dec" is a scrambled calendar, not a ranking.
 */
function pointsOf(config: ChartConfig, sortDesc: boolean): Point[] {
  const raw = config.data.map((row) => String(row[config.x_key] ?? ''));
  const keys = raw.map(temporalKey);
  const points = raw.map((label, i) => ({
    label: formatLabel(label, Number.POSITIVE_INFINITY),
    value: Number(config.data[i][config.y_key] ?? 0),
    key: keys[i] ?? 0,
  }));
  if (keys.every((k) => k !== null)) return points.sort((a, b) => a.key - b.key);
  return sortDesc ? points.sort((a, b) => b.value - a.value) : points;
}

interface Plot {
  x: number;
  y: number;
  w: number;
  h: number;
  bottom: number;
}

function plotArea(frame: ChartFrame, inset: { left: number; right: number; top: number; bottom: number }): Plot {
  const x = frame.x + inset.left;
  const y = frame.y + inset.top;
  const w = frame.width - inset.left - inset.right;
  const h = frame.height - inset.top - inset.bottom;
  return { x, y, w, h, bottom: y + h };
}

/** Hairline gridlines with compact tick labels down the left. Returns the axis top. */
function drawValueGrid(doc: ChartDoc, plot: Plot, ticks: number[]): number {
  const top = ticks[ticks.length - 1];
  stroke(doc, PDF_PALETTE.grid, 0.5);
  ink(doc, PDF_PALETTE.muted, 7);
  for (const t of ticks) {
    const y = plot.bottom - (t / top) * plot.h;
    doc.line(plot.x, y, plot.x + plot.w, y);
    doc.text(formatCompact(t), plot.x - 4, y + 2.5, { align: 'right' });
  }
  return top;
}

function noData(doc: ChartDoc, frame: ChartFrame): number {
  ink(doc, PDF_PALETTE.muted, 9);
  doc.text('No chartable data', frame.x + frame.width / 2, frame.y + frame.height / 2, { align: 'center' });
  return frame.height;
}

function drawBars(doc: ChartDoc, points: Point[], frame: ChartFrame): void {
  const plot = plotArea(frame, { left: 44, right: 6, top: 8, bottom: 22 });
  const top = drawValueGrid(doc, plot, niceTicks(Math.max(...points.map((p) => p.value))));
  const band = plot.w / points.length;
  const barW = Math.min(MAX_BAR, band * 0.65);
  // Every bar keeps its label: a bar nobody can name is a shape, not a fact. When
  // the bands are too narrow for one row, labels alternate between two rows so
  // each gets two bands of room. A report chart has at most twelve points
  // (CHART_POINTS_MAX), which the two rows hold at 7pt.
  ink(doc, PDF_PALETTE.muted, 7);
  const stagger = points.some((p) => doc.getTextWidth(p.label) > band - 2);
  const labelRoom = (stagger ? 2 * band : band) - 2;

  points.forEach((p, i) => {
    const h = (Math.max(p.value, 0) / top) * plot.h;
    const x = plot.x + i * band + (band - barW) / 2;
    const y = plot.bottom - h;
    const r = Math.min(BAR_END_RADIUS, barW / 2, h / 2);
    fill(doc, PDF_PALETTE.accent);
    // Rounded at the data end, square at the baseline: a body up from the baseline
    // and a rounded cap over the top of it.
    if (h > r) doc.rect(x, y + r, barW, h - r, 'F');
    if (h > 0) doc.roundedRect(x, y, barW, Math.min(h, 2 * r), r, r, 'F');
    // Value on the cap only when the row is short enough for it to read as a
    // label rather than clutter; the axis carries the rest.
    if (points.length <= 6) {
      ink(doc, PDF_PALETTE.ink, 7);
      doc.text(formatCompact(p.value), x + barW / 2, y - 3, { align: 'center' });
    }
    ink(doc, PDF_PALETTE.muted, 7);
    const row = stagger ? i % 2 : 0;
    doc.text(fitLabel(doc, p.label, labelRoom), x + barW / 2, plot.bottom + 10 + row * 9, { align: 'center' });
  });
}

function drawHorizontalBars(doc: ChartDoc, points: Point[], frame: ChartFrame): void {
  // The gutter holds a customer's name in full at 8pt more often than not; what
  // still overruns is fitted with an ellipsis against the measured width.
  const gutter = 112;
  const plot = plotArea(frame, { left: gutter, right: 40, top: 6, bottom: 18 });
  const ticks = niceTicks(Math.max(...points.map((p) => p.value)));
  const axisTop = ticks[ticks.length - 1];
  stroke(doc, PDF_PALETTE.grid, 0.5);
  ink(doc, PDF_PALETTE.muted, 7);
  for (const t of ticks) {
    const x = plot.x + (t / axisTop) * plot.w;
    doc.line(x, plot.y, x, plot.bottom);
    doc.text(formatCompact(t), x, plot.bottom + 10, { align: 'center' });
  }

  const rowH = plot.h / points.length;
  const barH = Math.min(MAX_BAR, rowH * 0.65);
  points.forEach((p, i) => {
    const w = (Math.max(p.value, 0) / axisTop) * plot.w;
    const y = plot.y + i * rowH + (rowH - barH) / 2;
    const r = Math.min(BAR_END_RADIUS, barH / 2, w / 2);
    ink(doc, PDF_PALETTE.ink, 8);
    doc.text(fitLabel(doc, p.label, gutter - 8), plot.x - 6, y + barH / 2 + 3, { align: 'right' });
    fill(doc, PDF_PALETTE.accent);
    if (w > r) doc.rect(plot.x, y, w - r, barH, 'F');
    if (w > 0) doc.roundedRect(plot.x + Math.max(w - 2 * r, 0), y, Math.min(w, 2 * r), barH, r, r, 'F');
    // Value at the tip: the one label a horizontal bar earns.
    ink(doc, PDF_PALETTE.ink, 7);
    doc.text(formatCompact(p.value), plot.x + w + 4, y + barH / 2 + 2.5);
  });
}

function drawArea(doc: ChartDoc, points: Point[], frame: ChartFrame, withAxes: boolean): void {
  const plot = withAxes
    ? plotArea(frame, { left: 44, right: 10, top: 8, bottom: 22 })
    : plotArea(frame, { left: 4, right: 4, top: 4, bottom: 4 });
  const max = Math.max(...points.map((p) => p.value));
  const ticks = niceTicks(max);
  const top = withAxes ? drawValueGrid(doc, plot, ticks) : Math.max(max, 1);
  const stepX = points.length > 1 ? plot.w / (points.length - 1) : 0;
  const xy = points.map((p, i) => ({
    x: plot.x + i * stepX,
    y: plot.bottom - (Math.max(p.value, 0) / top) * plot.h,
  }));

  // Relative segments: jsPDF `lines` takes each point as a delta from the previous.
  const deltas = xy.slice(1).map((p, i) => [p.x - xy[i].x, p.y - xy[i].y]);
  if (withAxes) {
    const last = xy[xy.length - 1];
    fill(doc, PDF_PALETTE.accentWash);
    doc.lines([...deltas, [0, plot.bottom - last.y], [xy[0].x - last.x, 0]], xy[0].x, xy[0].y, [1, 1], 'F', true);
  }
  stroke(doc, PDF_PALETTE.accent, withAxes ? 1.5 : 1);
  doc.lines(deltas, xy[0].x, xy[0].y, [1, 1], 'S', false);

  if (withAxes) {
    xy.forEach((p) => {
      // A surface ring under each marker keeps it legible where it crosses the line.
      fill(doc, PDF_PALETTE.surface);
      doc.circle(p.x, p.y, 3.5, 'F');
      fill(doc, PDF_PALETTE.accent);
      doc.circle(p.x, p.y, 2.5, 'F');
    });
    // The endpoint is the value the story is about; the axis carries the rest.
    const last = xy[xy.length - 1];
    ink(doc, PDF_PALETTE.ink, 7);
    doc.text(formatCompact(points[points.length - 1].value), last.x, last.y - 6, { align: 'center' });
    const labelEvery = Math.ceil(points.length / 6);
    ink(doc, PDF_PALETTE.muted, 7);
    points.forEach((p, i) => {
      if (i % labelEvery === 0 || i === points.length - 1) {
        doc.text(fitLabel(doc, p.label, Math.max(stepX, 40)), xy[i].x, plot.bottom + 10, { align: 'center' });
      }
    });
  }
}

/** Cubic segments approximating an arc, each spanning at most a quarter turn. */
function arcSegments(cx: number, cy: number, r: number, a0: number, a1: number): number[][] {
  const segments: number[][] = [];
  const pieces = Math.max(1, Math.ceil((a1 - a0) / (Math.PI / 2)));
  const span = (a1 - a0) / pieces;
  let prev = { x: cx + r * Math.cos(a0), y: cy + r * Math.sin(a0) };
  for (let i = 0; i < pieces; i += 1) {
    const s = a0 + i * span;
    const e = s + span;
    const k = (4 / 3) * Math.tan(span / 4) * r;
    const p0 = { x: cx + r * Math.cos(s), y: cy + r * Math.sin(s) };
    const p1 = { x: cx + r * Math.cos(e), y: cy + r * Math.sin(e) };
    const c0 = { x: p0.x - k * Math.sin(s), y: p0.y + k * Math.cos(s) };
    const c1 = { x: p1.x + k * Math.sin(e), y: p1.y - k * Math.cos(e) };
    segments.push([c0.x - prev.x, c0.y - prev.y, c1.x - prev.x, c1.y - prev.y, p1.x - prev.x, p1.y - prev.y]);
    prev = p1;
  }
  return segments;
}

function drawPie(doc: ChartDoc, raw: Point[], frame: ChartFrame): void {
  // Part-to-whole reads at a glance only up to six segments; the tail folds into
  // "Other" rather than minting a seventh hue.
  let points = raw.filter((p) => p.value > 0);
  if (points.length > MAX_PIE_SLICES) {
    const kept = points.slice(0, MAX_PIE_SLICES - 1);
    const other = points.slice(MAX_PIE_SLICES - 1).reduce((sum, p) => sum + p.value, 0);
    points = [...kept, { label: 'Other', value: other }];
  }
  const total = points.reduce((sum, p) => sum + p.value, 0);
  const plot = plotArea(frame, { left: 6, right: 6, top: 6, bottom: 6 });
  const r = Math.min(plot.h, plot.w * 0.45) / 2 - 2;
  const cx = plot.x + r + 8;
  const cy = plot.y + plot.h / 2;

  let angle = -Math.PI / 2;
  const boundaries: { x: number; y: number }[] = [];
  points.forEach((p, i) => {
    const sweep = (p.value / total) * Math.PI * 2;
    const p0 = { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
    boundaries.push(p0);
    fill(doc, PDF_PALETTE.series[i % PDF_PALETTE.series.length]);
    doc.lines(
      [[p0.x - cx, p0.y - cy], ...arcSegments(cx, cy, r, angle, angle + sweep)],
      cx, cy, [1, 1], 'F', true,
    );
    angle += sweep;
  });
  // The surface gap between touching marks, drawn as surface-coloured separators.
  stroke(doc, PDF_PALETTE.surface, 1.5);
  boundaries.forEach((b) => doc.line(cx, cy, b.x, b.y));
  // The same donut the dashboard draws, so the two read as one chart.
  fill(doc, PDF_PALETTE.surface);
  doc.circle(cx, cy, r * 0.5, 'F');

  // A legend is always present for more than one series: identity never rides
  // on colour alone, and three of these hues sit under 3:1 on white.
  const legendX = cx + r + 18;
  const rowH = Math.min(14, plot.h / Math.max(points.length, 1));
  let ly = cy - (rowH * points.length) / 2 + rowH / 2;
  points.forEach((p, i) => {
    fill(doc, PDF_PALETTE.series[i % PDF_PALETTE.series.length]);
    doc.rect(legendX, ly - 4, 8, 8, 'F');
    ink(doc, PDF_PALETTE.ink, 8);
    const pct = `${Math.round((p.value / total) * 100)}%`;
    const room = plot.x + plot.w - legendX - 14 - doc.getTextWidth(` ${pct}`);
    doc.text(`${fitLabel(doc, p.label, Math.max(room, 20))} ${pct}`, legendX + 12, ly + 3);
    ly += rowH;
  });
}

/**
 * Draw one chart_config into `frame` and return the height consumed.
 *
 * Nominal bars are value-sorted like the dashboard; time-axis bars, area and pie
 * keep their order. A config with no rows or missing keys draws an explicit "No chartable data" --
 * never blank axes -- mirroring InsightChart's guard.
 */
export function drawChartConfig(doc: ChartDoc, config: ChartConfig, frame: ChartFrame): number {
  const { chart_type, data, x_key, y_key } = config;
  if (!data?.length || !data.every((d) => x_key in d && y_key in d)) return noData(doc, frame);

  switch (chart_type) {
    case 'bar':
      drawBars(doc, pointsOf(config, true), frame);
      break;
    case 'bar_horizontal':
      drawHorizontalBars(doc, pointsOf(config, true), frame);
      break;
    case 'area':
      drawArea(doc, pointsOf(config, false), frame, true);
      break;
    case 'sparkline':
      drawArea(doc, pointsOf(config, false), frame, false);
      break;
    case 'pie':
      drawPie(doc, pointsOf(config, false), frame);
      break;
    default:
      return noData(doc, frame);
  }
  return frame.height;
}
