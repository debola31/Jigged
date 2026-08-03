/**
 * Occupancy roll-up.
 *
 * The test that earns its keep is the cabinet-holds-nothing case. The view reports only what
 * sits DIRECTLY at a location, so a cabinet whose shelves are full has no row at all. Reporting
 * it as empty would be worse than showing no fill state: it would tell an owner to put material
 * somewhere already occupied. The seed contains exactly this shape (Cabinet 3 › Shelf A/B).
 */
import { describe, it, expect } from 'vitest';
import { rollUpOccupancy, occupancyFor } from '@/utils/locationOccupancy';
import type { InventoryLocationNode } from '@/types/inventoryLocations';

/** Minimal node — the roll-up only reads `id` and `children`. */
const node = (
  id: string,
  children: InventoryLocationNode[] = [],
  depth = 0,
): InventoryLocationNode =>
  ({
    id,
    company_id: 'co1',
    parent_id: null,
    name: id,
    kind: null,
    code: null,
    sort_order: 0,
    created_at: '',
    updated_at: '',
    children,
    depth,
  }) as InventoryLocationNode;

describe('rollUpOccupancy', () => {
  it('reports a container as occupied when only its children hold stock', () => {
    const shelfA = node('shelf-a');
    const shelfB = node('shelf-b');
    const cabinet = node('cabinet', [shelfA, shelfB]);

    const map = rollUpOccupancy([cabinet], new Map([['shelf-a', 2], ['shelf-b', 1]]));

    const cab = occupancyFor(map, 'cabinet');
    expect(cab.directParts).toBe(0);
    expect(cab.totalParts).toBe(3);
    expect(cab.hasStock).toBe(true);
    // The distinction the sheet's wording depends on.
    expect(cab.stockedBelow).toBe(true);
  });

  it('does not set stockedBelow when the node holds stock itself', () => {
    const shelf = node('shelf');
    const cabinet = node('cabinet', [shelf]);
    const map = rollUpOccupancy([cabinet], new Map([['cabinet', 1], ['shelf', 2]]));

    expect(occupancyFor(map, 'cabinet')).toMatchObject({
      directParts: 1,
      totalParts: 3,
      hasStock: true,
      stockedBelow: false,
    });
  });

  it('sums through more than one level', () => {
    const bin = node('bin');
    const shelf = node('shelf', [bin]);
    const cabinet = node('cabinet', [shelf]);
    const map = rollUpOccupancy([cabinet], new Map([['bin', 5]]));

    expect(occupancyFor(map, 'cabinet').totalParts).toBe(5);
    expect(occupancyFor(map, 'shelf').totalParts).toBe(5);
    expect(occupancyFor(map, 'bin').directParts).toBe(5);
  });

  it('keeps siblings independent', () => {
    const full = node('full');
    const empty = node('empty');
    const map = rollUpOccupancy([full, empty], new Map([['full', 3]]));

    expect(occupancyFor(map, 'full').hasStock).toBe(true);
    expect(occupancyFor(map, 'empty').hasStock).toBe(false);
  });

  it('marks a genuinely empty tree empty at every level', () => {
    const shelf = node('shelf');
    const map = rollUpOccupancy([node('cabinet', [shelf])], new Map());

    expect(occupancyFor(map, 'cabinet')).toMatchObject({ hasStock: false, stockedBelow: false });
    expect(occupancyFor(map, 'shelf').hasStock).toBe(false);
  });

  it('covers every node in the tree, not just the occupied ones', () => {
    const map = rollUpOccupancy([node('a', [node('b')]), node('c')], new Map([['b', 1]]));
    expect([...map.keys()].sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('occupancyFor', () => {
  // An unknown location and an empty one are the same thing to a board. Making callers
  // remember that is how a `?.hasStock` slips through reading as "empty".
  it('returns zeros for a location the map has never heard of', () => {
    expect(occupancyFor(new Map(), 'nope')).toEqual({
      directParts: 0,
      totalParts: 0,
      hasStock: false,
      stockedBelow: false,
    });
  });
});
