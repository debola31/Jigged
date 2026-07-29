/**
 * The detail sheet — where every action moved to when the board became one tap target per unit.
 *
 * Two things here are load-bearing rather than cosmetic:
 *  - the **fill line's three states**, because "nothing here directly · 3 parts in sub-locations"
 *    is the sentence that stops a cabinet reading as empty when its shelves are full;
 *  - the **system bucket withholding structural actions**, because renaming `Unassigned` splits
 *    the backfill bucket (the stock RPCs resolve it by literal name) and every balance would be
 *    left in the renamed row while new writes went to a fresh empty one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '../../../test-utils';
import userEvent from '@testing-library/user-event';

vi.mock('@/utils/inventoryLocationsAccess', () => ({
  getLocationContents: vi.fn(async () => ({ contents: [], total: 0 })),
}));

import LocationDetailSheet from '@/components/inventory/locations/board/LocationDetailSheet';
import { getLocationContents } from '@/utils/inventoryLocationsAccess';
import { rollUpOccupancy } from '@/utils/locationOccupancy';
import type { InventoryLocation, InventoryLocationNode } from '@/types/inventoryLocations';

const node = (
  over: Partial<InventoryLocation> & { id: string },
  children: InventoryLocationNode[] = [],
  depth = 0,
): InventoryLocationNode => ({
  company_id: 'co1',
  parent_id: null,
  name: over.id,
  kind: null,
  code: null,
  sort_order: 0,
  created_at: '',
  updated_at: '',
  ...over,
  children,
  depth,
});

const actions = () => ({
  onAddChild: vi.fn(),
  onSubdivide: vi.fn(),
  onPrintQR: vi.fn(),
  onDuplicate: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
});

const renderSheet = (
  target: InventoryLocationNode,
  {
    roots = [target],
    path = [target],
    counts = [] as Array<[string, number]>,
    onNavigate = vi.fn(),
  } = {},
) => {
  const acts = actions();
  render(
    <LocationDetailSheet
      open
      node={target}
      path={path}
      occupancy={rollUpOccupancy(roots, new Map(counts))}
      actions={acts}
      onNavigate={onNavigate}
      onClose={vi.fn()}
    />,
  );
  return { acts, onNavigate };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getLocationContents).mockResolvedValue({ contents: [], total: 0 });
});

/**
 * Contents load lazily, so a synchronous assertion would race the resolved state update.
 * Awaiting the empty-contents copy is the cheapest proof the load has landed.
 */
const contentsSettled = () => screen.findByText(/no parts recorded at this location/i);

describe('LocationDetailSheet — fill line', () => {
  it('distinguishes "nothing here directly" from empty', async () => {
    const shelf = node({ id: 'shelf-a', name: 'Shelf A', parent_id: 'cab' }, [], 1);
    const cab = node({ id: 'cab', name: 'Cabinet 3' }, [shelf]);
    renderSheet(cab, { roots: [cab], counts: [['shelf-a', 3]] });
    await contentsSettled();

    expect(screen.getByText(/nothing here directly · 3 parts in sub-locations/i)).toBeInTheDocument();
  });

  it('says empty when nothing anywhere inside holds stock', async () => {
    const cab = node({ id: 'cab', name: 'Cabinet 3' });
    renderSheet(cab);
    await contentsSettled();
    expect(screen.getByText(/nothing recorded here or in anything inside it/i)).toBeInTheDocument();
  });

  it('separates what is here from what is below when both hold stock', async () => {
    const shelf = node({ id: 'shelf-a', name: 'Shelf A', parent_id: 'cab' }, [], 1);
    const cab = node({ id: 'cab', name: 'Cabinet 3' }, [shelf]);
    renderSheet(cab, { roots: [cab], counts: [['cab', 1], ['shelf-a', 3]] });
    await contentsSettled();

    expect(screen.getByText(/1 part here · 3 parts in sub-locations/i)).toBeInTheDocument();
  });
});

describe('LocationDetailSheet — navigation', () => {
  it('lists children with their own fill state and how many are inside each', async () => {
    const bin = node({ id: 'bin', name: 'Bin 1', parent_id: 'shelf-a' }, [], 2);
    const shelfA = node({ id: 'shelf-a', name: 'Shelf A', parent_id: 'cab' }, [bin], 1);
    const shelfB = node({ id: 'shelf-b', name: 'Shelf B', parent_id: 'cab' }, [], 1);
    const cab = node({ id: 'cab', name: 'Cabinet 3' }, [shelfA, shelfB]);
    renderSheet(cab, { roots: [cab], counts: [['bin', 4]] });
    await contentsSettled();

    expect(screen.getByText('Inside (2)')).toBeInTheDocument();
    expect(screen.getByText(/4 parts · 1 inside/)).toBeInTheDocument();
    expect(screen.getByText('empty')).toBeInTheDocument();
  });

  it('re-targets itself at a child rather than navigating away', async () => {
    const user = userEvent.setup();
    const shelf = node({ id: 'shelf-a', name: 'Shelf A', parent_id: 'cab' }, [], 1);
    const cab = node({ id: 'cab', name: 'Cabinet 3' }, [shelf]);
    const { onNavigate } = renderSheet(cab, { roots: [cab] });

    await user.click(screen.getByRole('button', { name: /Shelf A/ }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate.mock.calls[0][0].id).toBe('shelf-a');
  });

  it('offers the breadcrumb as a way back up', async () => {
    const user = userEvent.setup();
    const shelf = node({ id: 'shelf-a', name: 'Shelf A', parent_id: 'cab' }, [], 1);
    const cab = node({ id: 'cab', name: 'Cabinet 3' }, [shelf]);
    const { onNavigate } = renderSheet(shelf, { roots: [cab], path: [cab, shelf] });

    await user.click(screen.getByRole('button', { name: 'Cabinet 3' }));
    expect(onNavigate.mock.calls[0][0].id).toBe('cab');
  });
});

describe('LocationDetailSheet — contents', () => {
  it('loads what is stored here once, for the opened node only', async () => {
    vi.mocked(getLocationContents).mockResolvedValue({
      contents: [
        { part_id: 'p1', part_name: 'BUY-BEARING-608ZZ', primary_unit: 'each', quantity: 580 },
        { part_id: 'p2', part_name: 'BUY-ORING-214', primary_unit: 'each', quantity: 828 },
      ],
      total: 2,
    });
    renderSheet(node({ id: 'shelf-a', name: 'Shelf A' }));

    expect(await screen.findByText('BUY-BEARING-608ZZ')).toBeInTheDocument();
    expect(screen.getByText('828')).toBeInTheDocument();
    expect(getLocationContents).toHaveBeenCalledTimes(1);
    expect(getLocationContents).toHaveBeenCalledWith('shelf-a');
  });

  // The read is capped; a capped list that doesn't say so is the silent `max_rows` truncation
  // this cap was added to replace.
  it('admits truncation instead of presenting a clipped list as the whole truth', async () => {
    vi.mocked(getLocationContents).mockResolvedValue({
      contents: [{ part_id: 'p1', part_name: 'A', primary_unit: 'each', quantity: 1 }],
      total: 9428,
    });
    renderSheet(node({ id: 'un', name: 'Unassigned' }));

    expect(await screen.findByText(/showing the 1 largest of 9,428 parts/i)).toBeInTheDocument();
  });

  it('says so plainly when a location holds nothing', async () => {
    renderSheet(node({ id: 'shelf-a', name: 'Shelf A' }));
    expect(await screen.findByText(/no parts recorded at this location/i)).toBeInTheDocument();
  });

  it('surfaces a load failure rather than rendering as though empty', async () => {
    vi.mocked(getLocationContents).mockRejectedValue(new Error('boom'));
    renderSheet(node({ id: 'shelf-a', name: 'Shelf A' }));
    expect(await screen.findByText(/couldn't load what's stored here/i)).toBeInTheDocument();
  });
});

describe('LocationDetailSheet — actions', () => {
  it('offers all six on a real location', async () => {
    const user = userEvent.setup();
    const cab = node({ id: 'cab', name: 'Cabinet 3', kind: 'cabinet' });
    const { acts } = renderSheet(cab);

    await user.click(screen.getByRole('button', { name: /subdivide this unit/i }));
    await user.click(screen.getByRole('button', { name: /add one inside/i }));
    await user.click(screen.getByRole('button', { name: /print qr/i }));
    await user.click(screen.getByRole('button', { name: /rename/i }));
    await user.click(screen.getByRole('button', { name: /duplicate/i }));
    await user.click(screen.getByRole('button', { name: /delete/i }));

    expect(acts.onSubdivide).toHaveBeenCalledWith(cab);
    expect(acts.onAddChild).toHaveBeenCalledWith(cab);
    expect(acts.onPrintQR).toHaveBeenCalledWith(cab);
    expect(acts.onEdit).toHaveBeenCalledWith(cab);
    expect(acts.onDuplicate).toHaveBeenCalledWith(cab);
    expect(acts.onDelete).toHaveBeenCalledWith(cab);
  });

  /**
   * Renaming `Unassigned` is silently destructive: `inv_get_or_create_unassigned` resolves by
   * literal name, so it would create a SECOND empty bucket while every existing balance stayed
   * in the renamed one — and every subsequent stock RPC would write to the empty one.
   */
  it('withholds every structural action from the system bucket', async () => {
    renderSheet(node({ id: 'un', name: 'Unassigned', kind: 'system' }));

    for (const name of [/subdivide/i, /add one inside/i, /print qr/i, /rename/i, /duplicate/i, /delete/i]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    // …and explains what it is, because a huge count with no explanation just reads as alarming.
    expect(screen.getByText(/not a physical place/i)).toBeInTheDocument();
    await waitFor(() => expect(getLocationContents).toHaveBeenCalledWith('un'));
  });
});
