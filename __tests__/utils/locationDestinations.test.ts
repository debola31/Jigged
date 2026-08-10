/**
 * Which locations may be offered as a destination.
 *
 * The case that earns its keep is the container. Before 20260806160053 every picker in the app
 * offered a cabinet made only of Side 1 and Side 2 as somewhere to put a part, and the database
 * now refuses that write — so an unfiltered option list turns into an error dialog on a choice the
 * user should never have been shown. These assertions are what keep the guard invisible.
 *
 * The second case is the asymmetry: a container is exactly what a MOVE wants and exactly what a
 * STOCK write must not have. Both rules are exercised against the same tree so the difference is
 * visible in one read.
 */
import { describe, it, expect } from 'vitest';

import { stockDestinationOptions, locationParentOptions } from '@/utils/locationDestinations';
import { rollUpOccupancy } from '@/utils/locationOccupancy';
import type { InventoryLocation, InventoryLocationNode } from '@/types/inventoryLocations';

/** The seed's shape: Cabinet 3 › Shelf A / Shelf B, plus a bare Yard and the put-away pile. */
const loc = (
  id: string,
  name: string,
  parent_id: string | null = null,
  kind: string | null = null,
): InventoryLocation =>
  ({
    id,
    company_id: 'co1',
    parent_id,
    name,
    kind,
    sort_order: 0,
    created_at: '',
    updated_at: '',
  }) as InventoryLocation;

const CABINET = loc('cabinet', 'Cabinet 3');
const SHELF_A = loc('shelf-a', 'Shelf A', 'cabinet');
const SHELF_B = loc('shelf-b', 'Shelf B', 'cabinet');
const YARD = loc('yard', 'Yard');
const PILE = loc('pile', 'Unassigned', null, 'system');

const TREE = [CABINET, SHELF_A, SHELF_B, YARD, PILE];

const ids = (options: { id: string }[]) => options.map((o) => o.id);

describe('stockDestinationOptions', () => {
  it('never offers a location that has sub-locations', () => {
    const options = stockDestinationOptions(TREE);

    expect(ids(options)).not.toContain('cabinet');
    expect(ids(options)).toEqual(expect.arrayContaining(['shelf-a', 'shelf-b', 'yard']));
  });

  it('never offers the put-away pile', () => {
    expect(ids(stockDestinationOptions(TREE))).not.toContain('pile');
  });

  it('excludes the source location', () => {
    expect(ids(stockDestinationOptions(TREE, { excludeId: 'shelf-a' }))).not.toContain('shelf-a');
  });

  it('labels each option with its full path, so "Shelf A" is never ambiguous', () => {
    const shelf = stockDestinationOptions(TREE).find((o) => o.id === 'shelf-a');
    expect(shelf?.label).toBe('Cabinet 3 › Shelf A');
  });

  it('sorts places already holding some of the part first', () => {
    const options = stockDestinationOptions(TREE, {
      balances: [{ location_id: 'yard', quantity: 12 } as never],
    });

    expect(ids(options)[0]).toBe('yard');
    expect(options[0].quantity).toBe(12);
  });

  it('turns a leaf into a container the moment it gains a child', () => {
    // The regression this guards: subdividing Shelf A must stop it being offered, without any
    // caller remembering to re-derive anything.
    const subdivided = [...TREE, loc('bin-1', 'Bin 1', 'shelf-a')];

    expect(ids(stockDestinationOptions(subdivided))).not.toContain('shelf-a');
    expect(ids(stockDestinationOptions(subdivided))).toContain('bin-1');
  });
});

describe('locationParentOptions', () => {
  /** Stock on Shelf B only — so Cabinet 3 rolls up as occupied while holding nothing itself. */
  const occupancy = rollUpOccupancy(
    [
      {
        ...CABINET,
        depth: 0,
        children: [
          { ...SHELF_A, depth: 1, children: [] } as InventoryLocationNode,
          { ...SHELF_B, depth: 1, children: [] } as InventoryLocationNode,
        ],
      } as InventoryLocationNode,
      { ...YARD, depth: 0, children: [] } as InventoryLocationNode,
    ],
    new Map([['shelf-b', 3]]),
  );

  it('offers a container — which is the whole point of a move', () => {
    // The opposite answer to stockDestinationOptions on the same node, which is why these are two
    // functions rather than one with a flag.
    expect(ids(locationParentOptions(TREE, { nodeId: 'yard', occupancy }))).toContain('cabinet');
    expect(ids(stockDestinationOptions(TREE))).not.toContain('cabinet');
  });

  it('drops a location that holds stock directly, since it could never become a parent', () => {
    expect(ids(locationParentOptions(TREE, { nodeId: 'yard', occupancy }))).not.toContain('shelf-b');
  });

  it('keeps a container whose stock is all in its children', () => {
    // Rolled-up occupancy would exclude Cabinet 3 here and wrongly empty the list on a real shop.
    expect(ids(locationParentOptions(TREE, { nodeId: 'yard', occupancy }))).toContain('cabinet');
  });

  it('excludes the node itself and everything under it', () => {
    const options = ids(locationParentOptions(TREE, { nodeId: 'cabinet', occupancy }));

    expect(options).not.toContain('cabinet');
    expect(options).not.toContain('shelf-a');
    expect(options).not.toContain('shelf-b');
  });

  it('never offers the put-away pile', () => {
    expect(ids(locationParentOptions(TREE, { nodeId: 'yard', occupancy }))).not.toContain('pile');
  });
});

/**
 * Natural order, on the picker that made it matter.
 *
 * A 12 × 15 cabinet puts 180 bins in one Move list. Sorted by plain `localeCompare` that reads
 * `Bin 1, Bin 10, Bin 11, … Bin 2`, and the has-stock-first grouping has to survive the fix.
 */
describe('natural ordering', () => {
  it('orders bins by number, not by character', () => {
    const locs = [
      loc('cab', 'Cabinet 1'),
      loc('b1', 'Bin 1', 'cab'),
      loc('b10', 'Bin 10', 'cab'),
      loc('b2', 'Bin 2', 'cab'),
    ];
    expect(stockDestinationOptions(locs).map((o) => o.label)).toEqual([
      'Cabinet 1 › Bin 1',
      'Cabinet 1 › Bin 2',
      'Cabinet 1 › Bin 10',
    ]);
  });

  it('still puts places already holding some of this part first', () => {
    const locs = [loc('cab', 'Cabinet 1'), loc('b1', 'Bin 1', 'cab'), loc('b10', 'Bin 10', 'cab')];
    const options = stockDestinationOptions(locs, {
      balances: [
        { location_id: 'b10', quantity: 4 },
      ] as unknown as Parameters<typeof stockDestinationOptions>[1]['balances'],
    });
    // Bin 10 sorts after Bin 1 by name, but holding stock outranks the name.
    expect(options.map((o) => o.label)).toEqual(['Cabinet 1 › Bin 10', 'Cabinet 1 › Bin 1']);
  });
});
