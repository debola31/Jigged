/**
 * What a mocked jsPDF can prove about the one-page report: ordering, argument
 * values, font state, and that addPage is never called. How a page looks is what
 * the gated real render (reportRender.test.ts) is for.
 *
 * The fake measures text at 0.55 × font size per character, so the rule that
 * nothing the model wrote is drawn unmeasured -- a title that steps its font
 * down, a caption that wraps, a note that is cut with an ellipsis -- can be
 * asserted here with real proportions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { jsPDFCtor, autoTableFn, docInstance } = vi.hoisted(() => {
  const record = (name: string, calls: Record<string, unknown[][]>) =>
    vi.fn((...args: unknown[]) => {
      (calls[name] ??= []).push(args);
    });
  const calls: Record<string, unknown[][]> = {};
  let fontSize = 10;
  const docInstance = {
    calls,
    internal: { pageSize: { getWidth: () => 612, getHeight: () => 792 } },
    setFont: record('setFont', calls),
    setFontSize: vi.fn((n: number) => {
      fontSize = n;
      (calls.setFontSize ??= []).push([n]);
    }),
    setTextColor: record('setTextColor', calls),
    setDrawColor: record('setDrawColor', calls),
    setLineWidth: record('setLineWidth', calls),
    setFillColor: record('setFillColor', calls),
    text: record('text', calls),
    line: record('line', calls),
    rect: record('rect', calls),
    roundedRect: record('roundedRect', calls),
    circle: record('circle', calls),
    lines: record('lines', calls),
    splitTextToSize: vi.fn((t: string) => [t]),
    getTextWidth: vi.fn((t: string) => t.length * fontSize * 0.55),
    addImage: record('addImage', calls),
    getImageProperties: vi.fn().mockReturnValue({ width: 200, height: 50, fileType: 'PNG' }),
    addPage: record('addPage', calls),
    setPage: vi.fn(),
    getNumberOfPages: vi.fn().mockReturnValue(1),
    save: vi.fn(),
    output: vi.fn().mockReturnValue('blob:report'),
    lastAutoTable: { finalY: 0 },
  };
  const jsPDFCtor = vi.fn().mockImplementation(function () {
    return docInstance;
  });
  // A table occupies about 60pt and advances the cursor, as the real one would.
  const autoTableFn = vi.fn((_doc: unknown, opts: { startY: number }) => {
    docInstance.lastAutoTable = { finalY: opts.startY + 60 };
  });
  return { jsPDFCtor, autoTableFn, docInstance };
});

vi.mock('jspdf', () => ({ jsPDF: jsPDFCtor }));
vi.mock('jspdf-autotable', () => ({ default: autoTableFn }));

import { generateReportPdf, periodLine, reportPdfFilename } from '@/utils/reportPdf';
import { reportSpecOf, type ReportSpec } from '@/utils/reportSpec';
import type { Company } from '@/utils/companyAccess';
import { ATTRIBUTION_MARK } from '@/utils/packingSlipPdf';

const spec = reportSpecOf(
  JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'reportSpecExample.json'), 'utf8')),
) as ReportSpec;
const company: Company = { id: 'co-1', name: 'Contour Tool & Machine', city: 'Detroit', state: 'MI' };
const GENERATED = new Date(2026, 8, 7, 15, 42);

const texts = () => (docInstance.calls.text ?? []).map((a) => String(a[0]));

describe('generateReportPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(docInstance.calls)) delete docInstance.calls[key];
    docInstance.lastAutoTable = { finalY: 0 };
  });

  it('draws the title top-right before the shop block, with period and generation meta', async () => {
    const doc = await generateReportPdf(spec, company, GENERATED);

    expect(doc).toBe(docInstance);
    const drawn = texts();
    const title = drawn.indexOf('OPERATIONS SUMMARY');
    const shop = drawn.indexOf('Contour Tool & Machine');
    expect(title).toBeGreaterThanOrEqual(0);
    expect(shop).toBeGreaterThan(title);
    const titleCall = docInstance.calls.text.find((a) => a[0] === 'OPERATIONS SUMMARY')!;
    expect(titleCall[3]).toEqual({ align: 'right' });
    expect(drawn).toContain('Period: Jun 1 – Sep 3, 2026');
    expect(drawn.some((t) => t.startsWith('Generated: Sep 7, 2026'))).toBe(true);
  });

  it('prints the KPI band: compact figures over uppercase captions', async () => {
    await generateReportPdf(spec, company, GENERATED);
    const drawn = texts();
    expect(drawn).toEqual(expect.arrayContaining(['115', '$99.3k', '$59k', '$56.4k']));
    expect(drawn).toEqual(expect.arrayContaining(['QUOTES ISSUED', 'BOOKED · 84 JOBS', 'SHIPPED · 69 SHIPMENTS']));
    const band = docInstance.calls.rect.find((a) => a[4] === 'FD')!;
    expect(band[3]).toBe(52);
  });

  it('wraps a caption the tile cannot hold onto a second line, and fits it, rather than running through the next tile', async () => {
    // The first live report captioned a tile "Total jobs in progress or active".
    const long: ReportSpec = {
      ...spec,
      kpis: [{ ...spec.kpis[0], caption: 'Total jobs in progress or active' }, ...spec.kpis.slice(1)],
    };
    await generateReportPdf(long, company, GENERATED);

    const drawn = texts();
    expect(drawn).toContain('QUOTES ISSUED');
    const caption = drawn.find((t) => t.startsWith('TOTAL JOBS'))!;
    expect(caption.endsWith('…')).toBe(true);
    expect(caption.length).toBeLessThan('TOTAL JOBS IN PROGRESS OR ACTIVE'.length);
    const band = docInstance.calls.rect.find((a) => a[4] === 'FD')!;
    expect(band[3]).toBe(61);
    // The label and its caption sit on two rows of the same tile.
    const rows = docInstance.calls.text.filter((a) => a[0] === 'QUOTES ISSUED' || a[0] === caption).map((a) => a[2]);
    expect(new Set(rows).size).toBe(2);
  });

  it('steps the title font down before cutting a character, and keeps it out of the shop block', async () => {
    await generateReportPdf({ ...spec, title: 'Booked work by customer this quarter' }, company, GENERATED);
    const drawn = texts();
    expect(drawn).toContain('BOOKED WORK BY CUSTOMER THIS QUARTER');
    const sizes = docInstance.calls.setFontSize.map((a) => a[0] as number);
    expect(sizes).toContain(16);
    expect(sizes).toContain(22);
  });

  it('cuts a note that overruns its block with an ellipsis instead of spilling', async () => {
    const note = 'Pipeline counts active, unexpired, unconverted quotes and every open line item that has not yet been converted.';
    const noted: ReportSpec = {
      ...spec,
      blocks: spec.blocks.map((b) => (b.type === 'table' && b.title === 'Quoting' ? { ...b, note } : b)),
    };
    await generateReportPdf(noted, company, GENERATED);
    const drawn = texts().find((t) => t.startsWith('Pipeline counts'))!;
    expect(drawn.endsWith('…')).toBe(true);
    expect(drawn.length).toBeLessThan(note.length);
  });

  it('caps the headline at two lines and ends the second with an ellipsis when there was a third', async () => {
    docInstance.splitTextToSize.mockImplementation((t: string) =>
      t.startsWith('Booked $99,251')
        ? [`${t} [one]`, 'line two of the headline', 'line three, long enough that folding it onto line two overruns the page width by a wide margin']
        : [t],
    );
    await generateReportPdf(spec, company, GENERATED);
    docInstance.splitTextToSize.mockImplementation((t: string) => [t]);

    const drawn = texts();
    expect(drawn.some((t) => t.startsWith('line two') && t.endsWith('…'))).toBe(true);
    expect(drawn.some((t) => t.startsWith('line three'))).toBe(false);
  });

  it('renders every table through autoTable, pairing two narrow ones side by side', async () => {
    await generateReportPdf(spec, company, GENERATED);

    expect(autoTableFn).toHaveBeenCalledTimes(3);
    const configs = autoTableFn.mock.calls.map((c) => c[1] as { head: string[][]; tableWidth: number; margin: { left: number } });
    expect(configs[0].head).toEqual([['Month', 'Quotes', 'Booked', 'Shipped']]);
    expect(configs[0].tableWidth).toBe(532);
    // Backlog aging (3 columns) and Quoting (2 columns) share a row.
    expect(configs[1].tableWidth).toBe(configs[2].tableWidth);
    expect(configs[1].tableWidth).toBeLessThan(532 / 2);
    expect(configs[2].margin.left).toBeGreaterThan(configs[1].margin.left);
    // Cells never wrap: a wrapped cell grows its row past the packed height.
    expect((autoTableFn.mock.calls[0][1] as { styles: { overflow: string } }).styles.overflow).toBe('ellipsize');
    // Cells are formatted by the column's declared format; the model never did.
    const body = (autoTableFn.mock.calls[0][1] as { body: string[][] }).body;
    expect(body[0]).toEqual(['Jun', '17', '$13,367', '$11,702']);
    expect((autoTableFn.mock.calls[0][1] as { foot: string[][] }).foot).toEqual([['Total', '115', '$99,251', '$59,002']]);
  });

  it('draws the chart block as vectors and its section title in caps', async () => {
    await generateReportPdf(spec, company, GENERATED);
    expect(texts()).toContain('TOP CUSTOMERS BY BOOKED VALUE');
    // A horizontal bar per customer.
    expect(docInstance.calls.rect.length).toBeGreaterThanOrEqual(5);
  });

  it('never adds a page, signs the one it has, and does not number it', async () => {
    await generateReportPdf(spec, company, GENERATED);
    expect(docInstance.calls.addPage).toBeUndefined();
    expect(texts()).toContain(ATTRIBUTION_MARK);
    expect(texts().some((t) => /^Page \d/.test(t))).toBe(false);
  });

  it('drops what does not fit and says so, rather than spilling onto a second page', async () => {
    const chart = spec.blocks.find((b) => b.type === 'chart')!;
    const tall: ReportSpec = { ...spec, blocks: [chart, chart, chart, chart].map((b, i) => ({ ...b, title: `Chart ${i + 1}` })) };

    await generateReportPdf(tall, company, GENERATED);

    expect(docInstance.calls.addPage).toBeUndefined();
    const notShown = texts().find((t) => t.startsWith('Not shown (one page):'));
    expect(notShown).toBeDefined();
    expect(notShown).toContain('Chart 4');
  });

  it('draws a chart shorter rather than dropping it when the page has most of its height left', async () => {
    const chart = spec.blocks.find((b) => b.type === 'chart')!;
    const table = spec.blocks.find((b) => b.type === 'table')!;
    const tight: ReportSpec = {
      ...spec,
      blocks: [chart, table, { type: 'text', body: 'One line.' }, { ...chart, title: 'Chart at the bottom' }],
    };
    await generateReportPdf(tight, company, GENERATED);

    expect(docInstance.calls.addPage).toBeUndefined();
    expect(texts()).toContain('CHART AT THE BOTTOM');
    expect(texts().some((t) => t.startsWith('Not shown'))).toBe(false);
  });

  it('keeps trying later blocks after one is dropped: a closing note still prints', async () => {
    const chart = spec.blocks.find((b) => b.type === 'chart')!;
    const tall: ReportSpec = {
      ...spec,
      blocks: [chart, chart, { ...chart, title: 'Third chart' }, { type: 'text', body: 'The closing note.' }],
    };
    await generateReportPdf(tall, company, GENERATED);

    expect(texts()).toContain('The closing note.');
    const notShown = texts().find((t) => t.startsWith('Not shown (one page):'))!;
    expect(notShown).toContain('Third chart');
    expect(notShown).not.toContain('note');
  });

  it('prints without a logo when no client is given, so the company name carries the header', async () => {
    await generateReportPdf(spec, { ...company, logo_url: 'co-1/company/logo.png' }, GENERATED);
    expect(docInstance.calls.addImage).toBeUndefined();
    expect(texts()).toContain('Contour Tool & Machine');
  });

  it('gives a logo the depth the shallow right column cannot lend it', async () => {
    // A title and two meta lines is 62pt of header; after the name and address
    // that left a 4pt logo on the first real render (2026-09-07). With a logo the
    // header is deepened instead, and the mark is drawn at a size a reader sees.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['x'], { type: 'image/png' }) }));
    const client = {
      storage: {
        from: () => ({
          createSignedUrl: async () => ({ data: { signedUrl: 'https://signed.example/l.png' }, error: null }),
        }),
      },
    };
    await generateReportPdf(spec, { ...company, logo_url: 'co-1/company/logo.png' }, GENERATED, client as never);
    vi.unstubAllGlobals();

    const drawn = docInstance.calls.addImage;
    expect(drawn).toHaveLength(1);
    const [, format, , y, w, h] = drawn[0] as [string, string, number, number, number, number];
    expect(format).toBe('PNG');
    expect(y).toBe(40);
    expect(h).toBeGreaterThanOrEqual(36);
    expect(w / h).toBeCloseTo(4, 5); // 200×50 fitted, never squashed
    // The name still prints under it: this logo does not claim to carry it.
    expect(texts()).toContain('Contour Tool & Machine');
  });
});

describe('periodLine', () => {
  it('prints the dates after a label that does not name them', () => {
    expect(periodLine({ period_start: '2026-07-01', period_end: '2026-09-30', period_label: 'Q3' })).toBe('Q3 · Jul 1 – Sep 30, 2026');
    expect(periodLine({ period_start: '2025-10-01', period_end: '2026-09-30', period_label: 'Last 12 months' })).toBe(
      'Last 12 months · Oct 1, 2025 – Sep 30, 2026',
    );
  });
  it('lets a label that carries a year stand alone, and dates one that does not', () => {
    expect(periodLine({ period_start: '2026-06-01', period_end: '2026-09-03', period_label: 'Jun 1 – Sep 3, 2026' })).toBe('Jun 1 – Sep 3, 2026');
    // The second live report wrote "June to September" and dated it 2023.
    expect(periodLine({ period_start: '2023-06-01', period_end: '2023-09-30', period_label: 'June to September' })).toBe(
      'June to September · Jun 1 – Sep 30, 2023',
    );
  });
});

describe('reportPdfFilename', () => {
  it('slugs the title and stamps the local date', () => {
    expect(reportPdfFilename(spec, GENERATED)).toBe('OPERATIONS-SUMMARY-2026-09-07.pdf');
  });
});
