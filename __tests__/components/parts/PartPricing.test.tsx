import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../test-utils';
import PartPricing from '@/components/parts/PartPricing';
import type { Part } from '@/types/part';

const mockGetTiersForPart = vi.fn();
const mockReplaceTiersForPart = vi.fn();
const mockCalculateRoutingCost = vi.fn();
const mockGetComputedPartCost = vi.fn();
const mockUpdatePartCostingBatchQuantity = vi.fn();
const mockAddPartPricingNote = vi.fn();
const mockGetCurrentMember = vi.fn();

vi.mock('@/utils/partPricingTiersAccess', () => ({
  getTiersForPart: (...a: unknown[]) => mockGetTiersForPart(...a),
  replaceTiersForPart: (...a: unknown[]) => mockReplaceTiersForPart(...a),
}));
vi.mock('@/utils/routingCostCalculation', () => ({
  calculateRoutingCost: (...a: unknown[]) => mockCalculateRoutingCost(...a),
}));
vi.mock('@/utils/partsAccess', () => ({
  getComputedPartCost: (...a: unknown[]) => mockGetComputedPartCost(...a),
  updatePartCostingBatchQuantity: (...a: unknown[]) =>
    mockUpdatePartCostingBatchQuantity(...a),
  addPartPricingNote: (...a: unknown[]) => mockAddPartPricingNote(...a),
}));
vi.mock('@/utils/operatorAccess', () => ({
  getCurrentMember: (...a: unknown[]) => mockGetCurrentMember(...a),
}));

const part = {
  id: 'p1',
  part_name: 'BRACKET-001',
  source: 'made',
  primary_unit: 'each',
  costing_batch_quantity: 1,
} as Part;

/** One persisted tier: 100 @ 25% markup. */
const savedTier = { id: 't1', sequence: 10, quantity: 100, markup_percent: 25 };

describe('PartPricing — staged tier edits survive sibling saves', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTiersForPart.mockResolvedValue([savedTier]);
    mockCalculateRoutingCost.mockResolvedValue({
      labor_items: [],
      material_items: [],
      total_labor_cost: 10,
      total_setup_cost: 0,
      total_material_cost: 5,
      total_cost: 15,
      materials_complete: true,
      warnings: [],
    });
    mockGetComputedPartCost.mockResolvedValue(15);
    mockReplaceTiersForPart.mockResolvedValue(undefined);
    mockGetCurrentMember.mockResolvedValue(null);
  });

  /** The Min qty box for the first tier row. */
  const minQtyInput = async (): Promise<HTMLElement> =>
    (await screen.findAllByRole('textbox'))[0];

  it('keeps a staged Min qty edit when a sibling panel bumps refreshKey', async () => {
    // This is the reported bug: type a Min qty, then save an operation in the
    // Operations card. That fires refreshAfterMutation -> refreshKey++, which
    // used to re-seed these rows from the DB and silently drop the typed value.
    const { rerender } = render(<PartPricing companyId="c1" part={part} refreshKey={0} />);

    const qty = await minQtyInput();
    await waitFor(() => expect(qty).toHaveValue('100'));

    await user.clear(qty);
    await user.type(qty, '250');
    expect(qty).toHaveValue('250');
    expect(await screen.findByText(/unsaved change/i)).toBeInTheDocument();

    // A sibling panel saves — same part, new refreshKey.
    rerender(<PartPricing companyId="c1" part={part} refreshKey={1} />);

    // The staged value survives, and so does the unsaved-changes state.
    await waitFor(() => expect(qty).toHaveValue('250'));
    expect(screen.getByText(/unsaved change/i)).toBeInTheDocument();
    // Nothing was written — this is still a staged edit, not an auto-save.
    expect(mockReplaceTiersForPart).not.toHaveBeenCalled();
  });

  it('still refetches derived base costs when refreshKey bumps while dirty', async () => {
    // Isolation protects the DRAFT, not the derived numbers: a routing change
    // really does change the rolled-up cost, so Base/unit must still refresh.
    const { rerender } = render(<PartPricing companyId="c1" part={part} refreshKey={0} />);

    const qty = await minQtyInput();
    await waitFor(() => expect(qty).toHaveValue('100'));
    await user.clear(qty);
    await user.type(qty, '250');

    mockGetComputedPartCost.mockClear();
    mockGetComputedPartCost.mockResolvedValue(22);

    rerender(<PartPricing companyId="c1" part={part} refreshKey={1} />);

    await waitFor(() => expect(mockGetComputedPartCost).toHaveBeenCalled());
    expect(qty).toHaveValue('250');
  });

  it('does re-seed from the database when NOT dirty', async () => {
    // The guard must not freeze the card: with nothing staged, a sibling save
    // still pulls fresh tiers through.
    const { rerender } = render(<PartPricing companyId="c1" part={part} refreshKey={0} />);

    const qty = await minQtyInput();
    await waitFor(() => expect(qty).toHaveValue('100'));

    mockGetTiersForPart.mockResolvedValue([
      { id: 't1', sequence: 10, quantity: 500, markup_percent: 25 },
    ]);
    rerender(<PartPricing companyId="c1" part={part} refreshKey={1} />);

    await waitFor(() => expect(qty).toHaveValue('500'));
  });

  it('reloads for a genuine part change even with a staged edit pending', async () => {
    // `dirty` belongs to the part being edited — it must not keep the NEXT
    // part's tiers off screen.
    const { rerender } = render(<PartPricing companyId="c1" part={part} refreshKey={0} />);

    const qty = await minQtyInput();
    await waitFor(() => expect(qty).toHaveValue('100'));
    await user.clear(qty);
    await user.type(qty, '250');

    mockGetTiersForPart.mockResolvedValue([
      { id: 't9', sequence: 10, quantity: 42, markup_percent: 30 },
    ]);
    const otherPart = { ...part, id: 'p2', part_name: 'PLATE-002' } as Part;
    rerender(<PartPricing companyId="c1" part={otherPart} refreshKey={0} />);

    await waitFor(async () => expect(await minQtyInput()).toHaveValue('42'));
    expect(screen.queryByText(/unsaved change/i)).toBeNull();
  });

  it('shows no unsaved-changes footer until something is edited', async () => {
    render(<PartPricing companyId="c1" part={part} refreshKey={0} />);

    const qty = await minQtyInput();
    await waitFor(() => expect(qty).toHaveValue('100'));

    // Save is absent (not merely disabled) while there is nothing to save, so
    // its appearance is itself the signal that work is pending.
    expect(screen.queryByText(/unsaved change/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /Save pricing/i })).toBeNull();

    await user.clear(qty);
    await user.type(qty, '250');

    expect(await screen.findByText(/1 unsaved change/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save pricing/i })).toBeEnabled();
  });

  it('discards staged edits back to the persisted values', async () => {
    render(<PartPricing companyId="c1" part={part} refreshKey={0} />);

    const qty = await minQtyInput();
    await waitFor(() => expect(qty).toHaveValue('100'));
    await user.clear(qty);
    await user.type(qty, '250');
    await screen.findByText(/unsaved change/i);

    await user.click(screen.getByRole('button', { name: /Discard/i }));

    await waitFor(() => expect(qty).toHaveValue('100'));
    expect(screen.queryByText(/unsaved change/i)).toBeNull();
    expect(mockReplaceTiersForPart).not.toHaveBeenCalled();
  });

  it('reports dirty state up so the workspace can guard the exit', async () => {
    const onDirtyChange = vi.fn();
    render(
      <PartPricing
        companyId="c1"
        part={part}
        refreshKey={0}
        onDirtyChange={onDirtyChange}
      />,
    );

    const qty = await minQtyInput();
    await waitFor(() => expect(qty).toHaveValue('100'));

    onDirtyChange.mockClear();
    await user.clear(qty);
    await user.type(qty, '250');

    await waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith(true));
  });

  it('auto-saves the batch size on blur instead of behind a Save button', async () => {
    render(<PartPricing companyId="c1" part={part} refreshKey={0} />);

    const batch = await screen.findByLabelText(/Batch size/i);
    await user.clear(batch);
    await user.type(batch, '25');

    // Not written while still focused — blur is the commit point.
    expect(mockUpdatePartCostingBatchQuantity).not.toHaveBeenCalled();

    await user.tab();

    await waitFor(() =>
      expect(mockUpdatePartCostingBatchQuantity).toHaveBeenCalledWith('p1', 25),
    );
  });
});
