/**
 * Count commit — routing and failure handling.
 *
 * What is NOT covered here, deliberately: the DB-enforced invariants the commit delegates to
 * Postgres. `enforce_tracked_part_quantity` rejecting a direct parts.quantity write on a
 * tracked part, and `recompute_part_quantity_from_locations` rolling the balance back up, are
 * not mockable — they're validated by the migration applying and by the manual pass in the
 * plan's verification section. What is covered is that we never *ask* for the illegal write.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/utils/partsAccess', () => ({
  getStockedParts: vi.fn(),
}));
vi.mock('@/utils/inventoryLocationsAccess', () => ({
  adjustStockAtLocation: vi.fn(),
  getBalancesForParts: vi.fn(),
  getLocations: vi.fn(),
}));
/**
 * A chainable stub rather than `{}`: `loadPartAtLocationCandidate` and
 * `refreshLocationQuantities` both go through `.from()`, and each test queues the results its
 * reads should see, in order.
 */
const { sbState, sbMock } = vi.hoisted(() => {
  type Result = { data: unknown; error: unknown };
  const st: { queue: Result[]; calls: Record<string, unknown[]>[] } = { queue: [], calls: [] };
  const builder = (result: Result) => {
    const b: Record<string, unknown> = {};
    const seen: Record<string, unknown[]> = {};
    st.calls.push(seen);
    ['select', 'eq', 'in', 'is', 'gt', 'order', 'limit', 'range', 'maybeSingle', 'single'].forEach(
      (m) => {
        b[m] = vi.fn((...args: unknown[]) => {
          seen[m] = args;
          return b;
        });
      },
    );
    b.then = (resolve: (v: unknown) => unknown) => resolve(result);
    return b;
  };
  return {
    sbState: st,
    sbMock: { from: vi.fn(() => builder(st.queue.shift() ?? { data: null, error: null })) },
  };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => sbMock,
}));

import {
  commitCount,
  loadCountCandidates,
  loadPartAtLocationCandidate,
} from '@/utils/inventoryCountAccess';
import { getStockedParts } from '@/utils/partsAccess';
import {
  adjustStockAtLocation,
  getBalancesForParts,
  getLocations,
} from '@/utils/inventoryLocationsAccess';
import type { CountVariance } from '@/types/inventoryCount';

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const variance = (
  partId: string,
  counted: number,
  target: CountVariance['candidate']['target'],
  systemQuantity = 0,
): CountVariance => ({
  candidate: { partId, partName: partId.toUpperCase(), description: null, unit: 'ft', systemQuantity, target },
  counted,
  delta: counted - systemQuantity,
  movedSinceOpened: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  sbState.queue = [];
  sbState.calls = [];
  asMock(adjustStockAtLocation).mockResolvedValue({});
});

/**
 * There is one write path, not two. The `aggregate` target — write `parts.quantity` via
 * `adjustPartStock` for a part not tracked by place — was deleted in 20260802015837 along with
 * `is_location_tracked` and the four aggregate writers themselves. `parts.quantity` is now a
 * trigger-maintained rollup that rejects direct writes, so there is nothing left to route to.
 */
describe('commitCount routing', () => {
  it('writes a counted part at its location', async () => {
    await commitCount([
      variance('p2', 12, { locationId: 'loc-a', locationName: 'Shelf A', locationPath: 'Shelf A' }, 10),
    ]);

    expect(adjustStockAtLocation).toHaveBeenCalledWith(
      'p2',
      'loc-a',
      12,
      'ft',
      { notes: 'Inventory count at Shelf A — counted 12 ft (recorded as 10 ft)' },
    );
  });

  it('sends every line of a batch to its own place', async () => {
    await commitCount([
      variance('p1', 5, { locationId: 'loc-unassigned', locationName: 'Unassigned', locationPath: 'Unassigned' }),
      variance('p2', 6, { locationId: 'loc-a', locationName: 'A', locationPath: 'A' }),
    ]);
    expect(adjustStockAtLocation).toHaveBeenCalledTimes(2);
    expect(asMock(adjustStockAtLocation).mock.calls.map((c) => c[1])).toEqual([
      'loc-unassigned',
      'loc-a',
    ]);
  });
});

describe('commitCount resilience', () => {
  it('keeps going after a failed line — a committed count is a real observation', async () => {
    asMock(adjustStockAtLocation)
      .mockRejectedValueOnce(new Error('network died'))
      .mockResolvedValueOnce({});

    const result = await commitCount([
      variance('p1', 1, { locationId: 'loc-a', locationName: 'A', locationPath: 'A' }),
      variance('p2', 2, { locationId: 'loc-b', locationName: 'B', locationPath: 'B' }),
    ]);

    expect(result.committed).toBe(1);
    // The place is named because one part can occupy several lines: "P1 could not be saved"
    // doesn't tell someone which of three numbers to re-enter.
    expect(result.failures).toEqual([
      { partName: 'P1', locationName: 'A', message: 'network died' },
    ]);
  });

  it('reports progress per line and finishes at total', async () => {
    const seen: string[] = [];
    await commitCount(
      [
        variance('p1', 1, { locationId: 'loc-a', locationName: 'A', locationPath: 'A' }),
        variance('p2', 2, { locationId: 'loc-b', locationName: 'B', locationPath: 'B' }),
      ],
      { onProgress: (p) => seen.push(`${p.done}/${p.total}:${p.currentPartName}`) },
    );
    expect(seen).toEqual(['0/2:P1', '1/2:P2', '2/2:']);
  });
});

/**
 * "Count here" from the part page. The interesting case is the one the ordinary bin read cannot
 * reach: the system says zero, and you are standing there holding twelve.
 */
describe('loadPartAtLocationCandidate', () => {
  const part = (over: Record<string, unknown> = {}) => ({
    id: 'p1',
    part_name: 'RAW-AL6061-BLANK',
    description: 'Aluminium blank',
    primary_unit: 'ea',
    ...over,
  });

  it('reads the balance rather than assuming zero', async () => {
    sbState.queue = [
      { data: part(), error: null },
      { data: [{ part_id: 'p1', quantity: 12 }], error: null },
    ];

    const c = await loadPartAtLocationCandidate('co1', 'p1', 'l1', 'Shelf A');

    expect(c.systemQuantity).toBe(12);
    expect(c.target).toEqual({ locationId: 'l1', locationName: 'Shelf A', locationPath: 'Shelf A' });
  });

  /**
   * The row `getLocationContentsPage` filters away with `.gt('quantity', 0)`, which is exactly
   * why this loader exists. Zero must survive so a real count can correct it.
   */
  it('still returns a candidate when the part has no balance here', async () => {
    sbState.queue = [{ data: part(), error: null }, { data: [], error: null }];

    const c = await loadPartAtLocationCandidate('co1', 'p1', 'l1', 'Shelf A');
    expect(c.systemQuantity).toBe(0);
  });

  /** Archive is a soft delete; a by-id read that ignores it resurrects deleted parts. */
  it('scopes the read to the company and skips archived parts', async () => {
    sbState.queue = [{ data: part(), error: null }, { data: [], error: null }];
    await loadPartAtLocationCandidate('co1', 'p1', 'l1', 'Shelf A');

    const read = sbState.calls[0];
    expect(read.eq).toBeDefined();
    expect(read.is).toEqual(['deleted_at', null]);
  });

  it('says so when the part is gone', async () => {
    sbState.queue = [{ data: null, error: null }];
    await expect(loadPartAtLocationCandidate('co1', 'p1', 'l1', 'Shelf A')).rejects.toThrow(
      /no longer exists/i,
    );
  });

  /*
   * The guard that used to live here — refuse a part with `is_location_tracked = false`, naming
   * it — went with the column in 20260802015837. Every part is countable at every place now, so
   * there is no state for it to refuse.
   */
});

describe('commitCount attribution', () => {
  /** A count is a human assertion about a shelf, so the ledger has to say whose. */
  it('threads the operator onto every place-scoped line', async () => {
    await commitCount(
      [variance('p1', 5, { locationId: 'loc-a', locationName: 'Shelf A', locationPath: 'Shelf A' })],
      { operatorId: 'member-1' },
    );

    const opts = asMock(adjustStockAtLocation).mock.calls[0].at(-1);
    expect(opts.operatorId).toBe('member-1');
  });
});

/**
 * The company-wide sheet's row rule — one row per (part, place).
 *
 * This function had **no test at all** before PR B, and it is the one the row rule lives in. Both
 * of its plausible-but-wrong forms fail silently rather than throwing: sourcing straight from
 * `getBalancesForParts` (which filters `quantity > 0`) makes a part holding stock nowhere vanish
 * from the sheet, and emitting a row per balance ROW fills the sheet with the zero residue that
 * `transfer_stock` and `bulk_put_away` leave behind forever. Neither shows up as an error — one
 * is a shorter list, the other a longer one.
 */
describe('loadCountCandidates — one row per (part, place)', () => {
  const SYSTEM = { id: 'loc-unassigned', name: 'Unassigned', kind: 'system' };
  const SHELF_A = { id: 'loc-a', name: 'Shelf A', kind: 'shelf' };
  const SHELF_B = { id: 'loc-b', name: 'Shelf B', kind: 'shelf' };

  const part = (id: string, name: string) => ({
    id,
    part_name: name,
    description: null,
    primary_unit: 'ea',
    quantity: 0,
  });

  const bal = (locationId: string, locationName: string, quantity: number, path: string[] = []) => ({
    locationId,
    locationName,
    path,
    quantity,
  });

  beforeEach(() => {
    asMock(getLocations).mockResolvedValue([SYSTEM, SHELF_A, SHELF_B]);
  });

  it("emits one row per place holding stock, each carrying THAT place's balance", async () => {
    asMock(getStockedParts).mockResolvedValue([part('p1', 'BUY-ORING-214')]);
    asMock(getBalancesForParts).mockResolvedValue(
      new Map([['p1', [bal('loc-a', 'Shelf A', 800), bal('loc-b', 'Shelf B', 28)]]]),
    );

    const rows = await loadCountCandidates('co1');

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.target.locationId, r.systemQuantity])).toEqual([
      ['loc-a', 800],
      ['loc-b', 28],
    ]);
    // Never the company-wide roll-up — that is what made the old sheet write a shop total to
    // one bin.
    expect(rows.every((r) => r.systemQuantity !== 828)).toBe(true);
  });

  /**
   * The opening count. `trg_auto_track_stocked_part` seeds every stocked part at Unassigned with
   * 0, and `getBalancesForParts` filters those out — so without the fallback the entire catalogue
   * of a shop counting for the first time would be missing from its own count sheet.
   */
  it('still emits a row for a part holding stock nowhere, at the system bucket', async () => {
    asMock(getStockedParts).mockResolvedValue([part('p2', 'BRAND-NEW')]);
    asMock(getBalancesForParts).mockResolvedValue(new Map());

    const rows = await loadCountCandidates('co1');

    expect(rows).toHaveLength(1);
    expect(rows[0].target.locationId).toBe('loc-unassigned');
    expect(rows[0].systemQuantity).toBe(0);
  });

  /**
   * The residue: `transfer_stock` decrements and `bulk_put_away` sets 0 rather than deleting, so
   * a bin a part has left keeps a row forever. Rendering it would put a live absolute write
   * target on the wrong shelf.
   */
  it('never emits a row for a place the part has left', async () => {
    asMock(getStockedParts).mockResolvedValue([part('p1', 'BUY-ORING-214')]);
    // getBalancesForParts already filters `> 0`; assert we do not add the ghost back.
    asMock(getBalancesForParts).mockResolvedValue(new Map([['p1', [bal('loc-a', 'Shelf A', 800)]]]));

    const rows = await loadCountCandidates('co1');

    expect(rows).toHaveLength(1);
    expect(rows[0].target.locationId).toBe('loc-a');
  });

  /** Two bins can share a leaf name, so the path is what tells the rows apart. */
  it("carries the full ancestor path as the row's label", async () => {
    asMock(getStockedParts).mockResolvedValue([part('p1', 'BUY-ORING-214')]);
    asMock(getBalancesForParts).mockResolvedValue(
      new Map([['p1', [bal('loc-a', 'Shelf A', 5, ['Cabinet 3'])]]]),
    );

    const rows = await loadCountCandidates('co1');
    expect(rows[0].target.locationPath).toBe('Cabinet 3 › Shelf A');
  });

  it('throws rather than quietly shortening the sheet when there is no system bucket', async () => {
    asMock(getLocations).mockResolvedValue([SHELF_A]);
    asMock(getStockedParts).mockResolvedValue([part('p2', 'BRAND-NEW')]);
    asMock(getBalancesForParts).mockResolvedValue(new Map());

    await expect(loadCountCandidates('co1')).rejects.toThrow(/Unassigned/i);
  });
});
