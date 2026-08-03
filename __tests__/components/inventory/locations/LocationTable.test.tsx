/**
 * The indented table that replaced the drawn board.
 *
 * What is worth pinning here is the interaction model, because it is the part that changed twice:
 * the whole row opens a place, the chevron is a *separate* target that only expands, and there is
 * no selection column at all.
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

const shelfA = node({ id: 'a', name: 'Shelf A', parent_id: 'cab', depth: 1 });
const shelfB = node({ id: 'b', name: 'Shelf B', parent_id: 'cab', depth: 1 });
const cabinet = node({ id: 'cab', name: 'Cabinet 3', children: [shelfA, shelfB] });
const yard = node({ id: 'yard', name: 'Yard', sort_order: 1 });
const unassigned = node({ id: 'un', name: 'Unassigned', kind: 'system', sort_order: 2 });

const TREE = [cabinet, yard, unassigned];

const onOpen = vi.fn();
const onCountHere = vi.fn();

const renderTable = (tree = TREE, counts: Array<[string, number]> = [['a', 2], ['b', 1], ['yard', 1]]) =>
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

describe('LocationTable', () => {
  it('shows every level at once, children under their parent', () => {
    renderTable();
    const names = screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0].textContent);
    expect(names?.[0]).toContain('Cabinet 3');
    expect(names?.[1]).toContain('Shelf A');
    expect(names?.[2]).toContain('Shelf B');
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
    // Still expanded, i.e. the click did not toggle it.
    expect(screen.getByText('Shelf A')).toBeInTheDocument();
  });

  it('expands and collapses from the chevron without opening anything', async () => {
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole('button', { name: 'Collapse Cabinet 3' }));

    expect(screen.queryByText('Shelf A')).not.toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Expand Cabinet 3' }));
    expect(screen.getByText('Shelf A')).toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('counts one place without opening it', async () => {
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole('button', { name: 'Count Shelf A' }));

    expect(onCountHere).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
    expect(onOpen).not.toHaveBeenCalled();
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
