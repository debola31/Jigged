import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Builds a fresh chainable query-builder mock. All chain methods return
 * the builder; the builder doubles as the awaited result, so call sites
 * doing `const { data, error } = await query` see `.data` / `.error`.
 *
 * One builder per .from(...) call — that's how we let the two-query
 * functions (listShipmentsForCompanyWithJobs, getShippedBeforeShipment)
 * stub distinct responses for parts vs. line items vs. members.
 */
function buildQueryStub(initial?: { data?: unknown; error?: unknown }) {
  const builder: Record<string, unknown> = {};
  const chainMethods = [
    'select',
    'insert',
    'update',
    'delete',
    'eq',
    'neq',
    'ilike',
    'or',
    'in',
    'is',
    'not',
    'gte',
    'lte',
    'order',
    'range',
    'single',
    'maybeSingle',
    'limit',
  ];
  chainMethods.forEach((m) => {
    builder[m] = vi.fn().mockImplementation(() => builder);
  });
  builder.data = initial?.data ?? null;
  builder.error = initial?.error ?? null;
  return builder as Record<string, ReturnType<typeof vi.fn>> & {
    data: unknown;
    error: unknown;
  };
}

const { mockSupabase, queueBuilders, mockAuthGetUser } = vi.hoisted(() => {
  let queue: ReturnType<typeof Object>[] = [];
  const authGetUser = vi.fn().mockResolvedValue({
    data: { user: { id: 'user-1' } },
    error: null,
  });
  const supabase = {
    from: vi.fn().mockImplementation(() => {
      const next = queue.shift();
      if (!next) {
        // Unexpected extra .from() — surface as an obvious test failure.
        throw new Error('queueBuilders: ran out of stubbed builders');
      }
      return next;
    }),
    auth: { getUser: authGetUser },
  };
  return {
    mockSupabase: supabase,
    mockAuthGetUser: authGetUser,
    queueBuilders: (builders: ReturnType<typeof Object>[]) => {
      queue = builders;
    },
  };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
  createClient: () => mockSupabase,
  supabase: mockSupabase,
}));

import {
  compareShipmentOrder,
  countShipmentsForJob,
  getShippedBeforeShipment,
  voidShipment,
} from '@/utils/shipmentsAccess';

describe('voidShipment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks resets call history but not the implementation; re-assert
    // the signed-in default so a prior test's *Once override can't leak.
    mockAuthGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    });
  });

  it('stamps voided_at/voided_by on the row, guarded against re-void', async () => {
    const updateBuilder = buildQueryStub({ data: null, error: null });
    queueBuilders([updateBuilder]);

    await voidShipment('ship-1');

    // voided_by is the current auth user; voided_at is an ISO timestamp.
    expect(updateBuilder.update).toHaveBeenCalledTimes(1);
    const patch = updateBuilder.update.mock.calls[0][0] as {
      voided_at: string;
      voided_by: string;
    };
    expect(patch.voided_by).toBe('user-1');
    expect(typeof patch.voided_at).toBe('string');
    expect(Number.isNaN(Date.parse(patch.voided_at))).toBe(false);
    expect(updateBuilder.eq).toHaveBeenCalledWith('id', 'ship-1');
    // Idempotency guard: only void rows not already voided.
    expect(updateBuilder.is).toHaveBeenCalledWith('voided_at', null);
  });

  it('throws when no user is signed in (never writes)', async () => {
    mockAuthGetUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    // No builder queued — if it tried to UPDATE, .from() would throw a
    // different error. We assert the auth-guard message specifically.
    await expect(voidShipment('ship-1')).rejects.toThrow(/signed in/i);
  });

  it('surfaces the database error message', async () => {
    const updateBuilder = buildQueryStub({
      data: null,
      error: { message: 'permission denied' },
    });
    queueBuilders([updateBuilder]);

    await expect(voidShipment('ship-1')).rejects.toThrow(/permission denied/);
  });
});

describe('countShipmentsForJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('counts all shipment rows for a job via the direct job_id column', async () => {
    const stub = buildQueryStub({ error: null });
    (stub as unknown as { count: number }).count = 3;
    queueBuilders([stub]);

    const n = await countShipmentsForJob('job-1');

    expect(n).toBe(3);
    expect(mockSupabase.from).toHaveBeenCalledWith('shipments');
    expect(stub.select).toHaveBeenCalledWith('id', { count: 'exact', head: true });
    expect(stub.eq).toHaveBeenCalledWith('job_id', 'job-1');
  });

  it('returns 0 when the count is null', async () => {
    const stub = buildQueryStub({ error: null });
    queueBuilders([stub]);

    await expect(countShipmentsForJob('job-1')).resolves.toBe(0);
  });

  it('throws when the count query errors', async () => {
    const stub = buildQueryStub({ error: { message: 'boom' } });
    queueBuilders([stub]);

    await expect(countShipmentsForJob('job-1')).rejects.toThrow(/check shipments/i);
  });
});

describe('compareShipmentOrder', () => {
  const key = (ship_date: string, created_at: string, id: string) => ({
    ship_date,
    created_at,
    id,
  });

  it('orders by ship_date first', () => {
    const early = key('2026-08-01', '2026-08-05T10:00:00+00:00', 'zzz');
    const late = key('2026-08-02', '2026-08-01T10:00:00+00:00', 'aaa');
    expect(compareShipmentOrder(early, late)).toBeLessThan(0);
    expect(compareShipmentOrder(late, early)).toBeGreaterThan(0);
  });

  it('falls back to created_at as an instant, not as text', () => {
    // '…:56.7' is LATER than '…:56.68' numerically but sorts earlier as a
    // string — the reason this compares parsed timestamps.
    const a = key('2026-08-01', '2026-08-01T10:00:56.68+00:00', 'aaa');
    const b = key('2026-08-01', '2026-08-01T10:00:56.7+00:00', 'bbb');
    expect(compareShipmentOrder(a, b)).toBeLessThan(0);
    expect(compareShipmentOrder(b, a)).toBeGreaterThan(0);
  });

  it('breaks a full tie on id, and reports identity as 0', () => {
    const a = key('2026-08-01', '2026-08-01T10:00:00+00:00', 'aaa');
    const b = key('2026-08-01', '2026-08-01T10:00:00+00:00', 'bbb');
    expect(compareShipmentOrder(a, b)).toBeLessThan(0);
    expect(compareShipmentOrder(a, { ...a })).toBe(0);
  });
});

describe('getShippedBeforeShipment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const current = {
    id: 'ship-2',
    job_id: 'job-1',
    ship_date: '2026-08-05',
    created_at: '2026-08-05T12:00:00+00:00',
  };

  it('sums only the slips ordered before this one, skipping itself', async () => {
    const stub = buildQueryStub({
      data: [
        {
          id: 'ship-1',
          ship_date: '2026-08-01',
          created_at: '2026-08-01T09:00:00+00:00',
          shipment_line_items: [{ job_part_id: 'jp-1', quantity: 30 }],
        },
        {
          id: 'ship-2',
          ship_date: '2026-08-05',
          created_at: '2026-08-05T12:00:00+00:00',
          shipment_line_items: [{ job_part_id: 'jp-1', quantity: 10 }],
        },
        {
          id: 'ship-3',
          ship_date: '2026-08-09',
          created_at: '2026-08-09T09:00:00+00:00',
          shipment_line_items: [{ job_part_id: 'jp-1', quantity: 5 }],
        },
      ],
    });
    queueBuilders([stub]);

    const before = await getShippedBeforeShipment(current);

    expect(before.get('jp-1')).toBe(30);
    expect(mockSupabase.from).toHaveBeenCalledWith('shipments');
    expect(stub.eq).toHaveBeenCalledWith('job_id', 'job-1');
    // Voided siblings never reach the fold — a void removes the quantity.
    expect(stub.is).toHaveBeenCalledWith('voided_at', null);
  });

  it('excludes a same-timestamp sibling with a greater id', async () => {
    const stub = buildQueryStub({
      data: [
        {
          id: 'ship-1',
          ...{ ship_date: current.ship_date, created_at: current.created_at },
          shipment_line_items: [{ job_part_id: 'jp-1', quantity: 4 }],
        },
        {
          id: 'ship-9',
          ...{ ship_date: current.ship_date, created_at: current.created_at },
          shipment_line_items: [{ job_part_id: 'jp-1', quantity: 7 }],
        },
      ],
    });
    queueBuilders([stub]);

    // 'ship-1' < 'ship-2' < 'ship-9': only the first counts.
    await expect(getShippedBeforeShipment(current)).resolves.toEqual(
      new Map([['jp-1', 4]]),
    );
  });

  it('sums two lines of the same job_part on one prior slip, rounded to 2dp', async () => {
    const stub = buildQueryStub({
      data: [
        {
          id: 'ship-1',
          ship_date: '2026-08-01',
          created_at: '2026-08-01T09:00:00+00:00',
          shipment_line_items: [
            { job_part_id: 'jp-1', quantity: 0.1 },
            { job_part_id: 'jp-1', quantity: 0.2 },
            { job_part_id: 'jp-2', quantity: 6 },
          ],
        },
      ],
    });
    queueBuilders([stub]);

    const before = await getShippedBeforeShipment(current);

    expect(before.get('jp-1')).toBe(0.3);
    expect(before.get('jp-2')).toBe(6);
  });

  it('returns an empty map for the first slip on a job', async () => {
    const stub = buildQueryStub({
      data: [
        {
          id: current.id,
          ship_date: current.ship_date,
          created_at: current.created_at,
          shipment_line_items: [{ job_part_id: 'jp-1', quantity: 30 }],
        },
      ],
    });
    queueBuilders([stub]);

    await expect(getShippedBeforeShipment(current)).resolves.toEqual(new Map());
  });

  it('throws rather than reporting zero prior shipments when the query fails', async () => {
    const stub = buildQueryStub({ error: { message: 'boom' } });
    queueBuilders([stub]);

    await expect(getShippedBeforeShipment(current)).rejects.toThrow(/prior shipments/i);
  });
});
