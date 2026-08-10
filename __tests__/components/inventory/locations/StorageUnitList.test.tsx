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

const renderList = (tree: InventoryLocationNode[], counts: Array<[string, number]> = []) => {
  const onOpen = vi.fn();
  const onCountHere = vi.fn();
  render(
    <StorageUnitList
      tree={tree}
      occupancy={rollUpOccupancy(tree, new Map(counts))}
      onOpen={onOpen}
      onCountHere={onCountHere}
    />,
    { wrapper: ({ children }) => <ThemeProvider theme={jiggedTheme}>{children}</ThemeProvider> },
  );
  return { onOpen, onCountHere };
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
    expect(screen.getByText(/12 rows × 15 each/)).toBeInTheDocument();
    expect(screen.getByText(/180 places/)).toBeInTheDocument(); // leaves, not the 192 nodes
  });

  /**
   * Places used of places. Never a percentage — capacity is unknown — and never a PART count
   * dressed as one: three parts in a single bin is one place in use, and saying "3 of 4" for it
   * would be a straightforward lie about how full the cabinet is.
   */
  it('reports places in use, not parts, and never a percentage', () => {
    const cabinet = node('Cabinet', run('Row', 2, () => run('Bin', 2))); // 4 bins
    const bin = cabinet.children[0].children[0].id;
    renderList([cabinet], [[bin, 3]]); // three distinct parts, all in ONE bin

    expect(screen.getByText(/1 of 4 places in use/)).toBeInTheDocument();
    expect(screen.queryByText(/3 of 4/)).not.toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('names the put-away pile as what it is, and sorts it last', () => {
    const tree = [
      node('Unassigned', [], { kind: 'system', sort_order: 0 }),
      node('Cabinet 1', run('Row', 2), { sort_order: 1 }),
    ];
    renderList(tree);

    expect(screen.getByText('Put-away pile')).toBeInTheDocument();
    expect(screen.getByText(/your put-away list, not a shelf/i)).toBeInTheDocument();

    const names = screen.getAllByText(/Unassigned|Cabinet 1/).map((n) => n.textContent);
    expect(names[names.length - 1]).toBe('Unassigned');
  });

  it('opens a unit when the card is tapped', async () => {
    const user = userEvent.setup();
    const cabinet = node('Cabinet 1', run('Row', 2));
    const { onOpen } = renderList([cabinet]);

    await user.click(screen.getByText('Cabinet 1'));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: cabinet.id }));
  });

  /**
   * Counting sits OUTSIDE the card's action area, so one gesture never means two things — and at
   * the pile it is really a put-away, which the accessible name has to agree with. Sighted users
   * once read "Put away from Unassigned" while a screen reader said "Count Unassigned".
   */
  it('offers counting as its own target, worded for what it does', async () => {
    const user = userEvent.setup();
    const tree = [
      node('Cabinet 1', run('Row', 2), { sort_order: 0 }),
      node('Unassigned', [], { kind: 'system', sort_order: 1 }),
    ];
    const { onOpen, onCountHere } = renderList(tree);

    await user.click(screen.getByRole('button', { name: 'Count Cabinet 1' }));
    expect(onCountHere).toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();

    expect(screen.getByRole('button', { name: 'Put away from Unassigned' })).toBeInTheDocument();
  });
});
