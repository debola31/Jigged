import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../test-utils';
import PartProcurementPricingPanel from '@/components/parts/PartProcurementPricingPanel';
import type { ProcurementTier } from '@/types/procurementTier';
import type { Vendor } from '@/types/vendor';

const mockGetTiersForPart = vi.fn();
const mockAddTier = vi.fn();
const mockUpdateTier = vi.fn();
const mockDeleteTier = vi.fn();
const mockGetAllVendors = vi.fn();
const mockUpdatePartPreferredVendor = vi.fn();

vi.mock('@/utils/procurementTiersAccess', () => ({
  getTiersForPart: (...a: unknown[]) => mockGetTiersForPart(...a),
  addTier: (...a: unknown[]) => mockAddTier(...a),
  updateTier: (...a: unknown[]) => mockUpdateTier(...a),
  deleteTier: (...a: unknown[]) => mockDeleteTier(...a),
}));
vi.mock('@/utils/vendorsAccess', () => ({
  getAllVendors: (...a: unknown[]) => mockGetAllVendors(...a),
}));
vi.mock('@/utils/partsAccess', () => ({
  updatePartPreferredVendor: (...a: unknown[]) => mockUpdatePartPreferredVendor(...a),
}));

const vendor: Vendor = { id: 'v1', name: 'Acme Supply' } as Vendor;

describe('PartProcurementPricingPanel — part-level tiers, explicit save', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTiersForPart.mockResolvedValue([] as ProcurementTier[]);
    mockGetAllVendors.mockResolvedValue([vendor]);
    mockUpdatePartPreferredVendor.mockResolvedValue(undefined);
    mockAddTier.mockResolvedValue({ id: 't1', min_quantity: 10, cost_per_unit: 2.5 });
  });

  it('shows the red no-cost prompt + an empty starter row, with no Save affordance until edited', async () => {
    render(
      <PartProcurementPricingPanel partId="p1" companyId="c1" primaryUnit="each" />,
    );

    // With no saved tier the red part-level prompt appears (independent of vendor).
    expect(
      await screen.findByText(/Add at least one cost tier so this part can be priced/i),
    ).toBeInTheDocument();

    // The yellow "Add first tier" bubble copy is gone.
    expect(screen.queryByRole('button', { name: /Add first tier/i })).toBeNull();

    // Nothing staged → no unsaved-changes footer at all, so no Save button.
    // Save is hidden rather than disabled-and-visible because with nothing to
    // save the action is genuinely irrelevant, not blocked (interaction-
    // standards.md §4 rule 3) — and because a permanently-present Save button
    // carries no signal. Its APPEARANCE is what tells the user work is pending.
    expect(screen.queryByRole('button', { name: /Save costs/i })).toBeNull();
    expect(screen.queryByText(/unsaved change/i)).toBeNull();
  });

  it('saves a typed part-level tier via the Save button (no vendor dimension) and fires onSaved', async () => {
    const onSaved = vi.fn();
    render(
      <PartProcurementPricingPanel
        partId="p1"
        companyId="c1"
        primaryUnit="each"
        onSaved={onSaved}
      />,
    );

    await screen.findByText(/Add at least one cost tier/i);

    // The empty starter row is seeded by an effect one render after the red
    // prompt appears, so AWAIT the inputs — a synchronous getAllByRole can race
    // the seed render under CI's slower/instrumented run. The two table inputs
    // are the only textboxes (the vendor picker is a combobox).
    const inputs = await screen.findAllByRole('textbox');
    await user.type(inputs[0], '10'); // Min qty
    await user.type(inputs[1], '2.5'); // Unit cost

    // Nothing persisted yet — edits are not auto-saved on blur.
    expect(mockAddTier).not.toHaveBeenCalled();

    const save = screen.getByRole('button', { name: /Save costs/i });
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => {
      // Part-level payload — no vendor_id.
      expect(mockAddTier).toHaveBeenCalledWith(
        expect.objectContaining({
          part_id: 'p1',
          min_quantity: '10',
          cost_per_unit: '2.5',
        }),
      );
    });
    expect(mockAddTier).toHaveBeenCalledWith(
      expect.not.objectContaining({ vendor_id: expect.anything() }),
    );
    // Saving cost tiers no longer touches the preferred vendor (decoupled).
    expect(mockUpdatePartPreferredVendor).not.toHaveBeenCalled();
    // Parent is told to re-derive priceability so the "Needs cost" chip clears.
    expect(onSaved).toHaveBeenCalled();
  });

  it('picking a vendor sets it preferred without reloading or discarding unsaved tier edits', async () => {
    render(
      <PartProcurementPricingPanel partId="p1" companyId="c1" primaryUnit="each" />,
    );

    await screen.findByText(/Add at least one cost tier/i);
    const inputs = await screen.findAllByRole('textbox');
    await user.type(inputs[0], '10');
    await user.type(inputs[1], '2.5');

    // One fetch so far (initial load).
    expect(mockGetTiersForPart).toHaveBeenCalledTimes(1);

    // Pick the vendor from the combobox.
    const combo = screen.getByRole('combobox', { name: /Preferred vendor/i });
    await user.click(combo);
    await user.click(await screen.findByText('Acme Supply'));

    await waitFor(() => {
      expect(mockUpdatePartPreferredVendor).toHaveBeenCalledWith('p1', 'v1');
    });

    // The tier sheet was NOT reloaded (still one fetch) and the unsaved edits
    // are preserved.
    expect(mockGetTiersForPart).toHaveBeenCalledTimes(1);
    const after = screen.getAllByRole('textbox');
    expect((after[0] as HTMLInputElement).value).toBe('10');
    expect((after[1] as HTMLInputElement).value).toBe('2.5');
  });
});
