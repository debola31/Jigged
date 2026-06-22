import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Access-layer unit tests (mocked Supabase). These cover the TypeScript logic:
 * tree assembly, path computation, unit conversion, RPC argument shaping, and
 * the client-side delete/move guards.
 *
 * The DB-enforced invariants the access layer DELEGATES to Postgres —
 * parts.quantity == SUM(balances), the cross-tenant guard inside each RPC, and
 * the enable/disable backfill ordering — are not mockable here; they are
 * validated by the migration applying to staging and by the E2E flow
 * (scan → deplete → assert balance + rollup + ledger). See the PR description.
 */

const { state, mockSupabase } = vi.hoisted(() => {
  const s: { fromQueue: Array<{ data: unknown; error: unknown }>; rpc: { data: unknown; error: unknown } } = {
    fromQueue: [],
    rpc: { data: null, error: null },
  };
  const makeBuilder = (result: { data: unknown; error: unknown }) => {
    const b: Record<string, unknown> = {};
    ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'gt', 'order', 'limit', 'single', 'maybeSingle'].forEach(
      (m) => {
        b[m] = vi.fn(() => b);
      },
    );
    // Thenable: awaiting anywhere in the chain resolves to { data, error }.
    b.then = (resolve: (v: unknown) => unknown) => resolve(result);
    return b;
  };
  const supabase = {
    from: vi.fn(() => makeBuilder(s.fromQueue.shift() ?? { data: null, error: null })),
    rpc: vi.fn(() => s.rpc),
  };
  return { state: s, mockSupabase: supabase };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
  getTypedSupabase: () => mockSupabase,
}));

import {
  buildLocationTree,
  buildLocationUrl,
  createLocation,
  deleteLocation,
  moveLocation,
  getBalancesForPart,
  addStockAtLocation,
  depleteStockAtLocation,
  adjustStockAtLocation,
  transferStock,
  enableLocationTracking,
  disableLocationTracking,
} from '@/utils/inventoryLocationsAccess';
import type { InventoryLocation } from '@/types/inventoryLocations';

const loc = (over: Partial<InventoryLocation> & { id: string }): InventoryLocation => ({
  company_id: 'co1',
  parent_id: null,
  name: over.id,
  kind: null,
  code: null,
  is_stockable: true,
  is_qr_anchor: false,
  sort_order: 0,
  created_at: '',
  updated_at: '',
  ...over,
});

const queueFrom = (...results: Array<{ data: unknown; error: unknown }>) => {
  state.fromQueue.push(...results);
};

beforeEach(() => {
  vi.clearAllMocks();
  state.fromQueue = [];
  state.rpc = { data: null, error: null };
});

// ---------------------------------------------------------------------------
describe('buildLocationTree (pure)', () => {
  it('nests children under parents and assigns depth', () => {
    const flat = [
      loc({ id: 'cab', name: 'Cabinet 1' }),
      loc({ id: 'row3', name: 'Row 3', parent_id: 'cab' }),
      loc({ id: 'left', name: 'Left', parent_id: 'row3' }),
      loc({ id: 'cab2', name: 'Cabinet 2' }),
    ];
    const tree = buildLocationTree(flat);
    expect(tree.map((n) => n.id).sort()).toEqual(['cab', 'cab2']);
    const cab = tree.find((n) => n.id === 'cab')!;
    expect(cab.depth).toBe(0);
    expect(cab.children[0].id).toBe('row3');
    expect(cab.children[0].depth).toBe(1);
    expect(cab.children[0].children[0].id).toBe('left');
    expect(cab.children[0].children[0].depth).toBe(2);
  });

  it('treats a node whose parent is absent as a root', () => {
    const tree = buildLocationTree([loc({ id: 'orphan', parent_id: 'missing' })]);
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe('orphan');
  });
});

// ---------------------------------------------------------------------------
describe('buildLocationUrl', () => {
  it('encodes the location UUID against the operator login route', () => {
    expect(buildLocationUrl('co1', 'loc-abc')).toContain('/operator/co1/login?location=loc-abc');
  });
});

// ---------------------------------------------------------------------------
describe('createLocation', () => {
  it('rejects a blank name without querying', async () => {
    await expect(createLocation('co1', { name: '  ' })).rejects.toThrow(/name is required/i);
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('inserts a trimmed, company-scoped row (no parent → no parent check)', async () => {
    queueFrom({ data: loc({ id: 'new', name: 'Cabinet 1' }), error: null });
    const created = await createLocation('co1', { name: '  Cabinet 1 ', kind: 'cabinet' });
    expect(created.id).toBe('new');
    const builder = mockSupabase.from.mock.results[0].value as Record<string, ReturnType<typeof vi.fn>>;
    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ company_id: 'co1', name: 'Cabinet 1', kind: 'cabinet', parent_id: null }),
    );
  });

  it('rejects a parent from another company', async () => {
    queueFrom({ data: loc({ id: 'p', company_id: 'OTHER' }), error: null });
    await expect(createLocation('co1', { name: 'X', parent_id: 'p' })).rejects.toThrow(/same company/i);
  });
});

// ---------------------------------------------------------------------------
describe('moveLocation', () => {
  it('rejects moving a node beneath its own descendant (cycle)', async () => {
    // parent check: getLocation('child') returns same-company node
    queueFrom({ data: loc({ id: 'child', parent_id: 'node' }), error: null });
    // getLocations(company) for the ancestor walk: node → child → node
    queueFrom({
      data: [loc({ id: 'node' }), loc({ id: 'child', parent_id: 'node' })],
      error: null,
    });
    await expect(moveLocation('node', 'child', 'co1')).rejects.toThrow(/beneath one of its own/i);
  });

  it('rejects making a node its own parent', async () => {
    await expect(moveLocation('node', 'node', 'co1')).rejects.toThrow(/its own parent/i);
  });
});

// ---------------------------------------------------------------------------
describe('deleteLocation', () => {
  it('refuses when sub-locations exist', async () => {
    queueFrom({ data: null, error: null }); // child count query (count read below)
    queueFrom({ data: null, error: null }); // balance count query
    // counts come back via the `count` field; emulate by patching the builders:
    (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      select: () => ({ eq: () => ({ count: 2, error: null, then: (r: (v: unknown) => unknown) => r({ count: 2, error: null }) }) }),
    }));
    (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      select: () => ({ eq: () => ({ count: 0, error: null, then: (r: (v: unknown) => unknown) => r({ count: 0, error: null }) }) }),
    }));
    await expect(deleteLocation('node')).rejects.toThrow(/sub-locations/i);
  });

  it('refuses when stock balances exist', async () => {
    (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      select: () => ({ eq: () => ({ then: (r: (v: unknown) => unknown) => r({ count: 0, error: null }) }) }),
    }));
    (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      select: () => ({ eq: () => ({ then: (r: (v: unknown) => unknown) => r({ count: 3, error: null }) }) }),
    }));
    await expect(deleteLocation('node')).rejects.toThrow(/still holds stock/i);
  });
});

// ---------------------------------------------------------------------------
describe('getBalancesForPart', () => {
  it('joins each balance to its location and computes the full path', async () => {
    queueFrom({
      data: [{ company_id: 'co1', location_id: 'left', quantity: 7 }],
      error: null,
    });
    queueFrom({
      data: [
        loc({ id: 'cab', name: 'Cabinet 1' }),
        loc({ id: 'row3', name: 'Row 3', parent_id: 'cab' }),
        loc({ id: 'left', name: 'Left', parent_id: 'row3' }),
      ],
      error: null,
    });
    const balances = await getBalancesForPart('part1');
    expect(balances).toHaveLength(1);
    expect(balances[0].quantity).toBe(7);
    expect(balances[0].path).toEqual(['Cabinet 1', 'Row 3', 'Left']);
  });

  it('returns empty when the part has no balances', async () => {
    queueFrom({ data: [], error: null });
    expect(await getBalancesForPart('part1')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('RPC wrappers', () => {
  // For each: first from() is loadConversionContext (parts row), then rpc().
  const partCtx = (over: Record<string, unknown> = {}) => ({
    data: { primary_unit: 'ft', parts_unit_conversions: [], ...over },
    error: null,
  });

  it('addStockAtLocation passes through quantity when unit === primary', async () => {
    queueFrom(partCtx());
    state.rpc = { data: { location_balance: 12, part_quantity: 12 }, error: null };
    const res = await addStockAtLocation('part1', 'loc1', 12, 'ft', 'received');
    expect(mockSupabase.rpc).toHaveBeenCalledWith('add_stock_at_location', {
      p_part_id: 'part1',
      p_location_id: 'loc1',
      p_quantity: 12,
      p_unit: 'ft',
      p_converted_quantity: 12,
      p_notes: 'received',
    });
    expect(res.part_quantity).toBe(12);
  });

  it('addStockAtLocation applies a custom unit conversion to the converted quantity', async () => {
    queueFrom(partCtx({ parts_unit_conversions: [{ from_unit: 'in', to_primary_factor: 1 / 12 }] }));
    state.rpc = { data: { location_balance: 2, part_quantity: 2 }, error: null };
    await addStockAtLocation('part1', 'loc1', 24, 'in');
    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      'add_stock_at_location',
      expect.objectContaining({ p_quantity: 24, p_unit: 'in', p_converted_quantity: 2 }),
    );
  });

  it('depleteStockAtLocation forwards graceful flag, job tag, and discrepancy result', async () => {
    queueFrom(partCtx());
    state.rpc = { data: { location_balance: 0, part_quantity: 0, has_discrepancy: true, shortfall: 3 }, error: null };
    const res = await depleteStockAtLocation('part1', 'loc1', 8, 'ft', {
      graceful: true,
      jobId: 'job1',
      jobOperationId: 'op1',
      operatorId: 'opr1',
      notes: 'used',
    });
    expect(mockSupabase.rpc).toHaveBeenCalledWith('deplete_stock_at_location', {
      p_part_id: 'part1',
      p_location_id: 'loc1',
      p_quantity: 8,
      p_unit: 'ft',
      p_converted_quantity: 8,
      p_graceful: true,
      p_notes: 'used',
      p_job_id: 'job1',
      p_job_operation_id: 'op1',
      p_operator_id: 'opr1',
    });
    expect(res.has_discrepancy).toBe(true);
    expect(res.shortfall).toBe(3);
  });

  it('adjustStockAtLocation calls adjust with the new converted quantity', async () => {
    queueFrom(partCtx());
    state.rpc = { data: { location_balance: 5, part_quantity: 5 }, error: null };
    await adjustStockAtLocation('part1', 'loc1', 5, 'ft', 'cycle count');
    expect(mockSupabase.rpc).toHaveBeenCalledWith('adjust_stock_at_location', {
      p_part_id: 'part1',
      p_location_id: 'loc1',
      p_new_quantity: 5,
      p_unit: 'ft',
      p_converted_new_quantity: 5,
      p_notes: 'cycle count',
    });
  });

  it('transferStock calls transfer with from/to and returns the group id', async () => {
    queueFrom(partCtx());
    state.rpc = { data: { transfer_group_id: 'grp1', from_balance: 2, to_balance: 5 }, error: null };
    const res = await transferStock('part1', 'from1', 'to1', 3, 'ft');
    expect(mockSupabase.rpc).toHaveBeenCalledWith('transfer_stock', {
      p_part_id: 'part1',
      p_from_location_id: 'from1',
      p_to_location_id: 'to1',
      p_quantity: 3,
      p_unit: 'ft',
      p_converted_quantity: 3,
      p_notes: undefined,
    });
    expect(res.transfer_group_id).toBe('grp1');
  });

  it('enableLocationTracking calls the opt-in RPC with the optional initial location', async () => {
    state.rpc = { data: { location_id: 'unassigned', part_quantity: 100, tracked: true }, error: null };
    const res = await enableLocationTracking('part1', 'loc1');
    expect(mockSupabase.rpc).toHaveBeenCalledWith('enable_location_tracking', {
      p_part_id: 'part1',
      p_initial_location_id: 'loc1',
    });
    expect(res.tracked).toBe(true);
  });

  it('disableLocationTracking calls the opt-out RPC', async () => {
    state.rpc = { data: { part_quantity: 100, tracked: false }, error: null };
    const res = await disableLocationTracking('part1');
    expect(mockSupabase.rpc).toHaveBeenCalledWith('disable_location_tracking', { p_part_id: 'part1' });
    expect(res.tracked).toBe(false);
  });

  it('propagates an RPC error (e.g. the DB tenancy guard rejecting cross-company ids)', async () => {
    queueFrom(partCtx());
    state.rpc = { data: null, error: { message: 'access denied to company X' } };
    await expect(addStockAtLocation('part1', 'loc1', 1, 'ft')).rejects.toBeDefined();
  });
});
