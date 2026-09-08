/**
 * What a mocked jsPDF can prove about the one-page report: ordering, argument
 * values, font state, and that addPage is never called. Wrap width and overflow
 * are what the real-render checklist in the PR is for.
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
  const docInstance = {
    calls,
    internal: { pageSize: { getWidth: () => 612, getHeight: () => 792 } },
    setFont: record('setFont', calls),
    setFontSize: record('setFontSize', calls),
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
    getTextWidth: vi.fn((t: string) => t.length * 4),
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

import { generateReportPdf, reportPdfFilename } from '@/utils/reportPdf';
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

  it('never adds a page, and signs the one it has', async () => {
    await generateReportPdf(spec, company, GENERATED);
    expect(docInstance.calls.addPage).toBeUndefined();
    expect(texts()).toContain('Page 1 of 1');
    expect(texts()).toContain(ATTRIBUTION_MARK);
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

  it('prints without a logo when no client is given, so the company name carries the header', async () => {
    await generateReportPdf(spec, { ...company, logo_url: 'co-1/company/logo.png' }, GENERATED);
    expect(docInstance.calls.addImage).toBeUndefined();
    expect(texts()).toContain('Contour Tool & Machine');
  });
});

describe('reportPdfFilename', () => {
  it('slugs the title and stamps the local date', () => {
    expect(reportPdfFilename(spec, GENERATED)).toBe('OPERATIONS-SUMMARY-2026-09-07.pdf');
  });
});
