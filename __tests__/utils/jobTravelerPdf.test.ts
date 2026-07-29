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
  // Deterministic QR per URL so we can assert what the single header code encodes.
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
    head: string[][];
    body: string[][];
    didParseCell: (d: unknown) => void;
    didDrawCell?: (d: unknown) => void;
  };
}

// traveler ops table columns: Step, WC, Operation/Instructions, Notes, Done
const DETAIL_COL = 2;
const NOTES_COL = 3;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateJobTravelerPdf — external (outside) operations', () => {
  it('puts "OUTSIDE — ship to {vendor}" in the Notes column; internal Notes carry the times', async () => {
    const opts = await renderAndGetOpsTable(
      traveler([
        op({ id: 'op-0', sequence: 10, work_center_kind: 'internal', operation_name: 'Mill', setup_minutes: 15, cycle_minutes: 3 }),
        op({ id: 'op-1', sequence: 20, work_center_kind: 'external', vendor_name: 'AcmeCoat', operation_name: 'Anodize' }),
      ]),
    );
    // External: the ship-to cue lives in Notes, not the Instructions cell, and has
    // no non-ASCII star glyph.
    expect(opts.body[1][NOTES_COL]).toContain('OUTSIDE');
    expect(opts.body[1][NOTES_COL]).toContain('ship to AcmeCoat');
    expect(opts.body[1][NOTES_COL]).not.toContain('★');
    // The Instructions cell is the plain operation detail (no OUTSIDE prefix).
    expect(opts.body[1][DETAIL_COL]).not.toContain('OUTSIDE');
    // Internal: Notes carry the setup/cycle estimates.
    expect(opts.body[0][NOTES_COL]).toContain('Setup 15');
    expect(opts.body[0][NOTES_COL]).toContain('Cycle 3');
  });

  it('flags the external row with a heavy outline + bold black text, NO fill', async () => {
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
    // External cell → bold black text + heavy dark outline, and NO fill (border only).
    const ext = parse(1, DETAIL_COL);
    expect(ext).toMatchObject({ textColor: [20, 20, 20], fontStyle: 'bold', lineWidth: 1.2, lineColor: [20, 20, 20] });
    expect(ext.fillColor).toBeUndefined();
    // Internal row → no restyle.
    expect(parse(0, DETAIL_COL)).toEqual({});
  });

  it('renders a no-vendor external op without throwing (still flagged OUTSIDE)', async () => {
    const opts = await renderAndGetOpsTable(
      traveler([op({ id: 'op-1', work_center_kind: 'external', vendor_name: null })]),
    );
    expect(opts.body[0][NOTES_COL]).toContain('OUTSIDE');
    expect(opts.body[0][NOTES_COL]).toContain('the vendor');
  });

  it('handles the empty-ops placeholder row (null op) without throwing on the hooks', async () => {
    const opts = await renderAndGetOpsTable(traveler([]));
    expect(opts.body).toHaveLength(1);
    const cell = { styles: {} as Record<string, unknown> };
    expect(() =>
      opts.didParseCell({ section: 'body', row: { index: 0 }, column: { index: DETAIL_COL }, cell }),
    ).not.toThrow();
    expect(cell.styles).toEqual({});
  });
});

describe('generateJobTravelerPdf — single traveler QR', () => {
  it('generates exactly one QR, pointing at the part traveler (no operation param)', async () => {
    await generateJobTravelerPdf({
      traveler: traveler([
        op({ id: 'op-0', sequence: 10 }),
        op({ id: 'op-1', sequence: 20 }),
        op({ id: 'op-2', sequence: 30 }),
      ]),
      company,
      bom: [],
      companyId: 'c1',
      baseUrl: 'https://app.test',
      supabase: null,
    });

    // One code for the whole sheet, regardless of how many operations it lists.
    expect(qrMock).toHaveBeenCalledTimes(1);
    const url = qrMock.mock.calls[0][0] as string;
    expect(url).toBe('https://app.test/operator/c1/login?job=job-1&part=jp-1');
    expect(url).not.toContain('operation=');

    // ...and it's the only image drawn (no logo on this company).
    expect(addImageMock).toHaveBeenCalledTimes(1);
    expect(addImageMock.mock.calls[0][0]).toBe(`QR::${url}`);
  });

  it('drops the per-operation Scan column from the operations table', async () => {
    const opts = await renderAndGetOpsTable(traveler([op({ id: 'op-0' })]));
    expect(opts.head[0]).toEqual(['Step', 'Work Center', 'Operation / Instructions', 'Notes', 'Done']);
    expect(opts.body[0]).toHaveLength(5);
    expect(opts.didDrawCell).toBeUndefined();
  });

  // "Job needs" was a third statement of a fact the sheet already carries twice — the order
  // quantity in the header and the per-unit quantity in this table.
  it('lists the BOM without restating the whole-order quantity', async () => {
    await generateJobTravelerPdf({
      traveler: traveler([op({ id: 'op-0' })]),
      company,
      bom: [
        {
          id: 'b1', parent_part_id: 'p', child_part_id: 'c', quantity: 2, unit: 'each',
          sequence: 0, consume_whole_units: false, created_at: '', updated_at: '',
          child_part: {
            id: 'c', part_name: 'BUY-ORING-214', description: 'O-ring',
            primary_unit: 'each', is_stocked: true, source: 'bought', costing_batch_quantity: 1,
          },
        },
      ] as never,
      companyId: 'c1',
      baseUrl: 'https://app.test',
      supabase: null,
    });
    const call = autoTableFn.mock.calls.find(
      (c) => Array.isArray(c[1]?.head?.[0]) && c[1].head[0][0] === 'Material',
    );
    if (!call) throw new Error('BOM autoTable not found');
    expect(call[1].head[0]).toEqual(['Material', 'Description', 'Qty / unit', 'Unit']);
    expect(call[1].body[0]).toEqual(['BUY-ORING-214', 'O-ring', '2', 'each']);
  });

  it('still renders the sheet when QR generation fails', async () => {
    qrMock.mockRejectedValueOnce(new Error('qr boom'));
    const opts = await renderAndGetOpsTable(traveler([op({ id: 'op-0' })]));
    expect(opts.body).toHaveLength(1);
    expect(addImageMock).not.toHaveBeenCalled();
  });
});
