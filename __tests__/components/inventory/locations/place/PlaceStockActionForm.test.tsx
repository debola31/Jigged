/**
 * Add · Remove · Move, standing at one place.
 *
 * What these tests are really pinning is the **axis**: this dialog fixes the location and picks a
 * part, where `PartLocationActionModal` fixes the part and picks a location. Every bug worth
 * catching here is one where that inverts — a picker offering the catalogue when it should offer
 * the drawer, a write addressed to the wrong end of the pair.
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

const setup = (action: 'add' | 'deplete' | 'move') =>
  render(
    <PlaceStockActionForm
      action={action}
      companyId="co1"
      locationId="bin5"
      locationName="Bin 5"
      moveDestinations={DESTINATIONS}
      onCancel={vi.fn()}
      onDone={vi.fn()}
    />,
  );

const pickPart = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await user.click(screen.getByRole('combobox', { name: /part/i }));
  await user.click(await screen.findByRole('option', { name: new RegExp(name) }));
};

beforeEach(() => vi.clearAllMocks());

describe('PlaceStockActionForm', () => {
  /**
   * The axis, stated as a test.
   *
   * `Remove` may only name what is in the drawer — offering the catalogue would invite a removal
   * the RPC refuses, after the person has already typed a quantity.
   */
  it('offers only what is here when taking stock out', async () => {
    const user = userEvent.setup();
    setup('deplete');

    await user.click(await screen.findByRole('combobox', { name: /part/i }));
    expect(await screen.findByRole('option', { name: /RAW-STEEL-BLANK/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /BUY-ORING-214/ })).toBeInTheDocument();
    // In the catalogue but not in this bin.
    expect(screen.queryByRole('option', { name: /RAW-BRASS-ROD/ })).not.toBeInTheDocument();
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

    await user.click(await screen.findByRole('combobox', { name: /part/i }));
    expect(await screen.findByRole('option', { name: /RAW-BRASS-ROD/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /RAW-STEEL-BLANK/ })).toBeInTheDocument();
    expect(getLocationContents).not.toHaveBeenCalled();
  });

  /** What is on hand, where the quantity is typed — so "remove 40" from a bin of 12 is caught. */
  it('says how much is here beside the quantity field', async () => {
    const user = userEvent.setup();
    setup('deplete');
    await pickPart(user, 'RAW-STEEL-BLANK');

    expect(screen.getByText(/12 ea here now/i)).toBeInTheDocument();
  });

  it('writes the addition at this location, with the author', async () => {
    const user = userEvent.setup();
    setup('add');
    await pickPart(user, 'RAW-BRASS-ROD');
    await user.type(screen.getByLabelText(/quantity/i), '5');
    await user.click(screen.getByRole('button', { name: /^add$/i }));

    expect(addStockAtLocation).toHaveBeenCalledWith(
      'p-brass',
      'bin5',
      5,
      'ft', // the part's own unit, not the dialog's default
      expect.objectContaining({ operatorId: 'member-1' }),
    );
  });

  it('writes the depletion at this location', async () => {
    const user = userEvent.setup();
    setup('deplete');
    await pickPart(user, 'BUY-ORING-214');
    await user.type(screen.getByLabelText(/quantity/i), '2');
    await user.click(screen.getByRole('button', { name: /^remove$/i }));

    expect(depleteStockAtLocation).toHaveBeenCalledWith(
      'p-oring',
      'bin5',
      2,
      'ea',
      expect.objectContaining({ operatorId: 'member-1' }),
    );
  });

  /** A move is FROM here TO the chosen place. Getting that pair backwards is the expensive bug. */
  it('moves from this place to the chosen one, in that order', async () => {
    const user = userEvent.setup();
    setup('move');
    await pickPart(user, 'RAW-STEEL-BLANK');
    await user.type(screen.getByLabelText(/quantity/i), '3');

    await user.click(screen.getByRole('combobox', { name: /move to/i }));
    await user.click(await screen.findByRole('option', { name: /Bin 6/ }));
    await user.click(screen.getByRole('button', { name: /^move$/i }));

    expect(transferStock).toHaveBeenCalledWith(
      'p-steel',
      'bin5',
      'bin6',
      3,
      'ea',
      expect.objectContaining({ operatorId: 'member-1' }),
    );
  });

  it('refuses a move with no destination, without writing', async () => {
    const user = userEvent.setup();
    setup('move');
    await pickPart(user, 'RAW-STEEL-BLANK');
    await user.type(screen.getByLabelText(/quantity/i), '3');
    await user.click(screen.getByRole('button', { name: /^move$/i }));

    expect(await screen.findByText(/choose where it is going/i)).toBeInTheDocument();
    expect(transferStock).not.toHaveBeenCalled();
  });

  it('refuses a non-positive quantity, without writing', async () => {
    const user = userEvent.setup();
    setup('add');
    await pickPart(user, 'RAW-BRASS-ROD');
    await user.type(screen.getByLabelText(/quantity/i), '0');
    await user.click(screen.getByRole('button', { name: /^add$/i }));

    expect(await screen.findByText(/quantity must be positive/i)).toBeInTheDocument();
    expect(addStockAtLocation).not.toHaveBeenCalled();
  });

  /**
   * An empty bin is an ordinary state, not an error — and the honest answer is that there is
   * nothing to take out of it, rather than a picker containing no options.
   */
  it('says the bin is empty rather than showing an empty picker', async () => {
    vi.mocked(getLocationContents).mockResolvedValueOnce({ contents: [], total: 0 });
    setup('deplete');

    expect(await screen.findByText(/nothing is recorded at Bin 5 yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /part/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^remove$/i })).toBeDisabled();
  });

  /** A bin holding one thing is not a choice — pre-select it so it is quantity-and-go. */
  it('pre-selects the only part in the bin', async () => {
    vi.mocked(getLocationContents).mockResolvedValueOnce({
      contents: [
        {
          part_id: 'p-steel',
          part_name: 'RAW-STEEL-BLANK',
          primary_unit: 'ea',
          quantity: 12,
          location_id: 'bin5',
        },
      ],
      total: 1,
    });
    setup('deplete');

    const field = await screen.findByRole('combobox', { name: /part/i });
    expect(field).toHaveValue('RAW-STEEL-BLANK — 12 ea');
  });

  /**
   * The read is capped at 200 rows. A silently short picker is how someone concludes a part is not
   * in a bin it is in, so the cap is said out loud.
   */
  it('says so when the bin holds more than one read returns', async () => {
    vi.mocked(getLocationContents).mockResolvedValueOnce({
      contents: [
        {
          part_id: 'p-steel',
          part_name: 'RAW-STEEL-BLANK',
          primary_unit: 'ea',
          quantity: 12,
          location_id: 'bin5',
        },
      ],
      total: 240,
    });
    setup('move');

    expect(await screen.findByText(/showing the 1 largest of 240 parts here/i)).toBeInTheDocument();
  });

  /** The drawer's header names the place; the form no longer repeats it in its own body. */
  it('names the place it is acting on', async () => {
    setup('add');
    expect(await screen.findByText('Bin 5')).toBeInTheDocument();
  });
});
