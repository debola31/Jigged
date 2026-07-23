import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted jsPDF / autotable / qrcode mocks (mirrors quotePdf.test.ts).
const { jsPDFCtor, autoTableFn, addImageMock, qrMock } = vi.hoisted(() => {
  const addImageMock = vi.fn();
  const docInstance = {
    internal: { pageSize: { getWidth: () => 612, getHeight: () => 792 } },
    setFont: vi.fn(),
    setFontSize: vi.fn(),
    setTextColor: vi.fn(),
    setDrawColor: vi.fn(),
    setLineWidth: vi.fn(),
    setFillColor: vi.fn(),
    text: vi.fn(),
    line: vi.fn(),
    rect: vi.fn(),
    splitTextToSize: vi.fn().mockReturnValue(['wrapped']),
    save: vi.fn(),
    addPage: vi.fn(),
    setPage: vi.fn(),
    getNumberOfPages: vi.fn().mockReturnValue(1),
    getTextWidth: vi.fn().mockReturnValue(50),
    addImage: addImageMock,
    lastAutoTable: { finalY: 400 },
  };
  const jsPDFCtor = vi.fn().mockImplementation(function () {
    return docInstance;
  });
  const autoTableFn = vi.fn();
  // Deterministic QR per URL so we can assert which op's code lands on which row.
  const qrMock = vi.fn().mockImplementation((url: string) => Promise.resolve(`QR::${url}`));
  return { jsPDFCtor, autoTableFn, addImageMock, qrMock };
});

vi.mock('jspdf', () => ({ jsPDF: jsPDFCtor }));
vi.mock('jspdf-autotable', () => ({ default: autoTableFn }));
vi.mock('qrcode', () => ({ default: { toDataURL: qrMock } }));

// The traveler PDF's import graph reaches shipmentsAccess → lib/supabase, which
// creates a real browser client at module load. Stub it so import doesn't need
// Supabase env vars (this PDF path never calls the client — logo is skipped via
// supabase: null and a company with no logo_url).
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({}),
  getTypedSupabase: () => ({}),
  createClient: () => ({}),
}));

import { generateJobTravelerPdf } from '@/utils/jobTravelerPdf';
import type { JobTraveler, JobTravelerOperation } from '@/types/operator';
import type { Company } from '@/utils/companyAccess';

const company: Company = { id: 'c1', name: 'Acme Precision' };

function op(over: Partial<JobTravelerOperation>): JobTravelerOperation {
  return {
    id: 'op-x',
    sequence: 10,
    operation_name: 'Op',
    instructions: null,
    work_center_id: 'wc-x',
    work_center_name: 'Station',
    work_center_kind: 'internal',
    vendor_name: null,
    status: 'pending',
    setup_minutes: 0,
    cycle_minutes: 0,
    ...over,
  };
}

function traveler(operations: JobTravelerOperation[]): JobTraveler {
  return {
    job_part_id: 'jp-1',
    job_id: 'job-1',
    part_id: 'part-1',
    job_number: 'J-1000',
    customer_name: 'Customer',
    part_name: 'Bracket',
    part_description: null,
    quantity: 10,
    order_date: '2026-07-01T00:00:00Z',
    due_date: '2026-07-20',
    customer_po_number: null,
    production_status: 'in_progress',
    is_hot: false,
    job_part_count: 1,
    operations,
  };
}

async function renderAndGetOpsTable(t: JobTraveler) {
  await generateJobTravelerPdf({
    traveler: t,
    company,
    bom: [],
    companyId: 'c1',
    baseUrl: 'https://app.test',
    supabase: null,
  });
  // The operations table is the autoTable call whose header starts with 'Step'.
  const call = autoTableFn.mock.calls.find(
    (c) => Array.isArray(c[1]?.head?.[0]) && c[1].head[0][0] === 'Step',
  );
  if (!call) throw new Error('operations autoTable not found');
  return call[1] as {
    body: string[][];
    didParseCell: (d: unknown) => void;
    didDrawCell: (d: unknown) => void;
  };
}

const SCAN_COL = 6; // traveler ops table: Step,WC,Detail,Setup,Cycle,Good,Scan
const DETAIL_COL = 2;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateJobTravelerPdf — external (outside) operations', () => {
  it('renders an external row with a vendor banner in the detail cell', async () => {
    const opts = await renderAndGetOpsTable(
      traveler([
        op({ id: 'op-0', sequence: 10, work_center_kind: 'internal', operation_name: 'Mill' }),
        op({ id: 'op-1', sequence: 20, work_center_kind: 'external', vendor_name: 'AcmeCoat', operation_name: 'Anodize' }),
      ]),
    );
    expect(opts.body[1][DETAIL_COL]).toContain('OUTSIDE PROCESS');
    expect(opts.body[1][DETAIL_COL]).toContain('AcmeCoat');
    // Internal row is untouched.
    expect(opts.body[0][DETAIL_COL]).not.toContain('OUTSIDE PROCESS');
  });

  it('restyles the external row dark (white text) but keeps the Scan cell white', async () => {
    const opts = await renderAndGetOpsTable(
      traveler([
        op({ id: 'op-0', work_center_kind: 'internal' }),
        op({ id: 'op-1', work_center_kind: 'external', vendor_name: 'AcmeCoat' }),
      ]),
    );
    const parse = (rowIndex: number, colIndex: number) => {
      const cell = { styles: {} as Record<string, unknown> };
      opts.didParseCell({ section: 'body', row: { index: rowIndex }, column: { index: colIndex }, cell });
      return cell.styles;
    };
    // External non-scan cell → dark fill + white bold text.
    expect(parse(1, DETAIL_COL)).toMatchObject({ fillColor: [30, 30, 30], textColor: [255, 255, 255], fontStyle: 'bold' });
    // External Scan cell → white (so the QR stays scannable).
    expect(parse(1, SCAN_COL)).toMatchObject({ fillColor: [255, 255, 255] });
    // Internal row → no restyle.
    expect(parse(0, DETAIL_COL)).toEqual({});
  });

  it('maps each QR to the correct op id by identity (mixed routing, not by position)', async () => {
    const opts = await renderAndGetOpsTable(
      traveler([
        op({ id: 'op-0', work_center_kind: 'internal' }),
        op({ id: 'op-1', work_center_kind: 'external', vendor_name: 'AcmeCoat' }),
      ]),
    );
    const drawScan = (rowIndex: number) =>
      opts.didDrawCell({
        section: 'body',
        row: { index: rowIndex },
        column: { index: SCAN_COL },
        cell: { x: 0, y: 0, width: 80, height: 80 },
      });
    drawScan(0);
    drawScan(1);
    const drawnUrls = addImageMock.mock.calls.map((c) => c[0] as string);
    expect(drawnUrls[0]).toContain('operation=op-0');
    expect(drawnUrls[1]).toContain('operation=op-1');
  });

  it('renders a no-vendor external op without throwing (generic "the vendor")', async () => {
    const opts = await renderAndGetOpsTable(
      traveler([op({ id: 'op-1', work_center_kind: 'external', vendor_name: null })]),
    );
    expect(opts.body[0][DETAIL_COL]).toContain('OUTSIDE PROCESS');
    expect(opts.body[0][DETAIL_COL]).toContain('the vendor');
  });

  it('handles the empty-ops placeholder row (null op) without throwing on the hooks', async () => {
    const opts = await renderAndGetOpsTable(traveler([]));
    expect(opts.body).toHaveLength(1);
    const cell = { styles: {} as Record<string, unknown> };
    expect(() =>
      opts.didParseCell({ section: 'body', row: { index: 0 }, column: { index: DETAIL_COL }, cell }),
    ).not.toThrow();
    expect(cell.styles).toEqual({});
    expect(() =>
      opts.didDrawCell({ section: 'body', row: { index: 0 }, column: { index: SCAN_COL }, cell: { x: 0, y: 0, width: 80, height: 80 } }),
    ).not.toThrow();
    // No QR drawn for the placeholder row.
    expect(addImageMock).not.toHaveBeenCalled();
  });
});
