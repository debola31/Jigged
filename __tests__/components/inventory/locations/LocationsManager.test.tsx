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
  getTypedSupabase: () => ({}),
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
} from '@/utils/inventoryLocationsAccess';
import { generateLocationLabelSheet } from '@/utils/locationLabelPdf';
import type { InventoryLocation } from '@/types/inventoryLocations';

const loc = (over: Partial<InventoryLocation> & { id: string }): InventoryLocation => ({
  company_id: 'co1',
  parent_id: null,
  name: over.id,
  kind: null,
  code: null,
  sort_order: 0,
  created_at: '',
  updated_at: '',
  ...over,
});

/** The seed's shape: Unassigned + Cabinet 3 › Shelf A/B + Yard. */
const SEED_LOCATIONS = [
  loc({ id: 'un', name: 'Unassigned', kind: 'system' }),
  loc({ id: 'cab3', name: 'Cabinet 3', kind: 'cabinet', code: 'CAB3' }),
  loc({ id: 'shelf-a', name: 'Shelf A', parent_id: 'cab3', code: 'CAB3-A' }),
  loc({ id: 'shelf-b', name: 'Shelf B', parent_id: 'cab3', code: 'CAB3-B' }),
  loc({ id: 'yard', name: 'Yard', kind: 'outside', code: 'YARD' }),
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

    // Cabinet 3 holds nothing DIRECTLY; its shelves hold 3 between them. The roll-up is the
    // reason a full cabinet never reads empty, and it survived the board being deleted.
    expect(await screen.findByRole('button', { name: 'Cabinet 3' })).toBeInTheDocument();
    expect(screen.getByText('3 parts')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yard' })).toBeInTheDocument();
    // Several places hold one part each in the fixture; the roll-up on Cabinet 3 above is the
    // assertion that matters here.
    expect(screen.getAllByText('1 part').length).toBeGreaterThan(0);
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

  it('opens the sheet from a board tile and shows what is inside', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" />);

    await user.click(await screen.findByRole('button', { name: /^Cabinet 3/ }));

    expect(await screen.findByText('Inside (2)')).toBeInTheDocument();
    expect(screen.getByText(/nothing here directly · 3 parts in sub-locations/i)).toBeInTheDocument();
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

  /** The board is the hub, so the company-wide sheet is reached from here. */
  it('offers Count everything, since /inventory no longer exists to host it', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" />);
    await screen.findByRole('button', { name: /^Cabinet 3/ });

    await user.click(screen.getByRole('button', { name: /count everything/i }));
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
    render(<LocationsManager companyId="co1" />);

    await user.click(await screen.findByRole('button', { name: /^Cabinet 3/ }));
    await user.click(await screen.findByRole('button', { name: /divide it up/i }));

    // Title proves parentPath. There is no palette step to click through any more.
    expect(await screen.findByText('Divide up Cabinet 3')).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: /create 15 locations/i }));

    const [, parentId, spec] = vi.mocked(materializeLocationSpec).mock.calls[0];
    expect(parentId).toBe('cab3');
    // Cabinet 3 already holds Shelf A/B — a different series, so Rows start at 1.
    expect(spec.map((n) => n.name)).toEqual(['Row 1', 'Row 2', 'Row 3', 'Row 4', 'Row 5']);
    expect(spec[0].code).toBe('CAB3-R01');
  });

  /**
   * Found in the browser, not by a test: subdividing Cabinet 3 (holding Shelf A/B) into three Rows
   * drew `Row 1 · Row 2 · Shelf A · Row 3 · Shelf B`, because `getLocations` orders by
   * `sort_order` then `name` and new children defaulted to `sort_order = 0`.
   */
  it('sorts new children after the ones already inside, not interleaved with them', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" />);

    await user.click(await screen.findByRole('button', { name: /^Cabinet 3/ }));
    await user.click(await screen.findByRole('button', { name: /divide it up/i }));
    await user.click(await screen.findByRole('button', { name: /create 15 locations/i }));

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
        loc({ id: 'cab3', name: 'Cabinet 3', kind: 'cabinet', code: 'CAB3' }),
        loc({ id: 'r1', name: 'Row 1', parent_id: 'cab3', code: 'CAB3-R01' }),
        loc({ id: 'r2', name: 'Row 2', parent_id: 'cab3', code: 'CAB3-R02' }),
        loc({ id: 'r3', name: 'Row 3', parent_id: 'cab3', code: 'CAB3-R03' }),
      ]),
    );
    render(<LocationsManager companyId="co1" />);

    await user.click(await screen.findByRole('button', { name: /^Cabinet 3/ }));
    await user.click(await screen.findByRole('button', { name: /divide it up/i }));
    await user.click(await screen.findByRole('button', { name: /create 15 locations/i }));

    const spec = vi.mocked(materializeLocationSpec).mock.calls[0][2];
    expect(spec.map((n) => n.name)).toEqual(['Row 4', 'Row 5', 'Row 6', 'Row 7', 'Row 8']);
  });

  /**
   * `companyName` was accepted but never passed, so the printed label sheet had no heading —
   * the kind of defect only an end-to-end read of the prop chain finds.
   */
  it('prints the company name on the label sheet and never labels the system bucket', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" companyName="Vanguard Precision Works" />);
    await screen.findByRole('button', { name: /^Cabinet 3/ });

    await user.click(screen.getByRole('button', { name: /print all labels/i }));

    const arg = vi.mocked(generateLocationLabelSheet).mock.calls[0][0];
    expect(arg.heading).toBe('Vanguard Precision Works');
    expect(arg.labels.map((l) => l.id).sort()).toEqual(['cab3', 'shelf-a', 'shelf-b', 'yard']);
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

    await user.click(await screen.findByRole('button', { name: /^Cabinet 3/ }));
    await user.click(await screen.findByRole('button', { name: /count or put away/i }));

    expect(routerMocks.push).toHaveBeenCalledWith('/dashboard/co1/inventory/count?location=cab3');
  });

  /** The put-away entry a real shop needs most: `Unassigned` is where all 9,428 parts start. */
  it('routes the put-away pile to the same worksheet', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" />);

    await user.click(await screen.findByRole('button', { name: /^Unassigned/ }));
    await user.click(await screen.findByRole('button', { name: /put these away/i }));

    expect(routerMocks.push).toHaveBeenCalledWith('/dashboard/co1/inventory/count?location=un');
  });
});
