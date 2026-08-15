/**
 * The grid read model, tested against the shapes that actually exist.
 *
 * Every fixture below except the 4-level one is a real Contour unit, measured 2026-08-09. That
 * matters more than coverage here: the accordion this replaces was built on the belief that a
 * flat shop's storage is 12–18 rows in total, and the shop then built 237 locations with 180 bins
 * in one cabinet. Testing against invented shapes is how that happens again.
 */
import { describe, it, expect } from 'vitest';
import {
  readUnitLayout,
  describeShape,
  depthBelow,
  countPlaces,
  countStockablePlaces,
  orderUnits,
  type GridShape,
} from '@/lib/locationGrid';
import { rollUpOccupancy } from '@/utils/locationOccupancy';
import type { InventoryLocationNode } from '@/types/inventoryLocations';

let seq = 0;
const node = (
  name: string,
  children: InventoryLocationNode[] = [],
  over: Partial<InventoryLocationNode> = {},
): InventoryLocationNode =>
  ({
    id: `${name}-${seq++}`,
    company_id: 'co1',
    parent_id: null,
    name,
    kind: null,
    sort_order: 0,
    created_at: '',
    updated_at: '',
    depth: 0,
    children,
    ...over,
  }) as InventoryLocationNode;

/** Children numbered in `sort_order`, the way the generator writes them. */
const run = (label: string, n: number, make: (i: number) => InventoryLocationNode[] = () => []) =>
  Array.from({ length: n }, (_, i) => node(`${label} ${i + 1}`, make(i), { sort_order: i }));

const noStock = () => rollUpOccupancy([], new Map());

describe('depthBelow', () => {
  it('counts levels of nesting, not nodes', () => {
    expect(depthBelow(node('Bin'))).toBe(0);
    expect(depthBelow(node('Shelf', run('Row', 3)))).toBe(1);
    expect(depthBelow(node('Cabinet', run('Row', 2, () => run('Bin', 2))))).toBe(2);
  });

  it('takes the deepest branch, so a ragged unit reports its worst case', () => {
    const shelf = node('Shelf', [node('Row 1'), node('Row 2', [node('Left')])]);
    expect(depthBelow(shelf)).toBe(2);
  });
});

// ── Real Contour shapes ───────────────────────────────────────────────────────

describe('Form Tool Cabinet — 12 rows × 15 bins, the shape that broke the accordion', () => {
  const cabinet = node('Form Tool Cabinet', run('Row', 12, () => run('Bin', 15)));

  it('reads as a grid of 12 bands, 15 wide, not ragged', () => {
    const layout = readUnitLayout(cabinet, noStock());
    expect(layout.kind).toBe('grid');
    const grid = layout as GridShape & { kind: 'grid' };
    expect(grid.bands).toHaveLength(12);
    expect(grid.columns).toBe(15);
    expect(grid.ragged).toBe(false);
    expect(grid.bands.every((b) => b.cells.length === 15)).toBe(true);
    expect(grid.bands.every((b) => !b.isLeafItself)).toBe(true);
  });

  it('keeps bands and cells in sort_order — the coordinates are already in the data', () => {
    const grid = readUnitLayout(cabinet, noStock()) as GridShape & { kind: 'grid' };
    expect(grid.bands.map((b) => b.name).slice(0, 3)).toEqual(['Row 1', 'Row 2', 'Row 3']);
    expect(grid.bands[0].cells.map((c) => c.name).slice(0, 3)).toEqual(['Bin 1', 'Bin 2', 'Bin 3']);
  });

  it('describes its shape in the words the shop used, so a wrong one is noticeable', () => {
    expect(describeShape(cabinet)).toBe('12 rows × 15 each');
  });

  it('counts 193 nodes but 180 places, and the difference is the point', () => {
    expect(countPlaces(cabinet)).toBe(193); // 1 cabinet + 12 rows + 180 bins, matching production
    // The rows are structure: the container/bin invariant means stock cannot sit in one, so
    // counting nodes would overstate the shop's capacity by every container it owns.
    expect(countStockablePlaces(cabinet)).toBe(180);
  });
});

describe('Metal Shelf By Welder — ragged, and the reason grids are read structurally', () => {
  // Rows 1–5 are bare shelves; rows 6–10 are split Left / Center / Right.
  const shelf = node('Metal Shelf By Welder', [
    ...run('Row', 5),
    ...Array.from({ length: 5 }, (_, i) =>
      node(
        `Row ${i + 6}`,
        // Distinct sort_order, as the generator writes them — production has these in physical
        // left-to-right order, which is not their alphabetical order.
        [
          node('Left', [], { sort_order: 0 }),
          node('Center', [], { sort_order: 1 }),
          node('Right', [], { sort_order: 2 }),
        ],
        { sort_order: i + 5 },
      ),
    ),
  ]);

  it('draws the ragged shelf as it is rather than forcing it square', () => {
    const grid = readUnitLayout(shelf, noStock()) as GridShape & { kind: 'grid' };
    expect(grid.bands).toHaveLength(10);
    expect(grid.ragged).toBe(true);
    expect(grid.columns).toBe(3);
  });

  /**
   * The bare rows are where a `rows × cols` model on the unit would have had to lie. A row with
   * nothing inside it IS the place stock goes, so it becomes a band holding itself — which lets
   * the view draw it full width instead of as a lone square beside three-wide neighbours.
   */
  it('turns a bare row into a band of one cell that is the row itself', () => {
    const grid = readUnitLayout(shelf, noStock()) as GridShape & { kind: 'grid' };
    const bare = grid.bands[0];
    expect(bare.isLeafItself).toBe(true);
    expect(bare.cells).toHaveLength(1);
    expect(bare.cells[0].id).toBe(bare.id);

    // Physical order, not alphabetical — `sort_order` wins and the name is only the tiebreak.
    const split = grid.bands[9];
    expect(split.isLeafItself).toBe(false);
    expect(split.cells.map((c) => c.name)).toEqual(['Left', 'Center', 'Right']);
  });
});

describe('Cabinet by Mill/Lathe — 10 flat rows', () => {
  const cabinet = node('Cabinet by Mill/Lathe', run('Row', 10));

  /**
   * Ten shelves stack vertically. Reading them as ONE band of ten cells would draw a horizontal
   * strip, which is the opposite of the thing in the shop — so every child is a band, always.
   */
  it('stacks a 2-level unit vertically rather than laying it out sideways', () => {
    const grid = readUnitLayout(cabinet, noStock()) as GridShape & { kind: 'grid' };
    expect(grid.bands).toHaveLength(10);
    expect(grid.bands.every((b) => b.isLeafItself && b.cells.length === 1)).toBe(true);
    expect(grid.columns).toBe(1);
    expect(grid.ragged).toBe(false);
  });

  it('describes itself by count, not as a grid it is not', () => {
    expect(describeShape(cabinet)).toBe('10 locations');
  });
});

// ── The case with no production example yet ───────────────────────────────────

/**
 * Four levels: `Cabinet › Side › Row › Bin`. Nothing at Contour is this deep, which is exactly
 * why it is tested — it will arrive unannounced, and the whole point of reading a grid
 * structurally rather than by counting levels is that this case costs nothing.
 */
describe('a 4-level cabinet', () => {
  const cabinet = node('Cabinet 1-A', [
    node('Side 1', run('Row', 3, () => run('Bin', 4)), { sort_order: 0 }),
    node('Side 2', run('Row', 3, () => run('Bin', 4)), { sort_order: 1 }),
  ]);

  it('offers the sides as sections, each drawing the identical grid', () => {
    const layout = readUnitLayout(cabinet, noStock());
    expect(layout.kind).toBe('sections');
    const sections = (layout as { kind: 'sections'; sections: Array<GridShape & { name: string }> })
      .sections;
    expect(sections.map((s) => s.name)).toEqual(['Side 1', 'Side 2']);
    expect(sections[0].bands).toHaveLength(3);
    expect(sections[0].columns).toBe(4);
  });

  /**
   * Drilling into a side must produce a plain grid with no special casing — depth is measured from
   * whatever node the reader opened, which is what keeps the components free of depth checks.
   */
  it('reads a section on its own as an ordinary grid', () => {
    const side = cabinet.children[0];
    const layout = readUnitLayout(side, noStock());
    expect(layout.kind).toBe('grid');
    expect((layout as GridShape & { kind: 'grid' }).columns).toBe(4);
  });
});

describe('shapes it declines to draw', () => {
  it('falls back to a list past four levels instead of inventing a projection', () => {
    const deep = node('Warehouse', [
      node('Aisle', [node('Bay', [node('Shelf', [node('Bin')])])]),
    ]);
    expect(depthBelow(deep)).toBe(4);
    const layout = readUnitLayout(deep, noStock());
    expect(layout.kind).toBe('list');
    expect((layout as { kind: 'list'; cells: Array<{ name: string }> }).cells).toHaveLength(1);
  });

  /**
   * A unit that IS a place still draws — as one square. It used to return nothing, so picking the
   * Yard looked like nothing had happened next to picking a cabinet.
   */
  it('draws a single-place unit as a grid of one cell', () => {
    const yard = node('Yard');
    const layout = readUnitLayout(yard, noStock()) as GridShape & { kind: 'grid' };

    expect(layout.kind).toBe('grid');
    expect(layout.bands).toHaveLength(1);
    expect(layout.bands[0].isLeafItself).toBe(true);
    expect(layout.bands[0].cells[0].id).toBe(yard.id);
  });
});

// ── Occupancy ─────────────────────────────────────────────────────────────────

describe('occupancy on the grid', () => {
  const cabinet = node('Form Tool Cabinet', run('Row', 2, () => run('Bin', 3)));

  it('marks only the cells that hold something', () => {
    const stocked = cabinet.children[0].children[1].id;
    const occupancy = rollUpOccupancy([cabinet], new Map([[stocked, 1]]));
    const grid = readUnitLayout(cabinet, occupancy) as GridShape & { kind: 'grid' };

    expect(grid.bands[0].cells.map((c) => c.hasStock)).toEqual([false, true, false]);
    expect(grid.bands[1].cells.every((c) => !c.hasStock)).toBe(true);
  });

  /**
   * Rolled up, never direct. A cabinet whose bins are full holds nothing itself, and reporting it
   * empty is the one failure that would make fill state worse than none — it sends someone to put
   * material where material already is.
   */
  it('rolls occupancy up, so a container of full bins never reads empty', () => {
    const stocked = cabinet.children[0].children[0].id;
    const occupancy = rollUpOccupancy([cabinet], new Map([[stocked, 4]]));
    const grid = readUnitLayout(cabinet, occupancy) as GridShape & { kind: 'grid' };
    // The band's own row node holds nothing directly, but the cell inside it does.
    expect(grid.bands[0].cells[0].totalParts).toBe(4);
  });

  it('counts distinct parts, never a quantity — per-part units do not add', () => {
    const bin = cabinet.children[1].children[2].id;
    const occupancy = rollUpOccupancy([cabinet], new Map([[bin, 7]]));
    const grid = readUnitLayout(cabinet, occupancy) as GridShape & { kind: 'grid' };
    expect(grid.bands[1].cells[2].totalParts).toBe(7);
  });
});

describe('orderUnits', () => {
  it('sorts the put-away pile last — it is not a shelf and should not lead the page', () => {
    const units = [
      node('Unassigned', [], { kind: 'system', sort_order: 0 }),
      node('Cabinet 10', [], { sort_order: 0 }),
      node('Cabinet 2', [], { sort_order: 0 }),
    ];
    expect(orderUnits(units).map((u) => u.name)).toEqual([
      'Cabinet 2',
      'Cabinet 10',
      'Unassigned',
    ]);
  });
});
