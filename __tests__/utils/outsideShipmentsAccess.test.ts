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
  createOutsideShipment,
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
      data: [{ shipment_id: 'ship-1', slip_number: 'OSP-0141-2' }],
      error: null,
    });
    await expect(createOutsideShipment({ jobOperationId: 'op-1', quantity: 50 })).resolves.toEqual({
      shipmentId: 'ship-1',
      slipNumber: 'OSP-0141-2',
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

  it('derives at-vendor and to-send, and scrap retires the vendor balance without completing the step', async () => {
    queueBuilders([
      buildQueryStub({ data: ops }),
      buildQueryStub({
        data: [
          { id: 's1', job_operation_id: 'op-out', quantity: 60, shipped_at: '2026-08-01T00:00:00Z', due_back_on: '2026-08-08' },
          { id: 's2', job_operation_id: 'op-out', quantity: 40, shipped_at: '2026-08-05T00:00:00Z', due_back_on: null },
        ],
      }),
      buildQueryStub({
        data: [
          { job_operation_id: 'op-out', outside_shipment_id: 's1', quantity_good: 58, quantity_scrapped: 2 },
        ],
      }),
    ]);

    const [row] = await getOutsideSummariesForPart('jp-1');
    expect(row.qty_sent).toBe(100);
    expect(row.qty_good).toBe(58);
    expect(row.qty_scrapped).toBe(2);
    // s1 is fully accounted for (58 + 2 = 60); only s2's 40 are still out.
    expect(row.qty_at_vendor).toBe(40);
    // ordered 100 − good 58 − at_vendor 40 = 2: the pieces the vendor scrapped
    // have to be re-run and sent again. `ordered − sent` would say 0 here and
    // leave the job two parts short with nothing to send.
    expect(row.qty_to_send).toBe(2);
    expect(row.open_slip_count).toBe(1);
    // s1 is closed, so its due date must not be the one the UI chases.
    expect(row.oldest_open_shipped_at).toBe('2026-08-05T00:00:00Z');
    expect(row.earliest_due_back_on).toBeNull();
  });

  it('counts scrapped pieces back into what still has to be sent', async () => {
    // Everything ordered went out, 10 came back good and the vendor ruined 2.
    // Nothing is at the vendor and the step is two short, so two still have to
    // be re-run and sent -- which is the case that surfaced a dead "SEND 0"
    // button when this was `ordered - sent`.
    queueBuilders([
      buildQueryStub({
        data: [{ id: 'op-out', vendor_service_id: 'vs-1', job_part: { quantity: 12 } }],
      }),
      buildQueryStub({ data: [{ id: 's1', job_operation_id: 'op-out', quantity: 12, shipped_at: 'x', due_back_on: null }] }),
      buildQueryStub({
        data: [{ job_operation_id: 'op-out', outside_shipment_id: 's1', quantity_good: 10, quantity_scrapped: 2 }],
      }),
    ]);
    const [row] = await getOutsideSummariesForPart('jp-1');
    expect(row.qty_at_vendor).toBe(0);
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
          id: `s${i}`, job_operation_id: 'op-out', quantity: q, shipped_at: 'x', due_back_on: null,
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
          { id: 's1', quantity: 10, voided_at: null, receipts: [{ quantity_good: 10, quantity_scrapped: 0, voided_at: null }] },
          { id: 's2', quantity: 10, voided_at: null, receipts: [] },
        ],
      }),
    ]);
    const rows = await listOutsideShipmentsForCompany('co-1', { openOnly: true });
    expect(rows.map((r) => r.id)).toEqual(['s2']);
  });
});

describe('outstandingOn', () => {
  it('counts scrapped pieces as accounted for — they are not still on the rack', () => {
    expect(outstandingOn({
      quantity: 100, voided_at: null,
      receipts: [{ quantity_good: 98, quantity_scrapped: 2, voided_at: null }],
    } as never)).toBe(0);
  });

  it('ignores voided receipts, and a voided slip owes nothing', () => {
    expect(outstandingOn({
      quantity: 100, voided_at: null,
      receipts: [{ quantity_good: 100, quantity_scrapped: 0, voided_at: '2026-08-01' }],
    } as never)).toBe(100);
    expect(outstandingOn({ quantity: 100, voided_at: '2026-08-01', receipts: [] } as never)).toBe(0);
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
