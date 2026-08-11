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
const mockGetCompany = vi.fn();

vi.mock('@/utils/partPricingTiersAccess', () => ({
  getTiersForPart: (...a: unknown[]) => mockGetTiersForPart(...a),
  replaceTiersForPart: (...a: unknown[]) => mockReplaceTiersForPart(...a),
}));
vi.mock('@/utils/routingCostCalculation', () => ({
  calculateRoutingCost: (...a: unknown[]) => mockCalculateRoutingCost(...a),
}));
vi.mock('@/utils/partsAccess', () => ({
  // The tier table's Base / unit is the CHARGE base (#727) — the number markup
  // is applied to. Same value as true cost until a BOM line charges its child at
  // price, so one mock backs both.
  getComputedPartCost: (...a: unknown[]) => mockGetComputedPartCost(...a),
  getComputedPartChargeBase: (...a: unknown[]) => mockGetComputedPartCost(...a),
  updatePartCostingBatchQuantity: (...a: unknown[]) =>
    mockUpdatePartCostingBatchQuantity(...a),
  addPartPricingNote: (...a: unknown[]) => mockAddPartPricingNote(...a),
}));
vi.mock('@/utils/operatorAccess', () => ({
  getCurrentMember: (...a: unknown[]) => mockGetCurrentMember(...a),
}));
vi.mock('@/utils/companyAccess', () => ({
  getCompany: (...a: unknown[]) => mockGetCompany(...a),
  readCompanyStarterMarkups: (c: {
    default_markup_made_percent?: number;
    default_markup_bought_percent?: number;
  } | null) => ({
    made: c?.default_markup_made_percent ?? 0,
    bought: c?.default_markup_bought_percent ?? 0,
  }),
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
    mockGetCompany.mockResolvedValue({
      default_markup_made_percent: 0,
      default_markup_bought_percent: 0,
    });
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

  it('clears the unsaved state when an edit is manually reverted', async () => {
    // Dirty is derived from the persisted baseline, not latched on first
    // keystroke — so typing over a value and typing it back is genuinely clean.
    // Nagging for a save that would write nothing trains users to ignore the bar.
    render(<PartPricing companyId="c1" part={part} refreshKey={0} />);

    const qty = await minQtyInput();
    await waitFor(() => expect(qty).toHaveValue('100'));

    await user.clear(qty);
    await user.type(qty, '250');
    expect(await screen.findByText(/unsaved change/i)).toBeInTheDocument();

    await user.clear(qty);
    await user.type(qty, '100');

    await waitFor(() => expect(screen.queryByText(/unsaved change/i)).toBeNull());
    expect(screen.queryByRole('button', { name: /Save pricing/i })).toBeNull();
  });

  it('tells the workspace it is clean again after a manual revert', async () => {
    // Otherwise the exit guard stays armed and blocks a tab switch over nothing.
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
    await user.clear(qty);
    await user.type(qty, '250');
    await waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith(true));

    onDirtyChange.mockClear();
    await user.clear(qty);
    await user.type(qty, '100');

    await waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith(false));
  });

  it('keeps batch size behind an explicit Save — it re-costs every parent part', async () => {
    // `compute_part_cost_at_qty` values this part as a made child at exactly
    // this quantity in every parent's BOM, so a fat-fingered 30 -> 300 silently
    // reprices them. That makes it financial data, which never auto-saves.
    render(<PartPricing companyId="c1" part={part} refreshKey={0} />);

    const batch = await screen.findByLabelText(/Batch size/i);
    await user.clear(batch);
    await user.type(batch, '25');

    // Blur must NOT commit it.
    await user.tab();
    expect(mockUpdatePartCostingBatchQuantity).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Save batch size/i }));

    await waitFor(() =>
      expect(mockUpdatePartCostingBatchQuantity).toHaveBeenCalledWith('p1', 25),
    );
  });

  it('gives batch size the same unsaved affordance as the tier tables', async () => {
    // It's a staged explicit-Save surface, so it gets the identical treatment —
    // a lone Save button with no unsaved marker was the inconsistency that made
    // the tier tables' own hint easy to dismiss as decoration.
    render(<PartPricing companyId="c1" part={part} refreshKey={0} />);

    const batch = await screen.findByLabelText(/Batch size/i);
    expect(screen.queryByRole('button', { name: /Save batch size/i })).toBeNull();

    await user.clear(batch);
    await user.type(batch, '25');

    expect(await screen.findByText(/unsaved change/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save batch size/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Discard/i })).toBeEnabled();
  });

  it('clears the batch-size unsaved state on a manual revert', async () => {
    render(<PartPricing companyId="c1" part={part} refreshKey={0} />);

    const batch = await screen.findByLabelText(/Batch size/i);
    await user.clear(batch);
    await user.type(batch, '25');
    await screen.findByText(/unsaved change/i);

    await user.clear(batch);
    await user.type(batch, '1');

    await waitFor(() => expect(screen.queryByText(/unsaved change/i)).toBeNull());
    expect(mockUpdatePartCostingBatchQuantity).not.toHaveBeenCalled();
  });

  it('discards a staged batch size back to the persisted value', async () => {
    render(<PartPricing companyId="c1" part={part} refreshKey={0} />);

    const batch = await screen.findByLabelText(/Batch size/i);
    await user.clear(batch);
    await user.type(batch, '25');
    await screen.findByText(/unsaved change/i);

    await user.click(screen.getByRole('button', { name: /Discard/i }));

    await waitFor(() => expect(batch).toHaveValue(1));
    expect(screen.queryByText(/unsaved change/i)).toBeNull();
    expect(mockUpdatePartCostingBatchQuantity).not.toHaveBeenCalled();
  });
});

// ============================================================================
// The starter tier: a new part is quotable the moment it has a cost.
//
// Before this, adding the first operation or material left the part costed but
// NOT quotable — `get_priceable_part_ids` wants a tier carrying a non-null
// markup, and the card only offered an empty row someone had to fill in and
// save. The card now writes that row itself, at the shop's starting markup for
// the part's source (companies.default_markup_made/bought_percent, 0 by default).
//
// It is the single auto-save on a card whose standard is explicit Save, so what
// these tests pin down is mostly where it must NOT fire — plus that the number
// comes from the setting and says so.
// ============================================================================
describe('PartPricing — starter tier from the shop default', () => {
  const user = userEvent.setup();

  /** A breakdown with a real priced operation — i.e. there is a cost to mark up. */
  const pricedBreakdown = {
    labor_items: [
      {
        operation_name: 'Mill',
        run_time_minutes: 10,
        setup_time_minutes: 0,
        labor_rate: 60,
        cost: 10,
        setup_cost: 0,
      },
    ],
    material_items: [],
    total_labor_cost: 10,
    total_setup_cost: 0,
    total_material_cost: 0,
    total_cost: 10,
    materials_complete: true,
    warnings: [],
  };

  /** A made part with a routing row but nothing in it — cost rolls up to $0. */
  const emptyBreakdown = { ...pricedBreakdown, labor_items: [], total_labor_cost: 0, total_cost: 0 };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTiersForPart.mockResolvedValue([]); // never configured
    mockCalculateRoutingCost.mockResolvedValue(pricedBreakdown);
    mockGetComputedPartCost.mockResolvedValue(10);
    mockReplaceTiersForPart.mockResolvedValue(undefined);
    mockGetCurrentMember.mockResolvedValue({ id: 'u1' });
    mockGetCompany.mockResolvedValue({
      default_markup_made_percent: 0,
      default_markup_bought_percent: 0,
    });
  });

  const starterCall = () => mockReplaceTiersForPart.mock.calls[0];

  it('writes one tier at min qty 1 once the part has a priced operation', async () => {
    render(<PartPricing companyId="c1" part={part} refreshKey={0} />);

    await waitFor(() => expect(mockReplaceTiersForPart).toHaveBeenCalledTimes(1));
    expect(starterCall()[0]).toBe('c1');
    expect(starterCall()[1]).toBe('p1');
    expect(starterCall()[2]).toEqual([{ sequence: 10, quantity: 1, markup_percent: 0 }]);
  });

  it('fires for a part whose only cost is a material — no operations at all', async () => {
    // The reported case: a made part with one purchased material on its BOM and
    // an empty routing. Cost resolves, so the part must become quotable.
    mockCalculateRoutingCost.mockResolvedValue({
      ...pricedBreakdown,
      labor_items: [],
      total_labor_cost: 0,
      material_items: [
        {
          item_name: 'BUY-MOTOR-12V',
          quantity: 9,
          unit: 'ea',
          cost_per_unit: 14.5,
          cost: 130.5,
          qty_in_primary: 9,
          consume_whole_units: true,
          units_consumed: 9,
        },
      ],
      total_material_cost: 130.5,
      total_cost: 130.5,
    });

    render(<PartPricing companyId="c1" part={part} refreshKey={0} />);

    await waitFor(() => expect(mockReplaceTiersForPart).toHaveBeenCalledTimes(1));
    expect(starterCall()[2]).toEqual([{ sequence: 10, quantity: 1, markup_percent: 0 }]);
  });

  it('tells the parent, so the workspace stops saying "needs cost"', async () => {
    const onPricingChanged = vi.fn();
    render(
      <PartPricing companyId="c1" part={part} refreshKey={0} onPricingChanged={onPricingChanged} />,
    );

    await waitFor(() => expect(onPricingChanged).toHaveBeenCalled());
  });

  it('leaves an audit note saying the app wrote it, not a person', async () => {
    render(<PartPricing companyId="c1" part={part} refreshKey={0} />);

    await waitFor(() => expect(mockAddPartPricingNote).toHaveBeenCalled());
    const body = mockAddPartPricingNote.mock.calls[0][3] as string;
    expect(body).toMatch(/automatically/i);
    expect(body).toMatch(/0% markup/);
    expect(body).toMatch(/shop default/i);
  });

  it('uses the MADE default for a made part', async () => {
    mockGetCompany.mockResolvedValue({
      default_markup_made_percent: 35,
      default_markup_bought_percent: 12,
    });
    render(<PartPricing companyId="c1" part={part} refreshKey={0} />);

    await waitFor(() => expect(mockReplaceTiersForPart).toHaveBeenCalledTimes(1));
    expect(starterCall()[2]).toEqual([{ sequence: 10, quantity: 1, markup_percent: 35 }]);
  });

  it('uses the BOUGHT default for a bought part', async () => {
    mockGetCompany.mockResolvedValue({
      default_markup_made_percent: 35,
      default_markup_bought_percent: 12,
    });
    const bought = { ...part, source: 'bought' } as Part;
    render(<PartPricing companyId="c1" part={bought} refreshKey={0} />);

    await waitFor(() => expect(mockReplaceTiersForPart).toHaveBeenCalledTimes(1));
    expect(starterCall()[2]).toEqual([{ sequence: 10, quantity: 1, markup_percent: 12 }]);
  });

  it('writes nothing when the company row cannot be read', async () => {
    // Guessing 0 would write a markup the shop never chose. Better to leave the
    // card exactly as it behaved before the feature existed.
    mockGetCompany.mockRejectedValue(new Error('offline'));
    render(<PartPricing companyId="c1" part={part} refreshKey={0} />);

    await screen.findByText('Pricing');
    await waitFor(() => expect(mockGetTiersForPart).toHaveBeenCalled());
    expect(mockReplaceTiersForPart).not.toHaveBeenCalled();
  });

  it('does NOT fire for a part with a routing row but no priced work', async () => {
    // $0 cost + 0% markup would make the part quotable for nothing — the one
    // outcome worse than not being quotable at all.
    mockCalculateRoutingCost.mockResolvedValue(emptyBreakdown);
    render(<PartPricing companyId="c1" part={part} refreshKey={0} />);

    await screen.findByText('Pricing');
    await waitFor(() => expect(mockGetTiersForPart).toHaveBeenCalled());
    expect(mockReplaceTiersForPart).not.toHaveBeenCalled();
  });

  it('does NOT fire for a part with no routing and no BOM at all', async () => {
    mockCalculateRoutingCost.mockResolvedValue(null);
    render(<PartPricing companyId="c1" part={part} refreshKey={0} />);

    await screen.findByText('Pricing');
    await waitFor(() => expect(mockGetTiersForPart).toHaveBeenCalled());
    expect(mockReplaceTiersForPart).not.toHaveBeenCalled();
  });

  it('never discards a staged edit made while its write is in flight', async () => {
    // Caught by E2E, not by the unit tests: `parts-and-routing.spec.ts` types a
    // Min qty and then saves an operation, and the Min qty came back as 1.
    //
    // The starter write reloads the tier rows when it lands, to pick up the new
    // row's id — and a reload re-seeds from the database. If the user started
    // typing in between, that wipes what they typed. It is the exact bug the
    // load effect's isolation guard exists to prevent; calling loadAll directly
    // walks around that guard, so the check has to be repeated here.
    let releaseWrite: () => void = () => {};
    mockReplaceTiersForPart.mockImplementation(
      () => new Promise<void>((resolve) => { releaseWrite = () => resolve(); }),
    );
    // What the reload WOULD return: the persisted starter row, min qty 1.
    mockGetTiersForPart.mockResolvedValue([]);

    render(<PartPricing companyId="c1" part={part} refreshKey={0} />);
    await waitFor(() => expect(mockReplaceTiersForPart).toHaveBeenCalledTimes(1));

    // The user types while the write is still open.
    const minQty = (await screen.findAllByRole('textbox'))[0];
    await user.clear(minQty);
    await user.type(minQty, '250');
    await screen.findByText(/unsaved change/i);

    mockGetTiersForPart.mockResolvedValue([
      { id: 't-auto', sequence: 10, quantity: 1, markup_percent: 0 },
    ]);
    releaseWrite();

    // Their number stands, and it is still staged.
    await waitFor(() => expect(minQty).toHaveValue('250'));
    expect(screen.getByText(/unsaved change/i)).toBeInTheDocument();
  });

  it('does NOT touch a part that already has tiers', async () => {
    mockGetTiersForPart.mockResolvedValue([savedTier]);
    render(<PartPricing companyId="c1" part={part} refreshKey={0} />);

    await screen.findByDisplayValue('100');
    expect(mockReplaceTiersForPart).not.toHaveBeenCalled();
  });

  it('does not write twice when a sibling panel bumps refreshKey', async () => {
    const { rerender } = render(<PartPricing companyId="c1" part={part} refreshKey={0} />);
    await waitFor(() => expect(mockReplaceTiersForPart).toHaveBeenCalledTimes(1));

    // The reload after the write returns the persisted row, as the DB would.
    mockGetTiersForPart.mockResolvedValue([
      { id: 't-auto', sequence: 10, quantity: 1, markup_percent: 0 },
    ]);
    const loadsBefore = mockGetTiersForPart.mock.calls.length;
    rerender(<PartPricing companyId="c1" part={part} refreshKey={1} />);

    // The bump re-reads the tiers, as it should...
    await waitFor(() =>
      expect(mockGetTiersForPart.mock.calls.length).toBeGreaterThan(loadsBefore),
    );
    // ...and finding a persisted 0% row, writes nothing.
    expect(mockReplaceTiersForPart).toHaveBeenCalledTimes(1);
  });

  it('fires for a bought part once its procurement cost resolves', async () => {
    const bought = { ...part, source: 'bought' } as Part;
    render(<PartPricing companyId="c1" part={bought} refreshKey={0} />);

    await waitFor(() => expect(mockReplaceTiersForPart).toHaveBeenCalledTimes(1));
    expect(starterCall()[2]).toEqual([{ sequence: 10, quantity: 1, markup_percent: 0 }]);
  });

  it('does NOT fire for a bought part with no vendor cost yet', async () => {
    const bought = { ...part, source: 'bought' } as Part;
    mockGetComputedPartCost.mockResolvedValue(null);
    render(<PartPricing companyId="c1" part={bought} refreshKey={0} />);

    await screen.findByText('Pricing');
    await waitFor(() => expect(mockGetTiersForPart).toHaveBeenCalled());
    expect(mockReplaceTiersForPart).not.toHaveBeenCalled();
  });

  it('names Settings as the source, and says what 0% means in money', async () => {
    mockGetTiersForPart.mockResolvedValue([
      { id: 't-auto', sequence: 10, quantity: 1, markup_percent: 0 },
    ]);
    render(<PartPricing companyId="c1" part={part} refreshKey={0} />);

    await screen.findByText(/sells for what it\s+costs/i);
    await screen.findByText(/starting markup for parts you\s+make/i);
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();

    // Changing it is a decision about THIS part; the hint has done its job.
    const markupBox = (await screen.findAllByRole('textbox'))[1];
    await user.clear(markupBox);
    await user.type(markupBox, '30');

    await waitFor(() => expect(screen.queryByText(/sells for what it\s+costs/i)).toBeNull());
  });

  it('at a non-zero default it names the source without the sells-at-cost line', async () => {
    mockGetCompany.mockResolvedValue({
      default_markup_made_percent: 35,
      default_markup_bought_percent: 12,
    });
    mockGetTiersForPart.mockResolvedValue([
      { id: 't-auto', sequence: 10, quantity: 1, markup_percent: 35 },
    ]);
    render(<PartPricing companyId="c1" part={part} refreshKey={0} />);

    await screen.findByText(/Ready to quote at 35% markup/);
    expect(screen.queryByText(/sells for what it costs/i)).toBeNull();
  });
});
