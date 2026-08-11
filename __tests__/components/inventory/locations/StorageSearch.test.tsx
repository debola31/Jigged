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

const LOCATIONS = [
  loc({ id: 'cab3', name: 'Cabinet 3', kind: 'cabinet' }),
  loc({ id: 'shelf-a', name: 'Shelf A', parent_id: 'cab3' }),
  loc({ id: 'yard', name: 'Yard' }),
];

const BY_ID = new Map(LOCATIONS.map((l) => [l.id, l] as const));

const node = (id: string, name: string, children: InventoryLocationNode[] = []) =>
  ({ ...loc({ id, name }), children }) as unknown as InventoryLocationNode;

const TREE = [node('cab3', 'Cabinet 3', [node('shelf-a', 'Shelf A')]), node('yard', 'Yard')];

const onPick = vi.fn();

const setup = () =>
  render(<StorageSearch companyId="co1" tree={TREE} byId={BY_ID} onPick={onPick} />);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(searchPartPlacements).mockResolvedValue([]);
});

describe('StorageSearch', () => {
  it('offers matching places', async () => {
    const user = userEvent.setup();
    setup();

    await user.type(screen.getByPlaceholderText(/find a part or a place/i), 'cab');
    expect(await screen.findByRole('option', { name: /Cabinet 3/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Yard/ })).not.toBeInTheDocument();
  });

  /** The dead end, closed: a part number typed into the only box now answers. */
  it('finds a part, and says which shelf it is on', async () => {
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

    await user.type(screen.getByPlaceholderText(/find a part or a place/i), 'oring');

    expect(await screen.findByRole('option', { name: /BUY-ORING-214/ })).toBeInTheDocument();
    // The PATH is the answer, so it is on the row rather than a click away.
    expect(screen.getByText(/Cabinet 3 › Shelf A · 828 ea/)).toBeInTheDocument();
  });

  /**
   * A part hit resolves to the BIN and to the unit that owns it. Landing on the cabinet would
   * leave the last step — which of its shelves — to be guessed off a grid.
   */
  it('hands back the bin and its unit when a part is picked', async () => {
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

    await user.type(screen.getByPlaceholderText(/find a part or a place/i), 'oring');
    await user.click(await screen.findByRole('option', { name: /BUY-ORING-214/ }));

    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'part', locationId: 'shelf-a', unitId: 'cab3' }),
    );
  });

  it('hands back the unit when a place is picked', async () => {
    const user = userEvent.setup();
    setup();

    await user.type(screen.getByPlaceholderText(/find a part or a place/i), 'yard');
    await user.click(await screen.findByRole('option', { name: /Yard/ }));

    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ kind: 'place', id: 'yard' }));
  });

  /** The same part in three bins is three rows — you want the shelf, not the total. */
  it('lists a part once per place it is in', async () => {
    const user = userEvent.setup();
    vi.mocked(searchPartPlacements).mockResolvedValue([
      { partId: 'p1', partName: 'BUY-ORING-214', primaryUnit: 'ea', locationId: 'shelf-a', quantity: 828 },
      { partId: 'p1', partName: 'BUY-ORING-214', primaryUnit: 'ea', locationId: 'yard', quantity: 552 },
    ]);
    setup();

    await user.type(screen.getByPlaceholderText(/find a part or a place/i), 'oring');

    expect(await screen.findAllByRole('option', { name: /BUY-ORING-214/ })).toHaveLength(2);
  });

  /** One character matches most of a catalogue; the server is not asked until it means something. */
  it('does not search on a single character', async () => {
    const user = userEvent.setup();
    setup();

    await user.type(screen.getByPlaceholderText(/find a part or a place/i), 'o');
    await waitFor(() => expect(searchPartPlacements).not.toHaveBeenCalled());
  });

  it('says nothing matched rather than looking broken', async () => {
    const user = userEvent.setup();
    setup();

    await user.type(screen.getByPlaceholderText(/find a part or a place/i), 'zzzz');
    expect(await screen.findByText(/nothing in storage matches/i)).toBeInTheDocument();
  });
});
