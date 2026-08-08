import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks so they're set up before imports resolve.
const { jsPDFCtor, autoTableFn, textMock } = vi.hoisted(() => {
  const textMock = vi.fn();

  const docInstance = {
    internal: { pageSize: { getWidth: () => 612, getHeight: () => 792 } },
    setFont: vi.fn(),
    setFontSize: vi.fn(),
    setTextColor: vi.fn(),
    setDrawColor: vi.fn(),
    setLineWidth: vi.fn(),
    setFillColor: vi.fn(),
    text: textMock,
    line: vi.fn(),
    rect: vi.fn(),
    splitTextToSize: vi.fn().mockReturnValue(['wrapped']),
    save: vi.fn(),
    addPage: vi.fn(),
    setPage: vi.fn(),
    getNumberOfPages: vi.fn().mockReturnValue(1),
    getTextWidth: vi.fn().mockReturnValue(50),
    addImage: vi.fn(),
    lastAutoTable: { finalY: 400 },
  };

  return {
    jsPDFCtor: vi.fn().mockImplementation(function () {
      return docInstance;
    }),
    autoTableFn: vi.fn(),
    textMock,
  };
});

vi.mock('jspdf', () => ({ jsPDF: jsPDFCtor }));
vi.mock('jspdf-autotable', () => ({ default: autoTableFn }));

// packingSlipPdf imports shipmentsAccess → lib/supabase, which builds a real
// browser client at module load. Stub it so importing doesn't need Supabase env
// vars (this path never calls the client — supabase: null skips the logo).
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({}),
  createClient: () => ({}),
}));

import {
  computePackingSlipQuantities,
  generatePackingSlipPdf,
  type PackingSlipQtyLine,
} from '@/utils/packingSlipPdf';
import type { ShipmentWithRelations } from '@/types/shipment';
import type { Company } from '@/utils/companyAccess';

const company: Company = { id: 'c1', name: 'Vanguard Precision Works' };

type LineItem = NonNullable<ShipmentWithRelations['shipment_line_items']>[number];

function line(over: {
  id?: string;
  jobPartId?: string;
  quantity: number;
  ordered: number;
  partName?: string;
}): LineItem {
  return {
    id: over.id ?? 'sli-1',
    shipment_id: 'ship-2',
    job_part_id: over.jobPartId ?? 'jp-1',
    quantity: over.quantity,
    created_at: '2026-08-05T12:00:00+00:00',
    job_part: {
      id: over.jobPartId ?? 'jp-1',
      job_id: 'job-1',
      quantity: over.ordered,
      part: {
        id: 'part-1',
        part_name: over.partName ?? 'SUB-PLATE-005',
        description: 'Waterjet-profile plate blank, milled flat',
      },
      job: {
        id: 'job-1',
        job_number: 'J-0023',
        customer_po_number: 'VEC-8903',
        quote_id: null,
      },
    },
  };
}

function shipment(over: Partial<ShipmentWithRelations> = {}): ShipmentWithRelations {
  return {
    id: 'ship-2',
    company_id: 'c1',
    customer_id: 'cust-1',
    job_id: 'job-1',
    shipping_address_id: 'addr-1',
    one_time_address: null,
    packing_slip_number: 'PS-0023-2',
    ship_date: '2026-08-05',
    carrier: null,
    shipping_method: 'customer_pickup',
    created_by: null,
    created_at: '2026-08-05T12:00:00+00:00',
    voided_at: null,
    voided_by: null,
    customer_name: 'Vertex Energy Controls',
    bill_to_address: null,
    ship_to_address: null,
    freight_terms: null,
    customer_carrier_account_id: null,
    freight_account_snapshot: null,
    shipment_line_items: [line({ quantity: 10, ordered: 40 })],
    ...over,
  };
}

/** The autoTable config from the one call generatePackingSlipPdf makes. */
function tableConfig() {
  const config = autoTableFn.mock.calls[0][1] as {
    head: string[][];
    body: string[][];
    columnStyles: Record<string, { cellWidth?: number | 'auto' }>;
  };
  return { ...config, headers: config.head[0] };
}

describe('computePackingSlipQuantities', () => {
  const lines = (over: Partial<PackingSlipQtyLine>[]): PackingSlipQtyLine[] =>
    over.map((o) => ({
      jobPartId: o.jobPartId ?? 'jp-1',
      qtyOrdered: o.qtyOrdered ?? 0,
      qtyShippedThisSlip: o.qtyShippedThisSlip ?? 0,
    }));

  it('nets nothing on the first slip of a job', () => {
    const [row] = computePackingSlipQuantities(
      lines([{ qtyOrdered: 40, qtyShippedThisSlip: 30 }]),
      new Map(),
      true,
    );
    expect(row).toEqual({
      qtyOrdered: 40,
      qtyPrevShipped: 0,
      qtyShipped: 30,
      qtyRemaining: 10,
    });
  });

  it('nets out prior shipments — the 30-then-10 of 40 case that read 30 remaining', () => {
    const [row] = computePackingSlipQuantities(
      lines([{ qtyOrdered: 40, qtyShippedThisSlip: 10 }]),
      new Map([['jp-1', 30]]),
      true,
    );
    expect(row.qtyPrevShipped).toBe(30);
    expect(row.qtyRemaining).toBe(0);
  });

  it('leaves a voided slip’s own quantity in the backlog', () => {
    const [row] = computePackingSlipQuantities(
      lines([{ qtyOrdered: 40, qtyShippedThisSlip: 10 }]),
      new Map([['jp-1', 30]]),
      false,
    );
    // Still prints what the voided slip carried, but those 10 are owed again.
    expect(row.qtyShipped).toBe(10);
    expect(row.qtyRemaining).toBe(10);
  });

  it('clamps an over-shipment at zero rather than printing a negative', () => {
    const [row] = computePackingSlipQuantities(
      lines([{ qtyOrdered: 10, qtyShippedThisSlip: 5 }]),
      new Map([['jp-1', 8]]),
      true,
    );
    expect(row.qtyRemaining).toBe(0);
  });

  it('keeps numeric(12,2) quantities exact', () => {
    const [row] = computePackingSlipQuantities(
      lines([{ qtyOrdered: 10.5, qtyShippedThisSlip: 0.2 }]),
      new Map([['jp-1', 0.1]]),
      true,
    );
    expect(row.qtyRemaining).toBe(10.2);
  });

  it('subtracts the whole slip when one job_part appears on two lines', () => {
    const rows = computePackingSlipQuantities(
      lines([
        { qtyOrdered: 10, qtyShippedThisSlip: 6 },
        { qtyOrdered: 10, qtyShippedThisSlip: 4 },
      ]),
      new Map(),
      true,
    );
    expect(rows.map((r) => r.qtyRemaining)).toEqual([0, 0]);
    // Each row still reports its own shipped quantity.
    expect(rows.map((r) => r.qtyShipped)).toEqual([6, 4]);
  });

  it('ignores map entries for job_parts not on this slip', () => {
    const [row] = computePackingSlipQuantities(
      lines([{ qtyOrdered: 40, qtyShippedThisSlip: 10 }]),
      new Map([['jp-OTHER', 30]]),
      true,
    );
    expect(row.qtyPrevShipped).toBe(0);
    expect(row.qtyRemaining).toBe(30);
  });

  it('treats a missing job_part as zero ordered without throwing', () => {
    const [row] = computePackingSlipQuantities(
      lines([{ qtyOrdered: Number.NaN, qtyShippedThisSlip: 5 }]),
      new Map(),
      true,
    );
    expect(row.qtyOrdered).toBe(0);
    expect(row.qtyRemaining).toBe(0);
  });
});

describe('generatePackingSlipPdf — the quantity table', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('drops the Job # column, keeping the job number in the meta block', async () => {
    await generatePackingSlipPdf({
      shipment: shipment(),
      company,
      shippedBeforeByJobPart: new Map(),
      supabase: null,
    });

    expect(tableConfig().headers).not.toContain('Job #');
    expect(textMock.mock.calls.some((c) => String(c[0]) === 'Job: J-0023')).toBe(true);
  });

  it('shows neither conditional column on a slip that ships everything at once', async () => {
    await generatePackingSlipPdf({
      shipment: shipment({ shipment_line_items: [line({ quantity: 40, ordered: 40 })] }),
      company,
      shippedBeforeByJobPart: new Map(),
      supabase: null,
    });

    expect(tableConfig().headers).toEqual([
      'Customer PO',
      'Part',
      'Description',
      'Qty Ordered',
      'Qty Shipped',
    ]);
  });

  it('prints Prev Shipped and a zero Qty Remaining is hidden once the order closes out', async () => {
    await generatePackingSlipPdf({
      shipment: shipment(),
      company,
      shippedBeforeByJobPart: new Map([['jp-1', 30]]),
      supabase: null,
    });

    const { headers, body } = tableConfig();
    expect(headers).toContain('Prev Shipped');
    expect(headers).not.toContain('Qty Remaining');
    expect(body[0]).toEqual(['VEC-8903', 'SUB-PLATE-005', expect.any(String), '40', '30', '10']);
  });

  it('prints Qty Remaining while the job is still open, and renders 0 rather than blanking', async () => {
    await generatePackingSlipPdf({
      shipment: shipment({
        shipment_line_items: [
          line({ id: 'a', jobPartId: 'jp-1', quantity: 10, ordered: 40, partName: 'AAA' }),
          line({ id: 'b', jobPartId: 'jp-2', quantity: 5, ordered: 5, partName: 'BBB' }),
        ],
      }),
      company,
      shippedBeforeByJobPart: new Map(),
      supabase: null,
    });

    const { headers, body } = tableConfig();
    const remainingIdx = headers.indexOf('Qty Remaining');
    expect(remainingIdx).toBeGreaterThan(-1);
    expect(body.map((r) => r[remainingIdx])).toEqual(['30', '0']);
  });

  it.each([
    ['neither column', new Map<string, number>(), 40],
    ['prev only', new Map([['jp-1', 30]]), 10],
    ['remaining only', new Map<string, number>(), 10],
    ['both columns', new Map([['jp-1', 20]]), 10],
  ])('keeps head, body and columnStyles aligned — %s', async (_label, before, qty) => {
    vi.clearAllMocks();
    await generatePackingSlipPdf({
      shipment: shipment({ shipment_line_items: [line({ quantity: qty, ordered: 40 })] }),
      company,
      shippedBeforeByJobPart: before,
      supabase: null,
    });

    const { headers, body, columnStyles } = tableConfig();
    expect(body.every((row) => row.length === headers.length)).toBe(true);
    expect(Object.keys(columnStyles)).toHaveLength(headers.length);
  });

  it('emits one full-width placeholder row when the slip has no line items', async () => {
    await generatePackingSlipPdf({
      shipment: shipment({ shipment_line_items: [] }),
      company,
      shippedBeforeByJobPart: new Map(),
      supabase: null,
    });

    const { headers, body } = tableConfig();
    expect(body).toHaveLength(1);
    expect(body[0]).toHaveLength(headers.length);
  });

  it('leaves Description enough room in the widest permutation', async () => {
    await generatePackingSlipPdf({
      shipment: shipment({
        shipment_line_items: [
          line({ id: 'a', jobPartId: 'jp-1', quantity: 10, ordered: 40, partName: 'AAA' }),
        ],
      }),
      company,
      shippedBeforeByJobPart: new Map([['jp-1', 20]]),
      supabase: null,
    });

    const { headers, columnStyles } = tableConfig();
    expect(headers).toHaveLength(7);
    const widths = Object.values(columnStyles).map((s) => s.cellWidth);
    // Exactly one 'auto' column (Description) absorbs the remainder, and the
    // fixed columns leave it at least 140pt of the 532pt usable width.
    expect(widths.filter((w) => w === 'auto')).toHaveLength(1);
    const fixed = widths.filter((w): w is number => typeof w === 'number');
    expect(fixed.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(392);
  });

  it('still draws the VOIDED banner', async () => {
    await generatePackingSlipPdf({
      shipment: shipment({ voided_at: '2026-08-06T09:00:00+00:00' }),
      company,
      shippedBeforeByJobPart: new Map([['jp-1', 30]]),
      supabase: null,
    });

    expect(
      textMock.mock.calls.some((c) => String(c[0]).startsWith('VOIDED')),
    ).toBe(true);
    // Voided: its own 10 are owed again, so Qty Remaining comes back.
    expect(tableConfig().headers).toContain('Qty Remaining');
  });
});
