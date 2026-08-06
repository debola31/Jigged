/**
 * The indented table that replaced the drawn board.
 *
 * What is worth pinning here is the interaction model, because it is the part that changed twice:
 * the whole row opens a place, the chevron is a *separate* target that only expands, and there is
 * no selection column at all.
 *
 * It changed a third time, and that is what most of the expand/collapse cases below now assert:
 * the table is an **accordion with one open branch**. Rows start collapsed and opening a place
 * closes anything not on its ancestor chain. The old suite assumed the opposite default and read
 * child rows straight out of the first render — so four cases here are rewrites, not additions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '../../../test-utils';
import userEvent from '@testing-library/user-event';

import LocationTable, { placeOrder } from '@/components/inventory/locations/LocationTable';
import type { InventoryLocationNode } from '@/types/inventoryLocations';
import { rollUpOccupancy } from '@/utils/locationOccupancy';

const node = (
  over: Partial<InventoryLocationNode> & { id: string; name: string },
): InventoryLocationNode => ({
  company_id: 'co1',
  parent_id: null,
  kind: null,
  sort_order: 0,
  photo_path: null,
  created_at: '',
  updated_at: '',
  children: [],
  depth: 0,
  ...over,
});

const bin1 = node({ id: 'bin1', name: 'Bin 1', parent_id: 'a', depth: 2 });
const shelfA = node({ id: 'a', name: 'Shelf A', parent_id: 'cab', depth: 1, children: [bin1] });
const shelfB = node({ id: 'b', name: 'Shelf B', parent_id: 'cab', depth: 1 });
const cabinet = node({ id: 'cab', name: 'Cabinet 3', children: [shelfA, shelfB] });
const rackShelf = node({ id: 'rs', name: 'Rack Shelf', parent_id: 'rack', depth: 1 });
const rack = node({ id: 'rack', name: 'Rack 1', sort_order: 1, children: [rackShelf] });
const yard = node({ id: 'yard', name: 'Yard', sort_order: 2 });
const unassigned = node({ id: 'un', name: 'Unassigned', kind: 'system', sort_order: 3 });

const TREE = [cabinet, rack, yard, unassigned];

const onOpen = vi.fn();
const onCountHere = vi.fn();

const renderTable = (
  tree = TREE,
  counts: Array<[string, number]> = [['bin1', 2], ['b', 1], ['yard', 1]],
) =>
  render(
    <LocationTable
      tree={tree}
      occupancy={rollUpOccupancy(tree, new Map(counts))}
      onOpen={onOpen}
      onCountHere={onCountHere}
    />,
  );

const rowFor = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;

beforeEach(() => vi.clearAllMocks());

const expand = async (user: ReturnType<typeof userEvent.setup>, name: string) =>
  user.click(screen.getByRole('button', { name: `Expand ${name}` }));

describe('LocationTable', () => {
  it('starts with roots only, so a generated cabinet does not bury the shop', () => {
    renderTable();
    const names = screen
      .getAllByRole('row')
      .slice(1)
      .map((r) => within(r).getAllByRole('cell')[0].textContent);

    expect(names).toHaveLength(4);
    expect(names[0]).toContain('Cabinet 3');
    expect(screen.queryByText('Shelf A')).not.toBeInTheDocument();
  });

  it('shows children under their parent once opened', async () => {
    const user = userEvent.setup();
    renderTable();

    await expand(user, 'Cabinet 3');

    const names = screen
      .getAllByRole('row')
      .slice(1)
      .map((r) => within(r).getAllByRole('cell')[0].textContent);
    expect(names[0]).toContain('Cabinet 3');
    expect(names[1]).toContain('Shelf A');
    expect(names[2]).toContain('Shelf B');
  });

  /** The roll-up bug this inherited from the board: a full cabinet must never read empty. */
  it('rolls child stock up to the parent', () => {
    renderTable();
    // Cabinet 3 holds nothing directly; its shelves hold 3 between them.
    expect(within(rowFor('Cabinet 3')).getByText('3 parts')).toBeInTheDocument();
  });

  it('says empty rather than showing a zero', () => {
    renderTable([node({ id: 'x', name: 'Empty shelf' })], []);
    expect(screen.getByText('empty')).toBeInTheDocument();
  });

  /**
   * The whole row is the target. Only the name was clickable at first, which left most of a wide
   * row as dead space.
   */
  it('opens the place from anywhere on the row', async () => {
    const user = userEvent.setup();
    renderTable();

    // The Stock cell — nowhere near the name.
    await user.click(within(rowFor('Yard')).getByText(/part|empty/i));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'yard' }));
  });

  /**
   * Deliberately NOT "a parent row expands". That would give one gesture two meanings depending
   * on whether a row happens to have children, and would cost parent rows their drawer — where
   * rename, print QR, photo and history live.
   */
  it('opens the place when a row WITH children is clicked, rather than expanding it', async () => {
    const user = userEvent.setup();
    renderTable();

    await user.click(within(rowFor('Cabinet 3')).getByText(/part|empty/i));

    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'cab' }));
    // Still collapsed, i.e. the click did not toggle it.
    expect(screen.queryByText('Shelf A')).not.toBeInTheDocument();
  });

  it('expands and collapses from the chevron without opening anything', async () => {
    const user = userEvent.setup();
    renderTable();

    await expand(user, 'Cabinet 3');
    expect(screen.getByText('Shelf A')).toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Collapse Cabinet 3' }));
    expect(screen.queryByText('Shelf A')).not.toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();
  });

  /** The accordion, at the level the screenshot complained about: two sides open at once. */
  it('closes the open sibling when another is opened', async () => {
    const user = userEvent.setup();
    renderTable();

    await expand(user, 'Cabinet 3');
    await expand(user, 'Shelf A');
    expect(screen.getByText('Bin 1')).toBeInTheDocument();

    // Shelf B has no children of its own, so opening Shelf A and then Cabinet 3's other branch is
    // expressed by going back up: re-opening Cabinet 3 collapses it, which takes Shelf A with it.
    await user.click(screen.getByRole('button', { name: 'Collapse Cabinet 3' }));
    expect(screen.queryByText('Bin 1')).not.toBeInTheDocument();
    expect(screen.queryByText('Shelf A')).not.toBeInTheDocument();
  });

  it('closes the other root entirely — one open branch in the whole table', async () => {
    const user = userEvent.setup();
    renderTable();

    await expand(user, 'Cabinet 3');
    await expand(user, 'Shelf A');
    expect(screen.getByText('Bin 1')).toBeInTheDocument();

    await expand(user, 'Rack 1');

    expect(screen.getByText('Rack Shelf')).toBeInTheDocument();
    // The whole Cabinet 3 chain went, not just its deepest level.
    expect(screen.queryByText('Shelf A')).not.toBeInTheDocument();
    expect(screen.queryByText('Bin 1')).not.toBeInTheDocument();
  });

  it('keeps the ancestors open when a deeper node is closed', async () => {
    const user = userEvent.setup();
    renderTable();

    await expand(user, 'Cabinet 3');
    await expand(user, 'Shelf A');
    await user.click(screen.getByRole('button', { name: 'Collapse Shelf A' }));

    expect(screen.queryByText('Bin 1')).not.toBeInTheDocument();
    expect(screen.getByText('Shelf A')).toBeInTheDocument();
  });

  it('announces the open state, not just a differently worded label', async () => {
    const user = userEvent.setup();
    renderTable();

    expect(screen.getByRole('button', { name: 'Expand Cabinet 3' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expand(user, 'Cabinet 3');
    expect(screen.getByRole('button', { name: 'Collapse Cabinet 3' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('counts one place without opening it', async () => {
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole('button', { name: 'Count Yard' }));

    expect(onCountHere).toHaveBeenCalledWith(expect.objectContaining({ id: 'yard' }));
    expect(onOpen).not.toHaveBeenCalled();
  });

  /**
   * A container holds no stock of its own (20260806160053), so this button briefly did nothing and
   * was briefly hidden. Both were wrong — counting a cabinet means counting the bins in it, and the
   * worksheet resolves the subtree.
   */
  it('offers a count action on a container too, for everything inside it', () => {
    renderTable();

    expect(screen.getByRole('button', { name: 'Count Cabinet 3' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Count Yard' })).toBeInTheDocument();
  });

  /**
   * Tooltip and accessible name must agree. They didn't: sighted users read "Put away from
   * Unassigned" while a screen reader said "Count Unassigned".
   */
  it('calls the pile action putting away, in both the label and the name', () => {
    renderTable();
    expect(screen.getByRole('button', { name: 'Put away from Unassigned' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Count Unassigned' })).not.toBeInTheDocument();
  });

  it('says what the pile is, so it is not mistaken for a shelf', () => {
    renderTable();
    expect(screen.getByText(/put-away list, not a shelf/i)).toBeInTheDocument();
  });

  /** Removed after being added on a feature list rather than a job — see the note in the file. */
  it('has no selection column', () => {
    renderTable();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});

describe('placeOrder', () => {
  it('puts the put-away pile last, whatever it is called', () => {
    const sorted = [unassigned, yard, cabinet].sort(placeOrder);
    expect(sorted.map((n) => n.id)).toEqual(['cab', 'yard', 'un']);
  });
});
