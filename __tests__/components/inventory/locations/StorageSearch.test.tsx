/**
 * The Places tab's search: one box that finds a LOCATION.
 *
 * It used to find parts too, and most of this file defended that half. Both went to the Inventory
 * tab on 2026-09-09 — the dead end the parts half closed (typing a part number into the only search
 * on the page and being told "Nothing matches") is now closed by a whole tab for parts, and a
 * search on the Places tab that answered with parts would be answering with things this tab cannot
 * show. What is left is what this box is for, plus one test that pins the removal.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '../../../test-utils';
import userEvent from '@testing-library/user-event';

import StorageSearch from '@/components/inventory/locations/StorageSearch';
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

const node = (id: string, name: string, children: InventoryLocationNode[] = []) =>
  ({ ...loc({ id, name }), children }) as unknown as InventoryLocationNode;

const TREE = [node('cab3', 'Cabinet 3', [node('shelf-a', 'Shelf A')]), node('yard', 'Yard')];

const onPick = vi.fn();
const setup = () => render(<StorageSearch tree={TREE} onPick={onPick} />);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('StorageSearch', () => {
  it('offers matching locations', async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByRole('combobox'), 'Cab');
    expect(await screen.findByText('Cabinet 3')).toBeInTheDocument();
    expect(screen.queryByText('Yard')).not.toBeInTheDocument();
  });

  it('hands back the unit that was picked, and clears itself', async () => {
    const user = userEvent.setup();
    setup();
    const box = screen.getByRole('combobox');
    await user.type(box, 'Cab');
    await user.click(await screen.findByText('Cabinet 3'));

    expect(onPick).toHaveBeenCalledWith({ kind: 'place', id: 'cab3', label: 'Cabinet 3' });
    // A search, not a selection that sticks: picking navigates and the box empties.
    expect(box).toHaveValue('');
  });

  it('says no unit matched, rather than looking broken', async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByRole('combobox'), 'zzzz');
    expect(await screen.findByText(/No storage unit matches/)).toBeInTheDocument();
  });

  /**
   * The removal, pinned.
   *
   * A part number typed here must find nothing — not because parts are unfindable, but because
   * they are found on the other tab. If this box ever starts answering with parts again there are
   * two searches that both find parts, and the one on the board answers with things the board
   * cannot show.
   */
  it('does not answer with parts — that is the Inventory tab', async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByRole('combobox'), 'BUY-ORING-214');
    expect(await screen.findByText(/No storage unit matches/)).toBeInTheDocument();
  });
});
