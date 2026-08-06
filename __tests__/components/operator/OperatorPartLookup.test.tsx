import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/__tests__/test-utils';
import userEvent from '@testing-library/user-event';

import type { PartSelectOption } from '@/utils/partsAccess';

/** Module-scope browser client; the import alone throws in jsdom without this. */
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({}),
  getTypedSupabase: () => ({}),
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
 * exercise. The stub also records the props this component relies on, so the two that carry real
 * meaning can be asserted: `kind="stocked"` and the ABSENCE of `onCreateNew`.
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
  it('shows every place the part sits, with the full path', async () => {
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
    expect(screen.getByText(/240 ea on 2 shelves/)).toBeInTheDocument();
  });

  it('navigates to the place, which is the point of looking it up', async () => {
    const user = userEvent.setup();
    mockBalances.mockResolvedValue([
      { location_id: 'l1', location_name: 'Yard', location_code: null, path: ['Yard'], quantity: 12, kind: 'shelf' },
    ]);
    renderLookup();
    await pick(user);
    await user.click(await screen.findByText('Yard'));

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
   */
  it('says a part with no stock anywhere is simply not available', async () => {
    const user = userEvent.setup();
    mockBalances.mockResolvedValue([]);
    renderLookup();
    await pick(user);

    expect(await screen.findByText('None available')).toBeInTheDocument();
    expect(screen.queryByText(/not put away yet/i)).not.toBeInTheDocument();
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
   * Two picker props carry real meaning rather than styling, so they are pinned:
   * a made top-level product has no on-hand and would only pad the list, and creating parts is
   * not an operator's job — the same call the board makes by withholding "Add storage".
   */
  it('searches stocked parts only, and never offers to create one', async () => {
    renderLookup();
    expect(pickerProps.kind).toBe('stocked');
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

  it('calls the put-away pile what it is, never a place the part lives', async () => {
    const user = userEvent.setup();
    mockBalances.mockResolvedValue([pile(240)]);
    renderLookup();
    await pick(user);

    expect(await screen.findByText(/not put away yet/i)).toBeInTheDocument();
    // The old copy. "Unassigned" must never be presented as a shelf to walk to.
    expect(screen.queryByText(/across 1 place/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/on 1 shelf/i)).not.toBeInTheDocument();
  });

  it('counts only shelves in the total, so nobody is sent to an empty one', async () => {
    const user = userEvent.setup();
    mockBalances.mockResolvedValue([
      shelf({ quantity: 40 }),
      // Passed through here once; the row survives at zero forever.
      shelf({ location_id: 'l2', location_name: 'Yard', path: ['Yard'], quantity: 0 }),
      pile(200),
    ]);
    renderLookup();
    await pick(user);

    expect(await screen.findByText(/40 ea on 1 shelf/i)).toBeInTheDocument();
    expect(screen.getByText('Shelf A')).toBeInTheDocument();
    expect(screen.queryByText('Yard')).not.toBeInTheDocument();
    // Both states shown, not merged: 40 shelved AND 200 still to put away.
    expect(screen.getByText(/not put away yet/i)).toBeInTheDocument();
  });

  it('still says not available when every row is a zero', async () => {
    const user = userEvent.setup();
    mockBalances.mockResolvedValue([
      shelf({ quantity: 0 }),
      pile(0),
    ]);
    renderLookup();
    await pick(user);

    expect(await screen.findByText('None available')).toBeInTheDocument();
  });
});

/**
 * The picker is the way through when scanning isn't available — no shelf yet, no printed label,
 * or no usable camera. Scanning stays the default because it is the only destination signal that
 * is physically self-verifying: you can only scan a label you are standing at.
 */
describe('OperatorPartLookup — the put-away picker', () => {
  const openPicker = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole('button', { name: /put it away/i }));
  };

  it('loads the places only when asked, not on every lookup', async () => {
    const user = userEvent.setup();
    mockLocations.mockResolvedValue([
      { id: 'l1', company_id: 'co1', parent_id: null, name: 'Shelf A', kind: 'shelf', code: null, sort_order: 0, photo_path: null, created_at: '', updated_at: '' },
    ]);
    renderLookup();
    await pick(user);
    // Most lookups end at a shelf card; paying for the whole location table every time is waste.
    expect(mockLocations).not.toHaveBeenCalled();

    await openPicker(user);
    expect(mockLocations).toHaveBeenCalledWith('co1');
    expect(await screen.findByRole('dialog')).toHaveTextContent('Put away RAW-AL6061-BLANK');
  });

  /** Offered on every tracked part, because a missing label is as good a reason as a missing shelf. */
  it('is offered even when the part is already shelved', async () => {
    const user = userEvent.setup();
    mockBalances.mockResolvedValue([
      { location_id: 'l1', location_name: 'Shelf A', location_code: null, path: ['Shelf A'], quantity: 40, kind: 'shelf' },
    ]);
    renderLookup();
    await pick(user);

    expect(await screen.findByRole('button', { name: /put it away/i })).toBeInTheDocument();
  });


  it('reports a failed places load instead of opening an empty picker', async () => {
    const user = userEvent.setup();
    mockLocations.mockRejectedValue(new Error('no places for you'));
    renderLookup();
    await pick(user);
    await openPicker(user);

    expect(await screen.findByText('no places for you')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
