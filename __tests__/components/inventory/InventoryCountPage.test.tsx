import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import jiggedTheme from '@/lib/theme';

const mockPush = vi.fn();
// `?location=` switches the sheet to place-scoped, so the search params are part of the fixture.
const searchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useParams: () => ({ companyId: 'co1' }),
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => searchParams,
}));

vi.mock('@/utils/inventoryCountAccess', () => ({
  loadCountCandidates: vi.fn(),
  loadLocationCountCandidates: vi.fn(),
  refreshSystemQuantities: vi.fn(),
  refreshLocationQuantities: vi.fn(),
  commitCount: vi.fn(),
}));

// The page reaches the locations access layer for put-away; unmocked it builds a real Supabase
// client at import time and the whole file fails to load.
vi.mock('@/utils/inventoryLocationsAccess', () => ({
  PUT_AWAY_MAX: 1000,
  bulkPutAway: vi.fn(),
  createLocation: vi.fn(),
  getLocations: vi.fn(async () => []),
}));

import InventoryCountPage from '@/app/dashboard/[companyId]/inventory/count/page';
import {
  loadCountCandidates,
  loadLocationCountCandidates,
  refreshSystemQuantities,
  refreshLocationQuantities,
  commitCount,
} from '@/utils/inventoryCountAccess';
import { bulkPutAway, getLocations } from '@/utils/inventoryLocationsAccess';
import type { CountCandidate } from '@/types/inventoryCount';

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

// This jsdom setup doesn't provide localStorage (no --localstorage-file), which is also a real
// browser case — private mode and some webviews. The page tolerates its absence; these tests
// need a working one to exercise the draft, so install a minimal in-memory shim.
const memoryStorage = () => {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      store = {};
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  } as Storage;
};
Object.defineProperty(window, 'localStorage', { value: memoryStorage(), writable: true });

const cand = (over: Partial<CountCandidate> & { partId: string }): CountCandidate => ({
  partName: over.partId,
  description: null,
  unit: 'ft',
  systemQuantity: 40,
  target: { kind: 'aggregate' },
  ...over,
});

const renderPage = () =>
  render(<InventoryCountPage />, {
    wrapper: ({ children }) => <ThemeProvider theme={jiggedTheme}>{children}</ThemeProvider>,
  });

/** The count input for a named part — every sheet row has one, so scope by label. */
const inputFor = (partName: string) =>
  screen.getByRole('spinbutton', { name: new RegExp(`counted quantity for ${partName}`, 'i') });

/** Pick parts on step 1 and advance to the sheet. */
const chooseParts = async (user: ReturnType<typeof userEvent.setup>, ...partNames: string[]) => {
  for (const name of partNames) {
    await user.click(screen.getByRole('checkbox', { name: new RegExp(`count ${name}`, 'i') }));
  }
  await user.click(screen.getByRole('button', { name: /^count \d+ parts?$/i }));
};

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  asMock(loadCountCandidates).mockResolvedValue([
    cand({ partId: 'p1', partName: '4140 bar', systemQuantity: 40 }),
    cand({ partId: 'p2', partName: '6061 plate', systemQuantity: 12 }),
  ]);
  asMock(refreshSystemQuantities).mockResolvedValue(new Map());
  asMock(commitCount).mockResolvedValue({ committed: 1, failures: [] });
});

describe('choosing what to count', () => {
  it('makes counting a single part an obvious option', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('4140 bar');
    // Framing says one part is fine, and the CTA counts what you picked — not everything.
    expect(screen.getByText(/one part or the whole shop/i)).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: /count 4140 bar/i }));
    expect(screen.getByRole('button', { name: /count 1 part$/i })).toBeEnabled();
  });

  it('cannot advance with nothing chosen', async () => {
    renderPage();
    await screen.findByText('4140 bar');
    expect(screen.getByRole('button', { name: /^count$/i })).toBeDisabled();
  });

  it('scopes the sheet to the chosen parts only', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('4140 bar');
    await chooseParts(user, '4140 bar');

    expect(inputFor('4140 bar')).toBeInTheDocument();
    expect(
      screen.queryByRole('spinbutton', { name: /counted quantity for 6061 plate/i }),
    ).not.toBeInTheDocument();
  });

  it('starts every input empty, so nothing can be tabbed past and accepted', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('4140 bar');
    await chooseParts(user, '4140 bar', '6061 plate');
    expect(inputFor('4140 bar')).toHaveValue(null);
    expect(inputFor('6061 plate')).toHaveValue(null);
  });

  it('names parts held back instead of dropping them silently', async () => {
    asMock(loadCountCandidates).mockResolvedValue([
      cand({ partId: 'p1', partName: '4140 bar' }),
      cand({
        partId: 'p9',
        partName: 'Split part',
        target: { kind: 'excluded', reason: 'Stock is split across 3 locations' },
      }),
    ]);
    renderPage();
    await screen.findByText('4140 bar');
    expect(screen.getByText(/not on this sheet/i)).toBeInTheDocument();
    expect(screen.getByText('Split part')).toBeInTheDocument();
  });

  it('shows an empty state when nothing is stocked', async () => {
    asMock(loadCountCandidates).mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText(/nothing to count yet/i)).toBeInTheDocument();
  });
});

describe('inline feedback', () => {
  /** Both parts on the sheet, ready to type into. */
  const onSheet = async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('4140 bar');
    await chooseParts(user, '4140 bar', '6061 plate');
    return user;
  };

  it('shows the delta on the row as soon as a number is typed', async () => {
    const user = await onSheet();
    await user.type(inputFor('4140 bar'), '38');
    expect(await screen.findByText('-2')).toBeInTheDocument();
  });

  it('says a count matches rather than showing a zero delta', async () => {
    const user = await onSheet();
    await user.type(inputFor('4140 bar'), '40');
    // Anchored: the footer also says "Everything matches so far".
    expect(await screen.findByText(/^No change$/)).toBeInTheDocument();
  });

  it('tracks progress against the chosen scope, in plain language', async () => {
    const user = await onSheet();
    expect(screen.getByText(/nothing entered yet/i)).toBeInTheDocument();

    await user.type(inputFor('4140 bar'), '40'); // matches
    expect(await screen.findByText(/everything matches so far/i)).toBeInTheDocument();

    await user.type(inputFor('6061 plate'), '9'); // changes
    expect(await screen.findByText('2 of 2 counted')).toBeInTheDocument();
    // Both parts are in 'ft', so the unit is stated once here rather than on every row.
    expect(screen.getByText(/1 will change · all in ft/)).toBeInTheDocument();
  });

  // The two quantity columns must name their *source*, not both claim to be the stock level —
  // "On hand" next to "Counted" read as the physical count, which is the other column.
  it('gives the sheet proper columns, and no per-row unit when they all match', async () => {
    await onSheet();
    expect(screen.getByRole('columnheader', { name: /^recorded$/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /counted/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /^change$/i })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /^unit$/i })).not.toBeInTheDocument();
  });

  it('adds a unit column when the sheet mixes units', async () => {
    asMock(loadCountCandidates).mockResolvedValue([
      cand({ partId: 'p1', partName: '4140 bar', unit: 'feet' }),
      cand({ partId: 'p2', partName: '6061 plate', unit: 'each' }),
    ]);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('4140 bar');
    await chooseParts(user, '4140 bar', '6061 plate');

    expect(screen.getByRole('columnheader', { name: /^unit$/i })).toBeInTheDocument();
  });

  it('cannot save when nothing would change', async () => {
    const user = await onSheet();
    expect(screen.getByRole('button', { name: /save 0 changes/i })).toBeDisabled();

    await user.type(inputFor('4140 bar'), '40'); // matches — still nothing to write
    expect(screen.getByRole('button', { name: /save 0 changes/i })).toBeDisabled();
  });

  it('clearing an input un-counts the row rather than counting it as zero', async () => {
    const user = await onSheet();
    await user.type(inputFor('4140 bar'), '38');
    expect(await screen.findByText('1 of 2 counted')).toBeInTheDocument();

    await user.clear(inputFor('4140 bar'));
    expect(await screen.findByText('0 of 2 counted')).toBeInTheDocument();
  });

  it('going back to the scope step keeps what has been typed', async () => {
    const user = await onSheet();
    await user.type(inputFor('4140 bar'), '38');
    await user.click(screen.getByRole('button', { name: /^back$/i }));

    await screen.findByText(/one part or the whole shop/i);
    await user.click(screen.getByRole('button', { name: /^count 2 parts$/i }));
    expect(inputFor('4140 bar')).toHaveValue(38);
  });
});

describe('saving', () => {
  const enterAndSave = async (partName: string, value: string) => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('4140 bar');
    await chooseParts(user, '4140 bar');
    await user.type(inputFor(partName), value);
    await user.click(screen.getByRole('button', { name: /save 1 change/i }));
    return user;
  };

  it('re-reads current quantities before writing', async () => {
    await enterAndSave('4140 bar', '38');
    await waitFor(() => expect(refreshSystemQuantities).toHaveBeenCalledWith(['p1']));
  });

  // Save saves. The confirm dialog that used to sit here restated rows still visible behind it
  // and warned on nearly every line, so it was removed — see the note on save() in the page.
  it('commits straight from the sheet, with no confirm step', async () => {
    await enterAndSave('4140 bar', '38');

    await waitFor(() => expect(commitCount).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    const [variances] = asMock(commitCount).mock.calls[0];
    expect(variances).toHaveLength(1);
    expect(variances[0].counted).toBe(38);
  });

  // Size is not a gate any more: a count that finds 2 where the system said 40 saves like any
  // other. Counting again is the fix, and the ledger records both numbers either way.
  it('does not treat a large change as something to ask about', async () => {
    await enterAndSave('4140 bar', '2'); // 40 -> 2

    await waitFor(() => expect(commitCount).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(asMock(commitCount).mock.calls[0][0][0].counted).toBe(2);
  });

  it('commits the quantity that was counted, not the one the sheet opened with', async () => {
    asMock(refreshSystemQuantities).mockResolvedValue(new Map([['p1', 44]]));
    await enterAndSave('4140 bar', '38');

    await waitFor(() => expect(commitCount).toHaveBeenCalled());
    const [variances] = asMock(commitCount).mock.calls[0];
    expect(variances[0].counted).toBe(38);
    // Delta is against the refreshed 44, not the 40 the sheet loaded with — countNote quotes
    // this number, so a stale one would put a wrong figure in the ledger.
    expect(variances[0].delta).toBe(-6);
  });

  it('says afterwards which parts moved while the count was open', async () => {
    asMock(refreshSystemQuantities).mockResolvedValue(new Map([['p1', 44]]));
    await enterAndSave('4140 bar', '38');

    expect(await screen.findByText(/moved while you were counting/i)).toBeInTheDocument();
  });

  it('saves nothing when the refresh shows the count already matches', async () => {
    asMock(refreshSystemQuantities).mockResolvedValue(new Map([['p1', 38]]));
    await enterAndSave('4140 bar', '38');

    expect(await screen.findByText(/everything already matches/i)).toBeInTheDocument();
    expect(commitCount).not.toHaveBeenCalled();
  });

  it('reports partial failure instead of claiming success', async () => {
    asMock(commitCount).mockResolvedValue({
      committed: 0,
      failures: [{ partName: '4140 bar', message: 'network died' }],
    });
    await enterAndSave('4140 bar', '38');

    expect(await screen.findByText(/could not be saved/i)).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe('draft', () => {
  const storeDraft = (partIds: string[], entries: Record<string, number>) =>
    window.localStorage.setItem(
      'jigged.inventoryCount.co1',
      JSON.stringify({ version: 3, companyId: 'co1', partIds, entries, savedAt: Date.now() }),
    );

  it('offers to resume, reporting how far the count got', async () => {
    storeDraft(['p1', 'p2'], { p1: 38 });
    renderPage();
    expect(await screen.findByText(/1 of 2 counted/i)).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: /resume/i }));
    // Straight back to the sheet, scope and entries restored.
    expect(await screen.findByText('1 of 2 counted')).toBeInTheDocument();
    expect(inputFor('4140 bar')).toHaveValue(38);
    expect(inputFor('6061 plate')).toHaveValue(null);
  });

  it('can be discarded to start clean', async () => {
    storeDraft(['p1'], { p1: 38 });
    renderPage();
    await screen.findByText(/unfinished count/i);

    await userEvent.setup().click(screen.getByRole('button', { name: /discard/i }));
    await waitFor(() => expect(screen.queryByText(/unfinished count/i)).not.toBeInTheDocument());
  });

  it('ignores a draft from another company', async () => {
    window.localStorage.setItem(
      'jigged.inventoryCount.co1',
      JSON.stringify({
        version: 3,
        companyId: 'SOMEONE-ELSE',
        partIds: ['p1'],
        entries: { p1: 5 },
        savedAt: Date.now(),
      }),
    );
    renderPage();
    await screen.findByText('4140 bar');
    expect(screen.queryByText(/unfinished count/i)).not.toBeInTheDocument();
  });

  it('drops parts that no longer exist rather than misattaching their numbers', async () => {
    storeDraft(['deleted-part', 'p1'], { 'deleted-part': 99, p1: 7 });
    renderPage();
    await screen.findByText(/unfinished count/i);

    await userEvent.setup().click(screen.getByRole('button', { name: /resume/i }));
    expect(await screen.findByText('1 of 1 counted')).toBeInTheDocument();
    expect(inputFor('4140 bar')).toHaveValue(7);
  });
});

/**
 * Place-scoped mode — `?location=<id>`.
 *
 * This is what §5.11 asked for ("place-scoped") and, at `Unassigned`, it is how a shop empties the
 * pile `trg_auto_track_stocked_part` created. So the put-away half is not a side feature of the
 * count sheet; it's the reason the location entry exists.
 */
describe('counting one place', () => {
  const LOC = 'loc-shelf-a';
  const here = (partId: string, quantity: number): CountCandidate =>
    cand({
      partId,
      quantity: undefined,
      systemQuantity: quantity,
      unit: 'ea',
      target: { kind: 'location', locationId: LOC, locationName: 'Shelf A' },
    } as Partial<CountCandidate> & { partId: string });

  beforeEach(() => {
    searchParams.set('location', LOC);
    asMock(getLocations).mockResolvedValue([
      { id: LOC, company_id: 'co1', parent_id: null, name: 'Shelf A', kind: 'shelf', code: null, sort_order: 0, created_at: '', updated_at: '' },
      { id: 'loc-yard', company_id: 'co1', parent_id: null, name: 'Yard', kind: 'outside', code: null, sort_order: 1, created_at: '', updated_at: '' },
      { id: 'loc-un', company_id: 'co1', parent_id: null, name: 'Unassigned', kind: 'system', code: null, sort_order: 2, created_at: '', updated_at: '' },
    ]);
    asMock(loadLocationCountCandidates).mockResolvedValue({
      candidates: [here('BUY-ORING-214', 828), here('BUY-BEARING-608ZZ', 580)],
      total: 2,
    });
    asMock(bulkPutAway).mockResolvedValue({ moved: 1, skipped: 0, transfer_group_id: 'g' });
  });

  afterEach(() => searchParams.delete('location'));

  it('names the place it is scoped to instead of the whole shop', async () => {
    renderPage();
    expect(await screen.findByText("What's in Shelf A?")).toBeInTheDocument();
    expect(loadLocationCountCandidates).toHaveBeenCalledWith(LOC, 'Shelf A', { search: '' });
  });

  it('reads this bin, not every stocked part in the company', async () => {
    renderPage();
    await screen.findByText("What's in Shelf A?");
    expect(loadCountCandidates).not.toHaveBeenCalled();
  });

  it('offers a destination for what does not belong here', async () => {
    renderPage();
    await screen.findByText("What's in Shelf A?");
    expect(screen.getByRole('combobox', { name: /send the ticked parts to/i })).toBeInTheDocument();
  });

  /** The put-away path: pick rows, pick a place, one atomic call. */
  it('sends the ticked parts away in a single call', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("What's in Shelf A?");

    await user.click(screen.getByRole('checkbox', { name: /count BUY-ORING-214/i }));
    await user.click(screen.getByRole('combobox', { name: /send the ticked parts to/i }));
    await user.click(await screen.findByRole('option', { name: /^Yard/ }));
    await user.click(screen.getByRole('button', { name: /put 1 away/i }));

    await waitFor(() => expect(bulkPutAway).toHaveBeenCalledTimes(1));
    expect(bulkPutAway).toHaveBeenCalledWith(LOC, 'loc-yard', ['BUY-ORING-214']);
  });

  /**
   * The rows just moved out of this location, so the result set shifted. Reusing the previous
   * offset would silently skip whatever moved up into it.
   */
  it('refetches from the start after a move rather than trusting the old page', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("What's in Shelf A?");
    asMock(loadLocationCountCandidates).mockClear();

    await user.click(screen.getByRole('checkbox', { name: /count BUY-ORING-214/i }));
    await user.click(screen.getByRole('combobox', { name: /send the ticked parts to/i }));
    await user.click(await screen.findByRole('option', { name: /^Yard/ }));
    await user.click(screen.getByRole('button', { name: /put 1 away/i }));

    await waitFor(() => expect(loadLocationCountCandidates).toHaveBeenCalled());
    const [, , opts] = asMock(loadLocationCountCandidates).mock.calls[0];
    expect(opts.offset ?? 0).toBe(0);
  });

  it('reports what had nothing here to move rather than claiming it all moved', async () => {
    const user = userEvent.setup();
    asMock(bulkPutAway).mockResolvedValue({ moved: 1, skipped: 3, transfer_group_id: 'g' });
    renderPage();
    await screen.findByText("What's in Shelf A?");

    await user.click(screen.getByRole('checkbox', { name: /count BUY-ORING-214/i }));
    await user.click(screen.getByRole('combobox', { name: /send the ticked parts to/i }));
    await user.click(await screen.findByRole('option', { name: /^Yard/ }));
    await user.click(screen.getByRole('button', { name: /put 1 away/i }));

    expect(await screen.findByText(/3 had nothing here to move/i)).toBeInTheDocument();
  });

  it('surfaces a refusal instead of reporting success', async () => {
    const user = userEvent.setup();
    // Shaped like a real PostgREST rejection, not a plain Error: Supabase errors are objects with
    // a SQLSTATE, and `friendlyErrorMessage` keys off that to decide whether the text is ours to
    // show. A bare `new Error(...)` here would have passed while production showed a fallback.
    asMock(bulkPutAway).mockRejectedValue({
      code: '23514',
      message: 'Too many parts at once (1001 of a maximum 1000). Narrow your search and put them away in smaller batches.',
    });
    renderPage();
    await screen.findByText("What's in Shelf A?");

    await user.click(screen.getByRole('checkbox', { name: /count BUY-ORING-214/i }));
    await user.click(screen.getByRole('combobox', { name: /send the ticked parts to/i }));
    await user.click(await screen.findByRole('option', { name: /^Yard/ }));
    await user.click(screen.getByRole('button', { name: /put 1 away/i }));

    expect(await screen.findByText(/Too many parts at once/i)).toBeInTheDocument();
  });

  /**
   * `refreshSystemQuantities` reads `parts.quantity` — the roll-up across every bin. Using it for a
   * shelf count would compare against the whole shop's total and flag a variance on every line.
   */
  it('re-reads THIS bin before saving, not the company-wide total', async () => {
    const user = userEvent.setup();
    asMock(refreshLocationQuantities).mockResolvedValue(new Map([['BUY-ORING-214', 828]]));
    asMock(commitCount).mockResolvedValue({ committed: 1, failures: [] });
    renderPage();
    await screen.findByText("What's in Shelf A?");

    await chooseParts(user, 'BUY-ORING-214');
    await user.type(inputFor('BUY-ORING-214'), '830');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(refreshLocationQuantities).toHaveBeenCalledWith(LOC, ['BUY-ORING-214']));
    expect(refreshSystemQuantities).not.toHaveBeenCalled();
  });

  it('admits when the bin holds more than the page shows', async () => {
    asMock(loadLocationCountCandidates).mockResolvedValue({
      candidates: [here('BUY-ORING-214', 828)],
      total: 9428,
    });
    renderPage();
    expect(await screen.findByText(/showing 1 of 9,428 parts here/i)).toBeInTheDocument();
  });

  // The RPC caps the array to bound how long it holds row locks; say so before someone selects
  // 2,000 rows and is refused.
  it('refuses to select-all past the cap', async () => {
    asMock(loadLocationCountCandidates).mockResolvedValue({
      candidates: Array.from({ length: 1001 }, (_, i) => here(`P${i}`, 1)),
      total: 1001,
    });
    renderPage();
    await screen.findByText("What's in Shelf A?");
    expect(screen.getByRole('button', { name: /select all/i })).toBeDisabled();
  });
});
