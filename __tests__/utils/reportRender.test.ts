/**
 * The real-render half of the report's checklist, reproducible.
 *
 * Skipped unless RENDER_REPORT_PDFS names a directory. Then it draws the report
 * with the REAL jsPDF (nothing mocked) for every case the module doc lists and
 * writes one PDF per case there, so a reviewer can rasterise and look -- the one
 * thing the mocked suite in reportPdf.test.ts cannot do:
 *
 *   RENDER_REPORT_PDFS=/tmp/report-renders pnpm test --run __tests__/utils/reportRender.test.ts
 *
 * Cases: the reference layout with no logo, with a logo, and with a logo that
 * carries the name; every chart type with long labels; a spec too tall for the
 * page (the "Not shown" footer); a shop with no shipments (null cells).
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateReportPdf } from '@/utils/reportPdf';
import { reportSpecOf, type ReportBlock, type ReportSpec } from '@/utils/reportSpec';
import type { Company } from '@/utils/companyAccess';
import type { SupabaseLike } from '@/utils/packingSlipPdf';

const OUT = process.env.RENDER_REPORT_PDFS;
const REPO = join(__dirname, '..', '..');
const GENERATED = new Date(2026, 8, 7, 15, 42);

const fixture = reportSpecOf(
  JSON.parse(readFileSync(join(REPO, '__tests__', 'fixtures', 'reportSpecExample.json'), 'utf8')),
) as ReportSpec;

const contour: Company = {
  id: 'co-1',
  name: 'Contour Tool & Machine',
  address_line1: '4120 Industrial Parkway',
  city: 'Fort Wayne',
  state: 'IN',
  postal_code: '46803',
  phone: '(260) 555-0147',
};

/** The Jigged logo, served the way the logos bucket would: a signed URL the loader fetches. */
function logoClient(): SupabaseLike {
  const png = readFileSync(join(REPO, 'public', 'jigged-logo.png'));
  globalThis.fetch = (async () => ({
    ok: true,
    blob: async () => new Blob([png], { type: 'image/png' }),
  })) as unknown as typeof fetch;
  return {
    storage: {
      from: () => ({
        createSignedUrl: async () => ({ data: { signedUrl: 'https://signed.example/logo.png' }, error: null }),
      }),
    },
  };
}

const chart = (title: string, chart_type: 'bar' | 'bar_horizontal' | 'area' | 'pie' | 'sparkline', rows: [string, number][]): ReportBlock => ({
  type: 'chart',
  title,
  note: null,
  chart_config: {
    chart_type,
    data: rows.map(([label, value]) => ({ label, value })),
    x_key: 'label',
    y_key: 'value',
    x_label: 'x',
    y_label: 'y',
  },
});

const LONG_NAMES = [
  'Hastings Machine Company Incorporated', 'Advance Turning & Manufacturing LLC', 'Northern Precision Products Group',
  'Deister Machine Company of Indiana', 'Helix Steel Fabrication Partners', 'Meridian Aerospace Components Ltd',
  'Vanguard Precision Works Holdings', 'Summit Tool & Die Engineering Inc', 'Great Lakes Hydraulic Systems Co',
  'Riverbend Industrial Castings LLC', 'Ironclad Fastener Distribution Inc', 'Keystone Gear & Spline Works',
];
const MONTHS = ['2025-10-01', '2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01'];

const cases: { file: string; spec: ReportSpec; company: Company; supabase: SupabaseLike | null }[] = [
  { file: '01-reference-no-logo.pdf', spec: fixture, company: contour, supabase: null },
  { file: '02-reference-logo.pdf', spec: fixture, company: { ...contour, logo_url: 'co-1/company/logo.png' }, supabase: logoClient() },
  {
    file: '03-reference-logo-includes-name.pdf',
    spec: fixture,
    company: { ...contour, logo_url: 'co-1/company/logo.png', settings: { logo_includes_name: true } },
    supabase: logoClient(),
  },
  {
    file: '04-charts-bar-area-table.pdf',
    spec: {
      ...fixture,
      title: 'Booked work by customer',
      period_label: 'Oct 2025 – Sep 2026',
      headline: 'Twelve customers booked work this year; Hastings leads with almost a third of the total.',
      kpis: fixture.kpis.slice(0, 3),
      blocks: [
        chart('Booked value by customer', 'bar', LONG_NAMES.map((n, i) => [n, 31000 - i * 2300])),
        chart('Booked value by month', 'area', MONTHS.map((m, i) => [m, 8000 + ((i * 3719) % 9000)])),
        { ...(fixture.blocks[2] as ReportBlock) },
      ],
    },
    company: contour,
    supabase: null,
  },
  {
    file: '05-charts-pie-hbar-sparkline-text.pdf',
    spec: {
      ...fixture,
      title: 'Where the work came from',
      kpis: [],
      blocks: [
        chart('Share of booked value', 'pie', LONG_NAMES.slice(0, 8).map((n, i) => [n, 9000 - i * 900])),
        chart('Top customers by booked value', 'bar_horizontal', LONG_NAMES.slice(0, 8).map((n, i) => [n, 29084 - i * 2600])),
        chart('Weekly quotes', 'sparkline', MONTHS.map((m, i) => [m, 3 + ((i * 5) % 7)])),
        { type: 'text', body: 'Booked value held steady through the summer; two customers account for over 40% of it.' },
      ],
    },
    company: contour,
    supabase: null,
  },
  {
    file: '06-too-tall-not-shown.pdf',
    spec: {
      ...fixture,
      title: 'Operations summary',
      blocks: [1, 2, 3, 4].map((i) => chart(`Chart ${i}`, 'bar', MONTHS.slice(0, 6).map((m, j) => [m, 1000 * (j + i)]))),
    },
    company: contour,
    supabase: null,
  },
  {
    file: '07-no-shipments-null-cells.pdf',
    spec: {
      ...fixture,
      title: 'Operations summary',
      headline: 'Nothing has shipped yet this period; two quotes are open.',
      kpis: [
        { label: 'Quotes issued', value: 2, format: 'integer', caption: null },
        { label: 'Booked', value: 0, format: 'currency', caption: '0 jobs' },
        { label: 'Shipped', value: 0, format: 'currency', caption: '0 shipments' },
      ],
      blocks: [
        {
          type: 'table',
          title: 'Monthly breakdown',
          columns: [
            { label: 'Month', format: 'plain' },
            { label: 'Quotes', format: 'integer' },
            { label: 'Booked', format: 'currency' },
            { label: 'Shipped', format: 'currency' },
          ],
          rows: [['Aug', 2, null, null], ['Sep (thru 7th)', null, null, null]],
          total_row: ['Total', 2, null, null],
          note: 'No shipment has been recorded in this period.',
        },
      ],
    },
    company: { id: 'co-2', name: 'Riverbend Industrial Castings' },
    supabase: null,
  },
];

describe.skipIf(!OUT)('render the report checklist to PDF files', () => {
  it.each(cases)('$file', async ({ file, spec, company, supabase }) => {
    mkdirSync(OUT!, { recursive: true });
    const doc = await generateReportPdf(spec, company, GENERATED, supabase);
    const bytes = Buffer.from(doc.output('arraybuffer'));
    writeFileSync(join(OUT!, file), bytes);
    expect(bytes.length).toBeGreaterThan(1000);
    expect(doc.getNumberOfPages()).toBe(1);
  });
});
