import { describe, it, expect } from 'vitest';
import { compareLocationNames, computePathNames } from '@/lib/locationTree';
import type { InventoryLocation } from '@/types/inventoryLocations';

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

/**
 * The comparator exists because a shop built a 12 × 15 cabinet: 180 bins in one Move picker, sorted
 * `Bin 1, Bin 10, Bin 11, … Bin 2`. Plain `localeCompare` is character-by-character, so anything
 * past nine sorts into the middle of the run.
 */
describe('compareLocationNames', () => {
  const sorted = (names: string[]) => [...names].sort(compareLocationNames);

  it('orders numbered names by magnitude, not by character', () => {
    expect(sorted(['Bin 10', 'Bin 2', 'Bin 1', 'Bin 15'])).toEqual([
      'Bin 1',
      'Bin 2',
      'Bin 10',
      'Bin 15',
    ]);
  });

  it('crosses the ten boundary in both directions', () => {
    expect(compareLocationNames('Row 9', 'Row 10')).toBeLessThan(0);
    expect(compareLocationNames('Row 10', 'Row 9')).toBeGreaterThan(0);
  });

  /**
   * Real shop data: `Metal Shelf By Welder`'s rows are split Left / Center / Right, and nothing in
   * those names is numeric. They must keep sorting alphabetically rather than becoming arbitrary.
   */
  it('leaves unnumbered names alphabetical', () => {
    expect(sorted(['Right', 'Left', 'Center'])).toEqual(['Center', 'Left', 'Right']);
  });

  /**
   * Matches the sibling-name unique index, which is on `lower(btrim(name))` — two names the
   * database considers the same must never sort apart.
   */
  it('folds case, like the uniqueness rule does', () => {
    expect(compareLocationNames('shelf a', 'Shelf A')).toBe(0);
  });

  /**
   * Several call sites compare a joined path (`Cabinet 1 › Row 2 › Left`) rather than a bare name.
   * `numeric` applies per digit-run wherever it falls, so a deep segment still orders correctly.
   */
  it('orders joined paths on the segment that actually differs', () => {
    expect(
      sorted([
        'Cabinet 1 › Row 10 › Left',
        'Cabinet 1 › Row 2 › Left',
        'Cabinet 1 › Row 2 › Center',
      ]),
    ).toEqual([
      'Cabinet 1 › Row 2 › Center',
      'Cabinet 1 › Row 2 › Left',
      'Cabinet 1 › Row 10 › Left',
    ]);
  });

  it('is a total order — equal names compare equal', () => {
    expect(compareLocationNames('Bin 3', 'Bin 3')).toBe(0);
  });
});

describe('computePathNames', () => {
  it('walks root → leaf', () => {
    const byId = new Map([
      ['cab', loc({ id: 'cab', name: 'Cabinet 1' })],
      ['row', loc({ id: 'row', name: 'Row 3', parent_id: 'cab' })],
      ['bin', loc({ id: 'bin', name: 'Bin 5', parent_id: 'row' })],
    ]);
    expect(computePathNames('bin', byId)).toEqual(['Cabinet 1', 'Row 3', 'Bin 5']);
  });

  /**
   * The cycle guard is the reason this walk is shared rather than hand-rolled a fifth time —
   * re-parenting can produce a loop, and every private copy had to remember to break it.
   */
  it('stops on a cycle instead of hanging', () => {
    const byId = new Map([
      ['a', loc({ id: 'a', name: 'A', parent_id: 'b' })],
      ['b', loc({ id: 'b', name: 'B', parent_id: 'a' })],
    ]);
    expect(computePathNames('a', byId)).toEqual(['B', 'A']);
  });

  it('returns nothing for a location the map does not hold', () => {
    expect(computePathNames('ghost', new Map())).toEqual([]);
  });
});
