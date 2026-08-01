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
  // `count` rides along because PostgREST returns it beside `data` when a select asks for
  // `{ count: 'exact' }` — that's how a capped read reports the true total.
  type Result = { data: unknown; error: unknown; count?: number | null };
  const s: { fromQueue: Result[]; rpc: { data: unknown; error: unknown }; calls: Record<string, unknown[]>[] } = {
    fromQueue: [],
    rpc: { data: null, error: null },
    calls: [],
  };
  const makeBuilder = (result: Result) => {
    const b: Record<string, unknown> = {};
    // Every chain method's arguments are recorded so a test can assert the filters
    // (`.is('part.deleted_at', null)`, `.limit(n)`) actually reached PostgREST.
    const seen: Record<string, unknown[]> = {};
    s.calls.push(seen);
    ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'is', 'not', 'gt', 'ilike', 'order', 'limit', 'range', 'single', 'maybeSingle'].forEach(
      (m) => {
        b[m] = vi.fn((...args: unknown[]) => {
          seen[m] = args;
          return b;
        });
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

// The board resolves photo URLs through storageHelpers; stub the module so no real client is
// built and so the request-budget tests can count storage calls separately from `.from()` reads.
vi.mock('@/utils/storageHelpers', () => ({
  generateStoragePath: vi.fn((co: string, kind: string, id: string, f: string) => `${co}/${kind}/${id}/${f}`),
  // Async, because the code under test chains `.catch()` on the delete — a bare `vi.fn()`
  // returns undefined and blows up on `.catch is not a function`.
  uploadFileToStorage: vi.fn(async () => {}),
  deleteFileFromStorage: vi.fn(async () => {}),
  getSignedUrls: vi.fn(async () => new Map()),
}));

import {
  buildLocationTree,
  createLocation,
  updateLocation,
  deleteLocation,
  moveLocation,
  materializeLocationSpec,
  duplicateLocation,
  getBalancesForPart,
  getBalancesForParts,
  addStockAtLocation,
  depleteStockAtLocation,
  adjustStockAtLocation,
  transferStock,
  enableLocationTracking,
  disableLocationTracking,
  getLocationOccupancy,
  getLocationBoard,
  getLocationContents,
  getLocationContentsPage,
  LOCATION_CONTENTS_LIMIT,
  LOCATION_PAGE_SIZE,
  bulkPutAway,
  setLocationPhoto,
  clearLocationPhoto,
  resolveScan,
  getRecentActivity,
  getLocationHistory,
} from '@/utils/inventoryLocationsAccess';
import {
  deleteFileFromStorage,
  generateStoragePath,
  getSignedUrls,
  uploadFileToStorage,
} from '@/utils/storageHelpers';
import type { InventoryLocation } from '@/types/inventoryLocations';

const loc = (over: Partial<InventoryLocation> & { id: string }): InventoryLocation => ({
  company_id: 'co1',
  parent_id: null,
  name: over.id,
  kind: null,
  code: null,
  sort_order: 0,
  photo_path: null,
  created_at: '',
  updated_at: '',
  ...over,
});

const queueFrom = (...results: Array<{ data: unknown; error: unknown; count?: number | null }>) => {
  state.fromQueue.push(...results);
};

beforeEach(() => {
  vi.clearAllMocks();
  state.fromQueue = [];
  state.calls = [];
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

// `buildLocationUrl` was deleted: it duplicated `locationLabelPdf`'s `buildLocationScanUrl`
// (which is what actually encodes the printed QR) and had no caller. That function's own test
// covers the route shape.

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
  it('calls the delete_location RPC and resolves on success', async () => {
    state.rpc = { data: null, error: null };
    await expect(deleteLocation('node')).resolves.toBeUndefined();
    expect(mockSupabase.rpc).toHaveBeenCalledWith('delete_location', { p_location_id: 'node' });
  });

  it('maps a stocked-subtree error to a friendly message', async () => {
    state.rpc = { data: null, error: { message: 'location subtree still holds stock' } };
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
    const res = await addStockAtLocation('part1', 'loc1', 12, 'ft', { notes: 'received' });
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
    await adjustStockAtLocation('part1', 'loc1', 5, 'ft', { notes: 'cycle count' });
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

// ---------------------------------------------------------------------------
describe('materializeLocationSpec', () => {
  it('recursively creates parent-then-child and returns every created row', async () => {
    const spec = [
      {
        key: '0',
        name: 'Cabinet 1',
        kind: 'cabinet',
        code: 'C01',
        children: [
          {
            key: '0/0',
            name: 'Row 1',
            kind: 'row',
            code: 'C01-R01',
            children: [],
          },
        ],
      },
    ];
    // One insert per node, and nothing else — see the request-budget test below.
    queueFrom({ data: loc({ id: 'a', name: 'Cabinet 1', code: 'C01' }), error: null });
    queueFrom({ data: loc({ id: 'b', name: 'Row 1', parent_id: 'a', code: 'C01-R01' }), error: null });

    const created = await materializeLocationSpec('co1', null, spec);

    expect(created.map((r) => r.id)).toEqual(['a', 'b']);
    // first from() is the cabinet insert; assert the payload carries the spec fields
    const cabinetBuilder = mockSupabase.from.mock.results[0].value as Record<string, ReturnType<typeof vi.fn>>;
    expect(cabinetBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        parent_id: null,
        name: 'Cabinet 1',
        code: 'C01',
        sort_order: 0,
      }),
    );
  });

  /**
   * The nested parents this function inserts are rows it created moments earlier in the same
   * company, so re-fetching each one to prove it belongs there bought nothing and cost a request
   * per node — a 16-node cabinet paid ~31 requests for 16 inserts. Only the caller's `parentId`
   * is unverified, and it's checked once.
   */
  it('validates the caller-supplied parent once, not once per node', async () => {
    const spec = [
      {
        key: '0',
        name: 'Row 1',
        kind: 'row',
        code: 'C01-R01',
        children: [
          { key: '0/0', name: 'Left', kind: 'bin', code: 'C01-R01-L', children: [] },
          { key: '0/1', name: 'Right', kind: 'bin', code: 'C01-R01-R', children: [] },
        ],
      },
    ];
    queueFrom({ data: loc({ id: 'cab', company_id: 'co1' }), error: null }); // the ONE parent check
    queueFrom({ data: loc({ id: 'r1' }), error: null });
    queueFrom({ data: loc({ id: 'l' }), error: null });
    queueFrom({ data: loc({ id: 'r' }), error: null });

    const created = await materializeLocationSpec('co1', 'cab', spec);

    expect(created).toHaveLength(3);
    // 1 parent check + 3 inserts. The old shape spent 3 extra getLocation calls on parents it
    // had just created itself.
    expect(mockSupabase.from).toHaveBeenCalledTimes(4);
  });

  it('still rejects a parent from another company, before writing anything', async () => {
    queueFrom({ data: loc({ id: 'cab', company_id: 'OTHER' }), error: null });
    await expect(
      materializeLocationSpec('co1', 'cab', [{ key: '0', name: 'Row 1', kind: 'row', code: 'R01', children: [] }]),
    ).rejects.toThrow(/same company/i);
    expect(mockSupabase.from).toHaveBeenCalledTimes(1);
  });
});

describe('duplicateLocation', () => {
  it('deep-copies a subtree as a bumped sibling, codes re-derived, structure only', async () => {
    // Existing: Cabinet 1 (C01) → Bin 1 (C01-B01)
    queueFrom({
      data: [
        loc({ id: 'cab', name: 'Cabinet 1', kind: 'cabinet', code: 'C01' }),
        loc({ id: 'b1', name: 'Bin 1', kind: 'bin', parent_id: 'cab', code: 'C01-B01' }),
      ],
      error: null,
    });
    // materialize → new cabinet insert, then the copied bin under it. No per-node parent check:
    // the bin's parent is the cabinet this call just created.
    queueFrom({ data: loc({ id: 'cab2', name: 'Cabinet 2', code: 'C02' }), error: null });
    queueFrom({ data: loc({ id: 'b2', name: 'Bin 1', parent_id: 'cab2', code: 'C02-B01' }), error: null });

    const created = await duplicateLocation('co1', 'cab');

    expect(created.map((r) => r.id)).toEqual(['cab2', 'b2']);
    // from() #0 = getLocations; #1 = new cabinet insert. sort_order lands AFTER
    // the one existing sibling (sort_order 0), so the copy doesn't jump to front.
    const cabInsert = mockSupabase.from.mock.results[1].value as Record<string, ReturnType<typeof vi.fn>>;
    expect(cabInsert.insert).toHaveBeenCalledWith(
      expect.objectContaining({ parent_id: null, name: 'Cabinet 2', code: 'C02', sort_order: 1 }),
    );
    // #2 = copied bin insert, code re-derived under the new cabinet
    const binInsert = mockSupabase.from.mock.results[2].value as Record<string, ReturnType<typeof vi.fn>>;
    expect(binInsert.insert).toHaveBeenCalledWith(
      expect.objectContaining({ parent_id: 'cab2', name: 'Bin 1', code: 'C02-B01' }),
    );
  });
});

/**
 * The board's read budget.
 *
 * A storage board is exactly the shape that becomes an N+1 — loop the tree, ask each location
 * what's in it. This pins that it does not: two requests, whatever the tree size. A comment
 * saying "don't N+1 this" is not a guarantee; counting `.from()` calls is.
 */
describe('getLocationBoard — request budget', () => {
  const manyLocations = Array.from({ length: 40 }, (_, i) => loc({ id: `l${i}` }));
  const manyOccupied = Array.from({ length: 40 }, (_, i) => ({
    location_id: `l${i}`,
    part_count: i + 1,
  }));

  it('reads locations and occupancy in exactly two requests', async () => {
    state.fromQueue = [
      { data: manyLocations, error: null },
      { data: manyOccupied, error: null },
    ];

    const board = await getLocationBoard('co1');

    expect(mockSupabase.from).toHaveBeenCalledTimes(2);
    expect(mockSupabase.from.mock.calls.map((c) => c[0])).toEqual([
      'inventory_locations',
      'inventory_location_occupancy',
    ]);
    expect(board.locations).toHaveLength(40);
    expect(board.directPartCounts.get('l39')).toBe(40);
  });

  it('holds that budget as the tree grows', async () => {
    state.fromQueue = [
      { data: Array.from({ length: 400 }, (_, i) => loc({ id: `l${i}` })), error: null },
      { data: manyOccupied, error: null },
    ];
    await getLocationBoard('co1');
    expect(mockSupabase.from).toHaveBeenCalledTimes(2);
  });
});

describe('getLocationOccupancy', () => {
  it('returns a map of only the occupied locations', async () => {
    state.fromQueue = [{
      data: [{ location_id: 'shelf-a', part_count: 2 }, { location_id: 'yard', part_count: 1 }],
      error: null,
    }];

    const map = await getLocationOccupancy('co1');

    expect([...map.entries()].sort()).toEqual([['shelf-a', 2], ['yard', 1]]);
    // Absent = empty. Callers go through occupancyFor rather than reading this directly.
    expect(map.has('cabinet')).toBe(false);
  });

  // The generated type marks view columns nullable; a null key would poison the map.
  it('skips a row with no location id rather than keying on null', async () => {
    state.fromQueue = [{
      data: [{ location_id: null, part_count: 9 }, { location_id: 'shelf-a', part_count: 2 }],
      error: null,
    }];
    const map = await getLocationOccupancy('co1');
    expect(map.size).toBe(1);
    expect(map.get('shelf-a')).toBe(2);
  });

  it('propagates a read failure instead of silently reporting an empty warehouse', async () => {
    state.fromQueue = [{ data: null, error: { message: 'boom' } }];
    await expect(getLocationOccupancy('co1')).rejects.toBeTruthy();
  });
});

/**
 * A read that used to lie by omission.
 *
 * `getLocationContents` had no `.limit()`, so PostgREST's `max_rows = 1000` clipped it silently —
 * invisible against the seed's 14 rows, wrong for a shop whose `Unassigned` bucket holds every
 * part they own. And it didn't filter archived parts, so it would have listed four where the
 * occupancy view counted three, making the board and the sheet contradict each other.
 */
describe('getLocationContents', () => {
  const row = (id: string, quantity: number) => ({
    quantity,
    part: { id, part_name: id, primary_unit: 'each' },
  });

  it('caps the page and reports the true total so the UI can admit truncation', async () => {
    queueFrom({ data: [row('p1', 5), row('p2', 3)], error: null, count: 9428 });

    const page = await getLocationContents('shelf-a');

    expect(page.contents).toHaveLength(2);
    expect(page.total).toBe(9428);
    expect(state.calls[0].limit).toEqual([LOCATION_CONTENTS_LIMIT]);
  });

  it('excludes archived parts, so the sheet agrees with the occupancy view', async () => {
    queueFrom({ data: [row('p1', 5)], error: null, count: 1 });
    await getLocationContents('shelf-a');
    // An `!inner` embed is what makes the filter drop the parent row rather than null the join.
    expect(String(state.calls[0].select?.[0])).toContain('!inner');
    expect(state.calls[0].is).toEqual(['part.deleted_at', null]);
  });

  it('falls back to the page length when PostgREST returns no count', async () => {
    queueFrom({ data: [row('p1', 5)], error: null, count: null });
    expect((await getLocationContents('shelf-a')).total).toBe(1);
  });

  it('sorts the page by part name for scanning, whatever order it arrived in', async () => {
    queueFrom({ data: [row('zinc', 1), row('alum', 2)], error: null, count: 2 });
    const page = await getLocationContents('shelf-a');
    expect(page.contents.map((c) => c.part_name)).toEqual(['alum', 'zinc']);
  });

  it('honours an explicit smaller limit', async () => {
    queueFrom({ data: [row('p1', 5)], error: null, count: 50 });
    await getLocationContents('shelf-a', 10);
    expect(state.calls[0].limit).toEqual([10]);
  });
});

/**
 * The bin view's contract with the cap.
 *
 * `resolveScan` fans out to the capped read, so it has to carry the total up — otherwise the
 * operator page silently re-acquires the exact truncation the cap was added to expose.
 */
describe('resolveScan', () => {
  it('carries the contents total up so the operator page can say what it hid', async () => {
    queueFrom(
      { data: loc({ id: 'shelf-a', parent_id: 'cab' }), error: null }, // getLocation
      { data: [loc({ id: 'cab' }), loc({ id: 'shelf-a', parent_id: 'cab' })], error: null },
      { data: [{ quantity: 5, part: { id: 'p1', part_name: 'p1', primary_unit: 'each' } }], error: null, count: 9428 },
    );

    const scan = await resolveScan('shelf-a');

    expect(scan.contents).toHaveLength(1);
    expect(scan.contentsTotal).toBe(9428);
    expect(scan.path.map((p) => p.id)).toEqual(['cab', 'shelf-a']);
  });
});

/**
 * Duplicate sibling names, mapped.
 *
 * `inventory_locations_unique_sibling_name` is the only unique index a write from this module can
 * trip, so the mapping is unambiguous — and raw PostgREST text ("duplicate key value violates
 * unique constraint inventory_locations_unique_sibling_name") tells a shop owner nothing about
 * which name to change.
 */
describe('duplicate sibling names', () => {
  const UNIQUE_VIOLATION = { code: '23505', message: 'duplicate key value violates unique constraint' };

  it('names the offending value when a create collides', async () => {
    queueFrom({ data: null, error: UNIQUE_VIOLATION });
    await expect(createLocation('co1', { name: 'Shelf A' })).rejects.toThrow(
      /already a "Shelf A" in the same place/i,
    );
  });

  it('maps a rename collision too, not just a create', async () => {
    queueFrom({ data: null, error: UNIQUE_VIOLATION });
    await expect(updateLocation('loc1', { name: 'Shelf A' })).rejects.toThrow(
      /already a "Shelf A" in the same place/i,
    );
  });

  it('leaves an unrelated write failure with its own message', async () => {
    queueFrom({ data: null, error: { code: '42501', message: 'permission denied' } });
    await expect(createLocation('co1', { name: 'Shelf A' })).rejects.toThrow(/permission denied/i);
  });

  // Every node the wizard generates goes through the same insert, so a collision mid-run surfaces
  // the same actionable message rather than raw constraint text.
  it('surfaces the same message from inside a generated spec', async () => {
    queueFrom({ data: null, error: UNIQUE_VIOLATION });
    await expect(
      materializeLocationSpec('co1', null, [
        { key: '0', name: 'Row 1', kind: 'row', code: 'R01', children: [] },
      ]),
    ).rejects.toThrow(/already a "Row 1" in the same place/i);
  });
});

/**
 * Put-away's read: searchable and paginated, because `Unassigned` holds everything.
 */
describe('getLocationContentsPage', () => {
  const row = (id: string, quantity: number) => ({
    quantity,
    part: { id, part_name: id, primary_unit: 'each' },
  });

  it('pages with range and reports the true total', async () => {
    queueFrom({ data: [row('p1', 5), row('p2', 3)], error: null, count: 9428 });

    const page = await getLocationContentsPage('un', { limit: 2, offset: 4 });

    expect(page.contents).toHaveLength(2);
    expect(page.total).toBe(9428);
    // range() is inclusive on both ends, so a limit of 2 from offset 4 is 4..5.
    expect(state.calls[0].range).toEqual([4, 5]);
  });

  it('pushes the search to the server rather than filtering a fetched page', async () => {
    queueFrom({ data: [row('BUY-ORING-214', 828)], error: null, count: 1 });
    await getLocationContentsPage('un', { search: '  oring  ' });
    expect(state.calls[0].ilike).toEqual(['part.part_name', '%oring%']);
  });

  it('omits the filter entirely for a blank search', async () => {
    queueFrom({ data: [], error: null, count: 0 });
    await getLocationContentsPage('un', { search: '   ' });
    expect(state.calls[0].ilike).toBeUndefined();
  });

  /**
   * `referencedTable` must be the embed's ALIAS. Passing the table name type-checks fine and then
   * fails at runtime with `PGRST108 'parts' is not an embedded resource` — so the string is pinned.
   */
  it('orders by name through the embed alias, not the table name', async () => {
    queueFrom({ data: [], error: null, count: 0 });
    await getLocationContentsPage('un');
    expect(state.calls[0].order).toEqual(['part_name', { referencedTable: 'part', ascending: true }]);
  });

  it('excludes archived parts and empty rows, like the board does', async () => {
    queueFrom({ data: [], error: null, count: 0 });
    await getLocationContentsPage('un');
    expect(String(state.calls[0].select?.[0])).toContain('!inner');
    expect(state.calls[0].is).toEqual(['part.deleted_at', null]);
    expect(state.calls[0].gt).toEqual(['quantity', 0]);
  });

  it('defaults to one page of LOCATION_PAGE_SIZE from the start', async () => {
    queueFrom({ data: [], error: null, count: 0 });
    await getLocationContentsPage('un');
    expect(state.calls[0].range).toEqual([0, LOCATION_PAGE_SIZE - 1]);
  });
});

/**
 * Put-away's write.
 *
 * The budget test is the important one: it exists to stop someone "helpfully" adding a 500-chunk
 * loop later, which would silently turn one atomic transaction into several and re-create the
 * half-moved pile the RPC was built to prevent.
 */
describe('bulkPutAway', () => {
  it('sends every part in ONE rpc call, whatever the count', async () => {
    state.rpc = { data: { moved: 900, skipped: 0, transfer_group_id: 'grp1' }, error: null };
    const ids = Array.from({ length: 900 }, (_, i) => `p${i}`);

    const res = await bulkPutAway('un', 'yard', ids);

    expect(mockSupabase.rpc).toHaveBeenCalledTimes(1);
    expect(mockSupabase.rpc).toHaveBeenCalledWith('bulk_put_away', {
      p_from_location_id: 'un',
      p_to_location_id: 'yard',
      p_part_ids: ids,
    });
    expect(res.moved).toBe(900);
    expect(res.transfer_group_id).toBe('grp1');
  });

  // No quantity and no unit — it moves the whole balance, so there is nothing to convert and no
  // per-part conversion read. Looping transferStock would have cost 2 requests per part.
  it('reads nothing before writing — no conversion context', async () => {
    state.rpc = { data: { moved: 1, skipped: 0, transfer_group_id: 'g' }, error: null };
    await bulkPutAway('un', 'yard', ['p1']);
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('reports what it skipped rather than pretending everything moved', async () => {
    state.rpc = { data: { moved: 3, skipped: 4, transfer_group_id: 'g' }, error: null };
    expect(await bulkPutAway('un', 'yard', ['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toMatchObject({
      moved: 3,
      skipped: 4,
    });
  });

  it('propagates the DB refusal instead of reporting a silent success', async () => {
    state.rpc = { data: null, error: { message: 'Too many parts at once (1001 of a maximum 1000).' } };
    await expect(bulkPutAway('un', 'yard', ['p1'])).rejects.toBeTruthy();
  });
});

/**
 * Photos.
 *
 * The budget matters as much as the behaviour: the bucket is private, so a naive board would sign
 * one URL per tile on every load. `getLocationBoard` resolves them all in a single batched call —
 * and skips storage entirely when nothing has a photo, which is every company today.
 */
describe('location photos', () => {
  const withPhotos = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      loc({ id: `l${i}`, photo_path: `co1/locations/l${i}/p.jpg` }),
    );

  it('signs every tile’s photo in ONE storage call, whatever the board size', async () => {
    state.fromQueue = [{ data: withPhotos(40), error: null }, { data: [], error: null }];
    vi.mocked(getSignedUrls).mockResolvedValue(new Map([['co1/locations/l0/p.jpg', 'https://s/0']]));

    const board = await getLocationBoard('co1');

    expect(getSignedUrls).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getSignedUrls).mock.calls[0][0]).toHaveLength(40);
    expect(board.photoUrls.get('co1/locations/l0/p.jpg')).toBe('https://s/0');
  });

  it('touches storage not at all when no location has a photo', async () => {
    state.fromQueue = [
      { data: [loc({ id: 'l1' }), loc({ id: 'l2' })], error: null },
      { data: [], error: null },
    ];
    const board = await getLocationBoard('co1');

    expect(getSignedUrls).not.toHaveBeenCalled();
    expect(board.photoUrls.size).toBe(0);
  });

  /**
   * Upload, then point the row at it, then remove the old file. A failure at any step leaves a
   * READABLE location — the reverse order could leave a row pointing at a file that isn't there.
   */
  it('uploads before pointing the row at it, and cleans up the replaced file', async () => {
    queueFrom({ data: loc({ id: 'cab', photo_path: 'co1/locations/cab/new.jpg' }), error: null });

    await setLocationPhoto('co1', 'cab', new File(['x'], 'new.jpg'), 'co1/locations/cab/old.jpg');

    expect(uploadFileToStorage).toHaveBeenCalledWith('co1/locations/cab/new.jpg', expect.anything());
    expect(deleteFileFromStorage).toHaveBeenCalledWith('co1/locations/cab/old.jpg');
    // Path namespacing is what the storage.objects RLS policies gate on — first segment = company.
    expect(vi.mocked(generateStoragePath).mock.calls[0].slice(0, 2)).toEqual(['co1', 'locations']);
  });

  it('removes the just-uploaded file if the row update fails, leaving no orphan', async () => {
    queueFrom({ data: null, error: { code: '42501', message: 'permission denied' } });

    await expect(
      setLocationPhoto('co1', 'cab', new File(['x'], 'new.jpg'), null),
    ).rejects.toBeTruthy();
    expect(deleteFileFromStorage).toHaveBeenCalledWith('co1/locations/cab/new.jpg');
  });

  it('clears the row first, so a failed file delete only orphans bytes', async () => {
    queueFrom({ data: loc({ id: 'cab', photo_path: null }), error: null });
    vi.mocked(deleteFileFromStorage).mockRejectedValueOnce(new Error('gone'));

    // Must not throw: the location is already photo-less, which is what the user asked for.
    await expect(clearLocationPhoto('cab', 'co1/locations/cab/old.jpg')).resolves.toBeTruthy();
  });
});

/**
 * A transfer writes TWO ledger rows sharing a `transfer_group_id` — a depletion at the source and
 * an addition at the destination. Correct for the ledger, wrong for a shop-wide feed, where the
 * same event then appears twice in a row with opposite signs.
 */
describe('recent activity — one move, one row', () => {
  const txn = (over: Record<string, unknown>) => ({
    id: 'x',
    created_at: '2026-07-30T10:00:00Z',
    type: 'addition',
    part_id: 'p1',
    item_name: 'BUY-BEARING-608ZZ',
    quantity: 580,
    unit: 'each',
    notes: null,
    operator_id: null,
    photo_path: null,
    has_discrepancy: false,
    transfer_group_id: null,
    location_id: 'l1',
    location_name: 'Shelf A',
    ...over,
  });

  const pair = [
    txn({ id: 'to', type: 'addition', transfer_group_id: 'g1', location_id: 'l1', location_name: 'Shelf A', notes: 'Put away [Transfer from Unassigned]' }),
    txn({ id: 'from', type: 'depletion', transfer_group_id: 'g1', location_id: 'sys', location_name: 'Unassigned', notes: 'Put away [Transfer to Shelf A]' }),
  ];

  it('folds a transfer pair into a single row naming both ends', async () => {
    queueFrom({ data: pair, error: null });

    const [entry, ...rest] = await getRecentActivity('co1');

    expect(rest).toHaveLength(0);
    expect(entry.type).toBe('transfer');
    expect(entry.fromName).toBe('Unassigned');
    // The destination is kept: it holds the put-away photo and is the half worth walking to.
    expect(entry.locationName).toBe('Shelf A');
    expect(entry.locationId).toBe('l1');
  });

  /** The folded row states the route, so the RPC's generated tag would print it twice. */
  it('drops the [Transfer from X] tag the RPC appends, keeping the operator’s own words', async () => {
    queueFrom({ data: pair, error: null });

    const [entry] = await getRecentActivity('co1');
    expect(entry.notes).toBe('Put away');
  });

  /** A move whose other leg fell outside the window is still a move that happened. */
  it('leaves a half-pair alone rather than dropping it', async () => {
    queueFrom({ data: [pair[1]], error: null });

    const [entry] = await getRecentActivity('co1');
    expect(entry.type).toBe('depletion');
    expect(entry.fromName).toBeUndefined();
    // In isolation the tag is the ONLY clue about the other end, so it stays.
    expect(entry.notes).toContain('[Transfer to Shelf A]');
  });

  it('leaves plain additions and depletions untouched', async () => {
    queueFrom({ data: [txn({ id: 'a' }), txn({ id: 'd', type: 'depletion' })], error: null });

    const entries = await getRecentActivity('co1');
    expect(entries.map((e) => e.type)).toEqual(['addition', 'depletion']);
  });

  /** Folding halves the row count, so a limit applied before it would render a half-empty feed. */
  it('over-fetches so the fold cannot shrink the page below the limit', async () => {
    queueFrom({ data: [], error: null });
    await getRecentActivity('co1', 15);

    expect(state.calls.at(-1)?.limit).toEqual([30]);
  });

  /**
   * Folding is for the shop-wide feed ONLY. One bin sees exactly one leg of any move, and that
   * leg's direction is the true answer for that place — an "in" at the destination is not a
   * transfer as far as the destination is concerned.
   */
  it('never folds inside a single bin', async () => {
    queueFrom({ data: [pair[0]], error: null });

    const [entry] = await getLocationHistory('l1');
    expect(entry.type).toBe('addition');
    expect(entry.notes).toContain('[Transfer from Unassigned]');
  });
});

/**
 * The bug this suite exists for. `bulk_put_away` mints ONE transfer_group_id before its loop
 * (20260730010705_inventory_bulk_put_away.sql), so a 15-part put-away writes 30 rows sharing it.
 * Keying the fold on the group alone treated the whole batch as a single pair: it dropped one row,
 * folded one, and left 28 — the wall of rows folding exists to prevent. `transfer_stock` mints per
 * call, which is why single put-aways looked correct and hid this.
 */
describe('recent activity — a batch shares one transfer group', () => {
  const at = (n: number) => '2026-07-30T10:0' + n + ':00Z';
  const leg = (partId: string, type: string, place: string, id: string) => ({
    id,
    created_at: at(1),
    type,
    part_id: partId,
    item_name: partId.toUpperCase(),
    quantity: 10,
    unit: 'ea',
    notes: type === 'depletion' ? 'Put away to Shelf A' : 'Put away from Unassigned',
    operator_id: null,
    photo_path: null,
    has_discrepancy: false,
    transfer_group_id: 'batch1',
    location_id: type === 'depletion' ? 'sys' : 'l1',
    location_name: place,
  });

  const batch = (n: number) =>
    Array.from({ length: n }, (_, i) => [
      leg('p' + i, 'addition', 'Shelf A', 'to' + i),
      leg('p' + i, 'depletion', 'Unassigned', 'from' + i),
    ]).flat();

  it('collapses a whole batch to one row instead of leaving 2N-1', async () => {
    queueFrom({ data: batch(15), error: null });

    const entries = await getRecentActivity('co1');

    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('transfer');
    expect(entries[0].partCount).toBe(15);
    expect(entries[0].fromName).toBe('Unassigned');
    expect(entries[0].locationName).toBe('Shelf A');
  });

  /** A batch mixes units, so any total would be a number that means nothing. */
  it('reports a batch as a count of parts, not a summed quantity', async () => {
    queueFrom({ data: batch(3), error: null });

    const [e] = await getRecentActivity('co1');
    expect(e.quantity).toBe(0);
    expect(e.partCount).toBe(3);
    // `itemName` still holds one arbitrary member; the renderer is what must not show it.
    expect(e.notes).toBeNull();
  });

  /** One part in the group is an ordinary single move and must keep its detail. */
  it('still folds a one-part group the normal way', async () => {
    queueFrom({ data: batch(1), error: null });

    const [e] = await getRecentActivity('co1');
    expect(e.partCount).toBeUndefined();
    expect(e.itemName).toBe('P0');
    expect(e.quantity).toBe(10);
  });

  /** The generated note restates the route the row already shows. Operator prose does not. */
  it('drops the machine-written put-away note but keeps typed words', async () => {
    queueFrom({ data: batch(1), error: null });
    const [auto] = await getRecentActivity('co1');
    expect(auto.notes).toBeNull();

    const typed = batch(1);
    typed[0].notes = 'Box was damaged, 2 set aside';
    queueFrom({ data: typed, error: null });
    const [prose] = await getRecentActivity('co1');
    expect(prose.notes).toBe('Box was damaged, 2 set aside');
  });
});

describe('reserved location kind', () => {
  /** Typing "system" removes the whole structural-actions block, rename included, with no way back. */
  it('refuses to create a location whose kind is the reserved word', async () => {
    await expect(createLocation('co1', { name: 'Shelf A', kind: 'System ' })).rejects.toThrow(
      /reserved/i,
    );
  });

  it('refuses to rename a kind into it either', async () => {
    await expect(updateLocation('l1', { kind: 'system' })).rejects.toThrow(/reserved/i);
  });

  /** Free text is the design (lib/locationKinds.ts); only the one word is reserved. */
  it('still accepts an unrecognised kind, which degrades to a generic tile', async () => {
    queueFrom({ data: loc({ id: 'l1', kind: '34r3' }), error: null });
    await expect(createLocation('co1', { name: 'Shelf A', kind: '34r3' })).resolves.toBeTruthy();
  });
});

/**
 * Issue #619. A chunk of 500 parts is not 500 rows: every part carries an `Unassigned` balance
 * from `trg_auto_track_stocked_part` plus one per place it has been in, so three places per part
 * is 1,500 rows against PostgREST's `max_rows` of 1,000. PostgREST does not error — it returns
 * the first 1,000 and stops, so the rest read as "this part is nowhere".
 */
describe('getBalancesForParts — paging past max_rows', () => {
  const bal = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      part_id: 'p' + (i % 500),
      location_id: 'l1',
      quantity: 5,
    }));

  it('keeps reading while a page comes back full', async () => {
    // getLocations consumes queue slot 0; the balance pages follow.
    queueFrom(
      { data: [loc({ id: 'l1', name: 'Shelf A' })], error: null },
      { data: bal(1000), error: null },
      { data: bal(200), error: null },
    );

    const out = await getBalancesForParts('co1', ['p0']);

    // 1,200 rows arrived across two pages; a single unpaged read would have stopped at 1,000.
    const total = [...out.values()].reduce((n, list) => n + list.length, 0);
    expect(total).toBe(1200);
  });

  /** Exactly max_rows is ambiguous — it may or may not be the end — so it must be followed up. */
  it('does not assume a full page is the last one', async () => {
    queueFrom(
      { data: [loc({ id: 'l1' })], error: null },
      { data: bal(1000), error: null },
      { data: [], error: null },
    );
    await getBalancesForParts('co1', ['p0']);
    // Three reads: locations, the full page, and the follow-up that proved it was the end.
    expect(state.calls).toHaveLength(3);
  });

  it('stops after a short page instead of looping', async () => {
    queueFrom({ data: [loc({ id: 'l1' })], error: null }, { data: bal(3), error: null });
    await getBalancesForParts('co1', ['p0']);
    expect(state.calls).toHaveLength(2);
  });

  /**
   * A place the part merely passed through keeps a zero row forever — `transfer_stock`
   * decrements and `bulk_put_away` sets 0, neither deletes. Those are not places the part is,
   * and they burn page budget.
   */
  it('asks the server to drop zero rows rather than filtering them here', async () => {
    queueFrom({ data: [loc({ id: 'l1' })], error: null }, { data: [], error: null });
    await getBalancesForParts('co1', ['p0']);
    expect(state.calls[1].gt).toEqual(['quantity', 0]);
    // Without a total order, successive ranges can repeat or skip rows.
    expect(state.calls[1].order).toBeDefined();
    expect(state.calls[1].range).toEqual([0, 999]);
  });
});

describe('moveLocation — error mapping', () => {
  /** The (company_id, parent_id, name) index does not care whether a row arrived by create or move. */
  it('turns a sibling-name collision into something a person can read', async () => {
    queueFrom(
      { data: loc({ id: 'cab2' }), error: null },   // assertParentInCompany
      { data: [loc({ id: 'cab2' }), loc({ id: 'shelf' })], error: null }, // cycle walk
      { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } },
    );

    await expect(moveLocation('shelf', 'cab2', 'co1')).rejects.not.toThrow(/23505|unique constraint/);
  });
});
