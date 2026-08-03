import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import type { PartSelectOption } from '@/utils/partsAccess';
import type { LocationHistoryEntry } from '@/types/inventoryLocations';

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useParams: () => ({ companyId: 'co1' }),
  useRouter: () => ({ push: mockPush }),
}));

/**
 * `lib/supabase` creates its browser client eagerly at module scope, so importing the real
 * access layer in jsdom throws "Your project's URL and API key are required" before any test
 * runs. Stubbing the two getters is the established pattern in this repo.
 */
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({}),
  getTypedSupabase: () => ({}),
}));

vi.mock('@/utils/inventoryLocationsAccess', () => ({
  getRecentActivity: vi.fn(),
  getBalancesForPart: vi.fn().mockResolvedValue([]),
  getLocations: vi.fn().mockResolvedValue([]),
}));

/**
 * Stub the shared picker, as `OperatorPartLookup.test.tsx` does — what matters on THIS page is
 * which of the two modes is showing, not MUI's Autocomplete.
 */
vi.mock('@/components/parts/PartAutocomplete', () => ({
  __esModule: true,
  default: (props: { onChange: (o: PartSelectOption | null) => void }) => (
    <button
      type="button"
      onClick={() =>
        props.onChange({
          id: 'p1',
          part_name: 'RAW-AL6061-BLANK',
          description: null,
          has_routing: false,
          is_stocked: true,
          source: 'bought',
          primary_unit: 'ea',
          quantity: 240,
        })
      }
    >
      pick-part
    </button>
  ),
}));

import OperatorWarehouseHomePage from '@/app/operator/[companyId]/inventory/page';
import { getRecentActivity } from '@/utils/inventoryLocationsAccess';

const entry = (over: Partial<LocationHistoryEntry> = {}): LocationHistoryEntry => ({
  id: 't1',
  type: 'addition',
  quantity: 7,
  unit: 'ea',
  notes: null,
  createdAt: '2026-07-30T14:20:00Z',
  actorName: 'Dev Seed User',
  photoUrl: null,
  itemName: 'RAW-AL6061-BLANK',
  locationId: 'l1',
  locationName: 'Shelf A',
  hasDiscrepancy: false,
  ...over,
});

const renderPage = () =>
  render(<OperatorWarehouseHomePage />, {
    wrapper: ({ children }) => <ThemeProvider theme={jiggedTheme}>{children}</ThemeProvider>,
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRecentActivity).mockResolvedValue([]);
});

describe('OperatorWarehouseHomePage — item-first Inventory tab', () => {
  it('leads with recent activity when nothing is selected', async () => {
    vi.mocked(getRecentActivity).mockResolvedValue([entry()]);
    renderPage();

    expect(await screen.findByText('+7 ea')).toBeInTheDocument();
    expect(screen.getByText('RAW-AL6061-BLANK')).toBeInTheDocument();
  });

  /** The one thing the drawn board did that nothing else does: reach a bin whose label came off. */
  it('taps through from a movement to the place it happened in', async () => {
    const user = userEvent.setup();
    vi.mocked(getRecentActivity).mockResolvedValue([entry()]);
    renderPage();

    // The whole card is the target, not a caption-height link — under 20px in a bright shop.
    await user.click(await screen.findByRole('button', { name: 'Open Shelf A' }));
    expect(mockPush).toHaveBeenCalledWith('/operator/co1/inventory/locations/l1');
  });

  /** Mid-lookup the shop-wide feed is noise — this is what keeps the page from becoming a wall. */
  it('hides the feed once a part is chosen', async () => {
    const user = userEvent.setup();
    vi.mocked(getRecentActivity).mockResolvedValue([entry({ itemName: 'SOMETHING-ELSE' })]);
    renderPage();
    await screen.findByText('SOMETHING-ELSE');

    await user.click(screen.getByRole('button', { name: 'pick-part' }));

    expect(screen.queryByText('SOMETHING-ELSE')).not.toBeInTheDocument();
    expect(screen.queryByText(/recent activity/i)).not.toBeInTheDocument();
  });

  /** Creating storage is an owner's job; an operator doing it mid-shift is how MISC 8-25-21 happens. */
  it('offers no way to add storage', async () => {
    renderPage();
    await screen.findByText(/no stock has moved yet/i);

    expect(screen.queryByRole('button', { name: /add storage/i })).not.toBeInTheDocument();
  });

  /**
   * An empty feed must not read as "the shop is empty" — it is a brand-new install, and the copy
   * points at the action that fills it.
   */
  it('tells a new shop what to do instead of showing an empty board', async () => {
    renderPage();
    expect(await screen.findByText(/scan a shelf label to put something away/i)).toBeInTheDocument();
  });
});
