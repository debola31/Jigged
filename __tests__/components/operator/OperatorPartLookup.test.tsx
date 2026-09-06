import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/__tests__/test-utils';
import userEvent from '@testing-library/user-event';

import type { PartSelectOption } from '@/utils/partsAccess';

/** Module-scope browser client; the import alone throws in jsdom without this. */
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({}),
}));

/**
 * Partial mock: only the two fetches are stubbed. `computePathNames` stays real — the put-away
 * picker's labels ARE that walk, so replacing it would test the mock instead of the paths.
 */
vi.mock('@/utils/inventoryLocationsAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/inventoryLocationsAccess')>()),
  getBalancesForPart: vi.fn(),
  getLocations: vi.fn(),
}));

/**
 * Stub the shared picker, the way `MaterialRowEditor.test.tsx` does.
 *
 * What is worth testing here is the *answer* — where the part is, and the untracked-vs-empty
 * distinction — not MUI's Autocomplete, which `PartAutocomplete` owns and quotes/jobs already
 * exercise. The stub also records the props this component relies on, so the one that carries
 * real meaning can be asserted: the ABSENCE of `onCreateNew`.
 */
let nextPick: PartSelectOption | null = null;
const pickerProps: Record<string, unknown> = {};
vi.mock('@/components/parts/PartAutocomplete', () => ({
  __esModule: true,
  default: (props: { onChange: (o: PartSelectOption | null) => void } & Record<string, unknown>) => {
    Object.assign(pickerProps, props);
    return (
      <button type="button" onClick={() => props.onChange(nextPick)}>
        pick-part
      </button>
    );
  },
}));

/**
 * Stub the destination picker, for the same reason the part picker is stubbed: what matters here
 * is what happens once a place is CHOSEN, not MUI's Autocomplete, which `LocationPicker` owns and
 * the office side exercises. The stub picks the first option it is handed.
 */
vi.mock('@/components/inventory/locations/LocationPicker', () => ({
  __esModule: true,
  default: (props: {
    options: Array<{ id: string; label: string }>;
    onChange: (o: { id: string; label: string }) => void;
  }) => (
    <button type="button" onClick={() => props.onChange(props.options[0])}>
      pick-place
    </button>
  ),
}));

import OperatorPartLookup from '@/components/operator/OperatorPartLookup';
import { getBalancesForPart, getLocations } from '@/utils/inventoryLocationsAccess';

const mockBalances = vi.mocked(getBalancesForPart);
const mockLocations = vi.mocked(getLocations);

const part = (over: Partial<PartSelectOption> = {}): PartSelectOption => ({
  id: 'p1',
  part_name: 'RAW-AL6061-BLANK',
  description: 'Aluminum 6061 machining blank',
  has_routing: false,
  is_stocked: true,
  source: 'bought',
  primary_unit: 'ea',
  quantity: 240,
  ...over,
});

const onOpenLocation = vi.fn();
const renderLookup = () =>
  render(<OperatorPartLookup companyId="co1" onOpenLocation={onOpenLocation} />);

/** Choose whatever `nextPick` holds, through the stubbed picker. */
const pick = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: 'pick-part' }));

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(pickerProps)) delete pickerProps[k];
  nextPick = part();
  mockBalances.mockResolvedValue([]);
  mockLocations.mockResolvedValue([]);
});

describe('OperatorPartLookup — J11, "is this part in storage, and where?"', () => {
  it('shows every location the part sits in, with the full path', async () => {
    const user = userEvent.setup();
    mockBalances.mockResolvedValue([
      { location_id: 'l1', location_name: 'Left', location_code: 'CAB1-R3-L', path: ['Cabinet 1', 'Row 3', 'Left'], quantity: 40, kind: 'shelf' },
      { location_id: 'l2', location_name: 'Yard', location_code: 'YARD', path: ['Yard'], quantity: 200, kind: 'shelf' },
    ]);
    renderLookup();
    await pick(user);

    expect(await screen.findByText('Left')).toBeInTheDocument();
    // "Left" is meaningless on its own — the ancestry is what sends someone to the right shelf.
    expect(screen.getByText('Cabinet 1 › Row 3 › Left')).toBeInTheDocument();
    expect(screen.getByText('40 ea')).toBeInTheDocument();
    expect(screen.getByText('200 ea')).toBeInTheDocument();
    expect(screen.getByText(/240 ea in 2 locations/)).toBeInTheDocument();
  });

  /**
   * Act on the part where you found it — the office rule, now on the shop floor too.
   *
   * Tapping a location used to navigate to that bin, which throws away half of what you arrived
   * with: you hold a PART and a PLACE, and the bin view keeps only the place. The office side fixed
   * that on 2026-08-12 and this surface kept the old behaviour.
   */
  it('expands the four verbs in place rather than navigating away', async () => {
    const user = userEvent.setup();
    mockBalances.mockResolvedValue([
      { location_id: 'l1', location_name: 'Yard', location_code: null, path: ['Yard'], quantity: 12, kind: 'shelf' },
    ]);
    renderLookup();
    await pick(user);
    await user.click(await screen.findByText('Yard'));

    expect(onOpenLocation).not.toHaveBeenCalled();
    for (const verb of ['Add', 'Remove', 'Move', 'Adjust']) {
      expect(screen.getByRole('button', { name: verb })).toBeInTheDocument();
    }
  });

  it('keeps the bin one click away, inside the section rather than on the row', async () => {
    // Two hit targets on one 48px row is the ambiguity this module removed from the grid.
    const user = userEvent.setup();
    mockBalances.mockResolvedValue([
      { location_id: 'l1', location_name: 'Yard', location_code: null, path: ['Yard'], quantity: 12, kind: 'shelf' },
    ]);
    renderLookup();
    await pick(user);
    await user.click(await screen.findByText('Yard'));
    await user.click(screen.getByRole('button', { name: /open this location/i }));

    expect(onOpenLocation).toHaveBeenCalledWith('l1');
  });

  /*
   * The distinction this screen used to keep straight — "isn't tracked by place" versus "nowhere"
   * — no longer exists. `is_location_tracked` was dropped in 20260802015837, so an empty balances
   * read has exactly one meaning now: there is genuinely none anywhere. Removing the branch is
   * the point; the remaining test below is the one true answer.
   */

  /**
   * The wording is a stock statement, not a placement one. It used to read "None in any place
   * right now.", which sounds like something that exists and has not been put away — the state the
   * blue "not put away yet" alert reports. No balance rows means the shop holds none of it at all.
   *
   * And since 2026-09-04 it is a NUMBER, in the same line and shape as every other answer, not a
   * warning Alert reading "None available": zero is an ordinary quantity, and being out of
   * something is the most routine finding this screen has.
   */
  it('answers zero, in the same shape as any other quantity, when the shop holds none', async () => {
    const user = userEvent.setup();
    mockBalances.mockResolvedValue([]);
    renderLookup();
    await pick(user);

    expect(await screen.findByText(/0\s*ea/)).toBeInTheDocument();
    expect(screen.getByText(/in any location/i)).toBeInTheDocument();
    expect(screen.queryByText(/none available/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/not stored yet/i)).not.toBeInTheDocument();
  });

  it('surfaces a failed read instead of showing an empty answer', async () => {
    const user = userEvent.setup();
    mockBalances.mockRejectedValue(new Error('denied'));
    renderLookup();
    await pick(user);

    expect(await screen.findByText('denied')).toBeInTheDocument();
  });

  it('clears the answer when the part is deselected', async () => {
    const user = userEvent.setup();
    mockBalances.mockResolvedValue([
      { location_id: 'l1', location_name: 'Yard', location_code: null, path: ['Yard'], quantity: 12, kind: 'shelf' },
    ]);
    renderLookup();
    await pick(user);
    expect(await screen.findByText('Yard')).toBeInTheDocument();

    nextPick = null;
    await pick(user);
    expect(screen.queryByText('Yard')).not.toBeInTheDocument();
  });

  /**
   * Creating parts is not an operator's job — the same call the board makes by withholding
   * "Add storage".
   *
   * This also pinned `kind="stocked"`, on the reasoning that a made top-level product has no
   * on-hand and would only pad the list. That prop is gone with `is_stocked`: every part is
   * stockable, so there is no subset to narrow to and the picker searches the catalogue.
   */
  it('never offers to create a part', async () => {
    renderLookup();
    expect(pickerProps.kind).toBeUndefined();
    expect(pickerProps.onCreateNew).toBeUndefined();
  });
});

/**
 * The three answers to "where is this?", which the first version collapsed into one.
 *
 * It rendered every `part_location_stock` row as somewhere the part lives, so a part sitting in the
 * put-away pile showed "240 ea across 1 place — Unassigned". `Unassigned` is `kind='system'`: it is
 * the pile, not a shelf, and 240 homeless is the opposite of 240 shelved. Balances are also never
 * deleted, so a place the part merely passed through keeps a zero row forever.
 */
describe('OperatorPartLookup — where it lives vs where it is piled', () => {
  const shelf = (over = {}) => ({
    location_id: 'l1',
    location_name: 'Shelf A',
    location_code: 'A',
    path: ['Cabinet 1', 'Shelf A'],
    quantity: 40,
    kind: 'shelf',
    ...over,
  });
  const pile = (qty = 240) => ({
    location_id: 'sys',
    location_name: 'Unassigned',
    location_code: null,
    path: ['Unassigned'],
    quantity: qty,
    kind: 'system',
    ...{},
  });

  it('calls the pile what it is, never a location the part lives in', async () => {
    const user = userEvent.setup();
    mockBalances.mockResolvedValue([pile(240)]);
    renderLookup();
    await pick(user);

    expect(await screen.findByText(/not stored yet/i)).toBeInTheDocument();
    // The old copy. "Unassigned" must never be presented as a shelf to walk to.
    expect(screen.queryByText(/across 1 place/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/on 1 shelf/i)).not.toBeInTheDocument();
  });

  it('counts only real locations in the total, so nobody is sent to an empty one', async () => {
    const user = userEvent.setup();
    mockBalances.mockResolvedValue([
      shelf({ quantity: 40 }),
      // Passed through here once; the row survives at zero forever.
      shelf({ location_id: 'l2', location_name: 'Yard', path: ['Yard'], quantity: 0 }),
      pile(200),
    ]);
    renderLookup();
    await pick(user);

    expect(await screen.findByText(/40 ea in 1 location/i)).toBeInTheDocument();
    expect(screen.getByText('Shelf A')).toBeInTheDocument();
    expect(screen.queryByText('Yard')).not.toBeInTheDocument();
    // Both states shown, not merged: 40 shelved AND 200 still to put away.
    expect(screen.getByText(/not stored yet/i)).toBeInTheDocument();
  });

  it('still answers zero when every row is a zero', async () => {
    const user = userEvent.setup();
    mockBalances.mockResolvedValue([
      shelf({ quantity: 0 }),
      pile(0),
    ]);
    renderLookup();
    await pick(user);

    expect(await screen.findByText(/0\s*ea/)).toBeInTheDocument();
    expect(screen.queryByText(/none available/i)).not.toBeInTheDocument();
  });
});

/**
 * The picker is the way through when scanning isn't available — no shelf yet, no printed label,
 * or no usable camera. Scanning stays the default because it is the only destination signal that
 * is physically self-verifying: you can only scan a label you are standing at.
 */
describe('OperatorPartLookup — the add-to-location picker', () => {
  const openPicker = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole('button', { name: /add at another location/i }));
  };

  it('loads the locations only when asked, not on every lookup', async () => {
    const user = userEvent.setup();
    mockLocations.mockResolvedValue([
      { id: 'l1', company_id: 'co1', parent_id: null, name: 'Shelf A', kind: 'shelf', sort_order: 0, created_at: '', updated_at: '' },
    ]);
    renderLookup();
    await pick(user);
    // Most lookups end at a location card; paying for the whole table every time is waste.
    expect(mockLocations).not.toHaveBeenCalled();

    await openPicker(user);
    expect(mockLocations).toHaveBeenCalledWith('co1');
    expect(await screen.findByRole('dialog')).toHaveTextContent(
      'Add RAW-AL6061-BLANK at another location',
    );
  });

  /** Offered on every tracked part: a missing label is as good a reason as having nowhere yet. */
  it('is offered even when the part is already somewhere', async () => {
    const user = userEvent.setup();
    mockBalances.mockResolvedValue([
      { location_id: 'l1', location_name: 'Shelf A', location_code: null, path: ['Shelf A'], quantity: 40, kind: 'shelf' },
    ]);
    renderLookup();
    await pick(user);

    expect(await screen.findByRole('button', { name: /add at another location/i })).toBeInTheDocument();
  });


  /**
   * THE FIX, 2026-09-04. Choosing a place used to NAVIGATE there, and the bin view keeps only the
   * place — so you re-found, among everything on that shelf, the part you had arrived holding.
   * It now opens Add against a row for the chosen place, right here, and never calls the
   * navigate. `Open this location` inside the section is still there for whoever wants to walk.
   */
  it('stocks the chosen place in place, rather than sending you there to re-find the part', async () => {
    const user = userEvent.setup();
    mockLocations.mockResolvedValue([
      { id: 'l9', company_id: 'co1', parent_id: null, name: 'Bay A', kind: 'shelf', sort_order: 0, created_at: '', updated_at: '' },
    ]);
    renderLookup();
    await pick(user);
    await openPicker(user);

    await user.click(await screen.findByRole('button', { name: 'pick-place' }));
    await user.click(await screen.findByRole('button', { name: 'Add here' }));

    // The place is now a row on the answer, with the Add form open on it...
    expect(await screen.findByText('Bay A')).toBeInTheDocument();
    // ...and nothing navigated.
    expect(onOpenLocation).not.toHaveBeenCalled();
  });

  it('reports a failed location load instead of opening an empty picker', async () => {
    const user = userEvent.setup();
    mockLocations.mockRejectedValue(new Error('no places for you'));
    renderLookup();
    await pick(user);
    await openPicker(user);

    expect(await screen.findByText('no places for you')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
