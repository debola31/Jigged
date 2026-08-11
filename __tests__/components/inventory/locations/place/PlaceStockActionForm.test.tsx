/**
 * Add · Remove · Move, standing at one place — several parts at a time.
 *
 * Two things these tests exist to defend.
 *
 * **The axis.** This form fixes the *location* and picks *parts*, where `PartLocationActionModal`
 * fixes the part and picks locations. Every bug worth catching is one where that inverts — a list
 * offering the catalogue when it should offer the drawer, a write addressed to the wrong end.
 *
 * **A blank row is not an instruction.** The form lists everything in the bin, which invites the
 * reading that every row is being acted on. Only rows with a positive quantity are, and a bug there
 * would empty a shelf someone merely looked at.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '../../../../test-utils';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}) }));

vi.mock('@/utils/inventoryLocationsAccess', () => ({
  addStockAtLocation: vi.fn(async () => ({})),
  depleteStockAtLocation: vi.fn(async () => ({})),
  transferStock: vi.fn(async () => ({})),
  getLocationContents: vi.fn(async () => ({
    contents: [
      {
        part_id: 'p-steel',
        part_name: 'RAW-STEEL-BLANK',
        primary_unit: 'ea',
        quantity: 12,
        location_id: 'bin5',
      },
      {
        part_id: 'p-oring',
        part_name: 'BUY-ORING-214',
        primary_unit: 'ea',
        quantity: 4,
        location_id: 'bin5',
      },
    ],
    total: 2,
  })),
}));

vi.mock('@/utils/partsAccess', () => ({
  getStockedParts: vi.fn(async () => [
    { id: 'p-steel', part_name: 'RAW-STEEL-BLANK', primary_unit: 'ea' },
    { id: 'p-brass', part_name: 'RAW-BRASS-ROD', primary_unit: 'ft' },
  ]),
}));

vi.mock('@/utils/operatorAccess', () => ({
  getCurrentMember: vi.fn(async () => ({ id: 'member-1' })),
}));

vi.mock('@/components/inventory/JobTagPicker', () => ({
  default: () => null,
  loadTaggableJobs: vi.fn(async () => []),
}));

import PlaceStockActionForm from '@/components/inventory/locations/place/PlaceStockActionForm';
import {
  addStockAtLocation,
  depleteStockAtLocation,
  getLocationContents,
  transferStock,
} from '@/utils/inventoryLocationsAccess';
import { getStockedParts } from '@/utils/partsAccess';

const DESTINATIONS = [
  { id: 'bin6', label: 'Cabinet 3 › Row 1 › Bin 6' },
  { id: 'shelf-a', label: 'Metal Shelf › Shelf A' },
];

const onCancel = vi.fn();

const setup = (action: 'add' | 'deplete' | 'move') =>
  render(
    <PlaceStockActionForm
      action={action}
      companyId="co1"
      locationId="bin5"
      locationName="Bin 5"
      moveDestinations={DESTINATIONS}
      onCancel={onCancel}
      onDone={vi.fn()}
    />,
  );

const qtyFor = (partName: string) => screen.getByLabelText(`Quantity for ${partName}`);

/** `Add` builds its rows by picking; the other two already list the bin. */
const pickToAdd = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await user.click(await screen.findByRole('combobox', { name: /add a part to this list/i }));
  await user.click(await screen.findByRole('option', { name }));
};

beforeEach(() => vi.clearAllMocks());

describe('PlaceStockActionForm', () => {
  /**
   * The axis, stated as a test.
   *
   * `Remove` may only name what is in the drawer — offering the catalogue would invite a removal
   * the RPC refuses, after the person has already typed a quantity.
   */
  it('lists only what is here when taking stock out', async () => {
    setup('deplete');

    expect(await screen.findByText('RAW-STEEL-BLANK')).toBeInTheDocument();
    expect(screen.getByText('BUY-ORING-214')).toBeInTheDocument();
    // In the catalogue but not in this bin.
    expect(screen.queryByText('RAW-BRASS-ROD')).not.toBeInTheDocument();
    expect(getStockedParts).not.toHaveBeenCalled();
  });

  /**
   * …and the inverse. `Add` offers everything, INCLUDING parts already here.
   *
   * The operator's receive flow excludes those because a phone user tops one up from the part's own
   * card. There is no card to tap here, so excluding them would make the commonest case — more of
   * what is already in the bin — the one thing the button could not do.
   */
  it('offers the whole catalogue when putting stock in, including what is already here', async () => {
    const user = userEvent.setup();
    setup('add');

    await user.click(await screen.findByRole('combobox', { name: /add a part to this list/i }));
    expect(await screen.findByRole('option', { name: 'RAW-BRASS-ROD' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'RAW-STEEL-BLANK' })).toBeInTheDocument();
    expect(getLocationContents).not.toHaveBeenCalled();
  });

  it('says how much is here on each row', async () => {
    setup('deplete');
    expect(await screen.findByText(/12 ea here/i)).toBeInTheDocument();
    expect(screen.getByText(/4 ea here/i)).toBeInTheDocument();
  });

  /** THE RULE. A listed row is not an instruction; a typed quantity is. */
  it('acts only on the rows a quantity was typed into', async () => {
    const user = userEvent.setup();
    setup('deplete');
    await screen.findByText('RAW-STEEL-BLANK');

    await user.type(qtyFor('RAW-STEEL-BLANK'), '3');
    await user.click(screen.getByRole('button', { name: /^remove stock$/i }));

    expect(depleteStockAtLocation).toHaveBeenCalledTimes(1);
    expect(depleteStockAtLocation).toHaveBeenCalledWith(
      'p-steel',
      'bin5',
      3,
      'ea',
      expect.objectContaining({ operatorId: 'member-1' }),
    );
  });

  it('writes one line per row when several are filled', async () => {
    const user = userEvent.setup();
    setup('deplete');
    await screen.findByText('RAW-STEEL-BLANK');

    await user.type(qtyFor('RAW-STEEL-BLANK'), '3');
    await user.type(qtyFor('BUY-ORING-214'), '2');
    await user.click(screen.getByRole('button', { name: /remove stock \(2\)/i }));

    expect(depleteStockAtLocation).toHaveBeenCalledTimes(2);
    expect(depleteStockAtLocation).toHaveBeenCalledWith('p-steel', 'bin5', 3, 'ea', expect.anything());
    expect(depleteStockAtLocation).toHaveBeenCalledWith('p-oring', 'bin5', 2, 'ea', expect.anything());
  });

  it('adds several picked parts in one go, each in its own unit', async () => {
    const user = userEvent.setup();
    setup('add');

    await pickToAdd(user, 'RAW-BRASS-ROD');
    await pickToAdd(user, 'RAW-STEEL-BLANK');
    await user.type(qtyFor('RAW-BRASS-ROD'), '5');
    await user.type(qtyFor('RAW-STEEL-BLANK'), '9');
    await user.click(screen.getByRole('button', { name: /add stock \(2\)/i }));

    expect(addStockAtLocation).toHaveBeenCalledTimes(2);
    // Each row keeps its OWN part's unit — brass is measured in feet, steel in each.
    expect(addStockAtLocation).toHaveBeenCalledWith('p-brass', 'bin5', 5, 'ft', expect.anything());
    expect(addStockAtLocation).toHaveBeenCalledWith('p-steel', 'bin5', 9, 'ea', expect.anything());
  });

  it('drops a picked row again', async () => {
    const user = userEvent.setup();
    setup('add');

    await pickToAdd(user, 'RAW-BRASS-ROD');
    expect(screen.getByText('RAW-BRASS-ROD')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /remove RAW-BRASS-ROD from this list/i }));
    expect(screen.queryByText('RAW-BRASS-ROD')).not.toBeInTheDocument();
  });

  /** A move is FROM here TO the chosen place. Getting that pair backwards is the expensive bug. */
  it('moves every filled row from this place to the one destination', async () => {
    const user = userEvent.setup();
    setup('move');
    await screen.findByText('RAW-STEEL-BLANK');

    await user.type(qtyFor('RAW-STEEL-BLANK'), '3');
    await user.type(qtyFor('BUY-ORING-214'), '1');
    await user.click(screen.getByRole('combobox', { name: /move to/i }));
    await user.click(await screen.findByRole('option', { name: /Bin 6/ }));
    await user.click(screen.getByRole('button', { name: /move stock \(2\)/i }));

    expect(transferStock).toHaveBeenCalledWith('p-steel', 'bin5', 'bin6', 3, 'ea', expect.anything());
    expect(transferStock).toHaveBeenCalledWith('p-oring', 'bin5', 'bin6', 1, 'ea', expect.anything());
  });

  it('refuses a move with no destination, without writing', async () => {
    const user = userEvent.setup();
    setup('move');
    await screen.findByText('RAW-STEEL-BLANK');

    await user.type(qtyFor('RAW-STEEL-BLANK'), '3');
    await user.click(screen.getByRole('button', { name: /^move stock$/i }));

    expect(await screen.findByText(/choose where it is going/i)).toBeInTheDocument();
    expect(transferStock).not.toHaveBeenCalled();
  });

  it('cannot be submitted until something has a quantity', async () => {
    setup('deplete');
    await screen.findByText('RAW-STEEL-BLANK');

    expect(screen.getByRole('button', { name: /^remove stock$/i })).toBeDisabled();
  });

  /** A zero is not a quantity. Unlike a count, where 0 asserts "the bin is empty", 0 to move is a
   *  line with nothing on it. */
  it('ignores a zero quantity', async () => {
    const user = userEvent.setup();
    setup('deplete');
    await screen.findByText('RAW-STEEL-BLANK');

    await user.type(qtyFor('RAW-STEEL-BLANK'), '0');
    expect(screen.getByRole('button', { name: /^remove stock$/i })).toBeDisabled();
  });

  /** Caught on the row, before the RPC, where the number is being typed. */
  it('warns on the row when taking more than is there', async () => {
    const user = userEvent.setup();
    setup('deplete');
    await screen.findByText('RAW-STEEL-BLANK');

    await user.type(qtyFor('RAW-STEEL-BLANK'), '40');
    expect(screen.getByText(/12 ea here — more than that/i)).toBeInTheDocument();
  });

  /**
   * A partial batch is reported, never silently rolled back: each write is atomic on its own, so
   * what landed is real, and re-running the whole batch to retry one line is how someone
   * double-counts the other four.
   */
  it('names the lines that failed and keeps the rest', async () => {
    const user = userEvent.setup();
    vi.mocked(depleteStockAtLocation)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new Error('Insufficient stock'));
    setup('deplete');
    await screen.findByText('RAW-STEEL-BLANK');

    await user.type(qtyFor('RAW-STEEL-BLANK'), '3');
    await user.type(qtyFor('BUY-ORING-214'), '99');
    await user.click(screen.getByRole('button', { name: /remove stock \(2\)/i }));

    expect(await screen.findByText(/BUY-ORING-214 \(Insufficient stock\)/)).toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('says an empty place has nothing to take out', async () => {
    vi.mocked(getLocationContents).mockResolvedValueOnce({ contents: [], total: 0 });
    setup('deplete');

    expect(await screen.findByText(/nothing is recorded at Bin 5 yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^remove stock$/i })).toBeDisabled();
  });

  it('says which verb it is', async () => {
    setup('add');
    expect(await screen.findByText(/add stock here/i)).toBeInTheDocument();
  });
});
