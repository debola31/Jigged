/**
 * The manager — the wiring between one read, the board, the demoted list, and the sheet.
 *
 * The test that matters most is `treats a company with only the system bucket as having no
 * storage`. `trg_auto_track_stocked_part` creates a top-level `('Unassigned', kind='system')`
 * row the moment any stocked part exists, so the old `tree.length === 0` empty state was
 * **unreachable for every real tenant** — both its CTAs were dead code and what an owner got was
 * one action-less row reading "Unassigned".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, routerMocks } from '../../../test-utils';
import userEvent from '@testing-library/user-event';

// `importOriginal` below pulls in the real access module, which constructs a Supabase client at
// import time. Stub the client so only the pure helper survives the import.
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({}),
}));

vi.mock('@/utils/inventoryLocationsAccess', async (importOriginal) => {
  // `buildLocationTree` is pure and is what the manager assembles the board from — mocking it
  // would test nothing. Only the network functions are stubbed.
  const actual = await importOriginal<typeof import('@/utils/inventoryLocationsAccess')>();
  return {
    buildLocationTree: actual.buildLocationTree,
    getLocationBoard: vi.fn(),
    getLocationContents: vi.fn(async () => ({ contents: [], total: 0 })),
    createLocation: vi.fn(),
    updateLocation: vi.fn(),
    duplicateLocation: vi.fn(async () => [{ id: 'dup' }]),
    deleteLocation: vi.fn(),
    // Re-parenting: the sheet's new "Move into…" reaches this.
    moveLocation: vi.fn(),
    // The sheet now mounts PlaceHistory, which reads a place's ledger on expand. Unmocked it is
    // `undefined` in every test here, not just the ones that expand it.
    getLocationHistory: vi.fn(async () => []),
    // Subdivide runs the real builder, so its write has to be stubbed here too.
    materializeLocationSpec: vi.fn(async () => [{ id: 'new' }]),
    // `Change layout` writes through this now — the reshape path, which can also remove and rename.
    applyLocationLayout: vi.fn(async () => [{ id: 'cab3' }]),
    getContentsPageForLocations: vi.fn(async () => ({ contents: [], total: 0 })),
    // The three verbs that write. Unmocked they are `undefined` and only fail on submit, which is
    // the failure mode most likely to be mistaken for a UI bug.
    addStockAtLocation: vi.fn(async () => ({})),
    depleteStockAtLocation: vi.fn(async () => ({})),
    transferStock: vi.fn(async () => ({})),
  };
});

// The Add picker offers the whole stocked catalogue. Without this it reaches the stubbed Supabase
// client and the dialog renders its error state instead of a part list.
vi.mock('@/utils/partsAccess', () => ({
  getAllParts: vi.fn(async () => [
    { id: 'p1', part_name: 'RAW-STEEL-BLANK', primary_unit: 'ea' },
  ]),
}));

// The unit-scoped Bulk Adjust drawer reads the whole subtree's rows through this.
vi.mock('@/utils/inventoryCountAccess', () => ({
  loadCountCandidatesForPlaces: vi.fn(async () => ({ candidates: [], total: 0 })),
  commitCount: vi.fn(async () => ({ committed: 0, failures: [] })),
}));

vi.mock('@/utils/locationLabelPdf', () => ({
  generateLocationLabelSheet: vi.fn(async () => ({ save: vi.fn() })),
}));

import LocationsManager from '@/components/inventory/locations/LocationsManager';
import {
  getLocationBoard,
  deleteLocation,
  materializeLocationSpec,
  applyLocationLayout,
  createLocation,
} from '@/utils/inventoryLocationsAccess';
import { generateLocationLabelSheet } from '@/utils/locationLabelPdf';
import type { InventoryLocation } from '@/types/inventoryLocations';

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

/** The seed's shape: Unassigned + Cabinet 3 › Shelf A/B + Yard. */
const SEED_LOCATIONS = [
  loc({ id: 'un', name: 'Unassigned', kind: 'system' }),
  loc({ id: 'cab3', name: 'Cabinet 3', kind: 'cabinet' }),
  loc({ id: 'shelf-a', name: 'Shelf A', parent_id: 'cab3' }),
  loc({ id: 'shelf-b', name: 'Shelf B', parent_id: 'cab3' }),
  loc({ id: 'yard', name: 'Yard', kind: 'outside' }),
];

const board = (
  locations: InventoryLocation[],
  counts: Array<[string, number]> = [],
) => ({ locations, directPartCounts: new Map(counts) });

const seedBoard = () => board(SEED_LOCATIONS, [['shelf-a', 2], ['shelf-b', 1], ['un', 7], ['yard', 1]]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getLocationBoard).mockResolvedValue(seedBoard());
});

describe('LocationsManager', () => {
  it('loads locations and occupancy in one request pair and rolls it up the tree', async () => {
    render(<LocationsManager companyId="co1" />);

    // Cabinet 3 holds nothing DIRECTLY; both its shelves hold something. The roll-up is the
    // reason a full cabinet never reads empty, and it survived the table being deleted too.
    expect(await screen.findByRole('button', { name: /^Cabinet 3/ })).toBeInTheDocument();
    expect(screen.getByText(/2\/2 used/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Yard/ })).toBeInTheDocument();
    expect(getLocationBoard).toHaveBeenCalledTimes(1);
    expect(getLocationBoard).toHaveBeenCalledWith('co1');
  });

  /** The empty state that never rendered. */
  it('treats a company with only the system bucket as having no storage', async () => {
    vi.mocked(getLocationBoard).mockResolvedValue(
      board([loc({ id: 'un', name: 'Unassigned', kind: 'system' })], [['un', 9428]]),
    );
    render(<LocationsManager companyId="co1" />);

    expect(await screen.findByText(/9,428 parts, nowhere in particular/i)).toBeInTheDocument();
  });

  it('does not claim "nowhere in particular" once real storage exists', async () => {
    render(<LocationsManager companyId="co1" />);
    await screen.findByRole('button', { name: /^Cabinet 3/ });
    expect(screen.queryByText(/nowhere in particular/i)).not.toBeInTheDocument();
  });

  it('keeps the genuinely-empty state for a company with no locations at all', async () => {
    vi.mocked(getLocationBoard).mockResolvedValue(board([]));
    render(<LocationsManager companyId="co1" />);

    expect(await screen.findByText(/no storage yet/i)).toBeInTheDocument();
    // ONE button. This used to offer "Build visually" and "Add manually" side by side,
    // asking someone who has never seen the feature to choose between two flows before
    // knowing what either produces.
    expect(screen.getByRole('button', { name: /add storage/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /build visually/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add manually/i })).not.toBeInTheDocument();
  });

  /**
   * A unit is a ROUTE, not a mode the list is in.
   *
   * It was local state until 2026-08-10, which meant no back button, no shareable link, and the
   * list's own toolbar following the reader into a cabinet where "Add storage" acted on something
   * they were no longer looking at.
   */
  /**
   * Picking a unit is a SELECTION on one page, not a journey to another.
   *
   * It was a nested route for a day, and Next treated every pick as a page transition — the whole
   * screen blanked and reloaded to change one pane. `replace`, so clicking through six cabinets
   * does not bury the page you arrived from under six history entries, and `scroll: false` so a
   * pick does not throw away your position in a 12-row grid.
   */
  it('selects the unit on the same page rather than navigating to another', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" />);

    await user.click(await screen.findByRole('button', { name: /^Cabinet 3/ }));
    expect(routerMocks.replace).toHaveBeenCalledWith(
      '/dashboard/co1/inventory/locations?unit=cab3',
      { scroll: false },
    );
    expect(routerMocks.push).not.toHaveBeenCalled();
  });

  /**
   * The bug this closes: clicking a single-place unit set the selected PLACE without changing the
   * unit, so the pane carried on showing the previous cabinet and the click looked like a no-op.
   */
  it('selects a single-place unit like any other', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" unitId="cab3" />);

    await user.click(await screen.findByRole('button', { name: /^Yard/ }));
    expect(routerMocks.replace).toHaveBeenCalledWith(
      '/dashboard/co1/inventory/locations?unit=yard',
      { scroll: false },
    );
  });

  /**
   * On the unit, the unit's own actions are on the unit — not behind a drawer over it. The sheet
   * is now only for a place INSIDE the unit, which is also what gives a row band an action path.
   */
  it('draws the unit and carries its actions on the unit', async () => {
    render(<LocationsManager companyId="co1" unitId="cab3" />);

    // The grid: both shelves are drawn as cells with their fill state named.
    expect(await screen.findByRole('button', { name: /^Shelf A/ })).toBeInTheDocument();
    // The three you reach for while working are on the surface…
    for (const label of [/^bulk adjust$/i, /change layout/i, /print qr/i]) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    // …and the do-it-once ones are behind a menu, so seven buttons do not wrap to three rows and
    // push the grid off a phone. `Move into…` is gone entirely — see the test below.
    expect(screen.queryByRole('button', { name: /^rename$/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /more actions for Cabinet 3/i })).toBeInTheDocument();
  });

  /**
   * A single-place unit is not a special case any more.
   *
   * The Yard has no rows and no bins. It used to open a right-anchored drawer while a cabinet
   * swapped the page — the seam that made this read as two products. Now every unit lands in the
   * same pane, which simply has no grid to draw for this one.
   */
  it('shows a single-location unit in the same pane, drawn as one square', async () => {
    render(<LocationsManager companyId="co1" unitId="yard" />);

    // Twice, deliberately: on its card in the list and again in the pane beside it.
    expect(await screen.findAllByText('One location')).toHaveLength(2);
    // Drawn, not a bare contents list — the same shape as every other unit, with one cell.
    expect(screen.getByRole('button', { name: /^Yard —/ })).toBeInTheDocument();
  });

  /**
   * `Move into…` is gone. Re-parenting a unit was the one thing `Change layout` cannot do, and it
   * was reachable from a menu nobody opened; 118 of Contour's 121 legacy locations were flat and
   * its five real units nest under nothing. Recorded here so its removal is deliberate rather than
   * something that quietly fell out of a refactor.
   */
  it('no longer offers Move into', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" unitId="cab3" />);

    await user.click(await screen.findByRole('button', { name: /more actions for Cabinet 3/i }));
    expect(screen.queryByRole('menuitem', { name: /move into/i })).not.toBeInTheDocument();
    expect(await screen.findByRole('menuitem', { name: /rename/i })).toBeInTheDocument();
  });

  /**
   * Clicking a bin does NOT navigate: the grid stays put and the contents open underneath, so
   * working through a cabinet costs no page loads and never loses your position.
   */
  it('opens a place in the drawer rather than navigating away from it', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" unitId="cab3" />);

    await user.click(await screen.findByRole('button', { name: /^Shelf A/ }));

    // The drawer names the place and its path — a shop can hold two bins both called Shelf A.
    const drawer = await screen.findByRole('presentation');
    expect(within(drawer).getByText('Shelf A')).toBeInTheDocument();
    expect(within(drawer).getByText(/Cabinet 3/)).toBeInTheDocument();
    expect(routerMocks.push).not.toHaveBeenCalled();
  });

  /**
   * Three tests were removed here — "defaults to the board and can re-mode to the list",
   * "sorts Unassigned last in the list too" and "opens the sheet from a list row too".
   *
   * The Board|List toggle and `LocationTreeView` are gone. An indented text tree is the
   * opposite of the visual map the research asks for, Cabinet 1 alone exploded into 15
   * rows, and at the ~12–18 places a real shop has the board is strictly better — so the
   * toggle was a choice with no good answer. The board is now the only view, which is why
   * these three have nothing left to assert.
   */
  it('offers no view toggle — the board is the only view', async () => {
    render(<LocationsManager companyId="co1" />);
    await screen.findByRole('button', { name: /^Cabinet 3/ });

    expect(screen.queryByRole('button', { name: 'List' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Board' })).not.toBeInTheDocument();
  });

  /** Scanning is an operator gesture at a shelf, not an admin gesture at a desk. */
  it('has no Scan button — that moved to the operator tab bar', async () => {
    render(<LocationsManager companyId="co1" />);
    await screen.findByRole('button', { name: /^Cabinet 3/ });

    expect(screen.queryByRole('button', { name: /^scan$/i })).not.toBeInTheDocument();
  });

  /** The whole point of the reshape: one way in, not three. */
  it('exposes exactly one way to add storage, and it is not the wizard', async () => {
    render(<LocationsManager companyId="co1" />);
    await screen.findByRole('button', { name: /^Cabinet 3/ });

    expect(screen.getAllByRole('button', { name: /add storage/i })).toHaveLength(1);
    expect(
      screen.queryByRole('button', { name: /new top-level location/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /build visually/i })).not.toBeInTheDocument();
  });

  /**
   * The company-wide sheet is NOT reached from here, and that is the correction.
   *
   * `Count all parts` opened one list of every stocked part in the shop. Nobody audits a shop that
   * way — you audit one cabinet, walking bin to bin, which is what `Adjust` on a unit does now that
   * the worksheet resolves a container to every leaf under it. The shop-wide sheet still exists as
   * `Count Inventory` on the Parts toolbar, where the noun is the items rather than the places.
   */
  it('no longer offers a company-wide count from Storage', async () => {
    render(<LocationsManager companyId="co1" />);
    await screen.findByRole('button', { name: /^Cabinet 3/ });

    expect(screen.queryByRole('button', { name: /count all parts/i })).not.toBeInTheDocument();
    // The one page-level control that IS about every place stays.
    expect(screen.getByRole('button', { name: /print all labels/i })).toBeInTheDocument();
  });

  it('routes delete through the confirm dialog', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" unitId="yard" />);

    await user.click(await screen.findByRole('button', { name: /more actions for Yard/i }));
    await user.click(await screen.findByRole('menuitem', { name: /delete/i }));

    expect(await screen.findByText(/delete location\?/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    expect(deleteLocation).toHaveBeenCalledWith('yard');
  });

  /**
   * `Change layout` opens on the unit's REAL layout.
   *
   * The three tests this replaces asserted the opposite and passed: they pinned the builder being
   * handed `existingSiblingNames` and a `startSortOrder` past them, so a cabinet holding Shelf A/B
   * got Row 1–5 *beside* them and one already holding Row 1–3 got Row 4–8. That was the bug — the
   * button is titled `Change the layout of Cabinet 3` and could only ever add to it.
   */
  it('opens Change layout on the same controls that built the unit', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" unitId="cab3" />);

    await user.click(await screen.findByRole('button', { name: /change layout/i }));

    expect(await screen.findByText('Change the layout of Cabinet 3')).toBeInTheDocument();
    // Cabinet 3 holds Shelf A and Shelf B — unnumbered, so the numbers editor reads them back as a
    // names list rather than inventing "Shelf {n}". Either way it is the CREATE modal, pre-filled.
    expect(await screen.findByDisplayValue('Shelf A, Shelf B')).toBeInTheDocument();
    expect(screen.queryByText(/unchanged so far/i)).not.toBeInTheDocument();
  });

  it('removes a location instead of appending beside it, and says what that costs', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" unitId="cab3" />);

    await user.click(await screen.findByRole('button', { name: /change layout/i }));

    // Drop Shelf B by editing the list — the numbers path, which is what opens by default.
    const names = await screen.findByLabelText('Names');
    await user.clear(names);
    await user.type(names, 'Shelf A');

    // Shelf B holds one part in the fixture, so this cannot just be applied.
    expect(await screen.findByText(/Removing 1 location, 1 of which holds stock/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /where does the stock go/i }),
    ).toBeInTheDocument();
  });

  it('hands the reshape to apply_location_layout, never to the create path', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" unitId="cab3" />);

    await user.click(await screen.findByRole('button', { name: /change layout/i }));
    await user.click(await screen.findByRole('button', { name: /edit locations one by one/i }));

    const field = await screen.findByDisplayValue('Shelf A');
    await user.clear(field);
    await user.type(field, 'Top Shelf');

    await user.click(screen.getByRole('button', { name: /review changes/i }));
    await user.click(await screen.findByRole('button', { name: /apply changes/i }));

    expect(applyLocationLayout).toHaveBeenCalledTimes(1);
    expect(materializeLocationSpec).not.toHaveBeenCalled();
    const [unitId, payload] = vi.mocked(applyLocationLayout).mock.calls[0];
    expect(unitId).toBe('cab3');
    expect(payload.removals).toEqual([]);
    expect(
      payload.nodes.find((n) => n.ref === 'id:shelf-a')?.name,
    ).toBe('Top Shelf');
  });

  /**
   * Drilling into a container used to be a one-way trip.
   *
   * Clicking a container makes it the pane's subject (`openCell` → `showUnit`), and a container is
   * not in the list beside it — so on a wide screen, where the "All storage" button is hidden,
   * there was no way back. The report: *"once you click row 1 and then the tabs and their cells,
   * you can't go back anywhere to click row 2 unless you first click on another root storage
   * unit."*
   */
  it('gives a drilled-into container a path back to the unit it came from', async () => {
    const user = userEvent.setup();
    vi.mocked(getLocationBoard).mockResolvedValue(
      board([
        loc({ id: 'cab', name: 'Grid Cabinet', kind: 'cabinet' }),
        loc({ id: 'row1', name: 'Row 1', parent_id: 'cab' }),
        loc({ id: 'bin1', name: 'Bin 1', parent_id: 'row1' }),
      ]),
    );
    render(<LocationsManager companyId="co1" unitId="row1" />);

    // The subject is Row 1, which the list does not contain.
    expect(await screen.findByRole('heading', { name: 'Row 1' })).toBeInTheDocument();

    const crumbs = screen.getByLabelText('Where this is');
    expect(within(crumbs).getByRole('button', { name: 'Grid Cabinet' })).toBeInTheDocument();
    await user.click(within(crumbs).getByRole('button', { name: 'Storage' }));

    // `showUnit(null)` — back to the whole list.
    expect(routerMocks.replace).toHaveBeenCalledWith(
      '/dashboard/co1/inventory/locations',
      expect.anything(),
    );
  });

  it('shows no path on a root unit — the list beside it is already the way back', async () => {
    render(<LocationsManager companyId="co1" unitId="cab3" />);
    await screen.findByRole('heading', { name: 'Cabinet 3' });
    expect(screen.queryByLabelText('Where this is')).not.toBeInTheDocument();
  });

  /**
   * The `Unassigned` system bucket is not a place anyone can stick a label on, so printing one for
   * it would waste a sticker and put a QR on a shelf that does not exist.
   */
  it('prints every real place and never labels the system bucket', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" />);
    await screen.findByRole('button', { name: /^Cabinet 3/ });

    await user.click(screen.getByRole('button', { name: /print all labels/i }));

    const arg = vi.mocked(generateLocationLabelSheet).mock.calls[0][0];
    expect(arg.labels.map((l) => l.id).sort()).toEqual(['cab3', 'shelf-a', 'shelf-b', 'yard']);
    // No heading and no origin. The sheet is die-cut Avery stock, where a page heading prints
    // across label 1, and the scan origin is pinned so a preview-printed sticker can't outlive its
    // deployment.
    expect(arg).not.toHaveProperty('heading');
    expect(arg.baseUrl).toBeUndefined();
  });
});

/**
 * The board's daily job.
 *
 * On review, the board read as purposeless — and correctly, because every control on it was
 * one-time setup. This is the route out to the place-scoped worksheet, which is the one thing here
 * you come back to do.
 */
/**
 * The four verbs, and why there are exactly four.
 *
 * Storage could not move stock at all: `Count or put away` was a single button that navigated to
 * the count worksheet, so from here you could audit a place and empty it, and could not put
 * anything into it. Every real write lived on the operator's phone or a part's own page, both
 * part-first — you find the part, then say where. Standing at a cabinet you have the opposite
 * information.
 *
 * The names are the operator's, in the operator's fixed order, because they are the four kinds of
 * ledger row and there is no fifth: addition, depletion, transfer, adjustment. **`Count` and `Put
 * away` were never separate actions** — `commitCount` writes one `adjustStockAtLocation` per line
 * and `bulk_put_away` writes ordinary transfer pairs, so each was a batch form of a verb already
 * here. That is why `Adjust` navigates to the worksheet instead of opening a dialog.
 */
describe('LocationsManager — the four verbs', () => {
  /**
   * The paragraph of instructions is gone. It explained a page whose shape did not explain
   * itself — a list you clicked to swap the page out from under you. A list beside the thing it
   * selects needs no caption; the empty pane says the one thing worth saying.
   */
  it('explains the pane by its shape, not a paragraph above it', async () => {
    render(<LocationsManager companyId="co1" />);
    await screen.findByRole('button', { name: /^Cabinet 3/ });

    expect(screen.queryByText(/Adding and removing stock happens on the part itself/i))
      .not.toBeInTheDocument();
    expect(screen.getByText(/pick a location to see what is in it/i)).toBeInTheDocument();
  });

  /**
   * THE FIX FOR A REPORTED OFF-BY-ONE.
   *
   * The contents used to sit under the grid, so selecting a bin near the top of a 12-row cabinet
   * put the answer below the fold and the panel scrolled the page to it. That moved the grid up
   * under the cursor by about one row height — click Row 4, the page jumps, click again where Row 4
   * was, and you get Row 5. Measured in a browser: cells and labels align to half a pixel and one
   * click always selected the row it was on. The page moving was the whole of it.
   *
   * jsdom has no scroll and no layout, so this can only assert the STRUCTURAL cause: nothing below
   * the grid to scroll to.
   */
  it('keeps the pane to the unit, with nothing below the grid to scroll to', async () => {
    render(<LocationsManager companyId="co1" unitId="cab3" />);

    await screen.findByRole('button', { name: /^Shelf A/ });
    expect(screen.queryByText(/what's in shelf a/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/recent activity/i)).not.toBeInTheDocument();
  });

  it('offers the four verbs on a place, in the operator order', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" unitId="yard" />);

    await user.click(await screen.findByRole('button', { name: /^Yard —/ }));
    await screen.findByRole('button', { name: /^adjust$/i });
    const labels = ['Add', 'Remove', 'Move', 'Adjust'];
    const found = labels.map((l) => screen.getByRole('button', { name: new RegExp(`^${l}$`, 'i') }));
    // ORDER, not just presence: the same person may use this and the phone in one day, and muscle
    // memory should not have to be re-learned per screen.
    for (let i = 1; i < found.length; i += 1) {
      expect(
        found[i - 1].compareDocumentPosition(found[i]) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  /**
   * ONE PLACE IS A DIALOG. MANY PLACES ARE THE WORKSHEET.
   *
   * Adjusting a single bin used to navigate to the worksheet, which for a place holding two parts
   * cost a page transition, a two-step wizard, a search box over two rows and a bulk put-away panel
   * the `Move` verb now duplicates. A leaf is the same weight as the other three verbs, so it gets
   * what they get — a dialog that leaves the grid where it is.
   */
  /**
   * ONE PAGE. The verb opens a section under itself; it does not swap the drawer to another view.
   * Swapping was one layer, but it still cost the contents list, the history and the other three
   * verbs off screen to type one quantity.
   */
  it('opens Adjust in place, keeping the rest of the drawer on screen', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" unitId="yard" />);

    await user.click(await screen.findByRole('button', { name: /^Yard —/ }));
    const adjust = await screen.findByRole('button', { name: /^adjust$/i });
    await user.click(adjust);

    expect(screen.getByText(/type what you actually counted/i)).toBeInTheDocument();
    // The other three verbs stay on screen — this is one page, not a view swap.
    expect(screen.getByRole('button', { name: /^add$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^move$/i })).toBeInTheDocument();
    // …and the read-only list steps aside, because Adjust lists the very same parts with a field
    // on each. Painting both put the verb a screen and a half above the rows it applies to.
    expect(screen.queryByText(/what's here/i)).not.toBeInTheDocument();
    expect(adjust).toHaveAttribute('aria-expanded', 'true');
    expect(routerMocks.push).not.toHaveBeenCalled();

    // …and the same button closes it again.
    await user.click(adjust);
    expect(screen.queryByText(/type what you actually counted/i)).not.toBeInTheDocument();
  });

  /**
   * The reversal that makes container-scoped auditing work.
   *
   * A container holds no stock of its own (20260806160053), so this button was once withheld on one
   * — it could only have opened a blank sheet. Auditing a container means auditing every leaf under
   * it, which is how it physically happens: one cabinet, bin by bin.
   *
   * And it no longer navigates. It was the last control on Storage that did, for the operation you
   * are most likely to run while looking at the cabinet.
   */
  it('audits a whole cabinet in a drawer, without leaving the page', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" unitId="cab3" />);

    await user.click(await screen.findByRole('button', { name: /^bulk adjust$/i }));

    const heading = await screen.findByRole('heading', { name: /bulk adjust Cabinet 3/i });
    // Both shelves are in scope — a container is audited through its bins. Scoped to the drawer,
    // because the unit's own card in the list says "2 places" too.
    expect(within(heading.parentElement!).getByText(/2 locations/i)).toBeInTheDocument();
    expect(routerMocks.push).not.toHaveBeenCalled();
  });

  it('opens Add against the place you are looking at', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" unitId="yard" />);

    await user.click(await screen.findByRole('button', { name: /^Yard —/ }));
    await user.click(await screen.findByRole('button', { name: /^add$/i }));

    expect(await screen.findByText(/add stock here/i)).toBeInTheDocument();
  });

  /**
   * You cannot take out of, or move from, an empty drawer — and offering it would open a picker
   * with no options in it. Disabled rather than hidden: a control that vanishes reads as a bug,
   * and its absence would not explain itself.
   */
  it('disables Remove and Move on a place holding nothing', async () => {
    const user = userEvent.setup();
    vi.mocked(getLocationBoard).mockResolvedValue(
      board(SEED_LOCATIONS, [['shelf-a', 2], ['un', 7]]),
    );
    render(<LocationsManager companyId="co1" unitId="yard" />);

    await user.click(await screen.findByRole('button', { name: /^Yard —/ }));
    await screen.findByRole('button', { name: /^adjust$/i });
    expect(screen.getByRole('button', { name: /^remove$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^move$/i })).toBeDisabled();
    // Add is always available: an empty bin is exactly where you put something.
    expect(screen.getByRole('button', { name: /^add$/i })).toBeEnabled();
  });

  /**
   * Stock does not live in a cabinet, so the cabinet's own row offers no way to put any there.
   * The four verbs appear once a place inside it is selected — which is also the only point at
   * which "add what, where" has an answer.
   */
  it('offers no stock verbs on a container until a location inside it is picked', async () => {
    render(<LocationsManager companyId="co1" unitId="cab3" />);

    await screen.findByRole('button', { name: /^bulk adjust$/i });
    for (const verb of [/^add$/i, /^remove$/i, /^move$/i]) {
      expect(screen.queryByRole('button', { name: verb })).not.toBeInTheDocument();
    }
    expect(screen.getByText(/pick a location to see what is in it/i)).toBeInTheDocument();
  });

  /**
   * The drawer is per-place, so switching cells must not leave you inside the previous place's
   * form with a new place's name on it. Enforced by a remount key rather than an effect.
   */
  it('returns to the overview when a different place is picked', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" unitId="cab3" />);

    await user.click(await screen.findByRole('button', { name: /^Shelf A —/ }));
    await user.click(await screen.findByRole('button', { name: /^add$/i }));
    expect(await screen.findByText(/add stock here/i)).toBeInTheDocument();

    // The verb toggles its own section shut — one layer, and never a dialog stacked on it.
    await user.click(screen.getByRole('button', { name: /^add$/i }));
    expect(screen.queryByText(/add stock here/i)).not.toBeInTheDocument();

    // Then close, and pick the other shelf. The drawer is modal, so the grid behind it is inert
    // until it closes — deliberate, and the reason this goes through Close rather than straight to
    // the next cell.
    await user.click(screen.getByRole('button', { name: /^close$/i }));
    await user.click(await screen.findByRole('button', { name: /^Shelf B —/ }));

    // Remounted by key, so it is the overview again rather than Shelf A's Add form renamed.
    expect(await screen.findByRole('button', { name: /^add$/i })).toBeInTheDocument();
    expect(screen.queryByText(/add stock here/i)).not.toBeInTheDocument();
  });

  /**
   * The put-away pile gets the same four verbs as anything else.
   *
   * `Put these away` is gone as a name because it was never its own action — it opened the same
   * worksheet, whose control reads `Move N to…` and whose write is `bulk_put_away`, a batch of
   * ordinary transfers. Emptying the pile is therefore a Move, and the bulk form of it is one click
   * further on, inside the worksheet that `Adjust` opens.
   */
  it('gives the put-away pile the same verbs in the same drawer', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" unitId="un" />);

    await user.click(await screen.findByRole('button', { name: /^Unassigned —/ }));
    expect(await screen.findByRole('button', { name: /^move$/i })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /put these away/i })).not.toBeInTheDocument();
  });

  /**
   * The pile is not furniture. Offering `Change layout` on it promises something the database
   * refuses outright — `assert_location_parent_holds_no_stock` will not give it children.
   */
  it('withholds layout and labelling from the put-away pile', async () => {
    render(<LocationsManager companyId="co1" unitId="un" />);

    // It draws like any other single place…
    await screen.findByRole('button', { name: /^Unassigned —/ });
    // …but it is not furniture: `assert_location_parent_holds_no_stock` refuses it children, and a
    // pile has nothing to label.
    expect(screen.queryByRole('button', { name: /change layout/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^print qr$/i })).not.toBeInTheDocument();
  });

  /**
   * Adding storage is ONE step.
   *
   * It used to be two: name a bare place here, then find `Divide it up…` inside its detail sheet
   * to give it any structure. Nobody making a cabinet wants an empty cabinet, and the second half
   * was behind a drawer — so a shop could end up with named furniture and no places in it. Since
   * `create_location_tree` the whole thing is also one transaction, so there is no reason to split
   * the decision either.
   */
  it('names the unit and shapes it in one step, in one call', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" />);
    await screen.findByRole('button', { name: /^Cabinet 3/ });

    await user.click(screen.getByRole('button', { name: /add storage/i }));
    await user.type(await screen.findByLabelText(/what is it called/i), 'New Cabinet');
    await user.click(await screen.findByRole('button', { name: /create 10 locations/i }));

    // ONE call, and the unit is the ROOT of the spec rather than a separate create beforehand.
    expect(materializeLocationSpec).toHaveBeenCalledTimes(1);
    expect(createLocation).not.toHaveBeenCalled();
    const [, parentId, spec] = vi.mocked(materializeLocationSpec).mock.calls[0];
    expect(parentId).toBeNull();
    expect(spec).toHaveLength(1);
    expect(spec[0].name).toBe('New Cabinet');
    expect(spec[0].children.map((n) => n.name)).toEqual([
      'Row 1', 'Row 2', 'Row 3', 'Row 4', 'Row 5',
    ]);
  });

  /** The count is what you get to put things in, not how many rows it takes to build it. */
  it('counts places rather than nodes — 5 rows x 2 is 10, not 15', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" />);
    await screen.findByRole('button', { name: /^Cabinet 3/ });

    await user.click(screen.getByRole('button', { name: /add storage/i }));
    expect(await screen.findByRole('button', { name: /create 10 locations/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /15 locations/i })).not.toBeInTheDocument();
  });

  /** A name is required; the layout is not — "the yard" is one place and that is a valid unit. */
  it('will not create an unnamed unit, and warns before a duplicate name', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" />);
    await screen.findByRole('button', { name: /^Cabinet 3/ });

    await user.click(screen.getByRole('button', { name: /add storage/i }));
    expect(await screen.findByRole('button', { name: /create 10 locations/i })).toBeDisabled();

    await user.type(screen.getByLabelText(/what is it called/i), 'Cabinet 3');
    expect(await screen.findByText(/you already have a cabinet 3/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create 10 locations/i })).toBeDisabled();
  });
});
