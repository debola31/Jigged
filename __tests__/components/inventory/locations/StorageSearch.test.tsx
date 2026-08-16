/**
 * One box that finds a place OR a part.
 *
 * The behaviour worth defending is the second half. Storage is place-first, so until this existed
 * the only search on the page matched storage-unit NAMES — and typing a part number into it, which
 * is the obvious thing to do, produced "Nothing matches". A dead end in the box a person tries
 * first. These tests pin that a part now resolves to the SHELF, not merely to the cabinet.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '../../../test-utils';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}) }));

vi.mock('@/utils/inventoryLocationsAccess', () => ({
  searchPartPlacements: vi.fn(async () => []),
}));

import StorageSearch from '@/components/inventory/locations/StorageSearch';
import { searchPartPlacements } from '@/utils/inventoryLocationsAccess';
import type { InventoryLocation, InventoryLocationNode } from '@/types/inventoryLocations';

/** The tree is all this needs now — paths and roots are the part drawer's job, not the box's. */
const loc = (over: Partial<InventoryLocation> & { id: string }): InventoryLocation => ({
  company_id: 'co1',
  parent_id: null,
  name: over.id,
  kind: null,
  sort_order: 0,
  created_at: '',
  updated_at: '',
  ...over,
});

const node = (id: string, name: string, children: InventoryLocationNode[] = []) =>
  ({ ...loc({ id, name }), children }) as unknown as InventoryLocationNode;

const TREE = [node('cab3', 'Cabinet 3', [node('shelf-a', 'Shelf A')]), node('yard', 'Yard')];

const onPick = vi.fn();

const setup = () => render(<StorageSearch companyId="co1" tree={TREE} onPick={onPick} />);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(searchPartPlacements).mockResolvedValue([]);
});

describe('StorageSearch', () => {
  it('offers matching locations', async () => {
    const user = userEvent.setup();
    setup();

    await user.type(screen.getByPlaceholderText(/find a part or a location/i), 'cab');
    expect(await screen.findByRole('option', { name: /Cabinet 3/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Yard/ })).not.toBeInTheDocument();
  });

  /** The dead end, closed: a part number typed into the only box now answers. */
  it('finds a part', async () => {
    const user = userEvent.setup();
    vi.mocked(searchPartPlacements).mockResolvedValue([
      {
        partId: 'p-oring',
        partName: 'BUY-ORING-214',
        primaryUnit: 'ea',
        locationId: 'shelf-a',
        quantity: 828,
      },
    ]);
    setup();

    await user.type(screen.getByPlaceholderText(/find a part or a location/i), 'oring');
    expect(await screen.findByRole('option', { name: /BUY-ORING-214/ })).toBeInTheDocument();
  });

  /**
   * The dropdown picks the PART. Where it lives is the answer, and it belongs on a surface that
   * stays rather than in a menu that closes the moment you look away from it.
   */
  it('hands back the part, not a location', async () => {
    const user = userEvent.setup();
    vi.mocked(searchPartPlacements).mockResolvedValue([
      {
        partId: 'p-oring',
        partName: 'BUY-ORING-214',
        primaryUnit: 'ea',
        locationId: 'shelf-a',
        quantity: 828,
      },
    ]);
    setup();

    await user.type(screen.getByPlaceholderText(/find a part or a location/i), 'oring');
    await user.click(await screen.findByRole('option', { name: /BUY-ORING-214/ }));

    expect(onPick).toHaveBeenCalledWith({
      kind: 'part',
      id: 'p-oring',
      label: 'BUY-ORING-214',
      unit: 'ea',
    });
  });

  it('hands back the unit when a location is picked', async () => {
    const user = userEvent.setup();
    setup();

    await user.type(screen.getByPlaceholderText(/find a part or a location/i), 'yard');
    await user.click(await screen.findByRole('option', { name: /Yard/ }));

    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ kind: 'place', id: 'yard' }));
  });

  /**
   * ONE ROW PER PART.
   *
   * The read returns a row per (part, place) because that is what stock is — the same part on three
   * shelves is three rows. Listing them as three options made you choose a shelf before you had
   * seen what the choices were, and showed the part's name three times over.
   */
  it('lists a part once however many locations it is in', async () => {
    const user = userEvent.setup();
    vi.mocked(searchPartPlacements).mockResolvedValue([
      { partId: 'p1', partName: 'BUY-ORING-214', primaryUnit: 'ea', locationId: 'shelf-a', quantity: 828 },
      { partId: 'p1', partName: 'BUY-ORING-214', primaryUnit: 'ea', locationId: 'yard', quantity: 552 },
    ]);
    setup();

    await user.type(screen.getByPlaceholderText(/find a part or a location/i), 'oring');

    expect(await screen.findAllByRole('option', { name: /BUY-ORING-214/ })).toHaveLength(1);
  });

  /** One character matches most of a catalogue; the server is not asked until it means something. */
  it('does not search on a single character', async () => {
    const user = userEvent.setup();
    setup();

    await user.type(screen.getByPlaceholderText(/find a part or a location/i), 'o');
    await waitFor(() => expect(searchPartPlacements).not.toHaveBeenCalled());
  });

  it('says nothing matched rather than looking broken', async () => {
    const user = userEvent.setup();
    setup();

    await user.type(screen.getByPlaceholderText(/find a part or a location/i), 'zzzz');
    expect(await screen.findByText(/nothing in storage matches/i)).toBeInTheDocument();
  });
});
