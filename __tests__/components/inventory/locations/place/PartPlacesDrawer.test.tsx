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
  render(<PartPlacesDrawer part={part} onClose={onClose} onOpenPlace={onOpenPlace} />);

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
  it('lists every place the part is, with full paths', async () => {
    setup();

    expect(await screen.findByRole('heading', { name: 'BUY-ORING-214' })).toBeInTheDocument();
    expect(screen.getByText('Cabinet 3 › Shelf A')).toBeInTheDocument();
    expect(screen.getByText('Cabinet 3 › Shelf B')).toBeInTheDocument();
  });

  /** The one sum on the screen, and it is safe: balances are stored in the part's primary unit. */
  it('totals across places', async () => {
    setup();
    expect(await screen.findByText(/1,380 ea across 2 places/i)).toBeInTheDocument();
  });

  it('walks to a place', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(await screen.findByRole('button', { name: /open Cabinet 3 › Shelf B/i }));
    expect(onOpenPlace).toHaveBeenCalledWith('shelf-b');
  });

  /**
   * The pile is listed — leaving it out would answer "nowhere" for a part sitting in it — but it is
   * marked, because walking to `Unassigned` is not a thing anyone can do.
   */
  it('marks the put-away pile rather than showing it as a shelf', async () => {
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
    expect(screen.getByText(/not put away yet/i)).toBeInTheDocument();
  });

  it('says plainly when a part is in no place at all', async () => {
    vi.mocked(getBalancesForPart).mockResolvedValue([]);
    setup();

    expect(await screen.findByText(/is not recorded in any place/i)).toBeInTheDocument();
    expect(screen.getByText(/not in any place/i)).toBeInTheDocument();
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
