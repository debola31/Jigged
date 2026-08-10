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
import { render, screen, routerMocks } from '../../../test-utils';
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
  };
});

vi.mock('@/utils/locationLabelPdf', () => ({
  generateLocationLabelSheet: vi.fn(async () => ({ save: vi.fn() })),
}));

import LocationsManager from '@/components/inventory/locations/LocationsManager';
import {
  getLocationBoard,
  deleteLocation,
  materializeLocationSpec,
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
    expect(screen.getByText(/2 of 2 places in use/)).toBeInTheDocument();
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
  it('navigates to the unit rather than swapping the list in place', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" />);

    await user.click(await screen.findByRole('button', { name: /^Cabinet 3/ }));
    expect(routerMocks.push).toHaveBeenCalledWith('/dashboard/co1/inventory/locations/cab3');
  });

  /**
   * On the unit, the unit's own actions are on the unit — not behind a drawer over it. The sheet
   * is now only for a place INSIDE the unit, which is also what gives a row band an action path.
   */
  it('draws the unit and carries its actions in its own header', async () => {
    render(<LocationsManager companyId="co1" unitId="cab3" />);

    // The grid: both shelves are drawn as cells with their fill state named.
    expect(await screen.findByRole('button', { name: /^Shelf A/ })).toBeInTheDocument();
    for (const label of [/change layout/i, /print qr/i, /rename/i, /delete/i, /count or put away/i]) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    // The list's toolbar does not follow you in.
    expect(screen.queryByRole('button', { name: /add storage/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /print all labels/i })).not.toBeInTheDocument();
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
   * The board is the hub, so the company-wide sheet is reached from here.
   *
   * "Count all parts", not "Count everything": every other control on this board is
   * place-scoped, so "everything" read as "all the places" rather than "the whole catalogue".
   */
  it('offers Count all parts, since /inventory no longer exists to host it', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" />);
    await screen.findByRole('button', { name: /^Cabinet 3/ });

    await user.click(screen.getByRole('button', { name: /count all parts/i }));
    expect(routerMocks.push).toHaveBeenCalledWith('/dashboard/co1/inventory/count');
  });

  it('routes the sheet delete through the confirm dialog', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" />);

    await user.click(await screen.findByRole('button', { name: /^Yard/ }));
    await user.click(await screen.findByRole('button', { name: /delete/i }));

    // The sheet closes first — two stacked surfaces leave nothing legible underneath.
    expect(await screen.findByText(/delete location\?/i)).toBeInTheDocument();
    expect(screen.queryByText("What's here")).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    expect(deleteLocation).toHaveBeenCalledWith('yard');
  });

  /**
   * The sheet is the only launcher for Subdivide, and it has to hand over what's already inside
   * so a second subdivide continues the numbering rather than colliding mid-insert.
   */
  it('launches Subdivide aimed at the unit, carrying its code and existing children', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" unitId="cab3" />);

    await user.click(await screen.findByRole('button', { name: /change layout/i }));

    // Title proves parentPath. There is no palette step to click through any more.
    expect(await screen.findByText('Change the layout of Cabinet 3')).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: /create 10 places/i }));

    const [, parentId, spec] = vi.mocked(materializeLocationSpec).mock.calls[0];
    expect(parentId).toBe('cab3');
    // Cabinet 3 already holds Shelf A/B — a different series, so Rows start at 1.
    expect(spec.map((n) => n.name)).toEqual(['Row 1', 'Row 2', 'Row 3', 'Row 4', 'Row 5']);
  });

  /**
   * Found in the browser, not by a test: subdividing Cabinet 3 (holding Shelf A/B) into three Rows
   * drew `Row 1 · Row 2 · Shelf A · Row 3 · Shelf B`, because `getLocations` orders by
   * `sort_order` then `name` and new children defaulted to `sort_order = 0`.
   */
  it('sorts new children after the ones already inside, not interleaved with them', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" unitId="cab3" />);

    await user.click(await screen.findByRole('button', { name: /change layout/i }));
    await user.click(await screen.findByRole('button', { name: /create 10 places/i }));

    // Shelf A and Shelf B carry sort_order 0 in the fixture, so the run must start at 1.
    const startSortOrder = vi.mocked(materializeLocationSpec).mock.calls[0][3];
    expect(startSortOrder).toBe(1);
  });

  /**
   * Removed: "starts a top-level build at zero — there is nothing to sort after".
   *
   * There is no top-level build any more. The multi-level builder is reachable only from
   * Subdivide on a unit that already exists (§5.5 decision 3's original intent), so its
   * `parentId` is never null and there is no top-level path to test. 118 of Contour's 121
   * legacy locations were flat in a system that supported nesting, which is why a wizard
   * was the wrong primary way to create a place.
   *
   * The subdivide paths — aimed at the unit, carrying its code, and continuing the
   * numbering on a repeat — are covered by the tests either side of this comment.
   */

  it('continues the numbering on a repeat subdivide', async () => {
    const user = userEvent.setup();
    vi.mocked(getLocationBoard).mockResolvedValue(
      board([
        loc({ id: 'cab3', name: 'Cabinet 3', kind: 'cabinet' }),
        loc({ id: 'r1', name: 'Row 1', parent_id: 'cab3' }),
        loc({ id: 'r2', name: 'Row 2', parent_id: 'cab3' }),
        loc({ id: 'r3', name: 'Row 3', parent_id: 'cab3' }),
      ]),
    );
    render(<LocationsManager companyId="co1" unitId="cab3" />);

    await user.click(await screen.findByRole('button', { name: /change layout/i }));
    await user.click(await screen.findByRole('button', { name: /create 10 places/i }));

    const spec = vi.mocked(materializeLocationSpec).mock.calls[0][2];
    expect(spec.map((n) => n.name)).toEqual(['Row 4', 'Row 5', 'Row 6', 'Row 7', 'Row 8']);
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
describe('LocationsManager — count or put away', () => {
  it('says what the page is for, rather than leaving you to infer it', async () => {
    render(<LocationsManager companyId="co1" />);
    await screen.findByRole('button', { name: /^Cabinet 3/ });
    expect(screen.getByText(/Your storage, and what's in it/i)).toBeInTheDocument();
  });

  it('routes a real location to its own worksheet', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" />);

    await user.click(await screen.findByRole('button', { name: /^Yard/ }));
    await user.click(await screen.findByRole('button', { name: /count or put away/i }));

    expect(routerMocks.push).toHaveBeenCalledWith('/dashboard/co1/inventory/count?location=yard');
  });

  /**
   * The worksheet counts what a place holds DIRECTLY, and since 20260806160053 a place with
   * sub-locations holds nothing directly — so this button could only ever open a blank sheet. Its
   * children each carry their own.
   */
  it('offers no worksheet for a place that has sub-locations', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" />);

    await user.click(await screen.findByRole('button', { name: /^Cabinet 3/ }));

    expect(screen.queryByRole('button', { name: /count or put away/i })).not.toBeInTheDocument();
  });

  /** The put-away entry a real shop needs most: `Unassigned` is where all 9,428 parts start. */
  it('routes the put-away pile to the same worksheet', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" />);

    await user.click(await screen.findByRole('button', { name: /^Unassigned/ }));
    await user.click(await screen.findByRole('button', { name: /put these away/i }));

    expect(routerMocks.push).toHaveBeenCalledWith('/dashboard/co1/inventory/count?location=un');
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
    await user.click(await screen.findByRole('button', { name: /create 10 places/i }));

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
    expect(await screen.findByRole('button', { name: /create 10 places/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /15 locations/i })).not.toBeInTheDocument();
  });

  /** A name is required; the layout is not — "the yard" is one place and that is a valid unit. */
  it('will not create an unnamed unit, and warns before a duplicate name', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" />);
    await screen.findByRole('button', { name: /^Cabinet 3/ });

    await user.click(screen.getByRole('button', { name: /add storage/i }));
    expect(await screen.findByRole('button', { name: /create 10 places/i })).toBeDisabled();

    await user.type(screen.getByLabelText(/what is it called/i), 'Cabinet 3');
    expect(await screen.findByText(/you already have a cabinet 3/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create 10 places/i })).toBeDisabled();
  });
});
