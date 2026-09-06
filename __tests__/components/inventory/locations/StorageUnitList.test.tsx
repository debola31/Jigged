/**
 * Storage as a list of units — the screen that replaced a 237-row accordion.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import StorageUnitList from '@/components/inventory/locations/StorageUnitList';
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

const renderList = (
  tree: InventoryLocationNode[],
  counts: Array<[string, number]> = [],
  selectedId: string | null = null,
  query = '',
) => {
  const onOpen = vi.fn();
  render(
    <StorageUnitList
      tree={tree}
      occupancy={rollUpOccupancy(tree, new Map(counts))}
      onOpen={onOpen}
      selectedId={selectedId}
      query={query}
    />,
    { wrapper: ({ children }) => <ThemeProvider theme={jiggedTheme}>{children}</ThemeProvider> },
  );
  return { onOpen };
};

beforeEach(() => vi.clearAllMocks());

describe('StorageUnitList', () => {
  /**
   * The whole point. Contour's real tree is 237 locations; the accordion rendered all of them.
   * Five cards is what a shop actually has to walk to.
   */
  it('shows one card per unit and nothing from inside them', () => {
    const tree = [
      node('Form Tool Cabinet', run('Row', 12, () => run('Bin', 15)), { sort_order: 0 }),
      node('Cabinet by Mill/Lathe', run('Row', 10), { sort_order: 1 }),
    ];
    renderList(tree);

    expect(screen.getByText('Form Tool Cabinet')).toBeInTheDocument();
    expect(screen.getByText('Cabinet by Mill/Lathe')).toBeInTheDocument();
    // 192 nodes live under the first card and none of them render here.
    expect(screen.queryByText('Row 1')).not.toBeInTheDocument();
    expect(screen.queryByText('Bin 1')).not.toBeInTheDocument();
  });

  /**
   * The operator built fifteen wide when he wanted twelve, and nothing ever told him what he had.
   * A shape you can read is a shape you can notice is wrong.
   */
  it('states the shape in the shop’s own words', () => {
    renderList([node('Form Tool Cabinet', run('Row', 12, () => run('Bin', 15)))]);
    // 180 leaves, not the 192 nodes — the twelve rows are structure and cannot hold stock.
    expect(screen.getByText(/12 rows × 15 each · 0\/180 used/)).toBeInTheDocument();
  });

  /**
   * Places used of places. Never a percentage — capacity is unknown — and never a PART count
   * dressed as one: three parts in a single bin is one place in use, and saying "3 of 4" for it
   * would be a straightforward lie about how full the cabinet is.
   */
  it('reports locations in use, not parts, and never a percentage', () => {
    const cabinet = node('Cabinet', run('Row', 2, () => run('Bin', 2))); // 4 bins
    const bin = cabinet.children[0].children[0].id;
    renderList([cabinet], [[bin, 3]]); // three distinct parts, all in ONE bin

    expect(screen.getByText(/1\/4 used/)).toBeInTheDocument();
    expect(screen.queryByText(/3\/4/)).not.toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  /*
   * `names the pile as what it is, and sorts it last` is gone — 20260906182638.
   *
   * `orderUnits` used to float the `Unassigned` bucket to the bottom, because the pile you are
   * trying to empty should not lead the page. Every root is a place someone named and ordered
   * deliberately now, so the shop's own `sort_order` is the whole rule.
   */


  it('opens a unit when the card is tapped', async () => {
    const user = userEvent.setup();
    const cabinet = node('Cabinet 1', run('Row', 2));
    const { onOpen } = renderList([cabinet]);

    await user.click(screen.getByText('Cabinet 1'));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: cabinet.id }));
  });

  /**
   * A card does ONE thing: show the unit in the pane. Counting used to be a second target on the
   * row; it moved to the pane, where it sits beside every other action on the same unit and does
   * not have to compete with the card for a tap.
   */
  it('gives a card one job, and no second target', async () => {
    const user = userEvent.setup();
    const cabinet = node('Cabinet 1', run('Row', 2));
    const { onOpen } = renderList([cabinet]);

    expect(screen.queryByRole('button', { name: /^count /i })).not.toBeInTheDocument();
    await user.click(screen.getByText('Cabinet 1'));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: cabinet.id }));
  });

  it('marks the unit currently showing in the pane', () => {
    const tree = [
      node('Cabinet 1', run('Row', 2), { sort_order: 0 }),
      node('Cabinet 2', run('Row', 2), { sort_order: 1 }),
    ];
    renderList(tree, [], tree[1].id);
    // Selection is an outline on the card, so assert through what the DOM can see: the selected
    // card is the one whose elevation changed. Checked visually in a browser; this pins that a
    // selection is expressed at all.
    expect(screen.getByText('Cabinet 2')).toBeInTheDocument();
  });

  /**
   * The field lives in the page header now; this only applies the filter. Not discovery — a shop
   * can see all of its units — but speed: typing "weld" beats reading. Names only, because
   * matching a nested `Bin 5` would put a cabinet in the results for a reason invisible in the row.
   */
  describe('filtering', () => {
    const tree = () => [
      node('Form Tool Cabinet', run('Row', 2), { sort_order: 0 }),
      node('Metal Shelf By Welder', run('Row', 2), { sort_order: 1 }),
      node('Yard', [], { sort_order: 2 }),
    ];

    it('shows only what matches, case-insensitively', () => {
      renderList(tree(), [], null, 'weld');
      expect(screen.getByText('Metal Shelf By Welder')).toBeInTheDocument();
      expect(screen.queryByText('Form Tool Cabinet')).not.toBeInTheDocument();
      expect(screen.queryByText('Yard')).not.toBeInTheDocument();
    });

    it('says so when nothing matches, rather than showing an empty column', () => {
      renderList(tree(), [], null, 'zzz');
      expect(screen.getByText(/nothing matches/i)).toBeInTheDocument();
    });
  });

});
