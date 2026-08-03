import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@/__tests__/test-utils';
import userEvent from '@testing-library/user-event';

/**
 * The dialog imports `computePathNames` from the access layer, and `lib/supabase` builds its
 * browser client at module scope — so the import alone throws in jsdom without this. Established
 * pattern in this repo; the path helper itself stays real, since it is what builds the labels.
 */
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({}),
  getTypedSupabase: () => ({}),
}));

import PutAwayPickerDialog from '@/components/operator/PutAwayPickerDialog';
import type {
  InventoryLocation,
  PartLocationBalanceWithLocation,
} from '@/types/inventoryLocations';

const loc = (over: Partial<InventoryLocation> & { id: string; name: string }): InventoryLocation => ({
  company_id: 'co1',
  parent_id: null,
  kind: 'shelf',
  code: null,
  sort_order: 0,
  photo_path: null,
  created_at: '',
  updated_at: '',
  ...over,
});

const bal = (
  location_id: string,
  quantity: number,
  name: string,
): PartLocationBalanceWithLocation => ({
  location_id,
  location_name: name,
  location_code: null,
  path: [name],
  quantity,
  kind: 'shelf',
});

const onChoose = vi.fn();
const onClose = vi.fn();

const renderDialog = (
  locations: InventoryLocation[],
  balances: PartLocationBalanceWithLocation[] = [],
) =>
  render(
    <PutAwayPickerDialog
      open
      partName="RAW-AL6061-BLANK"
      unit="ea"
      locations={locations}
      balances={balances}
      onClose={onClose}
      onChoose={onChoose}
    />,
  );

/** Open the picker's list and return its option rows. */
const openList = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('combobox', { name: /where is it going/i }));
  return within(await screen.findByRole('listbox')).getAllByRole('option');
};

beforeEach(() => vi.clearAllMocks());

describe('PutAwayPickerDialog — the fallback when you cannot scan the shelf', () => {
  /**
   * The quantities are most of what makes the choice an informed one — `LocationPicker` has
   * rendered them all along behind a `unit` prop that nothing was passing.
   */
  it('shows what is already at each place, and says "empty" where there is none', async () => {
    const user = userEvent.setup();
    renderDialog([loc({ id: 'l1', name: 'Shelf A' }), loc({ id: 'l2', name: 'Yard' })], [
      bal('l1', 40, 'Shelf A'),
    ]);

    const options = await openList(user);
    expect(options[0]).toHaveTextContent('Shelf A');
    expect(options[0]).toHaveTextContent('40 ea');
    expect(options[1]).toHaveTextContent(/empty/i);
  });

  /** Putting stock back with the rest of it is the common case, and it stops a part scattering. */
  it('offers places that already hold some of it first', async () => {
    const user = userEvent.setup();
    renderDialog(
      [loc({ id: 'l1', name: 'Aardvark Bin' }), loc({ id: 'l2', name: 'Zulu Rack' })],
      [bal('l2', 12, 'Zulu Rack')],
    );

    const options = await openList(user);
    expect(options[0]).toHaveTextContent('Zulu Rack');
  });

  /** `Unassigned` is the pile you are emptying, never a destination. */
  it('never offers the put-away pile', async () => {
    const user = userEvent.setup();
    renderDialog([
      loc({ id: 'l1', name: 'Shelf A' }),
      loc({ id: 'sys', name: 'Unassigned', kind: 'system' }),
    ]);

    const options = await openList(user);
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('Shelf A');
  });

  /** Creating places is an owner's job — the same call the board makes by withholding it. */
  it('offers no way to create a place', async () => {
    const user = userEvent.setup();
    renderDialog([loc({ id: 'l1', name: 'Shelf A' })]);

    const options = await openList(user);
    expect(options.some((o) => /create|add/i.test(o.textContent ?? ''))).toBe(false);
  });

  /**
   * It navigates; it does not write. A remote write is a claim that you put something somewhere
   * you may not have reached, and an inventory of unverifiable claims is worse than one with gaps.
   */
  it('takes you to the chosen bin rather than recording the move from here', async () => {
    const user = userEvent.setup();
    renderDialog([loc({ id: 'l1', name: 'Shelf A' })]);

    const [option] = await openList(user);
    await user.click(option);
    await user.click(screen.getByRole('button', { name: /go there/i }));

    expect(onChoose).toHaveBeenCalledWith('l1');
    expect(onClose).toHaveBeenCalled();
  });

  it('cannot be confirmed until somewhere is chosen', () => {
    renderDialog([loc({ id: 'l1', name: 'Shelf A' })]);
    expect(screen.getByRole('button', { name: /go there/i })).toBeDisabled();
  });
});
