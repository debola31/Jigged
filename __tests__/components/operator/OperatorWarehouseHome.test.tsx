import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

import type { PartSelectOption } from '@/utils/partsAccess';
import type { LocationHistoryEntry } from '@/types/inventoryLocations';

const mockPush = vi.fn();
const mockNavPush = vi.fn();
const mockReplace = vi.fn();
let searchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useParams: () => ({ companyId: 'co1' }),
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useSearchParams: () => searchParams,
}));

/**
 * The chrome's `push` is what tells the header back button there is in-app history to pop. Mocked
 * separately from the raw router so a test can prove which one a navigation went through — the
 * whole bug was that this branch used the raw one, leaving the depth counter at zero.
 */
vi.mock('@/components/operator/OperatorChromeContext', () => ({
  useOperatorNav: () => ({ push: mockNavPush, goBack: vi.fn() }),
}));

/**
 * `lib/supabase` creates its browser client eagerly at module scope, so importing the real
 * access layer in jsdom throws "Your project's URL and API key are required" before any test
 * runs. Stubbing the two getters is the established pattern in this repo.
 */
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({}),
}));

vi.mock('@/utils/inventoryLocationsAccess', () => ({
  getRecentActivity: vi.fn(),
  getBalancesForPart: vi.fn().mockResolvedValue([]),
  getLocations: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/utils/partsAccess', () => ({
  getPartsForSelectByIds: vi.fn(async () => [
    {
      id: 'p1',
      part_name: 'RAW-AL6061-BLANK',
      description: null,
      has_routing: false,
      is_stocked: true,
      source: 'bought',
      primary_unit: 'ea',
      quantity: 240,
    },
  ]),
}));

/**
 * Stub the shared picker, as `OperatorPartLookup.test.tsx` does — what matters on THIS page is
 * which of the two modes is showing, not MUI's Autocomplete.
 */
const PART: PartSelectOption = {
  id: 'p1',
  part_name: 'RAW-AL6061-BLANK',
  description: null,
  has_routing: false,
  is_stocked: true,
  source: 'bought',
  primary_unit: 'ea',
  quantity: 240,
};

vi.mock('@/components/parts/PartAutocomplete', () => ({
  __esModule: true,
  // Renders its `value`, so a test can tell "the field shows this part" from "the field is empty"
  // — which is the whole difference between a Back that worked and one that did not.
  default: (props: {
    value: PartSelectOption | null;
    onChange: (o: PartSelectOption | null) => void;
  }) => (
    <div>
      <span data-testid="picked">{props.value?.part_name ?? ''}</span>
      <button type="button" onClick={() => props.onChange(PART)}>
        pick-part
      </button>
      <button type="button" onClick={() => props.onChange(null)}>
        clear-part
      </button>
    </div>
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
  searchParams = new URLSearchParams();
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
    // Through the CHROME's push, not the raw router: that is what lets the header back button
    // pop real history instead of climbing to whatever this bin's parent happens to be.
    expect(mockNavPush).toHaveBeenCalledWith('/operator/co1/inventory/locations/l1');
    expect(mockPush).not.toHaveBeenCalled();
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
    expect(await screen.findByText(/scan a label to store something/i)).toBeInTheDocument();
  });
});

/**
 * Back has to land on the part you came from, and a page is only "where you came from" if it can
 * be rebuilt. The selection used to live in local state alone, so returning here after tapping a
 * location showed an empty search box and the answer had to be found again.
 */
describe('OperatorWarehouseHomePage — the selection survives a Back', () => {
  it('writes the chosen part into the URL, with replace so Back does not step through them', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/no stock has moved yet/i);

    await user.click(screen.getByRole('button', { name: 'pick-part' }));

    expect(mockReplace).toHaveBeenCalledWith('/operator/co1/inventory?part=p1', { scroll: false });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('strips the param when the part is cleared', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/no stock has moved yet/i);

    await user.click(screen.getByRole('button', { name: 'pick-part' }));
    await user.click(screen.getByRole('button', { name: 'clear-part' }));

    expect(mockReplace).toHaveBeenLastCalledWith('/operator/co1/inventory', { scroll: false });
  });

  it('rebuilds the part view from ?part= instead of showing the feed', async () => {
    searchParams = new URLSearchParams('part=p1');
    vi.mocked(getRecentActivity).mockResolvedValue([entry({ itemName: 'SOMETHING-ELSE' })]);
    renderPage();

    expect(await screen.findByTestId('picked')).toHaveTextContent('RAW-AL6061-BLANK');
    // Part selected means the shop-wide feed stays hidden, exactly as if you had just picked it.
    expect(screen.queryByText('SOMETHING-ELSE')).not.toBeInTheDocument();
  });
});
