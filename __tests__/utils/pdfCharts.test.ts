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
    // A wide fake glyph, so a label the shared formatter already shortened still
    // overruns the 88pt gutter and has to be fitted with an ellipsis.
    const { doc, calls } = fakeDoc(10);
    drawChartConfig(doc, cfg('bar_horizontal', [['Hastings Machine Company Ltd', 29084], ['Helix', 7991], ['Deister', 8154]]), FRAME);

    const drawn = texts(calls);
    expect(drawn.some((t) => t.endsWith('…') && t.startsWith('Hast') && t.length < 12)).toBe(true);
    expect(drawn).toEqual(expect.arrayContaining(['29.1K', '8.2K', '8K']));
    expect(calls.rect).toHaveLength(3);
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
