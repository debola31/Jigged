/**
 * Read a storage unit's subtree as something drawable — the shape behind the Storage grid.
 *
 * ## Why this exists
 *
 * The operator's model of his cabinet is spatial: *"three rows down, five slots over."* The UI was
 * a single-open-branch accordion, and at the scale he actually built — 237 locations, 216 of them
 * leaves, 180 in one cabinet — that is a wall of text pretending to be furniture.
 *
 * Drawing it needs one question answered: **given a subtree, what is a row and what is a cell?**
 * Answering it here, once and without a network, is what keeps every component free of depth
 * checks. `UnitGridView` renders whatever comes back; it never asks how deep anything is.
 *
 * ## The rule
 *
 * **A grid is read from the unit's children: every child becomes a BAND.**
 *
 *   * child is a leaf                    → a band holding one cell, which is the child itself
 *   * child's own children are all leaves → a band whose cells are those children
 *
 * That single rule covers every shape in production, which is why it is stated this way rather
 * than as "the unit and its grandchildren":
 *
 * | Levels | Real example | Reads as |
 * |---|---|---|
 * | 2 | `Cabinet by Mill/Lathe` › Row 1–10 | 10 bands of one cell — a vertical stack of shelves, which is what it physically is |
 * | 3 | `Form Tool Cabinet` › Row 1–12 › Bin 1–15 | 12 bands of 15 cells — the grid |
 * | 3, ragged | `Metal Shelf By Welder` — rows 1–5 bare, 6–10 split Left/Center/Right | 5 bands of one cell beside 5 bands of three. Drawn as it is, not forced square |
 * | 4 | `Cabinet › Side › Row › Bin` | Sections: pick the side, then the identical grid |
 *
 * Nothing at Contour is 4 levels today, but a cabinet with a side *and* a level *and* a slot is,
 * and it is expected to turn up. Defining a grid structurally rather than by counting levels is
 * what makes that case free rather than a rewrite.
 *
 * ## Coordinates are already in the data
 *
 * `sort_order` is the row index on a band and the column index on a cell — production confirms it
 * is 0…14 across all fifteen bins of every row, set by the generator. So the grid needs **no new
 * columns**, and a shrink or a re-order is an ordinary write rather than a schema migration.
 *
 * ## When it declines to draw
 *
 * Deeper than 4 levels returns `list`. Refusing to draw something it cannot read honestly beats
 * inventing a projection — the reader is still one tap from the same subtree, which is exactly what
 * the accordion gave them.
 */
import type { InventoryLocationNode } from '@/types/inventoryLocations';
import { occupancyFor, type OccupancyMap } from '@/utils/locationOccupancy';
import { compareLocationNames } from '@/lib/locationTree';
import { SYSTEM_KIND } from '@/lib/locationKinds';

/** One tappable place in the grid. Always a real location row, never a virtual coordinate. */
export interface GridCell {
  id: string;
  name: string;
  /** Anything here or anywhere inside it. Empty-vs-occupied only — capacity is unknown. */
  hasStock: boolean;
  /** Distinct parts, rolled up. Never a quantity sum: per-part units do not add. */
  totalParts: number;
  /** True when this cell has sub-locations, so stock lives below it rather than in it. */
  isContainer: boolean;
}

/** A row of cells — physically, one shelf or one row of a cabinet. */
export interface GridBand {
  /** The location the band corresponds to. For a leaf band this is also its single cell. */
  id: string;
  name: string;
  cells: GridCell[];
  /**
   * The band IS one stockable place rather than a row of them.
   *
   * Lets the view draw a full-width cell instead of a lone 44px square marooned beside 15-wide
   * neighbours — the difference between a ragged shelf reading as ragged and reading as broken.
   */
  isLeafItself: boolean;
}

export interface GridShape {
  bands: GridBand[];
  /** Widest band. What the view sizes its scroll container to. */
  columns: number;
  /** Bands disagree about width. Not a problem — a fact the view is allowed to show. */
  ragged: boolean;
}

export interface GridSection extends GridShape {
  id: string;
  name: string;
}

export type UnitLayout =
  /** The ordinary case: draw it. */
  | ({ kind: 'grid' } & GridShape)
  /** Four levels: choose a section (a side, a bay), then the identical grid. */
  | { kind: 'sections'; sections: GridSection[] }
  /** Too deep, or nothing inside. Offer the children and let the reader drill. */
  | { kind: 'list'; cells: GridCell[] };

/** Levels of nesting below a node: 0 for a leaf, 1 for a node whose children are all leaves. */
export function depthBelow(node: InventoryLocationNode): number {
  if (node.children.length === 0) return 0;
  return 1 + Math.max(...node.children.map(depthBelow));
}

/** Children in the order a person reads them — explicit `sort_order`, then natural name order. */
function ordered(nodes: InventoryLocationNode[]): InventoryLocationNode[] {
  return [...nodes].sort(
    (a, b) => a.sort_order - b.sort_order || compareLocationNames(a.name, b.name),
  );
}

function toCell(node: InventoryLocationNode, occupancy: OccupancyMap): GridCell {
  const occ = occupancyFor(occupancy, node.id);
  return {
    id: node.id,
    name: node.name,
    hasStock: occ.hasStock,
    totalParts: occ.totalParts,
    isContainer: node.children.length > 0,
  };
}

/** The band rule, applied to one node's children. Assumes depth below `parent` is 1 or 2. */
function toShape(parent: InventoryLocationNode, occupancy: OccupancyMap): GridShape {
  const bands: GridBand[] = ordered(parent.children).map((child) => {
    if (child.children.length === 0) {
      // A leaf child is a band of itself: "Row 3" with nothing inside it IS the place stock goes.
      return {
        id: child.id,
        name: child.name,
        cells: [toCell(child, occupancy)],
        isLeafItself: true,
      };
    }
    return {
      id: child.id,
      name: child.name,
      cells: ordered(child.children).map((c) => toCell(c, occupancy)),
      isLeafItself: false,
    };
  });

  const widths = bands.filter((b) => !b.isLeafItself).map((b) => b.cells.length);
  return {
    columns: widths.length > 0 ? Math.max(...widths) : 1,
    // Leaf bands do not count as narrow: a shelf that is one place is not a short row, and
    // flagging every 2-level unit as ragged would make the word meaningless.
    ragged: new Set(widths).size > 1 || (widths.length > 0 && widths.length < bands.length),
    bands,
  };
}

/**
 * How to draw one storage unit.
 *
 * `unit` is the node the reader opened — a root cabinet, or any node they drilled into. Depth is
 * measured from there, so drilling into a side of a 4-level cabinet yields a plain grid with no
 * special casing at the call site.
 */
export function readUnitLayout(
  unit: InventoryLocationNode,
  occupancy: OccupancyMap,
): UnitLayout {
  const depth = depthBelow(unit);

  /*
   * A unit that IS a place still draws — as a grid of exactly one cell.
   *
   * It used to return nothing and the pane rendered a bare contents list, so picking the Yard
   * looked like nothing had happened next to picking a cabinet. Consistency is the whole point of
   * the workspace: every unit is drawn, some are just one square.
   */
  if (depth === 0) {
    const cell = toCell(unit, occupancy);
    return {
      kind: 'grid',
      bands: [{ id: unit.id, name: unit.name, cells: [cell], isLeafItself: true }],
      columns: 1,
      ragged: false,
    };
  }

  if (depth <= 2) return { kind: 'grid', ...toShape(unit, occupancy) };

  if (depth === 3) {
    return {
      kind: 'sections',
      sections: ordered(unit.children).map((child) => ({
        id: child.id,
        name: child.name,
        // A section that is itself only 1–2 deep draws normally. A leaf child among sections is
        // the mixed case; `toShape` already renders it as a single-cell band.
        ...toShape(child, occupancy),
      })),
    };
  }

  // Five levels or more. Nothing has ever built one; if something does, say so by drawing a list
  // rather than inventing a projection nobody can check.
  return { kind: 'list', cells: ordered(unit.children).map((c) => toCell(c, occupancy)) };
}

/** What the unit card on the storage list says about shape, in the shop's own words. */
export function describeShape(unit: InventoryLocationNode): string {
  const depth = depthBelow(unit);
  if (depth === 0) return 'One location';

  const children = unit.children;
  if (depth === 1) {
    return `${children.length} ${children.length === 1 ? 'location' : 'locations'}`;
  }

  const widths = children.filter((c) => c.children.length > 0).map((c) => c.children.length);
  const uniform = widths.length === children.length && new Set(widths).size === 1;
  if (depth === 2 && uniform) {
    // "12 rows × 15 bins" — the shape stated back, so a wrong one is noticeable. `describeShape`
    // exists mostly for this: the operator built 15 wide and wanted 12, and nothing ever said so.
    return `${children.length} rows × ${widths[0]} each`;
  }
  return `${countStockablePlaces(unit)} locations`;
}

/** Every node under `unit`, including itself. Structure, not capacity. */
export function countPlaces(unit: InventoryLocationNode): number {
  return 1 + unit.children.reduce((sum, c) => sum + countPlaces(c), 0);
}

/**
 * The places you can actually put something — leaves only.
 *
 * A 12 × 15 cabinet has 193 nodes and **180 places**: the twelve rows are structure, and the
 * container/bin invariant means stock cannot sit in one. Counting nodes instead would report 192
 * and quietly overstate the shop's capacity by every container it owns.
 */
export function countStockablePlaces(unit: InventoryLocationNode): number {
  if (unit.children.length === 0) return 1;
  return unit.children.reduce((sum, c) => sum + countStockablePlaces(c), 0);
}

/**
 * How many of those places currently hold something.
 *
 * The honest fill signal for a unit: **places used of places**, not a percentage of a capacity
 * nobody knows. Counted over leaves for the same reason `countStockablePlaces` is — a container
 * cannot hold stock, so including one would inflate both halves of the ratio.
 *
 * Deliberately NOT `Occupancy.totalParts`, which counts distinct *parts*. Three parts in one bin
 * is one place in use, and reporting "3 in use of 180" for it would be a straightforward lie about
 * how full the cabinet is.
 */
export function countOccupiedPlaces(
  unit: InventoryLocationNode,
  occupancy: OccupancyMap,
): number {
  if (unit.children.length === 0) return occupancyFor(occupancy, unit.id).hasStock ? 1 : 0;
  return unit.children.reduce((sum, c) => sum + countOccupiedPlaces(c, occupancy), 0);
}

/**
 * The units to list on the Storage home screen — roots, with the put-away pile last.
 *
 * `Unassigned` sorts last for the reason the deleted board recorded and the table kept: the pile
 * you are trying to empty should not lead the page.
 */
export function orderUnits(roots: InventoryLocationNode[]): InventoryLocationNode[] {
  return [...roots].sort((a, b) => {
    const aSys = a.kind === SYSTEM_KIND ? 1 : 0;
    const bSys = b.kind === SYSTEM_KIND ? 1 : 0;
    if (aSys !== bSys) return aSys - bSys;
    return a.sort_order - b.sort_order || compareLocationNames(a.name, b.name);
  });
}
