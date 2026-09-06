import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The starter tier: a part becomes quotable at the same moment it first has a
 * cost, at the shop's starting markup for its source.
 *
 * `get_priceable_part_ids` needs a tier carrying a non-null markup, so before
 * this a part could be fully costed and still refuse to go on a quote, with the
 * only remedy a blank box on a card the user had no reason to open.
 *
 * It lives in the access layer, called from the workspace's post-mutation
 * refresh, for two reasons learned the hard way — it used to be an effect inside
 * the Pricing card:
 *
 *   * running AFTER the refresh made the workspace flash "this part can't be
 *     quoted yet" and then correct itself, and
 *   * an automatic write inside an explicit-Save card reached around that card's
 *     guards twice, eating a staged Min qty and then a staged operation edit.
 *
 * What these tests mostly pin down is where it must NOT fire. A markup written
 * against a $0 cost would make a part quotable for nothing, and a markup written
 * over an existing ladder would overwrite a decision somebody made.
 */

// A chainable Supabase stub, so getTiersForPart / replaceTiersForPart run for
// real and the assertion lands on the row actually written. Mocking this
// module's own exports would not work: ensureStarterPricingTier calls them
// directly, and a partial self-mock cannot intercept an internal call.
const { mockBuilder, mockSupabase } = vi.hoisted(() => {
  const builder: Record<string, unknown> = {};
  ['from', 'select', 'insert', 'update', 'delete', 'eq', 'in', 'order'].forEach((m) => {
    builder[m] = vi.fn(() => builder);
  });
  builder.data = [];
  builder.error = null;
  return { mockBuilder: builder, mockSupabase: { from: vi.fn(() => builder) } };
});
const mockGetComputedPartCost = vi.fn();
const mockCalculateRoutingCost = vi.fn();
const mockGetCompany = vi.fn();
const mockGetCurrentMember = vi.fn();
const mockAddPartPricingNote = vi.fn();

vi.mock('@/lib/supabase', () => ({ getSupabase: () => mockSupabase }));
vi.mock('@/utils/partsAccess', () => ({
  getComputedPartChargeBase: vi.fn(),
  getComputedPartCost: (...a: unknown[]) => mockGetComputedPartCost(...a),
  addPartPricingNote: (...a: unknown[]) => mockAddPartPricingNote(...a),
}));
vi.mock('@/utils/routingCostCalculation', () => ({
  calculateRoutingCost: (...a: unknown[]) => mockCalculateRoutingCost(...a),
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
vi.mock('@/utils/operatorAccess', () => ({
  getCurrentMember: (...a: unknown[]) => mockGetCurrentMember(...a),
}));

import { ensureStarterPricingTier } from '@/utils/partPricingTiersAccess';

/** The tier rows the part currently has. */
const givenExistingTiers = (rows: unknown[]) => {
  mockBuilder.data = rows;
};
/** The `part_pricing_tiers` insert payload, or undefined if nothing was written. */
const insertedTier = () =>
  (mockBuilder.insert as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];

/**
 * A bought part's cost lives ON its tier row, so such a part already HAS a row
 * the moment anyone records a cost. The starter fills the missing markup into
 * it — an UPDATE, not an INSERT — and must leave the id, quantity and row count
 * alone, because a quote line's drift check compares exactly those.
 */
const updatedTier = () =>
  (mockBuilder.update as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];

const givenCostedRowWithNoMarkup = () =>
  givenExistingTiers([
    { id: 't-cost', sequence: 10, quantity: 1, cost_per_unit: 4.5, markup_percent: null },
  ]);

/** A breakdown with a real priced operation — there is a cost to mark up. */
const pricedBreakdown = {
  labor_items: [{ operation_name: 'Mill', cost: 10, setup_cost: 0 }],
  material_items: [],
  total_labor_cost: 10,
  total_cost: 10,
};

describe('ensureStarterPricingTier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    givenExistingTiers([]);
    mockCalculateRoutingCost.mockResolvedValue(pricedBreakdown);
    mockGetComputedPartCost.mockResolvedValue(10);
    mockGetCurrentMember.mockResolvedValue({ id: 'u1' });
    mockGetCompany.mockResolvedValue({
      default_markup_made_percent: 0,
      default_markup_bought_percent: 0,
    });
  });

  it('writes one tier at min qty 1 for a made part with priced work', async () => {
    const created = await ensureStarterPricingTier('c1', 'p1', 'made');

    expect(created).toBe(true);
    expect(insertedTier()).toMatchObject({
      part_id: 'p1',
      company_id: 'c1',
      quantity: 1,
      markup_percent: 0,
    });
  });

  it('takes the MADE default for a made part and the BOUGHT default for a bought one', async () => {
    mockGetCompany.mockResolvedValue({
      default_markup_made_percent: 35,
      default_markup_bought_percent: 12,
    });

    await ensureStarterPricingTier('c1', 'p1', 'made');
    expect(insertedTier()).toMatchObject({ markup_percent: 35 });

    (mockBuilder.insert as ReturnType<typeof vi.fn>).mockClear();
    givenCostedRowWithNoMarkup();
    await ensureStarterPricingTier('c1', 'p2', 'bought');
    expect(updatedTier()).toMatchObject({ markup_percent: 12 });
  });

  it('leaves an audit note saying the app wrote it, not a person', async () => {
    await ensureStarterPricingTier('c1', 'p1', 'made');

    const body = mockAddPartPricingNote.mock.calls[0][3] as string;
    expect(body).toMatch(/automatically/i);
    expect(body).toMatch(/shop default/i);
    expect(body).toMatch(/parts you make/);
  });

  it('does NOT overwrite a ladder the shop already built', async () => {
    givenExistingTiers([{ id: 't1', sequence: 10, quantity: 100, markup_percent: 25 }]);

    expect(await ensureStarterPricingTier('c1', 'p1', 'made')).toBe(false);
    expect(insertedTier()).toBeUndefined();
  });

  it('does NOT fire for a made part with a routing but no priced work', async () => {
    // $0 cost + a markup = quotable for nothing, which is worse than not being
    // quotable at all.
    mockCalculateRoutingCost.mockResolvedValue({
      ...pricedBreakdown,
      labor_items: [],
      material_items: [],
    });

    expect(await ensureStarterPricingTier('c1', 'p1', 'made')).toBe(false);
    expect(insertedTier()).toBeUndefined();
  });

  it('does NOT fire for a made part with no routing and no BOM at all', async () => {
    mockCalculateRoutingCost.mockResolvedValue(null);

    expect(await ensureStarterPricingTier('c1', 'p1', 'made')).toBe(false);
    expect(insertedTier()).toBeUndefined();
  });

  it('fires for a bought part only once a cost has been recorded', async () => {
    // No row at all, or a row with no cost on it, means there is nothing to mark
    // up yet — a markup over an unknown cost is still unknown.
    expect(await ensureStarterPricingTier('c1', 'p1', 'bought')).toBe(false);
    expect(insertedTier()).toBeUndefined();

    givenExistingTiers([
      { id: 't1', sequence: 10, quantity: 1, cost_per_unit: null, markup_percent: null },
    ]);
    expect(await ensureStarterPricingTier('c1', 'p1', 'bought')).toBe(false);

    givenCostedRowWithNoMarkup();
    expect(await ensureStarterPricingTier('c1', 'p1', 'bought')).toBe(true);
  });

  it('leaves a bought part alone once it already has a markup', async () => {
    // Re-running must not overwrite a markup the shop chose.
    givenExistingTiers([
      { id: 't1', sequence: 10, quantity: 1, cost_per_unit: 4.5, markup_percent: 40 },
    ]);
    expect(await ensureStarterPricingTier('c1', 'p1', 'bought')).toBe(false);
    expect(insertedTier()).toBeUndefined();
  });

  it('fills the markup without disturbing the row identity a quote drifts against', async () => {
    givenCostedRowWithNoMarkup();
    await ensureStarterPricingTier('c1', 'p1', 'bought');
    // Same row, same break, same cost — only the markup arrives.
    expect(updatedTier()).toMatchObject({ quantity: 1, cost_per_unit: 4.5, markup_percent: 0 });
    expect(insertedTier()).toBeUndefined();
  });

  it('writes nothing when the company row cannot be read', async () => {
    // Guessing 0 would write a markup the shop never chose.
    mockGetCompany.mockResolvedValue(null);

    expect(await ensureStarterPricingTier('c1', 'p1', 'made')).toBe(false);
    expect(insertedTier()).toBeUndefined();
  });

  it('still reports success when only the audit note fails', async () => {
    // The tier is the point; the note is best-effort and must not undo it.
    mockAddPartPricingNote.mockRejectedValue(new Error('notes offline'));

    expect(await ensureStarterPricingTier('c1', 'p1', 'made')).toBe(true);
    expect(insertedTier()).toBeDefined();
  });
});
