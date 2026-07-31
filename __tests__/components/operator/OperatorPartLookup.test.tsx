import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/__tests__/test-utils';
import userEvent from '@testing-library/user-event';

vi.mock('@/utils/partsAccess', () => ({ searchPartsForSelect: vi.fn() }));
vi.mock('@/utils/inventoryLocationsAccess', () => ({ getBalancesForPart: vi.fn() }));

import OperatorPartLookup from '@/components/operator/OperatorPartLookup';
import { searchPartsForSelect, type PartSelectOption } from '@/utils/partsAccess';
import { getBalancesForPart } from '@/utils/inventoryLocationsAccess';

const mockSearch = vi.mocked(searchPartsForSelect);
const mockBalances = vi.mocked(getBalancesForPart);

const part = (over: Partial<PartSelectOption> = {}): PartSelectOption => ({
  id: 'p1',
  part_name: 'RAW-AL6061-BLANK',
  description: 'Aluminum 6061 machining blank',
  has_routing: false,
  is_stocked: true,
  is_location_tracked: true,
  source: 'bought',
  primary_unit: 'ea',
  quantity: 240,
  ...over,
});

const onOpenLocation = vi.fn();
const renderLookup = () =>
  render(<OperatorPartLookup companyId="co1" onOpenLocation={onOpenLocation} />);

/** Type enough to clear the min-query floor and let the debounce fire. */
const search = async (user: ReturnType<typeof userEvent.setup>, text = '6061') => {
  await user.type(screen.getByLabelText('Find a part'), text);
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSearch.mockResolvedValue([part()]);
  mockBalances.mockResolvedValue([]);
});

describe('OperatorPartLookup — J11, "is this part in storage, and where?"', () => {
  it('finds a part and shows every place it sits, with the full path', async () => {
    const user = userEvent.setup();
    mockBalances.mockResolvedValue([
      { location_id: 'l1', location_name: 'Left', location_code: 'CAB1-R3-L', path: ['Cabinet 1', 'Row 3', 'Left'], quantity: 40 },
      { location_id: 'l2', location_name: 'Yard', location_code: 'YARD', path: ['Yard'], quantity: 200 },
    ]);
    renderLookup();
    await search(user);

    await user.click(await screen.findByText('RAW-AL6061-BLANK'));

    expect(await screen.findByText('Left')).toBeInTheDocument();
    // "Left" is meaningless on its own — the ancestry is what sends someone to the right shelf.
    expect(screen.getByText('Cabinet 1 › Row 3 › Left')).toBeInTheDocument();
    expect(screen.getByText('40 ea')).toBeInTheDocument();
    expect(screen.getByText('200 ea')).toBeInTheDocument();
    expect(screen.getByText(/240 ea across 2 places/)).toBeInTheDocument();
  });

  it('navigates to the place, which is the point of looking it up', async () => {
    const user = userEvent.setup();
    mockBalances.mockResolvedValue([
      { location_id: 'l1', location_name: 'Yard', location_code: null, path: ['Yard'], quantity: 12 },
    ]);
    renderLookup();
    await search(user);
    await user.click(await screen.findByText('RAW-AL6061-BLANK'));
    await user.click(await screen.findByText('Yard'));

    expect(onOpenLocation).toHaveBeenCalledWith('l1');
  });

  /**
   * The distinction this screen exists to keep straight. An untracked part has no
   * `part_location_stock` rows at all, so the balances read is empty for the same reason a
   * genuinely-empty tracked part is — and telling someone their 240 on hand are "nowhere" would
   * send them looking for stock that is sitting right there, just unbinned.
   */
  it('says an untracked part is not binned, never that it is nowhere', async () => {
    const user = userEvent.setup();
    renderLookup();
    mockSearch.mockResolvedValue([part({ is_location_tracked: false, quantity: 240 })]);
    await search(user);
    await user.click(await screen.findByText('RAW-AL6061-BLANK'));

    expect(await screen.findByText(/isn't tracked by place/i)).toBeInTheDocument();
    expect(screen.getByText(/240/)).toBeInTheDocument();
    expect(screen.queryByText(/none in any place/i)).not.toBeInTheDocument();
    // No point asking for balances that cannot exist.
    expect(mockBalances).not.toHaveBeenCalled();
  });

  it('says a tracked part with no stock is genuinely nowhere', async () => {
    const user = userEvent.setup();
    mockBalances.mockResolvedValue([]);
    renderLookup();
    await search(user);
    await user.click(await screen.findByText('RAW-AL6061-BLANK'));

    expect(await screen.findByText(/none in any place right now/i)).toBeInTheDocument();
    expect(screen.queryByText(/isn't tracked by place/i)).not.toBeInTheDocument();
  });

  it('searches stocked parts only — a top-level product has no on-hand to find', async () => {
    const user = userEvent.setup();
    renderLookup();
    await search(user);
    await waitFor(() =>
      expect(mockSearch).toHaveBeenCalledWith('co1', '6061', 'stocked', expect.any(Number)),
    );
  });

  it('does not search on one character, which would match most of the catalogue', async () => {
    const user = userEvent.setup();
    renderLookup();
    await user.type(screen.getByLabelText('Find a part'), 'a');
    await new Promise((r) => setTimeout(r, 400));
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('says so when nothing matches, rather than showing an empty page', async () => {
    const user = userEvent.setup();
    mockSearch.mockResolvedValue([]);
    renderLookup();
    await search(user, 'zzzz');
    expect(await screen.findByText(/no stocked part matches/i)).toBeInTheDocument();
  });

  it('surfaces a failed search instead of looking like no results', async () => {
    const user = userEvent.setup();
    mockSearch.mockRejectedValue(new Error('denied'));
    renderLookup();
    await search(user);
    expect(await screen.findByText('denied')).toBeInTheDocument();
  });
});
