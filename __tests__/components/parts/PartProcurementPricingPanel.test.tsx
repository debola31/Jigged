import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../test-utils';
import PartProcurementPricingPanel from '@/components/parts/PartProcurementPricingPanel';
import type { ProcurementTierGroup } from '@/types/procurementTier';
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

describe('PartProcurementPricingPanel — explicit save + red no-cost state', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTiersForPart.mockResolvedValue([] as ProcurementTierGroup[]);
    mockGetAllVendors.mockResolvedValue([vendor]);
    mockUpdatePartPreferredVendor.mockResolvedValue(undefined);
    mockAddTier.mockResolvedValue({ id: 't1', min_quantity: 10, cost_per_unit: 2.5 });
  });

  it('shows the red no-cost prompt + an empty starter row, with Save disabled until edited', async () => {
    render(
      <PartProcurementPricingPanel partId="p1" companyId="c1" primaryUnit="each" />,
    );

    // The vendor auto-selects; with no saved tier the red prompt appears.
    expect(
      await screen.findByText(/Add at least one cost tier so this part can be priced/i),
    ).toBeInTheDocument();

    // The yellow "Add first tier" bubble copy is gone.
    expect(screen.queryByRole('button', { name: /Add first tier/i })).toBeNull();

    // Save is disabled until something is edited (no auto-save).
    const save = screen.getByRole('button', { name: /Save costs/i });
    expect(save).toBeDisabled();
  });

  it('saves a typed tier via the Save button (not on blur) and fires onSaved', async () => {
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
      expect(mockAddTier).toHaveBeenCalledWith(
        expect.objectContaining({ vendor_id: 'v1', min_quantity: '10', cost_per_unit: '2.5' }),
      );
    });
    // Preferred vendor is re-asserted before the tier write.
    expect(mockUpdatePartPreferredVendor).toHaveBeenCalledWith('p1', 'v1');
    // Parent is told to re-derive priceability so the "Needs cost" chip clears.
    expect(onSaved).toHaveBeenCalled();
  });
});
