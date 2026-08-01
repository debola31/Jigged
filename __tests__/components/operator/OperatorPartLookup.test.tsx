import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/__tests__/test-utils';
import userEvent from '@testing-library/user-event';

import type { PartSelectOption } from '@/utils/partsAccess';

vi.mock('@/utils/inventoryLocationsAccess', () => ({ getBalancesForPart: vi.fn() }));

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
import { getBalancesForPart } from '@/utils/inventoryLocationsAccess';

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

/** Choose whatever `nextPick` holds, through the stubbed picker. */
const pick = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: 'pick-part' }));

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(pickerProps)) delete pickerProps[k];
  nextPick = part();
  mockBalances.mockResolvedValue([]);
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

  /**
   * The distinction this screen exists to keep straight. An untracked part has no
   * `part_location_stock` rows at all, so the balances read is empty for the same reason a
   * genuinely-empty tracked part is — and telling someone their 240 on hand are "nowhere" would
   * send them looking for stock that is sitting right there, just unbinned.
   */
  it('says an untracked part is not binned, never that it is nowhere', async () => {
    const user = userEvent.setup();
    nextPick = part({ is_location_tracked: false, quantity: 240 });
    renderLookup();
    await pick(user);

    expect(await screen.findByText(/isn't tracked by place/i)).toBeInTheDocument();
    // The on-hand total must still be answered — that is the useful half of "no shelf for this".
    expect(screen.getByText('240 ea')).toBeInTheDocument();
    expect(screen.queryByText(/none in any place/i)).not.toBeInTheDocument();
    // No point asking for balances that cannot exist.
    expect(mockBalances).not.toHaveBeenCalled();
  });

  it('says a tracked part with no stock is genuinely nowhere', async () => {
    const user = userEvent.setup();
    mockBalances.mockResolvedValue([]);
    renderLookup();
    await pick(user);

    expect(await screen.findByText(/none in any place right now/i)).toBeInTheDocument();
    expect(screen.queryByText(/isn't tracked by place/i)).not.toBeInTheDocument();
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

  it('still says nowhere when there is genuinely nothing anywhere', async () => {
    const user = userEvent.setup();
    mockBalances.mockResolvedValue([
      shelf({ quantity: 0 }),
      pile(0),
    ]);
    renderLookup();
    await pick(user);

    expect(await screen.findByText(/none in any place right now/i)).toBeInTheDocument();
  });
});
