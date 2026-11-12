import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Chainable query-builder stub. Every chain method returns the builder, and the
 * builder doubles as the awaited result, so `const { data, error } = await q`
 * reads `.data` / `.error`. One builder per `.from()` so the multi-query reads
 * (getOutsideSummariesForPart, receiveOutsideShipment) can stub each hop.
 */
function buildQueryStub(initial?: { data?: unknown; error?: unknown }) {
  const builder: Record<string, unknown> = {};
  [
    'select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'is', 'not',
    'gte', 'lte', 'order', 'limit', 'single', 'maybeSingle',
  ].forEach((m) => {
    builder[m] = vi.fn().mockImplementation(() => builder);
  });
  builder.data = initial?.data ?? null;
  builder.error = initial?.error ?? null;
  return builder as Record<string, ReturnType<typeof vi.fn>> & { data: unknown; error: unknown };
}

const { mockSupabase, queueBuilders, mockRpc, mockCapture } = vi.hoisted(() => {
  let queue: ReturnType<typeof Object>[] = [];
  const rpc = vi.fn();
  const capture = vi.fn();
  const supabase = {
    from: vi.fn().mockImplementation(() => {
      const next = queue.shift();
      if (!next) throw new Error('queueBuilders: ran out of stubbed builders');
      return next;
    }),
    rpc,
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null }),
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: 'user-1' } } }, error: null,
      }),
    },
  };
  return {
    mockSupabase: supabase,
    mockRpc: rpc,
    mockCapture: capture,
    queueBuilders: (b: ReturnType<typeof Object>[]) => { queue = b; },
  };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
  createClient: () => mockSupabase,
  supabase: mockSupabase,
}));
vi.mock('@sentry/nextjs', () => ({ captureException: mockCapture }));

import {
  compareOutsideShipmentOrder,
  receiveOutsideShipment,
  createOutsideShipment,
  getOpenOutsideShipments,
  getOutsideShipmentById,
  getOutsideShipmentsForJob,
  getOutsideShipmentsForOperation,
  outsideShipmentPoNumber,
  getOutsideSummariesForPart,
  getSentBeforeShipment,
  listOutsideShipmentsForCompany,
  outstandingOn,
  resolveVendorShipTo,
  voidOutsideShipment,
} from '@/utils/outsideShipmentsAccess';

beforeEach(() => {
  vi.clearAllMocks();
  mockRpc.mockReset();
});

describe('createOutsideShipment', () => {
  it('refuses a zero quantity before it costs a round trip', async () => {
    await expect(
      createOutsideShipment({ jobOperationId: 'op-1', quantity: 0 }),
    ).rejects.toThrow(/how many pieces/i);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('unwraps the RETURNS TABLE row PostgREST hands back as an array', async () => {
    mockRpc.mockResolvedValue({
      data: [{ shipment_id: 'ship-1', slip_number: 'VPS-0141-2' }],
      error: null,
    });
    await expect(createOutsideShipment({ jobOperationId: 'op-1', quantity: 50 })).resolves.toEqual({
      shipmentId: 'ship-1',
      slipNumber: 'VPS-0141-2',
    });
  });

  it('reports an RPC failure to Sentry by hand — .rpc() is not covered by the integration', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'boom', code: 'P0001' } });
    await expect(
      createOutsideShipment({ jobOperationId: 'op-1', quantity: 5 }),
    ).rejects.toThrow();
    expect(mockCapture).toHaveBeenCalled();
  });

  it('throws distinguishably when the slip number cannot be read back', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    await expect(
      createOutsideShipment({ jobOperationId: 'op-1', quantity: 5 }),
    ).rejects.toThrow(/slip number could not be read back/i);
  });
});

describe('receiveOutsideShipment', () => {
  const shipRow = {
    company_id: 'co-1', id: 'ship-1', job_operation_id: 'op-1',
    job_part_id: 'jp-1', voided_at: null,
  };

  it('CLOSES the slip when asked, not just accepts the flag', async () => {
    // The flag was plumbed through the payload, validated against, and then
    // silently dropped -- every test passed because none asserted the close
    // actually happened. Only clicking it in the browser found it.
    const lookup = buildQueryStub({ data: shipRow });
    const insert = buildQueryStub({ data: { id: 'r-1' } });
    const close = buildQueryStub({ data: null });
    queueBuilders([lookup, insert, close]);

    await receiveOutsideShipment('ship-1', { quantityGood: 48, closeShipment: true });

    expect(close.update).toHaveBeenCalledWith(
      expect.objectContaining({ closed_at: expect.any(String), closed_by: 'user-1' }),
    );
    // Idempotent, and never re-closes a voided slip.
    expect(close.is).toHaveBeenCalledWith('closed_at', null);
    expect(close.is).toHaveBeenCalledWith('voided_at', null);
  });

  it('does not close when the flag is absent', async () => {
    const lookup = buildQueryStub({ data: shipRow });
    const insert = buildQueryStub({ data: { id: 'r-1' } });
    queueBuilders([lookup, insert]);
    // A third builder would throw "ran out of stubbed builders" if it closed.
    await expect(
      receiveOutsideShipment('ship-1', { quantityGood: 48 }),
    ).resolves.toEqual({ receiptId: 'r-1' });
  });

  it('writes NO receipt for a close with nothing received', async () => {
    // The vendor returned nothing and the shop is writing the slip off. A zero
    // receipt would be meaningless, and the CHECK refuses it anyway.
    const lookup = buildQueryStub({ data: shipRow });
    const close = buildQueryStub({ data: null });
    queueBuilders([lookup, close]);

    await expect(
      receiveOutsideShipment('ship-1', { quantityGood: 0, closeShipment: true }),
    ).resolves.toEqual({ receiptId: null });
    expect(close.update).toHaveBeenCalled();
  });

  it('refuses a receipt of nothing that is not a close', async () => {
    await expect(
      receiveOutsideShipment('ship-1', { quantityGood: 0 }),
    ).rejects.toThrow(/how many came back/i);
  });
});

describe('voidOutsideShipment', () => {
  it('goes through the RPC, because the ordering is what keeps the job rollup alive', async () => {
    mockRpc.mockResolvedValue({ data: 2, error: null });
    await expect(voidOutsideShipment('ship-1')).resolves.toEqual({ receiptsVoided: 2 });
    expect(mockRpc).toHaveBeenCalledWith('void_outside_shipment', { p_shipment_id: 'ship-1' });
  });
});

describe('getOutsideSummariesForPart', () => {
  const ops = [
    { id: 'op-out', vendor_service_id: 'vs-1', job_part: { quantity: 100 } },
    { id: 'op-in', vendor_service_id: null, job_part: { quantity: 100 } },
  ];

  it('ignores in-house operations entirely', async () => {
    queueBuilders([buildQueryStub({ data: [ops[1]] })]);
    await expect(getOutsideSummariesForPart('jp-1')).resolves.toEqual([]);
  });

  it('derives at-vendor and to-send per slip', async () => {
    queueBuilders([
      buildQueryStub({ data: ops }),
      buildQueryStub({
        data: [
          { id: 's1', job_operation_id: 'op-out', quantity: 60, shipped_at: '2026-08-01T00:00:00Z', due_back_on: '2026-08-08', closed_at: null },
          { id: 's2', job_operation_id: 'op-out', quantity: 40, shipped_at: '2026-08-05T00:00:00Z', due_back_on: null, closed_at: null },
        ],
      }),
      buildQueryStub({
        data: [
          { job_operation_id: 'op-out', outside_shipment_id: 's1', quantity_good: 60 },
        ],
      }),
    ]);

    const [row] = await getOutsideSummariesForPart('jp-1');
    expect(row.qty_sent).toBe(100);
    expect(row.qty_good).toBe(60);
    // s1 is fully accounted for; only s2's 40 are still out.
    expect(row.qty_at_vendor).toBe(40);
    // ordered 100 − good 60 − at_vendor 40 = 0: everything is either back or away.
    expect(row.qty_to_send).toBe(0);
    expect(row.open_slip_count).toBe(1);
    // s1 is fully received, so its ship date must not be the one the UI chases.
    expect(row.oldest_open_shipped_at).toBe('2026-08-05T00:00:00Z');
    expect(row.earliest_due_back_on).toBeNull();
  });

  it('a SHORT-CLOSED slip owes nothing, however little came back on it', async () => {
    // Sage's short-close. The 2 stay missing from qty_good -- so the step is
    // still short -- but the slip stops reading as at-the-vendor, which is what
    // stops a write-off sitting on the chase list forever.
    queueBuilders([
      buildQueryStub({ data: [ops[0]] }),
      buildQueryStub({
        data: [{ id: 's1', job_operation_id: 'op-out', quantity: 100, shipped_at: 'x', due_back_on: null, closed_at: '2026-08-09T00:00:00Z' }],
      }),
      buildQueryStub({
        data: [{ job_operation_id: 'op-out', outside_shipment_id: 's1', quantity_good: 98 }],
      }),
    ]);
    const [row] = await getOutsideSummariesForPart('jp-1');
    expect(row.qty_at_vendor).toBe(0);
    expect(row.qty_good).toBe(98);
    expect(row.open_slip_count).toBe(0);
    // Still two short of the order, so they reappear as work to send.
    expect(row.qty_to_send).toBe(2);
  });

  it('clamps at zero rather than reporting a negative backlog when more came back than went out', async () => {
    queueBuilders([
      buildQueryStub({ data: [ops[0]] }),
      buildQueryStub({ data: [{ id: 's1', job_operation_id: 'op-out', quantity: 10, shipped_at: 'x', due_back_on: null }] }),
      buildQueryStub({
        data: [{ job_operation_id: 'op-out', outside_shipment_id: 's1', quantity_good: 12, quantity_scrapped: 0 }],
      }),
    ]);
    const [row] = await getOutsideSummariesForPart('jp-1');
    expect(row.qty_at_vendor).toBe(0);
  });

  it('re-rounds each running total so a float chain cannot print 29.999999999999996', async () => {
    queueBuilders([
      buildQueryStub({ data: [ops[0]] }),
      buildQueryStub({
        data: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 25.5].map((q, i) => ({
          id: `s${i}`, job_operation_id: 'op-out', quantity: q, shipped_at: 'x', due_back_on: null, closed_at: null,
        })),
      }),
      buildQueryStub({ data: [] }),
    ]);
    const [row] = await getOutsideSummariesForPart('jp-1');
    expect(row.qty_sent).toBe(30);
    expect(String(row.qty_sent)).not.toContain('999');
  });
});

describe('compareOutsideShipmentOrder', () => {
  it('compares created_at as an instant, not as text', () => {
    // As strings, '…:56.7' sorts AFTER '…:56.68'. As times it is earlier.
    const a = { id: 'a', shipped_at: '2026-08-01', created_at: '2026-08-01T10:00:56.7+00:00' };
    const b = { id: 'b', shipped_at: '2026-08-01', created_at: '2026-08-01T10:00:56.68+00:00' };
    expect(compareOutsideShipmentOrder(a, b)).toBeGreaterThan(0);
    expect(a.created_at < b.created_at).toBe(false); // the text comparison this replaces
  });

  it('falls through to id so the order is total', () => {
    const a = { id: 'a', shipped_at: '2026-08-01', created_at: '2026-08-01T10:00:00Z' };
    const b = { id: 'b', shipped_at: '2026-08-01', created_at: '2026-08-01T10:00:00Z' };
    expect(compareOutsideShipmentOrder(a, b)).toBeLessThan(0);
  });
});

describe('getSentBeforeShipment', () => {
  const me = {
    id: 's2', job_operation_id: 'op-1',
    shipped_at: '2026-08-05T00:00:00Z', created_at: '2026-08-05T00:00:00Z',
  };

  it('counts earlier slips, and skips itself and every later one', async () => {
    queueBuilders([
      buildQueryStub({
        data: [
          { id: 's1', quantity: 60, shipped_at: '2026-08-01T00:00:00Z', created_at: '2026-08-01T00:00:00Z' },
          { id: 's2', quantity: 40, shipped_at: '2026-08-05T00:00:00Z', created_at: '2026-08-05T00:00:00Z' },
          { id: 's3', quantity: 25, shipped_at: '2026-08-09T00:00:00Z', created_at: '2026-08-09T00:00:00Z' },
        ],
      }),
    ]);
    await expect(getSentBeforeShipment(me)).resolves.toBe(60);
  });

  it('throws rather than reporting zero prior when the read fails', async () => {
    queueBuilders([buildQueryStub({ data: null, error: { message: 'nope' } })]);
    // "Couldn't read" must not print as "nothing has gone out yet" on a document.
    await expect(getSentBeforeShipment(me)).rejects.toThrow();
  });
});

describe('listOutsideShipmentsForCompany', () => {
  it('filters archived and cancelled jobs out through the joined parent', async () => {
    const q = buildQueryStub({ data: [] });
    queueBuilders([q]);
    await listOutsideShipmentsForCompany('co-1');
    expect(q.is).toHaveBeenCalledWith('job.deleted_at', null);
    expect(q.neq).toHaveBeenCalledWith('job.production_status', 'cancelled');
    expect(q.is).toHaveBeenCalledWith('voided_at', null);
  });

  it('openOnly keeps only slips with something still at the vendor', async () => {
    queueBuilders([
      buildQueryStub({
        data: [
          { id: 's1', quantity: 10, voided_at: null, closed_at: null, receipts: [{ quantity_good: 10, voided_at: null }] },
          { id: 's2', quantity: 10, voided_at: null, closed_at: null, receipts: [] },
        ],
      }),
    ]);
    const rows = await listOutsideShipmentsForCompany('co-1', { openOnly: true });
    expect(rows.map((r) => r.id)).toEqual(['s2']);
  });
});

describe('outstandingOn', () => {
  it('a CLOSED slip owes nothing, whatever came back on it', () => {
    expect(outstandingOn({
      quantity: 100, voided_at: null, closed_at: '2026-08-09',
      receipts: [{ quantity_good: 98, voided_at: null }],
    } as never)).toBe(0);
  });

  it('ignores voided receipts, and a voided slip owes nothing', () => {
    // A void says the send never counted; a close says it counted and is
    // finished. Different facts, same effect on what the vendor owes.
    expect(outstandingOn({
      quantity: 100, voided_at: null, closed_at: null,
      receipts: [{ quantity_good: 100, voided_at: '2026-08-01' }],
    } as never)).toBe(100);
    expect(outstandingOn({ quantity: 100, voided_at: '2026-08-01', closed_at: null, receipts: [] } as never)).toBe(0);
  });
});

describe('resolveVendorShipTo', () => {
  it('takes the default without asking', async () => {
    queueBuilders([
      buildQueryStub({
        data: [
          { id: 'a1', address_line1: '1 Anodize Way', city: 'Warren', state: 'MI', is_default: true },
          { id: 'a2', address_line1: 'PO Box 9', city: 'Detroit', state: 'MI', is_default: false },
        ],
      }),
    ]);
    const r = await resolveVendorShipTo('v-1');
    expect(r.requiresChoice).toBe(false);
    expect(r.address?.id).toBe('a1');
  });

  it('refuses to guess between two addresses with no default', async () => {
    // The second address on a vendor is as likely to be an accounts-receivable
    // desk as a second plant. Guessing sends a pallet to a mailroom.
    queueBuilders([
      buildQueryStub({
        data: [
          { id: 'a1', address_line1: '1 Anodize Way', city: 'Warren', is_default: false },
          { id: 'a2', address_line1: 'PO Box 9', city: 'Detroit', is_default: false },
        ],
      }),
    ]);
    const r = await resolveVendorShipTo('v-1');
    expect(r.requiresChoice).toBe(true);
    expect(r.address).toBeNull();
    expect(r.choices).toHaveLength(2);
  });

  it('is content with no address at all — the slip prints without a ship-to', async () => {
    queueBuilders([buildQueryStub({ data: [] })]);
    const r = await resolveVendorShipTo('v-1');
    expect(r).toEqual({ address: null, choices: [], requiresChoice: false });
  });
});

describe('the vendor PO line a slip ships against (purchasing, criterion O4)', () => {
  it('slip reads carry the link column and the PO number BY JOIN — never a frozen copy', async () => {
    const byId = buildQueryStub({
      data: {
        id: 'ship-1', company_id: 'co-1', created_by: null, vendor_purchase_order_line_id: 'line-2',
        vendor_purchase_order_line: { id: 'line-2', line_number: 2, vendor_purchase_order_id: 'po-1', vendor_purchase_order: { id: 'po-1', po_number: 'PO-1042' } },
      },
    });
    queueBuilders([byId]);
    const slip = await getOutsideShipmentById('ship-1');

    const select = String(byId.select.mock.calls[0][0]);
    expect(select).toContain('vendor_purchase_order_line_id');
    expect(select).toMatch(/vendor_purchase_order_line:vendor_purchase_order_lines\(id, line_number, vendor_purchase_order_id, vendor_purchase_order:vendor_purchase_orders\(id, po_number\)\)/);
    expect(outsideShipmentPoNumber(slip)).toBe('PO-1042');
  });

  it('every slip list carries the same join', async () => {
    const forOp = buildQueryStub({ data: [] });
    const forJob = buildQueryStub({ data: [] });
    const forCompany = buildQueryStub({ data: [] });
    queueBuilders([forOp, forJob, forCompany]);
    await getOutsideShipmentsForOperation('op-1');
    await getOutsideShipmentsForJob('job-1');
    await listOutsideShipmentsForCompany('co-1');
    for (const q of [forOp, forJob, forCompany]) {
      expect(String(q.select.mock.calls[0][0])).toContain('vendor_purchase_order:vendor_purchase_orders(id, po_number)');
    }
  });

  it('a slip on no PO reads null', () => {
    expect(outsideShipmentPoNumber({ vendor_purchase_order_line: null })).toBeNull();
    expect(outsideShipmentPoNumber({})).toBeNull();
  });

  /** The receive dialog names a slip's PO line from these rows, so the join must survive the filter. */
  it('the open slips keep the full slip read — the PO line included — with what each still owes', async () => {
    const join = { id: 'line-2', line_number: 2, vendor_purchase_order_id: 'po-1', vendor_purchase_order: { id: 'po-1', po_number: 'PO-1042' } };
    const forOp = buildQueryStub({
      data: [
        {
          id: 'ship-2', slip_number: 'VPS-0141-2', quantity: 50, shipped_at: '2026-11-04T10:00:00Z', created_at: '2026-11-04T10:00:00Z',
          closed_at: null, voided_at: null, vendor_purchase_order_line_id: 'line-2', vendor_purchase_order_line: join,
          receipts: [{ quantity_good: 20, voided_at: null }, { quantity_good: 5, voided_at: '2026-11-05T00:00:00Z' }],
        },
        {
          id: 'ship-1', slip_number: 'VPS-0141-1', quantity: 10, shipped_at: '2026-11-01T10:00:00Z', created_at: '2026-11-01T10:00:00Z',
          closed_at: '2026-11-03T00:00:00Z', voided_at: null, vendor_purchase_order_line_id: null, vendor_purchase_order_line: null, receipts: [],
        },
      ],
    });
    queueBuilders([forOp]);
    const open = await getOpenOutsideShipments('op-1');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ id: 'ship-2', outstanding: 30, vendor_purchase_order_line_id: 'line-2', vendor_purchase_order_line: join });
    expect(String(forOp.select.mock.calls[0][0])).toContain('vendor_purchase_order:vendor_purchase_orders(id, po_number)');
  });

  it('the send takes NO PO argument: create_outside_shipment links the single open line itself', async () => {
    mockRpc.mockResolvedValue({ data: [{ shipment_id: 'ship-1', slip_number: 'VPS-0141-2' }], error: null });
    await createOutsideShipment({ jobOperationId: 'op-1', quantity: 5 });
    expect(Object.keys(mockRpc.mock.calls[0][1]).sort()).toEqual([
      'p_carrier', 'p_due_back_on', 'p_job_operation_id', 'p_notes', 'p_quantity',
      'p_shipped_at', 'p_vendor_address_id', 'p_vendor_contact_id',
    ]);
  });
});
