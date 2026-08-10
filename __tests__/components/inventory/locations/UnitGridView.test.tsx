/**
 * The drawn grid.
 *
 * The assertion that matters most here is the **touch floor**, and it is the one thing in this PR
 * that "it compiles" proves nothing about. Fifteen columns across a 390px phone is ~24px per cell
 * — the WCAG 2.2 AA minimum, and below it once you allow for the spacing the same criterion
 * requires. Every cell opens a stock ledger, so a near-miss books material to the wrong bin. The
 * grid therefore does not shrink to fit; it scrolls. jsdom has no layout engine, so this checks the
 * declared size rather than the rendered one — the real check is a handset in shop lighting.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import UnitGridView from '@/components/inventory/locations/UnitGridView';
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

const run = (label: string, n: number, make: (i: number) => InventoryLocationNode[] = () => []) =>
  Array.from({ length: n }, (_, i) => node(`${label} ${i + 1}`, make(i), { sort_order: i }));

const renderGrid = (unit: InventoryLocationNode, counts: Array<[string, number]> = []) => {
  const onOpenCell = vi.fn();
  render(
    <UnitGridView
      unit={unit}
      occupancy={rollUpOccupancy([unit], new Map(counts))}
      onOpenCell={onOpenCell}
    />,
    { wrapper: ({ children }) => <ThemeProvider theme={jiggedTheme}>{children}</ThemeProvider> },
  );
  return { onOpenCell };
};

beforeEach(() => vi.clearAllMocks());

describe('UnitGridView — the touch floor', () => {
  it('keeps every cell at the 48px house floor rather than shrinking a 15-wide cabinet to fit', () => {
    const cabinet = node('Form Tool Cabinet', run('Row', 12, () => run('Bin', 15)));
    renderGrid(cabinet);

    const cells = screen.getAllByRole('button');
    expect(cells.length).toBe(180);
    for (const cell of cells.slice(0, 5)) {
      expect(cell).toHaveStyle({ height: '48px' });
    }
  });

  /**
   * 44px is a FLOOR and the cell sizes to its content above it — never to the container.
   *
   * `flex: 1 0 44px` was tried and was wrong on a wide screen: a cabinet two bins across gave each
   * cell half the monitor, so `Left` and `Right` rendered as two 790px slabs across the page.
   * Growth has to be bounded by the content. Shrink stays disabled, which is the half that
   * matters — it is what stops a 15-wide cabinet quietly fitting itself to a phone at 24px a cell.
   *
   * Both directions measured in a real browser: the cabinet holds at exactly 44 and scrolls; a
   * three-wide shelf sizes to its names. jsdom has no layout engine, so this pins the declaration.
   */
  it('declares cells content-sized above the floor, and never shrinkable', () => {
    renderGrid(node('Cabinet', [node('Row 1', [node('Left'), node('Right')], { sort_order: 0 })]));
    const cell = screen.getByRole('button', { name: /^Left/ });
    expect(cell).toHaveStyle({ flex: '0 0 auto' });
    expect(cell).toHaveStyle({ minWidth: '48px' });
  });

  /**
   * `Bin 7` shows as `7` — the band is already a row of bins, and the number is the coordinate the
   * operator counts along. A name with no number is shown in FULL: truncating to four characters
   * gave `Cent` and `Righ`, which read as typos, and the cells have room once the band is narrow.
   */
  it('shows a bin by its number and a named place by its name', () => {
    renderGrid(
      node('Cabinet', [
        node('Row 1', [node('Bin 7', [], { sort_order: 0 })], { sort_order: 0 }),
        node('Row 2', [node('Center', [], { sort_order: 0 })], { sort_order: 1 }),
      ]),
    );
    expect(screen.getByRole('button', { name: /^Bin 7/ })).toHaveTextContent('7');
    expect(screen.getByRole('button', { name: /^Center/ })).toHaveTextContent('Center');
  });
});

describe('UnitGridView — the shapes', () => {
  it('draws a row per band and a cell per bin', () => {
    const cabinet = node('Form Tool Cabinet', run('Row', 3, () => run('Bin', 4)));
    renderGrid(cabinet);

    expect(screen.getByText('Row 1')).toBeInTheDocument();
    expect(screen.getByText('Row 3')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(12);
  });

  /**
   * A bare shelf is one place, not a short row — so it draws full width instead of as a lone
   * square beside three-wide neighbours. This is Contour's welder shelf.
   */
  it('draws a ragged unit as it is, and says so', () => {
    const shelf = node('Metal Shelf By Welder', [
      node('Row 1', [], { sort_order: 0 }),
      node(
        'Row 2',
        [
          node('Left', [], { sort_order: 0 }),
          node('Center', [], { sort_order: 1 }),
          node('Right', [], { sort_order: 2 }),
        ],
        { sort_order: 1 },
      ),
    ]);
    renderGrid(shelf);

    expect(screen.getByText(/some rows are divided and some aren't/i)).toBeInTheDocument();
    // Four tap targets: the bare row itself, plus Left/Center/Right.
    expect(screen.getAllByRole('button')).toHaveLength(4);
  });

  /**
   * Four levels. Nothing at Contour is this deep; the chooser exists so that when one arrives it
   * costs nothing, and so a 3-level cabinet never sees it.
   */
  it('offers a chooser for a 4-level unit, and none for a 3-level one', () => {
    const deep = node('Cabinet 1-A', [
      node('Side 1', run('Row', 2, () => run('Bin', 2)), { sort_order: 0 }),
      node('Side 2', run('Row', 2, () => run('Bin', 2)), { sort_order: 1 }),
    ]);
    const { unmount } = render(
      <ThemeProvider theme={jiggedTheme}>
        <UnitGridView unit={deep} occupancy={rollUpOccupancy([deep], new Map())} onOpenCell={vi.fn()} />
      </ThemeProvider>,
    );
    expect(screen.getByRole('tab', { name: 'Side 1' })).toBeInTheDocument();
    unmount();

    renderGrid(node('Cabinet 2', run('Row', 2, () => run('Bin', 2))));
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('switches the drawn grid when another section is chosen', async () => {
    const user = userEvent.setup();
    const deep = node('Cabinet 1-A', [
      node('Side 1', [node('Row A', [node('Bin A1')])], { sort_order: 0 }),
      node('Side 2', [node('Row B', [node('Bin B1')])], { sort_order: 1 }),
    ]);
    renderGrid(deep);

    expect(screen.getByText('Row A')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Side 2' }));
    expect(screen.getByText('Row B')).toBeInTheDocument();
    expect(screen.queryByText('Row A')).not.toBeInTheDocument();
  });

  it('declines to draw past four levels rather than inventing a projection', () => {
    const deep = node('Warehouse', [node('Aisle', [node('Bay', [node('Shelf', [node('Bin')])])])]);
    renderGrid(deep);
    expect(screen.getByText(/nests deeper than the grid draws/i)).toBeInTheDocument();
  });

  it('says what an empty unit needs, rather than drawing nothing', () => {
    renderGrid(node('New Cabinet'));
    expect(screen.getByText(/change its layout to add places/i)).toBeInTheDocument();
  });
});

describe('UnitGridView — occupancy and tapping', () => {
  const cabinet = node('Cabinet', [
    node('Row 1', [node('Bin 1', [], { sort_order: 0 }), node('Bin 2', [], { sort_order: 1 })], {
      sort_order: 0,
    }),
  ]);
  const stockedBin = cabinet.children[0].children[1].id;

  /**
   * Empty-vs-occupied only, and it has to be legible without colour — an accessible name carries
   * it, because a bright shop floor is exactly where a subtle fill colour disappears.
   */
  it('names what is in a cell, so occupancy is not colour alone', () => {
    renderGrid(cabinet, [[stockedBin, 3]]);
    expect(screen.getByRole('button', { name: 'Bin 2 — 3 parts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bin 1 — empty' })).toBeInTheDocument();
  });

  it('reports one part in the singular', () => {
    renderGrid(cabinet, [[stockedBin, 1]]);
    expect(screen.getByRole('button', { name: 'Bin 2 — 1 part' })).toBeInTheDocument();
  });

  it('hands the tapped location up rather than deciding what happens to it', async () => {
    const user = userEvent.setup();
    const { onOpenCell } = renderGrid(cabinet);
    await user.click(screen.getByRole('button', { name: /^Bin 2/ }));
    expect(onOpenCell).toHaveBeenCalledWith(stockedBin);
  });

  /**
   * A row whose bins are full holds nothing itself. Reporting it empty is the one error that would
   * make fill state worse than none — it sends someone to put material where material already is.
   */
  it('rolls occupancy up, so a container of full bins never reads empty', () => {
    const fourLevel = node('Cabinet 1-A', [
      node('Side 1', [node('Row 1', [node('Bin 1')])], { sort_order: 0 }),
    ]);
    const bin = fourLevel.children[0].children[0].children[0].id;
    render(
      <ThemeProvider theme={jiggedTheme}>
        <UnitGridView
          unit={fourLevel}
          occupancy={rollUpOccupancy([fourLevel], new Map([[bin, 2]]))}
          onOpenCell={vi.fn()}
        />
      </ThemeProvider>,
    );
    // Bin 1 is where the stock actually is; the row and the side above it hold nothing directly,
    // and the cell still reports the rolled-up figure.
    expect(screen.getByRole('button', { name: 'Bin 1 — 2 parts' })).toBeInTheDocument();
  });
});
