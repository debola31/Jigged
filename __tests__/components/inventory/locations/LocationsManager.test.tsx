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
import { render, screen } from '../../../test-utils';
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
  it('loads locations and occupancy in one request pair and rolls it onto the board', async () => {
    render(<LocationsManager companyId="co1" />);

    // Cabinet 3 holds nothing directly; its shelves hold 3 between them.
    expect(await screen.findByRole('button', { name: 'Cabinet 3 — 3 parts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yard — 1 part' })).toBeInTheDocument();
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

    expect(await screen.findByText(/no storage locations yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add manually/i })).toBeInTheDocument();
  });

  it('opens the sheet from a board tile and shows what is inside', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" />);

    await user.click(await screen.findByRole('button', { name: /^Cabinet 3/ }));

    expect(await screen.findByText('Inside (2)')).toBeInTheDocument();
    expect(screen.getByText(/nothing here directly · 3 parts in sub-locations/i)).toBeInTheDocument();
  });

  /** Board is the home; the list survives for finding one name among many, and is not sticky. */
  it('defaults to the board and can re-mode to the list', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" />);

    const boardTile = await screen.findByRole('button', { name: /^Cabinet 3/ });
    expect(boardTile).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'List' }));

    // The list finally carries a child count and fill state — neither existed before.
    expect(await screen.findByText('2 inside')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add storage/i })).not.toBeInTheDocument();
  });

  it('opens the sheet from a list row too', async () => {
    const user = userEvent.setup();
    render(<LocationsManager companyId="co1" />);
    await screen.findByRole('button', { name: /^Cabinet 3/ });

    await user.click(screen.getByRole('button', { name: 'List' }));
    await user.click(await screen.findByRole('button', { name: /Shelf A/ }));

    expect(await screen.findByText("What's here")).toBeInTheDocument();
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
    await user.click(await screen.findByRole('button', { name: /subdivide this unit/i }));

    // Title proves parentPath; the absence of container cards proves the palette swap.
    expect(await screen.findByText('Subdivide Cabinet 3')).toBeInTheDocument();
    expect(screen.queryByText('Cabinet')).not.toBeInTheDocument();

    await user.click(screen.getByText('Rows'));
    await user.click(await screen.findByRole('button', { name: /create 5 locations/i }));

    const [, parentId, spec] = vi.mocked(materializeLocationSpec).mock.calls[0];
    expect(parentId).toBe('cab3');
    // Cabinet 3 already holds Shelf A/B — a different series, so Rows start at 1.
    expect(spec.map((n) => n.name)).toEqual(['Row 1', 'Row 2', 'Row 3', 'Row 4', 'Row 5']);
    expect(spec[0].code).toBe('CAB3-R01');
  });

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
    await user.click(await screen.findByRole('button', { name: /subdivide this unit/i }));
    await user.click(screen.getByText('Rows'));
    await user.click(await screen.findByRole('button', { name: /create 5 locations/i }));

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
