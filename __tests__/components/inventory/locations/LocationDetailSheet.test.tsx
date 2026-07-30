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

// The photo control compresses in the browser before uploading; jsdom has no canvas worker.
vi.mock('@/utils/imageCompression', () => ({
  compressPhoto: vi.fn(async (file: File) => ({ file })),
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
  onCountHere: vi.fn(),
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
    photoUrl = null as string | null,
    onPickPhoto = vi.fn(async () => {}),
    onClearPhoto = vi.fn(async () => {}),
  } = {},
) => {
  const acts = actions();
  render(
    <LocationDetailSheet
      open
      node={target}
      path={path}
      occupancy={rollUpOccupancy(roots, new Map(counts))}
      photoUrl={photoUrl}
      actions={acts}
      onPickPhoto={onPickPhoto}
      onClearPhoto={onClearPhoto}
      onNavigate={onNavigate}
      onClose={vi.fn()}
    />,
  );
  return { acts, onNavigate, onPickPhoto, onClearPhoto };
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

/**
 * The board's daily job.
 *
 * Everything else on this sheet is setup you do once when the shelf arrives — which is exactly why
 * the board read as purposeless on review. This is the one action you come back for, so it leads,
 * and it is the *only* action offered for the system bucket.
 */
describe('LocationDetailSheet — count or put away', () => {
  it('leads with it on a real location', async () => {
    const user = userEvent.setup();
    const cab = node({ id: 'cab', name: 'Cabinet 3', kind: 'cabinet' });
    const { acts } = renderSheet(cab);

    await user.click(screen.getByRole('button', { name: /count or put away/i }));
    expect(acts.onCountHere).toHaveBeenCalledWith(cab);
  });

  /**
   * The system bucket has no structural actions at all, so without this the sheet for the biggest
   * thing on a real shop's board would offer literally nothing to do.
   */
  it('is the one action the system bucket does offer, worded for what it is', async () => {
    const user = userEvent.setup();
    const un = node({ id: 'un', name: 'Unassigned', kind: 'system' });
    const { acts } = renderSheet(un);

    expect(screen.queryByRole('button', { name: /count or put away/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /put these away/i }));
    expect(acts.onCountHere).toHaveBeenCalledWith(un);
  });
});

/**
 * Photos — §5.5 decision 5.
 *
 * The one case worth being careful about is a `photo_path` that exists but whose URL didn't
 * resolve: an empty frame reads as "no photo" and invites someone to add a second one, so it has
 * to say what actually happened.
 */
describe('LocationDetailSheet — photo', () => {
  it('offers to add one when there is none', () => {
    renderSheet(node({ id: 'cab', name: 'Cabinet 3', kind: 'cabinet' }));
    expect(screen.getByRole('button', { name: /add a photo/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
  });

  it('shows the photo and offers to replace or remove it', () => {
    renderSheet(
      node({ id: 'cab', name: 'Cabinet 3', kind: 'cabinet', photo_path: 'p.jpg' }),
      { photoUrl: 'https://signed/p' },
    );
    expect(screen.getByAltText('Photo of Cabinet 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /replace photo/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove/i })).toBeInTheDocument();
  });

  it('says the photo could not be loaded rather than showing an empty frame', () => {
    renderSheet(
      node({ id: 'cab', name: 'Cabinet 3', kind: 'cabinet', photo_path: 'p.jpg' }),
      { photoUrl: null },
    );
    expect(screen.getByText(/has a photo, but it couldn't be loaded/i)).toBeInTheDocument();
  });

  it('removes on request', async () => {
    const user = userEvent.setup();
    const { onClearPhoto } = renderSheet(
      node({ id: 'cab', name: 'Cabinet 3', kind: 'cabinet', photo_path: 'p.jpg' }),
      { photoUrl: 'https://signed/p' },
    );

    await user.click(screen.getByRole('button', { name: /remove/i }));
    expect(onClearPhoto).toHaveBeenCalledTimes(1);
  });

  /** There is no shelf to photograph, and the bucket isn't a place. */
  it('offers nothing for the system bucket', () => {
    renderSheet(node({ id: 'un', name: 'Unassigned', kind: 'system' }));
    expect(screen.queryByRole('button', { name: /add a photo/i })).not.toBeInTheDocument();
  });
});
