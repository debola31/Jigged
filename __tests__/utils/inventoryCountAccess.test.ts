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
  getTypedSupabase: () => sbMock,
}));

import { commitCount, loadPartAtLocationCandidate } from '@/utils/inventoryCountAccess';
import { adjustStockAtLocation } from '@/utils/inventoryLocationsAccess';
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
      variance('p2', 12, { kind: 'location', locationId: 'loc-a', locationName: 'Shelf A' }, 10),
    ]);

    expect(adjustStockAtLocation).toHaveBeenCalledWith(
      'p2',
      'loc-a',
      12,
      'ft',
      { notes: 'Inventory count — counted 12 ft (recorded as 10 ft)' },
    );
  });

  it('sends every line of a batch to its own place', async () => {
    await commitCount([
      variance('p1', 5, { kind: 'location', locationId: 'loc-unassigned', locationName: 'Unassigned' }),
      variance('p2', 6, { kind: 'location', locationId: 'loc-a', locationName: 'A' }),
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
      variance('p1', 1, { kind: 'location', locationId: 'loc-a', locationName: 'A' }),
      variance('p2', 2, { kind: 'location', locationId: 'loc-b', locationName: 'B' }),
    ]);

    expect(result.committed).toBe(1);
    expect(result.failures).toEqual([{ partName: 'P1', message: 'network died' }]);
  });

  it('reports an excluded line as a failure rather than guessing a destination', async () => {
    const result = await commitCount([
      variance('p3', 9, { kind: 'excluded', reason: 'split across bins' }),
    ]);
    expect(result.committed).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(adjustStockAtLocation).not.toHaveBeenCalled();
  });

  it('reports progress per line and finishes at total', async () => {
    const seen: string[] = [];
    await commitCount(
      [
        variance('p1', 1, { kind: 'location', locationId: 'loc-a', locationName: 'A' }),
        variance('p2', 2, { kind: 'location', locationId: 'loc-b', locationName: 'B' }),
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
    expect(c.target).toEqual({ kind: 'location', locationId: 'l1', locationName: 'Shelf A' });
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
      [variance('p1', 5, { kind: 'location', locationId: 'loc-a', locationName: 'Shelf A' })],
      { operatorId: 'member-1' },
    );

    const opts = asMock(adjustStockAtLocation).mock.calls[0].at(-1);
    expect(opts.operatorId).toBe('member-1');
  });
});
