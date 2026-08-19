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

vi.mock('@/utils/operatorAccess', () => ({
  getCurrentMember: vi.fn(async () => ({ id: 'member-1', name: 'Owner' })),
}));

vi.mock('@/utils/inventoryCountAccess', () => ({
  loadCountCandidates: vi.fn(),
  loadCountCandidatesForPlaces: vi.fn(),
  loadPartAtLocationCandidate: vi.fn(),
  loadPartEverywhereCandidates: vi.fn(),
  refreshLocationQuantities: vi.fn(),
  commitCount: vi.fn(),
}));

// The back link's destination depends on the locations flag, and the real hook calls getCompany(),
// which transitively builds a Supabase client and fails without env vars. Defaults to flag-on
// because that is the configuration every other test in this file assumes.
const mockUseCompanyFeatures = vi.fn(() => ({
  features: { inventory_locations: true },
  loading: false,
}));
/**
 * Stub the shared picker, the way the operator lookup tests do. What matters here is that
 * choosing a part puts a row on the sheet, not MUI's Autocomplete — and the real one imports
 * `partsAccess`, which builds a Supabase client at module scope.
 */
let nextAddPick: { id: string; part_name: string } | null = null;
vi.mock('@/components/parts/PartAutocomplete', () => ({
  __esModule: true,
  default: (props: { onChange: (o: unknown) => void; disabled?: boolean }) => (
    <button type="button" disabled={props.disabled} onClick={() => props.onChange(nextAddPick)}>
      add-part
    </button>
  ),
}));

vi.mock('@/hooks/useCompanyFeatures', () => ({
  useCompanyFeatures: () => mockUseCompanyFeatures(),
}));

// The page reaches the locations access layer for put-away; unmocked it builds a real Supabase
// client at import time and the whole file fails to load.
vi.mock('@/utils/inventoryLocationsAccess', () => ({
  PUT_AWAY_MAX: 1000,
  // Small on purpose: the pager only renders past one page, and a fixture of 100 rows to prove
  // it would slow every test in this file.
  LOCATION_PAGE_SIZE: 2,
  bulkPutAway: vi.fn(),
  createLocation: vi.fn(),
  getBalancesForParts: vi.fn(),
  getLocations: vi.fn(async () => []),
}));

import InventoryCountPage from '@/app/dashboard/[companyId]/inventory/count/page';
import {
  loadCountCandidates,
  loadCountCandidatesForPlaces,
  refreshLocationQuantities,
  commitCount,
  loadPartAtLocationCandidate,
  loadPartEverywhereCandidates,
} from '@/utils/inventoryCountAccess';
import {
  bulkPutAway,
  getBalancesForParts,
  getLocations,
} from '@/utils/inventoryLocationsAccess';
import type { CountCandidate } from '@/types/inventoryCount';
import { COUNT_PICKER_LIMIT } from '@/lib/queryLimits';

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

/**
 * Stub the pre-save re-read.
 *
 * Keyed by `partId::locationId` on purpose: the page reads by PART now (one request instead of
 * one per bin) and then picks each row's own place out of the result, so a stub that ignored the
 * location would let a bug that applies Shelf A's balance to Shelf B pass unnoticed.
 */
const freshBalances = (rows: Record<string, number>) =>
  asMock(getBalancesForParts).mockImplementation(async (_co: string, ids: string[]) => {
    const out = new Map<string, { locationId: string; locationName: string; path: string[]; quantity: number }[]>();
    for (const [key, quantity] of Object.entries(rows)) {
      const [partId, locationId] = key.split('::');
      if (!ids.includes(partId)) continue;
      const list = out.get(partId) ?? [];
      list.push({ locationId, locationName: locationId, path: [], quantity });
      out.set(partId, list);
    }
    return out;
  });

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
  // Every part has a place since 20260802015837, so the company-wide sheet's default row is
  // an Unassigned row — there is no longer a target that writes `parts.quantity`.
  target: { locationId: 'loc-unassigned', locationName: 'Unassigned', locationPath: 'Unassigned' },
  ...over,
});

/** A (part, place) row — the shape the loaders actually return now. */
const at = (
  partId: string,
  partName: string,
  locationId: string,
  locationPath: string,
  systemQuantity: number,
): CountCandidate =>
  cand({
    partId,
    partName,
    systemQuantity,
    target: { locationId, locationName: locationPath.split(' › ').pop()!, locationPath },
  });

const renderPage = () =>
  render(<InventoryCountPage />, {
    wrapper: ({ children }) => <ThemeProvider theme={jiggedTheme}>{children}</ThemeProvider>,
  });

/**
 * The count input for one ROW — a part AT A PLACE.
 *
 * The place is required, not optional: a part on three shelves has three inputs, and the earlier
 * positional `getAllByRole('spinbutton')[0]` binds to whatever the sort happened to put first.
 */
const inputFor = (partName: string, place: string) =>
  screen.getByRole('spinbutton', {
    name: new RegExp(`counted quantity for ${partName} in ${place}`, 'i'),
  });

/** Pick parts in the picker (one row per PART, whatever its places) and advance to the sheet. */
const chooseParts = async (user: ReturnType<typeof userEvent.setup>, ...partNames: string[]) => {
  for (const name of partNames) {
    await user.click(screen.getByRole('checkbox', { name: new RegExp(`^count ${name}`, 'i') }));
  }
  await user.click(screen.getByRole('button', { name: /^count \d+ parts?/i }));
};

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` clears call records but NOT implementations, so a `mockReturnValue` set inside
  // one test leaks into every test after it. The flag-off back-link test sets one, so the flag-on
  // default is re-pinned here rather than relied on from the `vi.fn(impl)` above.
  mockUseCompanyFeatures.mockReturnValue({
    features: { inventory_locations: true },
    loading: false,
  });
  window.localStorage.clear();
  /*
   * Two parts, one place each — still the majority shape a real shop returns (9 of the 14 stocked
   * parts in `supabase/seed.sql` sit in exactly one place), so it is an honest default rather
   * than a stale one. The multi-place shape this change introduces is not smeared across the
   * tests that happen to need *a* row; it gets its own block, "a part in several places", where
   * the grouping is the subject rather than an incidental.
   */
  asMock(loadCountCandidates).mockResolvedValue([
    at('p1', '4140 bar', 'loc-unassigned', 'Unassigned', 40),
    at('p2', '6061 plate', 'loc-unassigned', 'Unassigned', 12),
  ]);
  // Location-AWARE by default: a blind stub returns the same Map for every bin, so a bug that
  // reads Shelf A's balance and applies it to Shelf B cannot fail a test.
  asMock(getBalancesForParts).mockImplementation(async (_co: string, ids: string[]) =>
    new Map(
      ids.map((id) => [
        id,
        id === 'p1'
          ? [
              { locationId: 'loc-unassigned', locationName: 'Unassigned', path: [], quantity: 40 },
              { locationId: 'loc-a', locationName: 'Shelf A', path: ['Cabinet 3'], quantity: 8 },
            ]
          : [{ locationId: 'loc-unassigned', locationName: 'Unassigned', path: [], quantity: 12 }],
      ]),
    ),
  );
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

    expect(inputFor('4140 bar', 'Unassigned')).toBeInTheDocument();
    expect(
      screen.queryByRole('spinbutton', { name: /counted quantity for 6061 plate/i }),
    ).not.toBeInTheDocument();
  });

  it('starts every input empty, so nothing can be tabbed past and accepted', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('4140 bar');
    await chooseParts(user, '4140 bar', '6061 plate');
    expect(inputFor('4140 bar', 'Unassigned')).toHaveValue(null);
    expect(inputFor('6061 plate', 'Unassigned')).toHaveValue(null);
  });

  /*
   * The two tests that stood here — "names parts held back instead of dropping them silently" and
   * "routes a held-back part to each place it actually sits in" — are deleted, not rewritten.
   *
   * They asserted the notice the founder rejected ("this is silly... many parts will be in many
   * places") and the chips that routed around it. A part in several places is now simply several
   * rows on the sheet, so there is nothing held back to name and nowhere to route to. The
   * behaviour that replaced them is covered in "a part in several places" below.
   *
   * Note this also removed the only test asserting a `?from=count` URL, so that `returnTo` branch
   * went with the chips that were its only setters.
   */

  /**
   * The back link used to push `/dashboard/co1/inventory` unconditionally. That route now redirects
   * to Parts, so anyone who reached counting from the Storage board was silently returned to a
   * different page than the one they left.
   *
   * Both flag states are asserted deliberately: with locations OFF the only entry point is the
   * `Count Inventory` button on the Parts toolbar, so sending those shops to Storage would just
   * relocate the bug — `/inventory/locations` redirects them straight back out. A test of one state
   * would have passed against the old hardcoded link.
   */
  it('returns to the storage board it was entered from', async () => {
    const user = userEvent.setup();
    asMock(loadCountCandidates).mockResolvedValue([cand({ partId: 'p1', partName: '4140 bar' })]);
    renderPage();
    await user.click(await screen.findByRole('button', { name: /back to storage/i }));
    expect(mockPush).toHaveBeenCalledWith('/dashboard/co1/inventory/locations');
  });

  it('returns to parts when the shop has no storage board', async () => {
    mockUseCompanyFeatures.mockReturnValue({
      features: { inventory_locations: false },
      loading: false,
    });
    const user = userEvent.setup();
    asMock(loadCountCandidates).mockResolvedValue([cand({ partId: 'p1', partName: '4140 bar' })]);
    renderPage();
    await user.click(await screen.findByRole('button', { name: /back to parts/i }));
    expect(mockPush).toHaveBeenCalledWith('/dashboard/co1/parts');
    expect(screen.queryByRole('button', { name: /back to storage/i })).not.toBeInTheDocument();
  });

  it('shows an empty state when the company has no parts at all', async () => {
    asMock(loadCountCandidates).mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText(/nothing to count yet/i)).toBeInTheDocument();
  });

  /**
   * The company-wide picker is SERVER-searched, and this reverses what these two tests used to
   * pin. The originals asserted the opposite — that a keystroke never reaches the server, and
   * that the list narrows in the same tick with no `waitFor` — and one of them said in as many
   * words that wiring `serverSearch` through to `loadCountCandidates` "turns this into a 300ms
   * round trip and this test goes red, which is the intended alarm rather than an inconvenience".
   *
   * The alarm fired, and the answer this time is that the premise expired. That guarantee was
   * affordable because `parts.is_stocked` bounded the list to a few hundred rows, so filtering in
   * memory cost nothing. Dropping the column made every part stockable and the same code would
   * have pulled an 8,451-part catalogue into the browser unvirtualised, then fanned the balances
   * read out over ~71 chunked queries. An instant filter over a list that takes seconds to arrive
   * is not the better screen.
   *
   * What replaces it is pinned below: the term reaches the server, debounced, once per settled
   * term — and the cap is stated on screen, since a capped list can silently lack the part you
   * wanted.
   */
  it('sends the search term to the server rather than filtering in the browser', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('4140 bar');

    asMock(loadCountCandidates).mockClear();
    await user.type(screen.getByPlaceholderText(/search parts/i), '4140');

    await waitFor(() => expect(loadCountCandidates).toHaveBeenCalledWith('co1', '4140'));
  });

  /**
   * The debounce is what makes the round trip affordable: a settled term is one request, not one
   * per keystroke. Without it every letter of a part number is a query plus a balances fan-out.
   */
  it('coalesces keystrokes into a single request', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('4140 bar');

    asMock(loadCountCandidates).mockClear();
    await user.type(screen.getByPlaceholderText(/search parts/i), '4140');
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(asMock(loadCountCandidates).mock.calls).toHaveLength(1);
  });

  /**
   * A capped list has one failure mode an unbounded one does not: the part you wanted is simply
   * not on it, and nothing on screen would otherwise say so. Only shown AT the cap — below it the
   * list is everything that matched, and a standing "showing the first 200" would be a lie.
   */
  it('says so when the view is capped, and stays quiet when it is not', async () => {
    asMock(loadCountCandidates).mockResolvedValue(
      Array.from({ length: COUNT_PICKER_LIMIT }, (_, i) =>
        cand({ partId: `p${i}`, partName: `PART-${i}` }),
      ),
    );
    renderPage();
    expect(
      await screen.findByText(new RegExp(`showing the first ${COUNT_PICKER_LIMIT}`, 'i')),
    ).toBeInTheDocument();
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
    await user.type(inputFor('4140 bar', 'Unassigned'), '38');
    expect(await screen.findByText('-2')).toBeInTheDocument();
  });

  it('says a count matches rather than showing a zero delta', async () => {
    const user = await onSheet();
    await user.type(inputFor('4140 bar', 'Unassigned'), '40');
    // Anchored: the footer also says "Everything matches so far".
    expect(await screen.findByText(/^No change$/)).toBeInTheDocument();
  });

  it('tracks progress against the chosen scope, in plain language', async () => {
    const user = await onSheet();
    expect(screen.getByText(/nothing entered yet/i)).toBeInTheDocument();

    await user.type(inputFor('4140 bar', 'Unassigned'), '40'); // matches
    expect(await screen.findByText(/everything matches so far/i)).toBeInTheDocument();

    await user.type(inputFor('6061 plate', 'Unassigned'), '9'); // changes
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

    await user.type(inputFor('4140 bar', 'Unassigned'), '40'); // matches — still nothing to write
    expect(screen.getByRole('button', { name: /save 0 changes/i })).toBeDisabled();
  });

  it('clearing an input un-counts the row rather than counting it as zero', async () => {
    const user = await onSheet();
    await user.type(inputFor('4140 bar', 'Unassigned'), '38');
    expect(await screen.findByText('1 of 2 counted')).toBeInTheDocument();

    await user.clear(inputFor('4140 bar', 'Unassigned'));
    expect(await screen.findByText('0 of 2 counted')).toBeInTheDocument();
  });

  it('going back to the scope step keeps what has been typed', async () => {
    const user = await onSheet();
    await user.type(inputFor('4140 bar', 'Unassigned'), '38');
    await user.click(screen.getByRole('button', { name: /^back$/i }));

    await screen.findByText(/one part or the whole shop/i);
    await user.click(screen.getByRole('button', { name: /^count 2 parts$/i }));
    expect(inputFor('4140 bar', 'Unassigned')).toHaveValue(38);
  });
});

describe('saving', () => {
  const enterAndSave = async (partName: string, value: string, place = 'Unassigned') => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('4140 bar');
    await chooseParts(user, '4140 bar');
    await user.type(inputFor(partName, place), value);
    await user.click(screen.getByRole('button', { name: /save 1 change/i }));
    return user;
  };

  it('re-reads current quantities before writing', async () => {
    await enterAndSave('4140 bar', '38');
    await waitFor(() =>
      // By part, not by bin: one request for the whole sheet, and it can see a place the sheet
      // does not hold (reported after the save, never blocking it).
      expect(getBalancesForParts).toHaveBeenCalledWith('co1', ['p1']),
    );
  });

  /**
   * The exit that mattered most and had no coverage. It fires at the moment someone wants to go
   * count the next shelf, and it used to push bare `/inventory` — which now redirects to Parts, so
   * saving a place-scoped count dumped the counter on a parts list with the board gone.
   */
  it('returns to the storage board after saving, not to parts', async () => {
    await enterAndSave('4140 bar', '38');
    await waitFor(() => expect(commitCount).toHaveBeenCalled());
    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith('/dashboard/co1/inventory/locations'),
    );
    expect(mockPush).not.toHaveBeenCalledWith('/dashboard/co1/inventory');
  });

  /** Same exit, and the same trap: with no board to return to, Parts is the correct landing. */
  it('returns to parts after saving when the shop has no storage board', async () => {
    mockUseCompanyFeatures.mockReturnValue({
      features: { inventory_locations: false },
      loading: false,
    });
    await enterAndSave('4140 bar', '38');
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/dashboard/co1/parts'));
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
    freshBalances({ 'p1::loc-unassigned': 44 });
    await enterAndSave('4140 bar', '38');

    await waitFor(() => expect(commitCount).toHaveBeenCalled());
    const [variances] = asMock(commitCount).mock.calls[0];
    expect(variances[0].counted).toBe(38);
    // Delta is against the refreshed 44, not the 40 the sheet loaded with — countNote quotes
    // this number, so a stale one would put a wrong figure in the ledger.
    expect(variances[0].delta).toBe(-6);
  });

  it('says afterwards which parts moved while the count was open', async () => {
    freshBalances({ 'p1::loc-unassigned': 44 });
    await enterAndSave('4140 bar', '38');

    // Named, not tallied: "1 item moved" doesn't say which shelf to go back and look at.
    expect(
      await screen.findByText(/4140 bar at Unassigned moved while you were counting/i),
    ).toBeInTheDocument();
  });

  it('saves nothing when the refresh shows the count already matches', async () => {
    freshBalances({ 'p1::loc-unassigned': 38 });
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

/**
 * The `draft` block is gone: the unfinished-count banner was removed 2026-08-01. Navigating away
 * is a deliberate act, and the page no longer treats it as an accident to recover from.
 */
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
      target: { locationId: LOC, locationName: 'Shelf A', locationPath: 'Shelf A' },
    } as Partial<CountCandidate> & { partId: string });

  beforeEach(() => {
    searchParams.set('location', LOC);
    asMock(getLocations).mockResolvedValue([
      { id: LOC, company_id: 'co1', parent_id: null, name: 'Shelf A', kind: 'shelf', code: null, sort_order: 0, created_at: '', updated_at: '' },
      { id: 'loc-yard', company_id: 'co1', parent_id: null, name: 'Yard', kind: 'outside', code: null, sort_order: 1, created_at: '', updated_at: '' },
      { id: 'loc-un', company_id: 'co1', parent_id: null, name: 'Unassigned', kind: 'system', code: null, sort_order: 2, created_at: '', updated_at: '' },
    ]);
    asMock(loadCountCandidatesForPlaces).mockResolvedValue({
      candidates: [here('BUY-ORING-214', 828), here('BUY-BEARING-608ZZ', 580)],
      total: 2,
    });
    asMock(bulkPutAway).mockResolvedValue({ moved: 1, skipped: 0, transfer_group_id: 'g' });
  });

  afterEach(() => searchParams.delete('location'));

  /**
   * The draft key is company-wide and only the company-wide loader reads it back, so a
   * place-scoped autosave was a silent data-destruction path: abandon a Shelf A count at 28,
   * open the company-wide sheet later, accept the resume, and 28 gets committed against a
   * company-wide on-hand of 830 — a −802 adjustment nobody asked for.
   */
  it('writes no draft, so a shelf count cannot resume as a company-wide one', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("What's in Shelf A?");

    await user.click(screen.getByRole('checkbox', { name: /count BUY-ORING-214/i }));
    await user.click(screen.getByRole('button', { name: /count 1 part$/i }));
    await user.type(inputFor('BUY-ORING-214', 'Shelf A'), '28');

    expect(window.localStorage.getItem('jigged.inventoryCount.co1')).toBeNull();
  });

  it('names the place it is scoped to instead of the whole shop', async () => {
    renderPage();
    expect(await screen.findByText("What's in Shelf A?")).toBeInTheDocument();
    expect(loadCountCandidatesForPlaces).toHaveBeenCalledWith([{ id: LOC, name: 'Shelf A', path: 'Shelf A' }], {
      search: '',
      offset: 0,
      limit: 2,
    });
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
  it('moves the ticked parts in a single call', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("What's in Shelf A?");

    await user.click(screen.getByRole('checkbox', { name: /count BUY-ORING-214/i }));
    await user.click(screen.getByRole('combobox', { name: /send the ticked parts to/i }));
    await user.click(await screen.findByRole('option', { name: /^Yard/ }));
    await user.click(screen.getByRole('button', { name: /move 1 to/i }));

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
    asMock(loadCountCandidatesForPlaces).mockClear();

    await user.click(screen.getByRole('checkbox', { name: /count BUY-ORING-214/i }));
    await user.click(screen.getByRole('combobox', { name: /send the ticked parts to/i }));
    await user.click(await screen.findByRole('option', { name: /^Yard/ }));
    await user.click(screen.getByRole('button', { name: /move 1 to/i }));

    await waitFor(() => expect(loadCountCandidatesForPlaces).toHaveBeenCalled());
    const [, opts] = asMock(loadCountCandidatesForPlaces).mock.calls[0];
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
    await user.click(screen.getByRole('button', { name: /move 1 to/i }));

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
    await user.click(screen.getByRole('button', { name: /move 1 to/i }));

    expect(await screen.findByText(/Too many parts at once/i)).toBeInTheDocument();
  });

  /**
   * A shelf count must be measured against ITS shelf. The re-read now fetches every place a
   * counted part sits in, so what this pins is that the page picks the row matching the sheet's
   * own location — 828 at Shelf A — and not some other bin's figure or a roll-up of them all.
   */
  it('re-reads THIS bin before saving, not the company-wide total', async () => {
    const user = userEvent.setup();
    freshBalances({ 'BUY-ORING-214::loc-shelf-a': 828, 'BUY-ORING-214::loc-elsewhere': 9999 });
    asMock(commitCount).mockResolvedValue({ committed: 1, failures: [] });
    renderPage();
    await screen.findByText("What's in Shelf A?");

    await chooseParts(user, 'BUY-ORING-214');
    await user.type(inputFor('BUY-ORING-214', 'Shelf A'), '830');
    await user.click(screen.getByRole('button', { name: /save/i }));

    // The variance is against Shelf A's 828, not the 9,999 sitting in another bin — so counting
    // 830 is +2, and the commit carries that shelf's id.
    await waitFor(() => expect(commitCount).toHaveBeenCalled());
    const [variances] = asMock(commitCount).mock.calls[0];
    expect(variances[0].delta).toBe(2);
    expect(variances[0].candidate.target.locationId).toBe(LOC);
  });

  /**
   * It used to *admit* the cap — "showing 100 of 9,428, search to narrow it down" — which was
   * honest and still left `Unassigned` uncountable, and that is the bin that most needs
   * emptying because the auto-track trigger seeds a row there for every stocked part.
   */
  it('pages through a bin instead of showing one capped page', async () => {
    const user = userEvent.setup();
    asMock(loadCountCandidatesForPlaces).mockResolvedValue({
      candidates: [here('BUY-ORING-214', 828), here('BUY-BEARING-608ZZ', 580)],
      total: 9428,
    });
    renderPage();

    expect(await screen.findByText(/1–2 of 9,428 here/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /next/i }));

    await waitFor(() =>
      expect(loadCountCandidatesForPlaces).toHaveBeenLastCalledWith([{ id: LOC, name: 'Shelf A', path: 'Shelf A' }], {
        search: '',
        offset: 2,
        limit: 2,
      }),
    );
  });

  /**
   * The search box debounces into `serverSearch` on a 300ms timer, and that timer also fires
   * ~300ms after MOUNT, when the term has not changed. It used to reset the page
   * unconditionally, so paging within 300ms of opening a bin silently yanked the operator
   * back to page 1. Measured call sequence before the fix:
   *
   *     offset 0  (initial load) → offset 2 (the click) → offset 0 (the mount timer)
   *
   * Invisible locally, because the timer usually expires before a human can click, and
   * deterministic on a loaded CI runner — which is how it was found, as the sibling test
   * above failing on `main` with `offset: 0` where it expected `2`.
   *
   * This asserts on the whole call list rather than the last call, so it fails loudly if a
   * stray reload reappears, and waits well past the debounce on purpose: the point is that
   * nothing happens when it fires.
   */
  it('does not reset the page when the mount-time search debounce fires', async () => {
    const user = userEvent.setup();
    asMock(loadCountCandidatesForPlaces).mockResolvedValue({
      candidates: [here('BUY-ORING-214', 828), here('BUY-BEARING-608ZZ', 580)],
      total: 9428,
    });
    renderPage();

    expect(await screen.findByText(/1–2 of 9,428 here/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /next/i }));

    await waitFor(() =>
      expect(loadCountCandidatesForPlaces).toHaveBeenLastCalledWith(
        [{ id: LOC, name: 'Shelf A', path: 'Shelf A' }],
        expect.objectContaining({ offset: 2 }),
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 700));

    const offsets = asMock(loadCountCandidatesForPlaces).mock.calls.map(
      (call: unknown[]) => (call[1] as { offset: number }).offset,
    );
    expect(offsets).toEqual([0, 2]);
  });

  /** A tick on page 1 must survive turning to page 2 — the sheet holds rows, not indexes. */
  it('keeps what is already ticked when the page turns', async () => {
    const user = userEvent.setup();
    asMock(loadCountCandidatesForPlaces).mockResolvedValue({
      candidates: [here('BUY-ORING-214', 828), here('BUY-BEARING-608ZZ', 580)],
      total: 9428,
    });
    renderPage();
    await screen.findByText(/1–2 of 9,428 here/i);

    await user.click(screen.getByRole('checkbox', { name: /count BUY-ORING-214/i }));
    asMock(loadCountCandidatesForPlaces).mockResolvedValue({
      candidates: [here('SOMETHING-ELSE', 3)],
      total: 9428,
    });
    await user.click(screen.getByRole('button', { name: /next/i }));

    await screen.findByText('SOMETHING-ELSE');
    expect(screen.getByRole('button', { name: /count 1 part$/i })).toBeEnabled();
  });

  // The RPC caps the array to bound how long it holds row locks; say so before someone selects
  // 2,000 rows and is refused.
  it('refuses to select-all past the cap', async () => {
    asMock(loadCountCandidatesForPlaces).mockResolvedValue({
      candidates: Array.from({ length: 1001 }, (_, i) => here(`P${i}`, 1)),
      total: 1001,
    });
    renderPage();
    await screen.findByText("What's in Shelf A?");
    expect(screen.getByRole('button', { name: /select all/i })).toBeDisabled();
  });
});

/**
 * The sheet must survive the list it came from being replaced.
 *
 * `candidates` is swapped wholesale by a debounced search (and, now, by turning a page), and
 * `save()` used to build its variances by mapping over that array. A number typed for a part that
 * then fell out of the result set was **silently never committed** — no warning, no failure, just
 * fewer changes than you made. Holding the chosen candidates by value is what fixes it.
 */
describe('counting one place — the sheet outlives the search', () => {
  const LOC2 = 'loc-shelf-a';
  const hereRow = (partId: string, quantity: number): CountCandidate =>
    cand({
      partId,
      quantity: undefined,
      systemQuantity: quantity,
      unit: 'ea',
      target: { locationId: LOC2, locationName: 'Shelf A', locationPath: 'Shelf A' },
    } as Partial<CountCandidate> & { partId: string });

  beforeEach(() => {
    searchParams.set('location', LOC2);
    asMock(getLocations).mockResolvedValue([
      { id: LOC2, company_id: 'co1', parent_id: null, name: 'Shelf A', kind: 'shelf', code: null, sort_order: 0, created_at: '', updated_at: '' },
    ]);
    asMock(loadCountCandidatesForPlaces).mockResolvedValue({
      candidates: [hereRow('BUY-ORING-214', 828), hereRow('BUY-BEARING-608ZZ', 580)],
      total: 2,
    });
    freshBalances({ 'BUY-ORING-214::loc-shelf-a': 828, 'BUY-BEARING-608ZZ::loc-shelf-a': 580 });
  });

  afterEach(() => searchParams.delete('location'));

  it('commits a count typed before a search that dropped the row', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("What's in Shelf A?");

    await user.click(screen.getByRole('checkbox', { name: /count BUY-ORING-214/i }));
    await user.click(screen.getByRole('button', { name: /count 1 part$/i }));
    await user.type(inputFor('BUY-ORING-214', 'Shelf A'), '800');

    // The server list is replaced by something that does not contain the counted part.
    asMock(loadCountCandidatesForPlaces).mockResolvedValue({
      candidates: [hereRow('SOMETHING-ELSE', 5)],
      total: 1,
    });
    asMock(refreshLocationQuantities).mockResolvedValue(new Map([['BUY-ORING-214', 828]]));

    await user.click(screen.getByRole('button', { name: /save|commit|finish/i }));

    await waitFor(() => expect(commitCount).toHaveBeenCalled());
    const [variances] = asMock(commitCount).mock.calls[0];
    expect(variances).toHaveLength(1);
    expect(variances[0].candidate.partId).toBe('BUY-ORING-214');
    expect(variances[0].counted).toBe(800);
  });

  /** Untick then re-tick must not make someone type the number again. */
  it('keeps a typed number when a row is unticked', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("What's in Shelf A?");

    await user.click(screen.getByRole('checkbox', { name: /count BUY-ORING-214/i }));
    await user.click(screen.getByRole('button', { name: /count 1 part$/i }));
    await user.type(inputFor('BUY-ORING-214', 'Shelf A'), '800');
    expect(screen.getByText(/1 of 1 counted/i)).toBeInTheDocument();

    // Back to the picker, untick, re-tick, forward again. Two "Back" buttons exist (the page
    // header's and the sheet footer's); the footer one is the step control.
    await user.click(screen.getAllByRole('button', { name: /^back$/i }).at(-1) as HTMLElement);
    await user.click(screen.getByRole('checkbox', { name: /count BUY-ORING-214/i }));
    await user.click(screen.getByRole('checkbox', { name: /count BUY-ORING-214/i }));
    await user.click(screen.getByRole('button', { name: /count 1 part$/i }));

    expect(inputFor('BUY-ORING-214', 'Shelf A')).toHaveValue(800);
  });
});

/**
 * The row a bin read cannot produce. `getLocationContentsPage` filters `.gt('quantity', 0)`, so
 * "the system says zero and I am holding twelve" had no row to type a number into — the most
 * valuable thing a count discovers was unrepresentable.
 */
describe('counting one place — adding a part that is not listed', () => {
  const LOC3 = 'loc-shelf-a';

  beforeEach(() => {
    searchParams.set('location', LOC3);
    asMock(getLocations).mockResolvedValue([
      { id: LOC3, company_id: 'co1', parent_id: null, name: 'Shelf A', kind: 'shelf', code: null, sort_order: 0, created_at: '', updated_at: '' },
    ]);
    asMock(loadCountCandidatesForPlaces).mockResolvedValue({ candidates: [], total: 0 });
    nextAddPick = { id: 'p-missing', part_name: 'BUY-DOWEL-3MM' };
    asMock(loadPartAtLocationCandidate).mockResolvedValue(
      cand({
        partId: 'p-missing',
        quantity: undefined,
        systemQuantity: 0,
        unit: 'ea',
        target: { locationId: LOC3, locationName: 'Shelf A', locationPath: 'Shelf A' },
      } as Partial<CountCandidate> & { partId: string }),
    );
  });

  afterEach(() => searchParams.delete('location'));

  it('puts a part the bin does not hold onto the sheet, already ticked', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("What's in Shelf A?");

    await user.click(screen.getByRole('button', { name: 'add-part' }));

    await waitFor(() =>
      expect(loadPartAtLocationCandidate).toHaveBeenCalledWith('co1', 'p-missing', LOC3, 'Shelf A'),
    );
    // Ticked on arrival: you added it because you are holding it.
    expect(await screen.findByRole('button', { name: /count 1 part$/i })).toBeEnabled();
  });

  /**
   * The toolbar used to live inside the `countable.length === 0` ternary, so a server search
   * matching nothing unmounted the search field along with everything else — leaving no way to
   * clear the term you had just typed, and nowhere to add the part you were looking for.
   */
  it('keeps the toolbar when the bin reads empty', async () => {
    renderPage();
    await screen.findByText("What's in Shelf A?");

    expect(screen.getByRole('button', { name: 'add-part' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/search what/i)).toBeInTheDocument();
  });

  it('says so when the part cannot be added, rather than failing silently', async () => {
    const user = userEvent.setup();
    asMock(loadPartAtLocationCandidate).mockRejectedValue(
      new Error("BUY-DOWEL-3MM isn't tracked by place, so it can't be counted at one."),
    );
    renderPage();
    await screen.findByText("What's in Shelf A?");

    await user.click(screen.getByRole('button', { name: 'add-part' }));
    expect(await screen.findByText(/isn't tracked by place/i)).toBeInTheDocument();
  });
});

/** A count session is a human assertion about a shelf, so the ledger must say whose. */
describe('count runs are attributed', () => {
  it('passes the acting member to every line it commits', async () => {
    const user = userEvent.setup();
    // The file's default fixture already provides "4140 bar"; only the refresh needs pinning.
    freshBalances({ 'p1::loc-unassigned': 40 });
    renderPage();
    await screen.findByText('4140 bar');

    await chooseParts(user, '4140 bar');
    await user.type(inputFor('4140 bar', 'Unassigned'), '38');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(commitCount).toHaveBeenCalled());
    const [, opts] = asMock(commitCount).mock.calls[0];
    expect(opts.operatorId).toBe('member-1');
  });
});

/**
 * One part at one place, reached from the part page's "Count here".
 */
describe('counting one part at one place', () => {
  const LOC4 = 'loc-shelf-a';

  beforeEach(() => {
    searchParams.set('location', LOC4);
    searchParams.set('part', 'p1');
    asMock(getLocations).mockResolvedValue([
      { id: LOC4, company_id: 'co1', parent_id: null, name: 'Shelf A', kind: 'shelf', code: null, sort_order: 0, created_at: '', updated_at: '' },
    ]);
    asMock(loadPartAtLocationCandidate).mockResolvedValue(
      cand({
        partId: 'p1',
        partName: '4140 bar',
        quantity: undefined,
        systemQuantity: 580,
        unit: 'ea',
        target: { locationId: LOC4, locationName: 'Shelf A', locationPath: 'Shelf A' },
      } as Partial<CountCandidate> & { partId: string }),
    );
  });

  afterEach(() => {
    searchParams.delete('location');
    searchParams.delete('part');
  });

  it('goes straight to a one-row sheet with nothing to pick', async () => {
    renderPage();
    expect(await screen.findByText('4140 bar')).toBeInTheDocument();
    expect(inputFor('4140 bar', 'Shelf A')).toBeInTheDocument();
    expect(screen.queryByText(/pick the parts/i)).not.toBeInTheDocument();
  });

  /**
   * Found in the browser, not by a test: step 0 is suppressed in part-scope, so the footer's
   * "Back" rendered a blank page under the header. The only way out is back to the part.
   */
  it('offers no step-back into a picker that is not there', async () => {
    renderPage();
    await screen.findByText('4140 bar');

    expect(screen.queryByRole('button', { name: /^Back$/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /back to part/i })).toBeInTheDocument();
  });

  it('sends you back to the part it came from', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('4140 bar');

    await user.click(screen.getByRole('button', { name: /back to part/i }));
    expect(mockPush).toHaveBeenCalledWith('/dashboard/co1/parts/p1?tab=inventory');
  });

  it('surfaces a part that cannot be counted here instead of an empty sheet', async () => {
    asMock(loadPartAtLocationCandidate).mockRejectedValue(
      new Error("4140 bar isn't tracked by place, so it can't be counted at one."),
    );
    renderPage();
    expect(await screen.findByText(/isn't tracked by place/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing to count yet/i)).not.toBeInTheDocument();
  });
});

/**
 * `?part=<id>` with no location: one part, every place it sits, on one sheet.
 *
 * The journey the excluded-part chips describe. Its hazard is that the SAME part appears on
 * several rows, which broke every part-id-keyed assumption on the page at once.
 */
describe('counting one part everywhere', () => {
  const row = (locationId: string, name: string, qty: number): CountCandidate =>
    cand({
      partId: 'p-split',
      partName: 'BUY-ORING-214',
      quantity: undefined,
      description: '1/2" O-ring, Buna-N',
      systemQuantity: qty,
      unit: 'ea',
      target: { locationId, locationName: name, locationPath: name },
    } as Partial<CountCandidate> & { partId: string });

  beforeEach(() => {
    searchParams.set('part', 'p-split');
    asMock(loadPartEverywhereCandidates).mockResolvedValue({
      partName: 'BUY-ORING-214',
      candidates: [row('shelf-a', 'Shelf A', 828), row('shelf-b', 'Shelf B', 552)],
    });
    freshBalances({ 'p-split::shelf-a': 828, 'p-split::shelf-b': 552 });
    asMock(commitCount).mockResolvedValue({ committed: 2, failures: [] });
  });

  afterEach(() => searchParams.delete('part'));

  it('opens straight onto a row per location, with no picker', async () => {
    renderPage();
    await screen.findByText('Shelf A');
    expect(screen.getByText('Shelf B')).toBeInTheDocument();
    // Grouped under one part header rather than repeating the part name down the rows.
    expect(screen.getByText('2 locations')).toBeInTheDocument();
    expect(screen.queryByText(/pick the parts/i)).not.toBeInTheDocument();
    expect(await screen.findByText(/0 of 2 counted/i)).toBeInTheDocument();
  });

  /**
   * The bug the row key exists to prevent: keyed by part alone, both rows read one entry, so
   * typing 800 for Shelf A silently committed 800 to Shelf B too — against a different recorded
   * quantity, which is a −52 adjustment nobody made.
   */
  it('keeps each shelf’s number to itself', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Shelf A');

    // By NAME, not by position. `getAllByRole('spinbutton')[0]` binds to whatever the sort
    // happened to put first, so it silently kept passing while telling you nothing about which
    // shelf got which number — which is the entire subject of this test.
    const inputA = inputFor('BUY-ORING-214', 'Shelf A');
    const inputB = inputFor('BUY-ORING-214', 'Shelf B');
    await user.type(inputA, '800');
    await user.type(inputB, '500');

    expect(inputA).toHaveValue(800);
    expect(inputB).toHaveValue(500);
    expect(await screen.findByText(/2 of 2 counted/i)).toBeInTheDocument();
  });

  /**
   * Each row must be re-read at ITS bin. Keying the refresh off a page-level location would send
   * every row down the `parts.quantity` roll-up branch and report a variance on all of them.
   */
  it('re-reads every shelf separately before committing', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Shelf A');

    await user.type(inputFor('BUY-ORING-214', 'Shelf A'), '800');
    await user.type(inputFor('BUY-ORING-214', 'Shelf B'), '500');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(commitCount).toHaveBeenCalled());
    // One read for the part, covering both its shelves — not one request per bin.
    expect(getBalancesForParts).toHaveBeenCalledWith('co1', ['p-split']);

    const [variances] = asMock(commitCount).mock.calls[0];
    expect(
      variances.map((v: { candidate: CountCandidate; counted: number; delta: number }) => [
        v.candidate.target.locationId,
        v.counted,
        v.delta,
      ]),
    ).toEqual([
      ['shelf-a', 800, -28],
      ['shelf-b', 500, -52],
    ]);
  });

  it('goes back to the part, not to storage', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Shelf A');

    await user.click(screen.getByRole('button', { name: /back to part/i }));
    expect(mockPush).toHaveBeenCalledWith('/dashboard/co1/parts/p-split?tab=inventory');
  });
});

/**
 * The company-wide sheet, when a part sits in more than one place.
 *
 * This is what replaced the held-back notice the founder rejected ("this is silly... many parts
 * will be in many places"). The design splits the two steps deliberately: the PICKER stays
 * part-grained — nobody chooses a shelf when deciding which parts to walk — and the SHEET is
 * place-grained, grouped under the part.
 */
describe('a part in several locations', () => {
  beforeEach(() => {
    asMock(loadCountCandidates).mockResolvedValue([
      at('p1', 'BUY-ORING-214', 'loc-a', 'Cabinet 3 › Shelf A', 800),
      at('p1', 'BUY-ORING-214', 'loc-b', 'Cabinet 3 › Shelf B', 20),
      at('p1', 'BUY-ORING-214', 'loc-unassigned', 'Unassigned', 8),
      at('p2', '6061 plate', 'loc-unassigned', 'Unassigned', 12),
    ]);
    freshBalances({
      'p1::loc-a': 800,
      'p1::loc-b': 20,
      'p1::loc-unassigned': 8,
      'p2::loc-unassigned': 12,
    });
  });

  /**
   * The picker must NOT multiply. It is unbounded, unvirtualised and filtered in the browser, so
   * one row per (part, place) would have made a 20-part shop read "Count 40 parts" — the same
   * species of nonsense as the notice this change deletes.
   */
  it('lists one row per part, saying how many locations it is in', async () => {
    renderPage();
    await screen.findByText('BUY-ORING-214');

    expect(screen.getAllByText('BUY-ORING-214')).toHaveLength(1);
    expect(screen.getByText('3 locations')).toBeInTheDocument();
    // The right-hand figure is the shop-wide total across those places.
    expect(screen.getByText('828 ft')).toBeInTheDocument();
  });

  it('ticks every location of a part at once, and says so in the accessible name', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('BUY-ORING-214');

    await user.click(
      screen.getByRole('checkbox', { name: 'Count BUY-ORING-214 in 3 locations' }),
    );
    // Rows, not parts — and the CTA has to say both or it lies about one of them.
    expect(
      screen.getByRole('button', { name: /^count 1 part in 3 locations$/i }),
    ).toBeEnabled();
  });

  it('expands the part into one input per location on the sheet', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('BUY-ORING-214');
    await chooseParts(user, 'BUY-ORING-214');

    expect(inputFor('BUY-ORING-214', 'Cabinet 3 › Shelf A')).toHaveValue(null);
    expect(inputFor('BUY-ORING-214', 'Cabinet 3 › Shelf B')).toHaveValue(null);
    expect(inputFor('BUY-ORING-214', 'Unassigned')).toHaveValue(null);
  });

  /**
   * The ambiguity this whole change removes: 38 counted against 10+20+10 has no defensible bin.
   * It is not *resolved* by grouping — it is never posed, because the group header has no input.
   * A total field there would rebuild the bug behind a UI that now promises it works.
   */
  it('gives the part header no input, only a read-only subtotal', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('BUY-ORING-214');
    await chooseParts(user, 'BUY-ORING-214');

    // Three places, three inputs — not four.
    expect(screen.getAllByRole('spinbutton')).toHaveLength(3);
    expect(
      screen.queryByRole('spinbutton', { name: /^counted quantity for BUY-ORING-214$/i }),
    ).not.toBeInTheDocument();
  });

  it('sums the counted locations on the header and says how many are done', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('BUY-ORING-214');
    await chooseParts(user, 'BUY-ORING-214');

    await user.type(inputFor('BUY-ORING-214', 'Cabinet 3 › Shelf A'), '803');
    expect(await screen.findByText('1 of 3 locations counted')).toBeInTheDocument();

    await user.type(inputFor('BUY-ORING-214', 'Cabinet 3 › Shelf B'), '18');
    expect(await screen.findByText('2 of 3 locations counted')).toBeInTheDocument();
    // +3 at Shelf A, −2 at Shelf B.
    expect(screen.getByText('+1')).toBeInTheDocument();
  });

  /**
   * A place left blank is a place you did not walk, and it must stay untouched. Partial counts
   * are the normal case — "I only got to Shelf A" — not an error state.
   */
  it('writes only the locations that were counted, each to its own bin', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('BUY-ORING-214');
    await chooseParts(user, 'BUY-ORING-214');

    await user.type(inputFor('BUY-ORING-214', 'Cabinet 3 › Shelf A'), '803');
    await user.click(screen.getByRole('button', { name: /save 1 change/i }));

    await waitFor(() => expect(commitCount).toHaveBeenCalled());
    const [variances] = asMock(commitCount).mock.calls[0];
    expect(variances).toHaveLength(1);
    expect(variances[0].candidate.target.locationId).toBe('loc-a');
    expect(variances[0].delta).toBe(3);
  });

  /** The notice the founder called silly. There should be no Alert above the list at all. */
  it('never holds a split part back from the sheet', async () => {
    renderPage();
    await screen.findByText('BUY-ORING-214');

    expect(screen.queryByText(/not on this sheet/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

/**
 * #656 — the save gate, on the page.
 *
 * `contestedParts` is unit-tested; what this covers is that the page actually STOPS. The whole
 * point of the issue is that explaining afterwards is too late: by then the wrong number is
 * committed and the counter has walked away. So the assertion that matters is
 * `expect(commitCount).not.toHaveBeenCalled()`.
 */
describe('stock that moved between two counted locations', () => {
  beforeEach(() => {
    asMock(loadCountCandidates).mockResolvedValue([
      at('p1', 'BUY-ORING-214', 'shelf-a', 'Shelf A', 40),
      at('p1', 'BUY-ORING-214', 'shelf-b', 'Shelf B', 12),
    ]);
    // A coworker moved 6 from A to B between opening the sheet and pressing Save.
    freshBalances({ 'p1::shelf-a': 34, 'p1::shelf-b': 18 });
  });

  const countBothShelves = async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('BUY-ORING-214');
    await chooseParts(user, 'BUY-ORING-214');
    await user.type(inputFor('BUY-ORING-214', 'Shelf A'), '40'); // true when written
    await user.type(inputFor('BUY-ORING-214', 'Shelf B'), '18'); // also true when written
    await user.click(screen.getByRole('button', { name: /save/i }));
    return user;
  };

  it('stops before writing, rather than resurrecting the stock and explaining after', async () => {
    await countBothShelves();

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/moved between locations you counted/i)).toBeInTheDocument();
    // The whole issue in one assertion: writing 40 absolutely to Shelf A would put back the six
    // units that legitimately left, taking the total to 58 against a truth of 52.
    expect(commitCount).not.toHaveBeenCalled();
  });

  it('names the shelf that changed and what it now reads', async () => {
    await countBothShelves();
    await screen.findByRole('dialog');

    expect(
      screen.getByText(/Shelf A: you counted 40 — now reads 34, changed since you looked/i),
    ).toBeInTheDocument();
  });

  it('lets the counter go back to the sheet with the refreshed figures', async () => {
    const user = await countBothShelves();
    await screen.findByRole('dialog');

    await user.click(screen.getByRole('button', { name: /let me recount/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    expect(commitCount).not.toHaveBeenCalled();
    // Refreshed, so the recount is measured against what is on the shelf now, not what was.
    expect(screen.getByRole('row', { name: /Shelf A/ })).toHaveTextContent('34');
  });

  /** The counter may have just walked both shelves again and know better than we do. */
  it('still allows an override', async () => {
    const user = await countBothShelves();
    await screen.findByRole('dialog');

    await user.click(screen.getByRole('button', { name: /save anyway/i }));
    await waitFor(() => expect(commitCount).toHaveBeenCalled());
  });

  it('does not stop a part counted at only one place', async () => {
    asMock(loadCountCandidates).mockResolvedValue([
      at('p2', '6061 plate', 'shelf-a', 'Shelf A', 40),
    ]);
    freshBalances({ 'p2::shelf-a': 34 });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('6061 plate');
    await chooseParts(user, '6061 plate');
    // 41, not 40: the sheet opened at 40, so counting 40 is a zero delta and Save stays disabled.
    await user.type(inputFor('6061 plate', 'Shelf A'), '41');
    await user.click(screen.getByRole('button', { name: /save 1 change/i }));

    // Reported after the fact, as before — the count IS what is on the shelf.
    await waitFor(() => expect(commitCount).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

/**
 * Counting a whole cabinet.
 *
 * A container holds no stock of its own since 20260806160053, so a one-bin sheet for one would be
 * permanently blank. "Count Cabinet 3" means the bins under it — and it needed no new write path,
 * because `commitCount` already adjusts each line at its own `target.locationId`.
 */
describe('counting a container', () => {
  const CAB = 'loc-cab';
  const ROW1 = 'loc-row-1';
  const ROW2 = 'loc-row-2';

  const place = (id: string, name: string, parent: string | null, sort = 0) => ({
    id,
    company_id: 'co1',
    parent_id: parent,
    name,
    kind: null,
    code: null,
    sort_order: sort,
    created_at: '',
    updated_at: '',
  });

  beforeEach(() => {
    searchParams.set('location', CAB);
    asMock(getLocations).mockResolvedValue([
      place(CAB, 'Cabinet 3', null),
      place(ROW1, 'Row 1', CAB, 0),
      place(ROW2, 'Row 2', CAB, 1),
      place('loc-un', 'Unassigned', null, 9),
    ]);
    asMock(loadCountCandidatesForPlaces).mockResolvedValue({
      candidates: [
        at('p-bearing', 'BUY-BEARING-608ZZ', ROW1, 'Cabinet 3 › Row 1', 380),
        at('p-oring', 'BUY-ORING-214', ROW1, 'Cabinet 3 › Row 1', 828),
        at('p-bearing', 'BUY-BEARING-608ZZ', ROW2, 'Cabinet 3 › Row 2', 200),
      ],
      total: 3,
    });
    freshBalances({ 'p-bearing::loc-row-1': 380, 'p-bearing::loc-row-2': 200 });
  });

  afterEach(() => searchParams.delete('location'));

  it('gathers every bin beneath the container, in walking order', async () => {
    renderPage();
    await screen.findByText("What's in Cabinet 3?");

    expect(loadCountCandidatesForPlaces).toHaveBeenCalledWith(
      [
        { id: ROW1, name: 'Row 1', path: 'Cabinet 3 › Row 1' },
        { id: ROW2, name: 'Row 2', path: 'Cabinet 3 › Row 2' },
      ],
      expect.objectContaining({ offset: 0 }),
    );
  });

  /**
   * The reason this is safe. Aggregating a split part would re-create the exact ambiguity that
   * forces the company-wide sheet to skip such parts: 380 + 200 counted as 560 has no defensible
   * home for the −20. Two lines means each number is about one shelf you are standing at.
   */
  it('keeps a split part as one line per bin rather than one total', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("What's in Cabinet 3?");

    // The picker is part-first — one row per part, whatever its places — so the split shows on the
    // sheet, which is where the numbers get typed.
    await user.click(screen.getByRole('checkbox', { name: /count BUY-BEARING-608ZZ/i }));
    await user.click(screen.getByRole('button', { name: /^count 1 part in 2 locations/i }));

    expect(inputFor('BUY-BEARING-608ZZ', 'Cabinet 3 › Row 1')).toBeInTheDocument();
    expect(inputFor('BUY-BEARING-608ZZ', 'Cabinet 3 › Row 2')).toBeInTheDocument();
  });

  it('commits a line against its own bin, not the container', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("What's in Cabinet 3?");

    await user.click(screen.getByRole('checkbox', { name: /count BUY-BEARING-608ZZ/i }));
    await user.click(screen.getByRole('button', { name: /^count 1 part in 2 locations/i }));
    // Only Row 2 gets a number, so only Row 2 commits — the other line has no entry.
    await user.type(inputFor('BUY-BEARING-608ZZ', 'Cabinet 3 › Row 2'), '190');
    await user.click(screen.getByRole('button', { name: /^save/i }));

    await waitFor(() => expect(commitCount).toHaveBeenCalled());
    const [variances] = asMock(commitCount).mock.calls.at(-1)!;
    const targets = (variances as Array<{ candidate: CountCandidate }>).map(
      (v) => v.candidate.target.locationId,
    );
    expect(targets).toEqual([ROW2]);
    expect(targets).not.toContain(CAB);
  });

  /**
   * `bulk_put_away` moves parts out of ONE location, and the ticked rows here come from several —
   * so there is no single source to send them from. Counting is unaffected; putting away stays
   * available one level down, standing at the bin.
   */
  it('withholds the bulk put-away, which has no single source on a subtree', async () => {
    renderPage();
    await screen.findByText("What's in Cabinet 3?");

    expect(screen.queryByLabelText(/send the ticked parts to/i)).not.toBeInTheDocument();
  });
});
