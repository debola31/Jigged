/**
 * One part, and everywhere it is.
 *
 * This is the surface the search now hands off to. The behaviour worth defending is that it is
 * AUTHORITATIVE — it re-reads rather than reusing the search's rows, which are capped — and that it
 * never presents the put-away pile as a shelf someone could walk to.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '../../../../test-utils';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}) }));

vi.mock('@/utils/inventoryLocationsAccess', () => ({
  getBalancesForPart: vi.fn(async () => []),
}));

import PartPlacesDrawer from '@/components/inventory/locations/place/PartPlacesDrawer';
import { getBalancesForPart } from '@/utils/inventoryLocationsAccess';

const PART = { id: 'p-oring', name: 'BUY-ORING-214', unit: 'ea' };

const onOpenPlace = vi.fn();
const onClose = vi.fn();

const setup = (part: typeof PART | null = PART) =>
  render(
    <PartPlacesDrawer
      part={part}
      companyId="co1"
      moveDestinations={[{ id: 'bin6', label: 'Cabinet 3 › Bin 6' }]}
      onClose={onClose}
      onOpenPlace={onOpenPlace}
      onChanged={vi.fn()}
    />,
  );

/** The row is the toggle now; opening a bin lives inside the section it opens. */
const expandRow = async (user: ReturnType<typeof userEvent.setup>, path: string) =>
  user.click(await screen.findByRole('button', { name: new RegExp(`^${path}`) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBalancesForPart).mockResolvedValue([
    {
      location_id: 'shelf-a',
      location_name: 'Shelf A',
      path: ['Cabinet 3', 'Shelf A'],
      quantity: 828,
      kind: null,
    },
    {
      location_id: 'shelf-b',
      location_name: 'Shelf B',
      path: ['Cabinet 3', 'Shelf B'],
      quantity: 552,
      kind: null,
    },
  ]);
});

describe('PartPlacesDrawer', () => {
  it('lists every location the part is in, with full paths', async () => {
    setup();

    expect(await screen.findByRole('heading', { name: 'BUY-ORING-214' })).toBeInTheDocument();
    expect(screen.getByText('Cabinet 3 › Shelf A')).toBeInTheDocument();
    expect(screen.getByText('Cabinet 3 › Shelf B')).toBeInTheDocument();
  });

  /** The one sum on the screen, and it is safe: balances are stored in the part's primary unit. */
  it('totals across locations', async () => {
    setup();
    expect(await screen.findByText(/1,380 ea across 2 locations/i)).toBeInTheDocument();
  });

  /**
   * The row EXPANDS rather than navigating. You arrived holding a part and a place; being sent to
   * a bin makes you re-find the part among everything in it.
   */
  it('expands a location into the four verbs instead of navigating', async () => {
    const user = userEvent.setup();
    setup();

    await expandRow(user, 'Cabinet 3 › Shelf B');

    for (const verb of [/^add$/i, /^remove$/i, /^move$/i, /^adjust$/i]) {
      expect(screen.getByRole('button', { name: verb })).toBeInTheDocument();
    }
    expect(onOpenPlace).not.toHaveBeenCalled();
  });

  /** Inside the section, not a second target on the row — that ambiguity was removed elsewhere. */
  it('still offers the bin, from inside the expanded section', async () => {
    const user = userEvent.setup();
    setup();

    await expandRow(user, 'Cabinet 3 › Shelf B');
    await user.click(screen.getByRole('button', { name: /open bin/i }));
    expect(onOpenPlace).toHaveBeenCalledWith('shelf-b');
  });

  it('opens one location at a time', async () => {
    const user = userEvent.setup();
    setup();

    await expandRow(user, 'Cabinet 3 › Shelf A');
    expect(screen.getByRole('button', { name: /open bin/i })).toBeInTheDocument();

    await expandRow(user, 'Cabinet 3 › Shelf B');
    // Still exactly one section open — two forms at once is a form nobody finished.
    expect(screen.getAllByRole('button', { name: /open bin/i })).toHaveLength(1);
  });

  /**
   * The pile is listed — leaving it out would answer "nowhere" for a part sitting in it — but it is
   * marked, because walking to `Unassigned` is not a thing anyone can do.
   */
  it('marks the pile rather than showing it as a location the part lives in', async () => {
    vi.mocked(getBalancesForPart).mockResolvedValue([
      {
        location_id: 'un',
        location_name: 'Unassigned',
        path: ['Unassigned'],
        quantity: 40,
        kind: 'system',
      },
    ]);
    setup();

    expect(await screen.findByText('Unassigned')).toBeInTheDocument();
    expect(screen.getByText(/not stored yet/i)).toBeInTheDocument();
  });

  it('says plainly when a part is in no location at all', async () => {
    vi.mocked(getBalancesForPart).mockResolvedValue([]);
    setup();

    expect(await screen.findByText(/is not recorded in any location/i)).toBeInTheDocument();
    expect(screen.getByText(/not in any location/i)).toBeInTheDocument();
  });

  /** Authoritative: it asks its own question rather than reusing the search's capped rows. */
  it('re-reads the part rather than trusting what found it', async () => {
    setup();
    await screen.findByRole('heading', { name: 'BUY-ORING-214' });
    expect(getBalancesForPart).toHaveBeenCalledWith('p-oring');
  });

  it('renders nothing with no part', () => {
    setup(null);
    expect(screen.queryByRole('heading', { name: 'BUY-ORING-214' })).not.toBeInTheDocument();
    expect(getBalancesForPart).not.toHaveBeenCalled();
  });
});
