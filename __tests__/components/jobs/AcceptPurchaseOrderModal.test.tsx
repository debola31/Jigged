import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../test-utils';
import AcceptPurchaseOrderModal from '@/components/jobs/AcceptPurchaseOrderModal';

const mockGetTiers = vi.fn();

vi.mock('@/utils/partPricingTiersAccess', () => ({
  getTiersWithComputedPrices: (...a: unknown[]) => mockGetTiers(...a),
}));
// resolveTier stays the REAL pure implementation — we want to exercise the
// actual quote-line resolution path the PO→Job flow reuses.
vi.mock('@/utils/jobsAccess', () => ({
  getCustomersForSelect: vi.fn().mockResolvedValue([{ id: 'c1', name: 'Acme Machining' }]),
  createJobFromPurchaseOrder: vi.fn(),
}));
vi.mock('@/utils/jobAttachmentsAccess', () => ({
  uploadJobAttachment: vi.fn(),
}));
// A trivial part picker that fires onChange with a fixed part when clicked, so
// the test can drive the expected-price lookup without the real Autocomplete.
vi.mock('@/components/parts/PartAutocomplete', () => ({
  default: ({ onChange }: { onChange: (p: { id: string; part_name: string }) => void }) => (
    <button type="button" onClick={() => onChange({ id: 'part-1', part_name: 'BRKT-001' })}>
      pick-part
    </button>
  ),
}));
vi.mock('@/components/jobs/AttachmentUploadField', () => ({ default: () => null }));

function pricedTier(unit_price: number) {
  return {
    id: 't1',
    part_id: 'part-1',
    company_id: 'c1',
    sequence: 0,
    quantity: 1,
    markup_percent: 100,
    unit_price,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

describe('AcceptPurchaseOrderModal — expected (sell) price', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTiers.mockResolvedValue([pricedTier(55.74)]);
  });

  it('pre-fills the unit price with the expected sell price when a part is picked', async () => {
    render(
      <AcceptPurchaseOrderModal open onClose={vi.fn()} companyId="c1" onCreated={vi.fn()} />,
    );

    await user.click(screen.getByRole('button', { name: 'pick-part' }));

    // After the debounce, resolveTier(getTiersWithComputedPrices) resolves and
    // the caption + pre-filled price appear (findBy rides the ~350ms debounce).
    expect(await screen.findByText(/Expected \$55\.74/i)).toBeInTheDocument();
    await waitFor(() => {
      const priceInput = screen.getByLabelText('Unit price') as HTMLInputElement;
      expect(priceInput.value).toBe('55.74');
    });
    expect(mockGetTiers).toHaveBeenCalledWith('part-1');
  });

  it('flags drift (non-blocking) when the entered price differs from expected', async () => {
    render(
      <AcceptPurchaseOrderModal open onClose={vi.fn()} companyId="c1" onCreated={vi.fn()} />,
    );

    await user.click(screen.getByRole('button', { name: 'pick-part' }));
    await screen.findByText(/Expected \$55\.74/i);

    const priceInput = screen.getByLabelText('Unit price');
    await user.clear(priceInput);
    await user.type(priceInput, '60');

    expect(await screen.findByText(/Differs from expected \$55\.74/i)).toBeInTheDocument();
    // A "Reset" affordance restores the expected price.
    await user.click(screen.getByRole('button', { name: /^Reset$/i }));
    await waitFor(() => {
      expect((screen.getByLabelText('Unit price') as HTMLInputElement).value).toBe('55.74');
    });
  });

  it('leaves the price blank when the part has no priced tier (no pre-fill)', async () => {
    mockGetTiers.mockResolvedValue([{ ...pricedTier(0), unit_price: null }]);
    render(
      <AcceptPurchaseOrderModal open onClose={vi.fn()} companyId="c1" onCreated={vi.fn()} />,
    );

    await user.click(screen.getByRole('button', { name: 'pick-part' }));

    // Give the debounce + lookup time to run, then assert no pre-fill / caption.
    await waitFor(() => expect(mockGetTiers).toHaveBeenCalledWith('part-1'));
    await waitFor(() => {
      expect((screen.getByLabelText('Unit price') as HTMLInputElement).value).toBe('');
    });
    expect(screen.queryByText(/Expected \$/i)).toBeNull();
  });
});
