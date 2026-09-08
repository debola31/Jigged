/**
 * The vector chart renderer, asserted through the primitives it calls. A mocked
 * jsPDF can prove ordering, counts and argument values; it cannot prove that a
 * page LOOKS right, which is what the real-render checklist in the PR is for.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ChartConfig } from '@/utils/insightsAccess';
import { PDF_PALETTE, chartFrameHeight, drawChartConfig, niceTicks, type ChartDoc } from '@/utils/pdfCharts';

function fakeDoc(charWidth = 4) {
  const calls: Record<string, unknown[][]> = {};
  const record = (name: string) =>
    vi.fn((...args: unknown[]) => {
      (calls[name] ??= []).push(args);
    });
  const doc = {
    setFont: record('setFont'),
    setFontSize: record('setFontSize'),
    setTextColor: record('setTextColor'),
    setDrawColor: record('setDrawColor'),
    setFillColor: record('setFillColor'),
    setLineWidth: record('setLineWidth'),
    text: record('text'),
    line: record('line'),
    rect: record('rect'),
    roundedRect: record('roundedRect'),
    circle: record('circle'),
    lines: record('lines'),
    getTextWidth: vi.fn((t: string) => t.length * charWidth),
  };
  return { doc: doc as unknown as ChartDoc, calls };
}

const FRAME = { x: 40, y: 100, width: 532, height: 170 };

function cfg(chart_type: ChartConfig['chart_type'], rows: [string, number][]): ChartConfig {
  return {
    chart_type,
    data: rows.map(([c, v]) => ({ c, v })),
    x_key: 'c',
    y_key: 'v',
    x_label: 'x',
    y_label: 'y',
  };
}

const texts = (calls: Record<string, unknown[][]>) => (calls.text ?? []).map((a) => String(a[0]));

describe('niceTicks', () => {
  it('rounds to clean thousands', () => {
    expect(niceTicks(7749)).toEqual([0, 2000, 4000, 6000, 8000]);
  });
  it('handles a zero or missing maximum without dividing by it', () => {
    expect(niceTicks(0)).toEqual([0, 1]);
  });
});

describe('drawChartConfig', () => {
  it('bars: one body and one rounded cap per row, tallest first, over a hairline grid', () => {
    const { doc, calls } = fakeDoc();
    const height = drawChartConfig(doc, cfg('bar', [['A', 100], ['B', 300], ['C', 200]]), FRAME);

    expect(height).toBe(chartFrameHeight('bar'));
    expect(calls.rect).toHaveLength(3);
    expect(calls.roundedRect).toHaveLength(3);
    // Value-sorted like the dashboard: the first bar drawn is the tallest (300).
    const heights = calls.rect.map((a) => a[3] as number);
    expect(heights[0]).toBeGreaterThan(heights[1]);
    expect(heights[1]).toBeGreaterThan(heights[2]);
    // Gridlines carry compact ticks; the grid is the recessive colour.
    expect(texts(calls)).toEqual(expect.arrayContaining(['0', '100', '300']));
    expect(calls.setDrawColor[0]).toEqual([...PDF_PALETTE.grid]);
    // Marks wear the accent; text never does.
    expect(calls.setFillColor).toEqual(expect.arrayContaining([[...PDF_PALETTE.accent]]));
  });

  it('horizontal bars: labels fitted to the gutter and a value at every tip', () => {
    // A wide fake glyph, so the longest name overruns the gutter and is fitted
    // with an ellipsis against the measured width; the short ones print whole.
    const { doc, calls } = fakeDoc(10);
    drawChartConfig(doc, cfg('bar_horizontal', [['Hastings Machine Company Ltd', 29084], ['Helix', 7991], ['Deister', 8154]]), FRAME);

    const drawn = texts(calls);
    expect(drawn.some((t) => t.endsWith('…') && t.startsWith('Hast') && t.length < 12)).toBe(true);
    expect(drawn).toEqual(expect.arrayContaining(['Helix', 'Deister', '29.1K', '8.2K', '8K']));
    expect(calls.rect).toHaveLength(3);
  });

  it('horizontal bars: a name the gutter holds prints whole, never cut at twelve characters', () => {
    // The first real render showed "Hastings Mac..." beside 60pt of empty gutter:
    // the screen formatter's cut, applied before the width was ever measured.
    const { doc, calls } = fakeDoc();
    drawChartConfig(doc, cfg('bar_horizontal', [['Hastings Machine Company', 29084], ['Helix', 7991], ['Deister', 8154]]), FRAME);
    expect(texts(calls)).toContain('Hastings Machine Company');
  });

  it('bars with a time axis keep calendar order, not value order', () => {
    // "Show me a bar chart of monthly bookings" reaches the renderer as bars over
    // dates. Ranking those prints Mar, Feb, Jan, Dec: a scrambled calendar.
    const { doc, calls } = fakeDoc();
    drawChartConfig(doc, cfg('bar', [['2026-01-01', 300], ['2026-02-01', 100], ['2026-03-01', 200]]), FRAME);

    const heights = calls.rect.map((a) => a[3] as number);
    expect(heights[0]).toBeGreaterThan(heights[1]);
    expect(heights[2]).toBeGreaterThan(heights[1]);
    expect(texts(calls).filter((t) => t.endsWith('2026'))).toEqual(['Jan 2026', 'Feb 2026', 'Mar 2026']);
  });

  it('bars over month names are put in calendar order whatever order they arrived in', () => {
    // The first live report labelled its months by name and listed them by value.
    const { doc, calls } = fakeDoc();
    drawChartConfig(doc, cfg('bar', [['August', 19606], ['September', 16282], ['July', 14617]]), FRAME);

    expect(texts(calls).filter((t) => /^(July|August|September)$/.test(t))).toEqual(['July', 'August', 'September']);
    const heights = calls.rect.map((a) => a[3] as number);
    expect(heights[1]).toBeGreaterThan(heights[0]);
    expect(heights[1]).toBeGreaterThan(heights[2]);
  });

  it('bars: every one of twelve long labels is drawn, staggered over two rows', () => {
    // Twelve bands of 40pt cannot each hold a name in one row, and dropping every
    // other label leaves half the bars anonymous. Two rows, each label fitted to
    // two bands.
    const { doc, calls } = fakeDoc();
    const rows: [string, number][] = Array.from({ length: 12 }, (_, i) => [`Customer Number ${i + 1} Incorporated`, 12 - i]);
    drawChartConfig(doc, cfg('bar', rows), FRAME);

    const labels = (calls.text ?? []).filter((a) => String(a[0]).startsWith('Customer'));
    expect(labels).toHaveLength(12);
    expect(new Set(labels.map((a) => a[2] as number)).size).toBe(2);
    expect(labels.every((a) => String(a[0]).endsWith('…'))).toBe(true);
  });

  it('bars: a handful of short labels sit on one row', () => {
    const { doc, calls } = fakeDoc();
    drawChartConfig(doc, cfg('bar', [['A', 1], ['B', 2], ['C', 3]]), FRAME);
    const labels = (calls.text ?? []).filter((a) => /^[ABC]$/.test(String(a[0])));
    expect(new Set(labels.map((a) => a[2] as number)).size).toBe(1);
  });

  it('pie: legend names print whole while the legend has room', () => {
    const { doc, calls } = fakeDoc();
    drawChartConfig(doc, cfg('pie', [['Hastings Machine Company', 50], ['Advance Turning', 30], ['Helix', 20]]), FRAME);
    expect(texts(calls)).toContain('Hastings Machine Company 50%');
  });

  it('area: a wash fill then a stroked line, a ringed marker per point, the endpoint labelled', () => {
    const { doc, calls } = fakeDoc();
    drawChartConfig(doc, cfg('area', [['2026-06-01', 10], ['2026-07-01', 30], ['2026-08-01', 20]]), FRAME);

    expect(calls.lines).toHaveLength(2);
    expect(calls.lines[0][4]).toBe('F');
    expect(calls.lines[0][5]).toBe(true);
    expect(calls.lines[1][4]).toBe('S');
    expect(calls.circle).toHaveLength(6); // a surface ring under each of 3 markers
    expect(texts(calls)).toContain('20');
    expect(texts(calls)).toEqual(expect.arrayContaining(['Jun 2026', 'Aug 2026']));
  });

  it('pie: one bezier path per slice, surface separators, a donut hole and a legend with shares', () => {
    const { doc, calls } = fakeDoc();
    drawChartConfig(doc, cfg('pie', [['A', 50], ['B', 30], ['C', 20]]), FRAME);

    expect(calls.lines).toHaveLength(3);
    for (const call of calls.lines) {
      const segments = call[0] as number[][];
      expect(segments[0]).toHaveLength(2); // centre to rim
      expect(segments.slice(1).every((s) => s.length === 6)).toBe(true); // cubic arcs
      expect(call[5]).toBe(true); // closed back to the centre
    }
    expect(calls.line).toHaveLength(3); // separators
    expect(calls.circle).toHaveLength(1); // the hole
    expect(texts(calls)).toEqual(expect.arrayContaining(['A 50%', 'B 30%', 'C 20%']));
  });

  it('pie: past six slices the tail folds into Other, never a seventh hue', () => {
    const { doc, calls } = fakeDoc();
    const rows: [string, number][] = Array.from({ length: 9 }, (_, i) => [`S${i}`, 9 - i]);
    drawChartConfig(doc, cfg('pie', rows), FRAME);

    expect(calls.lines).toHaveLength(6);
    expect(texts(calls).some((t) => t.startsWith('Other '))).toBe(true);
    const fills = calls.setFillColor.map((a) => JSON.stringify(a));
    for (const rgb of PDF_PALETTE.series) expect(fills).toContain(JSON.stringify([...rgb]));
  });

  it('sparkline: a single stroke, no axes, at its own height', () => {
    const { doc, calls } = fakeDoc();
    const frame = { ...FRAME, height: chartFrameHeight('sparkline') };
    const height = drawChartConfig(doc, cfg('sparkline', [['a', 1], ['b', 3], ['c', 2]]), frame);

    expect(height).toBe(60);
    expect(calls.lines).toHaveLength(1);
    expect(calls.rect).toBeUndefined();
    expect(calls.text).toBeUndefined();
  });

  it('draws an explicit empty state rather than blank axes', () => {
    const { doc, calls } = fakeDoc();
    drawChartConfig(doc, cfg('bar', []), FRAME);
    expect(texts(calls)).toEqual(['No chartable data']);

    const { doc: doc2, calls: calls2 } = fakeDoc();
    drawChartConfig(doc2, { ...cfg('bar', [['A', 1]]), y_key: 'missing' }, FRAME);
    expect(texts(calls2)).toEqual(['No chartable data']);
  });
});
