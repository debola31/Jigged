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
  readCompanyPricingDefaults: (c: {
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
const savedTier = { id: 't1', sequence: 10, quantity: 100, cost_per_unit: null, markup_percent: 25 };

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

  it('renders the ladder low break first, whatever order the rows arrive in', async () => {
    // A ladder reads bottom-up. Rows come back ordered by `sequence`, which need
    // not track the break on rows an importer or a migration wrote — so the
    // sort is on the number the user actually reads.
    mockGetTiersForPart.mockResolvedValue([
      { id: 'hi', sequence: 10, quantity: 100, cost_per_unit: null, markup_percent: 25 },
      { id: 'lo', sequence: 20, quantity: 0.5, cost_per_unit: null, markup_percent: 2 },
    ]);
    render(<PartPricing companyId="c1" part={part} refreshKey={0} />);

    const qtys = await screen.findAllByRole('textbox');
    await waitFor(() => expect(qtys[0]).toHaveValue('0.5'));
    expect(qtys[3]).toHaveValue('100');
  });

  it('lets the lowest break be edited, and says it also covers anything below', async () => {
    // It was briefly fixed text ("1 +") on the grounds that the engine floors to
    // the lowest break, so its number cannot gate anything. True, and still the
    // wrong remedy: a shop pricing from 0.5 up has to be able to say 0.5. State
    // the fact, don't confiscate the field.
    render(<PartPricing companyId="c1" part={part} refreshKey={0} />);

    const qty = await minQtyInput();
    await waitFor(() => expect(qty).toHaveValue('100'));
    await user.clear(qty);
    await user.type(qty, '0.5');
    expect(qty).toHaveValue('0.5');
    expect(screen.getByText('and below')).toBeInTheDocument();
  });

  it('reorders the ladder on save without renumbering the rows', async () => {
    // Two rows swapping places must not renumber their sequences:
    // replaceTiersForPart updates one row at a time against
    // UNIQUE (part_id, sequence), so a swap would collide halfway through.
    mockGetTiersForPart.mockResolvedValue([
      { id: 'a', sequence: 10, quantity: 1, cost_per_unit: null, markup_percent: 25 },
      { id: 'b', sequence: 20, quantity: 100, cost_per_unit: null, markup_percent: 15 },
    ]);
    render(<PartPricing companyId="c1" part={part} refreshKey={0} />);

    // Make row 'a' the HIGHER break, so the saved order flips.
    const qty = await minQtyInput();
    await waitFor(() => expect(qty).toHaveValue('1'));
    await user.clear(qty);
    await user.type(qty, '500');
    await user.click(screen.getByRole('button', { name: /Save pricing/i }));

    await waitFor(() => expect(mockReplaceTiersForPart).toHaveBeenCalled());
    const payload = mockReplaceTiersForPart.mock.calls[0][2];
    // Ascending by break...
    expect(payload.map((t: { quantity: number }) => t.quantity)).toEqual([100, 500]);
    // ...and each row still carries the sequence it arrived with.
    expect(payload.find((t: { id?: string }) => t.id === 'a').sequence).toBe(10);
    expect(payload.find((t: { id?: string }) => t.id === 'b').sequence).toBe(20);
  });

  it('refuses two tiers on the same break instead of surfacing a 23505', async () => {
    render(<PartPricing companyId="c1" part={part} refreshKey={0} />);
    await waitFor(async () => expect(await minQtyInput()).toHaveValue('100'));

    await user.click(screen.getByRole('button', { name: /Add tier/i }));
    const boxes = await screen.findAllByRole('textbox');
    await user.type(boxes[3], '100'); // the new row's Min qty
    await user.click(screen.getByRole('button', { name: /Save pricing/i }));

    expect(await screen.findByText(/same min qty/i)).toBeInTheDocument();
    expect(mockReplaceTiersForPart).not.toHaveBeenCalled();
  });

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
      { id: 't1', sequence: 10, quantity: 500, cost_per_unit: null, markup_percent: 25 },
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
      { id: 't9', sequence: 10, quantity: 42, cost_per_unit: null, markup_percent: 30 },
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
// The starter tier no longer lives on this card.
//
// It used to be an effect here that noticed a cost had appeared and wrote a
// tier. That was the wrong home twice over: it ran after the routing/BOM save
// had already refreshed the page, so the workspace flashed "this part can't be
// quoted yet" and then corrected itself; and an automatic write inside an
// explicit-Save card kept reaching around this card's own guards, eating a
// staged Min qty once and a staged operation edit once.
//
// It is now `ensureStarterPricingTier`, called from the workspace's
// post-mutation refresh BEFORE the refresh lands — covered by
// `__tests__/utils/ensureStarterPricingTier.test.ts`. What stays here is the
// caption that explains the resulting number.
// ============================================================================
describe('PartPricing — the starting-markup caption', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
    mockCalculateRoutingCost.mockResolvedValue({
      labor_items: [],
      material_items: [],
      total_labor_cost: 10,
      total_setup_cost: 0,
      total_material_cost: 5,
      total_cost: 15,
      total_material_true_cost: 5,
      total_true_cost: 15,
      materials_complete: true,
      warnings: [],
    });
    mockGetComputedPartCost.mockResolvedValue(15);
    mockReplaceTiersForPart.mockResolvedValue(undefined);
    mockGetCurrentMember.mockResolvedValue({ id: 'u1' });
    mockGetCompany.mockResolvedValue({
      default_markup_made_percent: 0,
      default_markup_bought_percent: 0,
    });
  });

  it('never writes a tier — this card only saves when the user says so', async () => {
    mockGetTiersForPart.mockResolvedValue([]);
    render(<PartPricing companyId="c1" part={part} refreshKey={0} />);

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

  it('says nothing about a ladder the shop has actually built', async () => {
    mockGetTiersForPart.mockResolvedValue([
      { id: 't1', sequence: 10, quantity: 1, markup_percent: 0 },
      { id: 't2', sequence: 20, quantity: 100, markup_percent: 15 },
    ]);
    render(<PartPricing companyId="c1" part={part} refreshKey={0} />);

    await screen.findByDisplayValue('100');
    expect(screen.queryByText(/starting markup for parts you/i)).toBeNull();
  });
});
