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
  adjustPartStock: vi.fn(),
}));
vi.mock('@/utils/inventoryLocationsAccess', () => ({
  adjustStockAtLocation: vi.fn(),
  getLocations: vi.fn(),
}));
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({}),
  getTypedSupabase: () => ({}),
}));

import { commitCount } from '@/utils/inventoryCountAccess';
import { adjustPartStock } from '@/utils/partsAccess';
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
  magnitude: 1,
});

beforeEach(() => {
  vi.clearAllMocks();
  asMock(adjustPartStock).mockResolvedValue({});
  asMock(adjustStockAtLocation).mockResolvedValue({});
});

describe('commitCount routing', () => {
  it('writes an untracked part through the aggregate path', async () => {
    await commitCount([variance('p1', 38, { kind: 'aggregate' }, 40)]);

    expect(adjustPartStock).toHaveBeenCalledTimes(1);
    expect(adjustPartStock).toHaveBeenCalledWith(
      'p1',
      38,
      'ft',
      'Stock count — counted 38 ft (system said 40 ft)',
    );
    expect(adjustStockAtLocation).not.toHaveBeenCalled();
  });

  it('writes a tracked part at its location, never to parts.quantity', async () => {
    await commitCount([
      variance('p2', 12, { kind: 'location', locationId: 'loc-a', locationName: 'Shelf A' }, 10),
    ]);

    expect(adjustStockAtLocation).toHaveBeenCalledWith(
      'p2',
      'loc-a',
      12,
      'ft',
      'Stock count — counted 12 ft (system said 10 ft)',
    );
    // The direct write would be rejected by enforce_tracked_part_quantity — we must not try.
    expect(adjustPartStock).not.toHaveBeenCalled();
  });

  it('routes a mixed batch to both paths', async () => {
    await commitCount([
      variance('p1', 5, { kind: 'aggregate' }),
      variance('p2', 6, { kind: 'location', locationId: 'loc-a', locationName: 'A' }),
    ]);
    expect(adjustPartStock).toHaveBeenCalledTimes(1);
    expect(adjustStockAtLocation).toHaveBeenCalledTimes(1);
  });
});

describe('commitCount resilience', () => {
  it('keeps going after a failed line — a committed count is a real observation', async () => {
    asMock(adjustPartStock)
      .mockRejectedValueOnce(new Error('network died'))
      .mockResolvedValueOnce({});

    const result = await commitCount([
      variance('p1', 1, { kind: 'aggregate' }),
      variance('p2', 2, { kind: 'aggregate' }),
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
    expect(adjustPartStock).not.toHaveBeenCalled();
    expect(adjustStockAtLocation).not.toHaveBeenCalled();
  });

  it('reports progress per line and finishes at total', async () => {
    const seen: string[] = [];
    await commitCount(
      [variance('p1', 1, { kind: 'aggregate' }), variance('p2', 2, { kind: 'aggregate' })],
      (p) => seen.push(`${p.done}/${p.total}:${p.currentPartName}`),
    );
    expect(seen).toEqual(['0/2:P1', '1/2:P2', '2/2:']);
  });
});
