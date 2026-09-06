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
}));

/**
 * Kept AFTER location photos were removed, and deliberately.
 *
 * Nothing in this module signs a URL directly any more — but it still reaches `storageHelpers`
 * TRANSITIVELY, through `resolveMovementAttribution`, which signs the photo on a MOVEMENT. That
 * path never fires today only because every movement fixture below has `photo_path: null`; the
 * first one that doesn't would call the real `getSignedUrls`, whose `getSupabase().storage` is
 * absent from the client mock above, and die with an error about `storage` rather than about
 * anything this file is testing.
 */
vi.mock('@/utils/storageHelpers', () => ({
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
  getLocationOccupancy,
  getLocationBoard,
  getLocationContents,
  getLocationContentsPage,
  LOCATION_CONTENTS_LIMIT,
  LOCATION_PAGE_SIZE,
  bulkPutAway,
  applyLocationLayout,
  resolveScan,
  getRecentActivity,
  getLocationHistory,
  getLotsAtLocation,
  getLotsAtLocationForPart,
} from '@/utils/inventoryLocationsAccess';
import type { InventoryLocation } from '@/types/inventoryLocations';
import { ID_CHUNK } from '@/lib/queryLimits';

const loc = (over: Partial<InventoryLocation> & { id: string }): InventoryLocation => ({
  company_id: 'co1',
  parent_id: null,
  name: over.id,
  kind: null,
  sort_order: 0,
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

// `buildLocationUrl` was deleted: it duplicated the printed QR's own URL builder and had no
// caller. That builder is now `buildScanUrl` in `lib/jiggedScan.ts`, which owns writing, reading
// and routing a scan in one place; `__tests__/lib/jiggedScan.test.ts` covers the shape.

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

  // The heat is optional on both writes. It travels as `p_heat_number` and is OMITTED (undefined,
  // so JSON drops the key) rather than sent as null when nothing was typed — the RPC's default is
  // what "not recorded" means, and the database normalises whatever does arrive.
  it('addStockAtLocation forwards the heat number as p_heat_number', async () => {
    queueFrom(partCtx());
    state.rpc = { data: { location_balance: 12, part_quantity: 12 }, error: null };
    await addStockAtLocation('part1', 'loc1', 12, 'ft', { heatNumber: '4471' });
    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      'add_stock_at_location',
      expect.objectContaining({ p_heat_number: '4471' }),
    );
  });

  it('depleteStockAtLocation forwards the heat number, and omits it when none was typed', async () => {
    queueFrom(partCtx());
    state.rpc = { data: { location_balance: 4, part_quantity: 4 }, error: null };
    await depleteStockAtLocation('part1', 'loc1', 8, 'ft', { jobId: 'job1', heatNumber: '8823' });
    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      'deplete_stock_at_location',
      expect.objectContaining({ p_job_id: 'job1', p_heat_number: '8823' }),
    );

    queueFrom(partCtx());
    await depleteStockAtLocation('part1', 'loc1', 8, 'ft', {});
    const args = (mockSupabase.rpc as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as Record<
      string,
      unknown
    >;
    expect(args.p_heat_number).toBeUndefined();
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



  it('propagates an RPC error (e.g. the DB tenancy guard rejecting cross-company ids)', async () => {
    queueFrom(partCtx());
    state.rpc = { data: null, error: { message: 'access denied to company X' } };
    await expect(addStockAtLocation('part1', 'loc1', 1, 'ft')).rejects.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
/**
 * One call, one transaction (#618).
 *
 * This used to insert node-by-node in an awaited loop: a 12 × 15 cabinet was 240 sequential round
 * trips, slow enough on shop hardware that the owner thought the app had frozen — and a failure
 * halfway left a partial tree with no rollback. `create_location_tree` does the whole subtree in
 * one statement, so the assertions worth having are the REQUEST COUNT and the payload shape.
 */
describe('getLotsAtLocation', () => {
  // What a take, a move and a count pick from: the lots that are ACTUALLY AT this place, with
  // their balances. The version this replaced read every heat ever RECEIVED for the part, which
  // after a year of deliveries is mostly heats long consumed — a list that grew without bound and
  // could still be used to name material that is not on the shelf.
  it('groups the lots held here per part, most stock first', async () => {
    queueFrom({ data: [{ id: 'p1', lot_tracked: true }, { id: 'p2', lot_tracked: false }], error: null });
    queueFrom({
      data: [
        { part_id: 'p1', quantity: 5, lot_id: 'l-a', material_lots: { id: 'l-a', lot_code: '4471', heat_number: '4471' } },
        { part_id: 'p1', quantity: 30, lot_id: 'l-b', material_lots: { id: 'l-b', lot_code: '8823', heat_number: '8823' } },
        { part_id: 'p2', quantity: 2, lot_id: 'l-c', material_lots: { id: 'l-c', lot_code: 'LOT-1', heat_number: null } },
      ],
      error: null,
    });

    const { lots, tracked } = await getLotsAtLocation(['p1', 'p2', 'p1'], 'loc1');

    // Most stock first — the bar you are most likely reaching for.
    expect(lots.get('p1')?.map((l) => l.lotCode)).toEqual(['8823', '4471']);
    expect(lots.get('p2')?.[0]).toMatchObject({ lotCode: 'LOT-1', heatNumber: null, quantity: 2 });

    // Tracked is carried separately, because "no lots here" and "this part does not use lots"
    // look identical in the map and must not look identical on screen.
    expect(tracked.has('p1')).toBe(true);
    expect(tracked.has('p2')).toBe(false);

    // Balances at THIS place, deduped ids, and never a lot-less row.
    expect(state.calls[1].in).toEqual(['part_id', ['p1', 'p2']]);
    expect(state.calls[1].eq).toEqual(['location_id', 'loc1']);
    expect(state.calls[1].not).toEqual(['lot_id', 'is', null]);
  });

  it('asks nothing for no parts, and answers empty for a part with none here', async () => {
    const empty = await getLotsAtLocation([], 'loc1');
    expect(empty.lots.size).toBe(0);
    expect(mockSupabase.from).not.toHaveBeenCalled();

    queueFrom({ data: [{ id: 'p1', lot_tracked: true }], error: null });
    queueFrom({ data: [], error: null });
    const one = await getLotsAtLocationForPart('p1', 'loc1');
    // Tracked with nothing here: the picker says the shelf is empty rather than showing no field.
    expect(one).toEqual({ lots: [], tracked: true });
  });
});

describe('materializeLocationSpec', () => {
  const spec = [
    {
      key: '0',
      name: 'Cabinet 1',
      kind: 'cabinet',
      children: [{ key: '0/0', name: 'Row 1', kind: 'row', children: [] }],
    },
  ];

  it('creates the whole tree in ONE request, whatever its size', async () => {
    const big = Array.from({ length: 15 }, (_, r) => ({
      key: `${r}`,
      name: `Row ${r + 1}`,
      kind: 'row',
      children: Array.from({ length: 15 }, (_, c) => ({
        key: `${r}/${c}`,
        name: `Bin ${c + 1}`,
        kind: 'bin',
        children: [],
      })),
    }));
    state.rpc = { data: [loc({ id: 'a' })], error: null };

    await materializeLocationSpec('co1', 'cab', big);

    // 240 nodes. The old shape was 240 inserts plus a parent check.
    expect(mockSupabase.rpc).toHaveBeenCalledTimes(1);
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  /**
   * The RPC rejects a forward reference rather than guessing, so the flattened list has to arrive
   * depth-first with every parent ahead of its children. Getting this wrong would silently root a
   * node in the wrong place, which is unrecoverable.
   */
  it('sends a flat parent-before-child node list, with the parent id and company', async () => {
    state.rpc = { data: [loc({ id: 'a' }), loc({ id: 'b' })], error: null };

    const created = await materializeLocationSpec('co1', 'cab', spec);

    expect(created.map((r) => r.id)).toEqual(['a', 'b']);
    const args = vi.mocked(mockSupabase.rpc).mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(args[0]).toBe('create_location_tree');
    expect(args[1].p_company_id).toBe('co1');
    expect(args[1].p_parent_id).toBe('cab');
    expect(args[1].p_nodes).toEqual([
      { ref: '0', parent_ref: null, name: 'Cabinet 1', kind: 'cabinet', sort_order: 0 },
      { ref: '0/0', parent_ref: '0', name: 'Row 1', kind: 'row', sort_order: 0 },
    ]);
  });

  /**
   * A root-level create — a whole new storage unit — is the case the old RPC could not express,
   * because it derived the company from the parent row. `undefined` rather than `null` so
   * PostgREST omits the argument and the SQL DEFAULT applies.
   */
  it('omits the parent for a root-level create', async () => {
    state.rpc = { data: [loc({ id: 'a' })], error: null };

    await materializeLocationSpec('co1', null, spec);

    const args = vi.mocked(mockSupabase.rpc).mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(args[1].p_parent_id).toBeUndefined();
  });

  /**
   * `startSortOrder` survives on this path only.
   *
   * It used to serve `Change layout` too, so a second pass sorted its new rows after the existing
   * ones instead of interleaving — i.e. it was half of the append behaviour. Reshape reconciles
   * positions against reality instead. What is left is `duplicateLocation`, where sorting the copy
   * after its siblings is genuinely what "duplicate" means.
   */
  it('offsets the top level by startSortOrder, so a duplicate sorts after its siblings', async () => {
    state.rpc = { data: [], error: null };

    await materializeLocationSpec('co1', 'cab', spec, 3);

    const args = vi.mocked(mockSupabase.rpc).mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect((args[1].p_nodes as Array<{ sort_order: number }>)[0].sort_order).toBe(3);
  });

  /**
   * Tenancy and the billing gate now live in the RPC, which is the point — they cannot be skipped
   * by a caller. The wrapper's job is only to render the refusal like every other write on this
   * table rather than leaking a raw SQLSTATE.
   */
  it('surfaces the database refusal instead of reporting a silent success', async () => {
    state.rpc = { data: null, error: { message: 'access denied to company OTHER' } };
    await expect(materializeLocationSpec('co1', 'cab', spec)).rejects.toBeTruthy();
  });

  it('names a duplicate sibling as a name clash, not a constraint violation', async () => {
    state.rpc = {
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint' },
    };
    await expect(materializeLocationSpec('co1', 'cab', spec)).rejects.toThrow(/already/i);
  });
});

// ---------------------------------------------------------------------------
describe('applyLocationLayout', () => {
  const payload = {
    nodes: [
      { ref: 'id:row1', parent_ref: null, name: 'Row 1', kind: null, sort_order: 0 },
      { ref: 'new:/1', parent_ref: null, name: 'Row 2', kind: null, sort_order: 1 },
    ],
    removals: ['row3'],
  };

  it('sends the diff whole — nodes, removals and moves in one call', async () => {
    queueFrom({ data: { primary_unit: 'ea', parts_unit_conversions: [] }, error: null });
    state.rpc = { data: [loc({ id: 'row1' })], error: null };

    await applyLocationLayout('cab', payload, [
      { partId: 'p1', fromLocationId: 'row3', toRef: 'new:/1', quantity: 4, unit: 'ea' },
    ]);

    const args = vi.mocked(mockSupabase.rpc).mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(args[0]).toBe('apply_location_layout');
    expect(args[1].p_parent_id).toBe('cab');
    expect(args[1].p_nodes).toEqual(payload.nodes);
    expect(args[1].p_removals).toEqual(['row3']);
    expect(args[1].p_moves).toEqual([
      {
        part_id: 'p1',
        from_location_id: 'row3',
        to_ref: 'new:/1',
        quantity: 4,
        unit: 'ea',
        converted_quantity: 4,
        // Explicitly null rather than omitted: the RPC reads `lot_id` off every move, and "no
        // lot" is a real answer (the untracked part, which is nearly all of them) rather than an
        // unstated one.
        lot_id: null,
      },
    ]);
  });

  /**
   * A tracked part moves ONE heat at a time, and the move has to say which.
   *
   * `transfer_stock` refuses a lot-less move of one — there is no such thing as "move 12 of this
   * bar" when the shelf holds 8 of one heat and 4 of another — so a reshape of a unit holding
   * traced material is rejected outright unless this reaches the payload.
   */
  it('carries the lot on a move, so a reshape of traced material is not refused', async () => {
    queueFrom({ data: { primary_unit: 'ea', parts_unit_conversions: [] }, error: null });
    state.rpc = { data: [loc({ id: 'row1' })], error: null };

    await applyLocationLayout('cab', payload, [
      { partId: 'p1', fromLocationId: 'row3', toRef: 'new:/1', quantity: 4, unit: 'ea', lotId: 'lot-1' },
    ]);

    const args = vi.mocked(mockSupabase.rpc).mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(args[1].p_moves).toEqual([expect.objectContaining({ lot_id: 'lot-1' })]);
  });

  /**
   * One conversion read per PART, not per move.
   *
   * Splitting one part across three bins is three moves against one part, and the conversion
   * context is a property of the part. Reading it per move would make a split cost N extra
   * requests for one answer.
   */
  it('reads a part’s conversion context once however many bins it is split across', async () => {
    queueFrom({ data: { primary_unit: 'ea', parts_unit_conversions: [] }, error: null });
    state.rpc = { data: [], error: null };

    await applyLocationLayout('cab', payload, [
      { partId: 'p1', fromLocationId: 'row3', toRef: 'id:row1', quantity: 4, unit: 'ea' },
      { partId: 'p1', fromLocationId: 'row3', toRef: 'new:/1', quantity: 6, unit: 'ea' },
    ]);

    expect(mockSupabase.from).toHaveBeenCalledTimes(1);
    expect(mockSupabase.from).toHaveBeenCalledWith('parts');
  });

  it('surfaces a duplicate sibling name as a sentence rather than a raw 23505', async () => {
    state.rpc = {
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint' },
    };
    await expect(applyLocationLayout('cab', payload, [])).rejects.toThrow(/already/i);
  });

});

describe('duplicateLocation', () => {
  it('deep-copies a subtree as a bumped sibling, structure only', async () => {
    // Existing: Cabinet 1 → Bin 1
    queueFrom({
      data: [
        loc({ id: 'cab', name: 'Cabinet 1', kind: 'cabinet' }),
        loc({ id: 'b1', name: 'Bin 1', kind: 'bin', parent_id: 'cab' }),
      ],
      error: null,
    });
    state.rpc = {
      data: [loc({ id: 'cab2', name: 'Cabinet 2' }), loc({ id: 'b2', name: 'Bin 1', parent_id: 'cab2' })],
      error: null,
    };

    const created = await duplicateLocation('co1', 'cab');

    expect(created.map((r) => r.id)).toEqual(['cab2', 'b2']);
    // One read for the tree, one RPC for the copy.
    expect(mockSupabase.from).toHaveBeenCalledTimes(1);
    const args = vi.mocked(mockSupabase.rpc).mock.calls[0] as unknown as [string, Record<string, unknown>];
    const nodes = args[1].p_nodes as Array<Record<string, unknown>>;
    // The copy is named past the existing sibling and sorts AFTER it, so it doesn't jump to front.
    expect(nodes[0]).toMatchObject({ parent_ref: null, name: 'Cabinet 2', sort_order: 1 });
    // Children ride along under the copy's own ref, never the original's id.
    expect(nodes[1]).toMatchObject({ parent_ref: nodes[0].ref, name: 'Bin 1' });
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

  it('does not map an unrelated write failure to the duplicate-name copy', async () => {
    // Renamed from "…with its own message": the fallback no longer passes `error.message`
    // straight through, because that rendered raw PostgREST text to the user. It now goes
    // through the shared translator. What still matters here is that a NON-23505 failure does
    // not get the "There's already a …" wording.
    queueFrom({ data: null, error: { code: '42501', message: 'permission denied' } });
    await expect(createLocation('co1', { name: 'Shelf A' })).rejects.toThrow(
      /don't have permission/i,
    );
  });

  it('tells a lapsed shop to restart its subscription rather than blaming permissions', async () => {
    queueFrom({
      data: null,
      error: {
        code: '42501',
        message:
          'new row violates row-level security policy "billing_gate_insert" for table "inventory_locations"',
      },
    });
    await expect(createLocation('co1', { name: 'Shelf A' })).rejects.toThrow(
      /subscription isn't active/i,
    );
  });

  /**
   * A generated spec gets the same actionable sentence, minus the name.
   *
   * It USED to name the offender ("already a \"Row 1\"") because the old loop knew which node it
   * was inserting when the 23505 landed. `create_location_tree` writes the whole subtree in one
   * statement, so no single name is attributable any more. Worth the trade: this case is now rare
   * by construction, because `buildSpecFromLevels` continues numbering past the parent's existing
   * siblings (Row 4-6, not a second Row 1-3) precisely so a repeat subdivide cannot collide. What
   * must not regress is the message being actionable rather than raw constraint text.
   */
  it('surfaces a name-clash message from inside a generated spec', async () => {
    state.rpc = { data: null, error: UNIQUE_VIOLATION };
    await expect(
      materializeLocationSpec('co1', null, [
        { key: '0', name: 'Row 1', kind: 'row', children: [] },
      ]),
    ).rejects.toThrow(/already a location with that name in the same place/i);
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

  it('excludes archived parts, like the board does', async () => {
    queueFrom({ data: [], error: null, count: 0 });
    await getLocationContentsPage('un');
    expect(String(state.calls[0].select?.[0])).toContain('!inner');
    expect(state.calls[0].is).toEqual(['part.deleted_at', null]);
    // No `quantity > 0`: since 20260802144310 a row at this bin IS stock at this bin, so the
    // filter and the CHECK would be saying the same thing in two places.
    expect(state.calls[0].gt).toBeUndefined();
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
  /**
   * The inverse of what this used to assert.
   *
   * It pinned `gt('quantity', 0)` — a filter that hid the residue `transfer_stock` and
   * `bulk_put_away` left behind. 20260802144310 deleted that residue and added
   * `CHECK (quantity > 0)`, so a row existing and the part being there are the same fact and the
   * filter would only restate the constraint. Asserting its ABSENCE is what stops someone
   * reintroducing it and quietly re-establishing the two-sources-of-truth split.
   */
  it('does not filter zero rows, because the table can no longer hold one', async () => {
    queueFrom({ data: [loc({ id: 'l1' })], error: null }, { data: [], error: null });
    await getBalancesForParts('co1', ['p0']);
    expect(state.calls[1].gt).toBeUndefined();
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

/**
 * The chunk size is a transport limit, and it was wrong by more than double.
 *
 * Measured against the local PostgREST gateway with real UUIDs on 2026-08-01: 200 ids returns
 * 200 OK, 220 returns **414 URI Too Long**. The old value was 500, with a comment claiming it
 * kept the list "well inside PostgREST's URL limits" — so any shop with more than ~200 stocked
 * parts got a hard 414 on every chunk. Contour has 9,428.
 */
describe('ID_CHUNK', () => {
  it('stays under the measured 414 threshold, with headroom', () => {
    expect(ID_CHUNK).toBeLessThanOrEqual(200);
    // Not so small that a real catalogue becomes hundreds of round trips.
    expect(ID_CHUNK).toBeGreaterThanOrEqual(100);
  });

  it('is what getBalancesForParts actually chunks by', async () => {
    const ids = Array.from({ length: ID_CHUNK + 1 }, (_, i) => 'p' + i);
    // locations + two chunks (the second holds the one leftover id).
    queueFrom(
      { data: [loc({ id: 'l1' })], error: null },
      { data: [], error: null },
      { data: [], error: null },
    );

    await getBalancesForParts('co1', ids);

    const inCalls = state.calls.filter((c) => c.in).map((c) => (c.in as [string, string[]])[1]);
    expect(inCalls).toHaveLength(2);
    expect(inCalls[0]).toHaveLength(ID_CHUNK);
    expect(inCalls[1]).toHaveLength(1);
  });
});
