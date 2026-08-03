/**
 * Pure (DB-free) roll-up of per-location occupancy onto the location tree.
 *
 * The `inventory_location_occupancy` view reports what sits DIRECTLY at each location. A board
 * needs more than that: a cabinet that holds nothing itself but whose shelves are full is not
 * empty, and reporting it as empty is the one thing that would make the fill state worse than
 * no fill state — it would tell an owner to put material somewhere that is already occupied.
 *
 * So this walks the tree once and gives every node both figures. Sibling of `locationSpec.ts`:
 * decisions live in pure functions, the network driver only fetches.
 *
 * **Occupancy is a count of distinct parts, never a quantity.** Quantities at one location are
 * per-part in each part's own primary unit, so 40 bearings + 3 castings sums to nothing
 * meaningful. See the view's own comment.
 */
import type { InventoryLocationNode } from '@/types/inventoryLocations';

export interface Occupancy {
  /** Distinct live parts recorded directly at this node. */
  directParts: number;
  /** `directParts` plus every descendant's. What "is this thing occupied?" means. */
  totalParts: number;
  /** The board's fill state: anything here or anywhere inside it. */
  hasStock: boolean;
  /**
   * Empty itself, but something inside it isn't.
   *
   * Drives the honest sheet line — "nothing here directly · 3 parts in sub-locations" — rather
   * than a bare "3" that reads as though the cabinet's own shelf were loaded.
   */
  stockedBelow: boolean;
}

export type OccupancyMap = ReadonlyMap<string, Occupancy>;

const EMPTY: Occupancy = {
  directParts: 0,
  totalParts: 0,
  hasStock: false,
  stockedBelow: false,
};

/**
 * Occupancy for every node in the tree, keyed by location id.
 *
 * `directPartCounts` comes from the view and contains ONLY occupied locations — an absent key
 * means empty, which is why every lookup goes through `occupancyFor`.
 */
export function rollUpOccupancy(
  roots: InventoryLocationNode[],
  directPartCounts: ReadonlyMap<string, number>,
): OccupancyMap {
  const out = new Map<string, Occupancy>();

  // Returns the subtree total so a parent can sum its children in one pass.
  const visit = (node: InventoryLocationNode): number => {
    const directParts = directPartCounts.get(node.id) ?? 0;
    let totalParts = directParts;
    for (const child of node.children) totalParts += visit(child);

    out.set(node.id, {
      directParts,
      totalParts,
      hasStock: totalParts > 0,
      stockedBelow: totalParts > 0 && directParts === 0,
    });
    return totalParts;
  };

  for (const root of roots) visit(root);
  return out;
}

/**
 * Occupancy for a location, zero-valued when absent.
 *
 * Exists so render code never branches on `undefined` — an unknown location and an empty one
 * are the same thing to a board, and making callers remember that is how a `?.hasStock` slips
 * through as "empty".
 */
export function occupancyFor(map: OccupancyMap, locationId: string): Occupancy {
  return map.get(locationId) ?? EMPTY;
}
