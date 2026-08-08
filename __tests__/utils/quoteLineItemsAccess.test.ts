import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ComputedPartPricingTier } from '@/types/partPricing';
import type { PricingBasisSnapshot } from '@/types/quote';

// Chainable Supabase mock. The builder returns itself for every chain
// method and exposes `.data` / `.error` so `await chain.single()` resolves
// to the builder and destructures cleanly.
const { mockQueryBuilder, mockSupabase } = vi.hoisted(() => {
  const builder: Record<string, ReturnType<typeof vi.fn> | unknown> = {};
  const chainMethods = ['from', 'select', 'insert', 'update', 'delete', 'eq', 'order', 'single'];
  chainMethods.forEach((m) => {
    builder[m] = vi.fn().mockImplementation(() => builder);
  });
  builder.data = null;
  builder.error = null;
  const supabase = { from: vi.fn().mockImplementation(() => builder) };
  return { mockQueryBuilder: builder, mockSupabase: supabase };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
  createClient: () => mockSupabase,
  supabase: mockSupabase,
}));

// Use the REAL pricing resolver (resolveMarkupAtQty / unitPriceFromBase /
// resolveTier* are pure and are the thing under test here — single-source
// pricing). Only buildPricingBasisSnapshot is stubbed to a sentinel so the
// snapshot payload is easy to assert.
const { buildPricingBasisSnapshotMock } = vi.hoisted(() => ({
  buildPricingBasisSnapshotMock: vi.fn(),
}));
vi.mock('@/utils/quotePricingResolver', async () => {
  const actual = await vi.importActual<typeof import('@/utils/quotePricingResolver')>(
    '@/utils/quotePricingResolver',
  );
  return { ...actual, buildPricingBasisSnapshot: buildPricingBasisSnapshotMock };
});

const { getComputedPartCostMock } = vi.hoisted(() => ({ getComputedPartCostMock: vi.fn() }));
vi.mock('@/utils/partsAccess', () => ({ getComputedPartCost: getComputedPartCostMock }));

import {
  insertLineItemForPart,
  updateLineItemQuantity,
  repriceLineItemToCurrent,
} from '@/utils/quoteLineItemsAccess';

function makeTier(partial: Partial<ComputedPartPricingTier>): ComputedPartPricingTier {
  return {
    id: partial.id ?? `tier-${partial.quantity ?? 0}`,
    part_id: 'part-1',
    company_id: 'co-1',
    sequence: partial.sequence ?? 0,
    quantity: partial.quantity ?? 1,
    markup_percent: partial.markup_percent ?? null,
    unit_price: partial.unit_price ?? null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...partial,
  };
}

// A frozen snapshot carrying one priced tier (t100 @ qty 100, listed 45.50).
// The edit path reads the LISTED price straight off this ladder — a quantity
// move walks the frozen price list, it does not re-cost.
const SNAPSHOT: PricingBasisSnapshot = {
  tiers: [{ id: 't100', quantity: 100, unit_price: 45.5, markup_percent: 20 }],
  resolved_tier_id: 't100',
  resolved_quantity: 100,
  captured_at: '2026-01-01T00:00:00Z',
};
const SNAPSHOT_SENTINEL = { tiers: [], resolved_tier_id: 't10' };

beforeEach(() => {
  vi.clearAllMocks();
  (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation(() => mockQueryBuilder);
  Object.keys(mockQueryBuilder).forEach((key) => {
    const value = mockQueryBuilder[key];
    if (typeof value === 'function' && 'mockClear' in value) {
      (value as ReturnType<typeof vi.fn>).mockClear();
      (value as ReturnType<typeof vi.fn>).mockImplementation(() => mockQueryBuilder);
    }
  });
  mockQueryBuilder.data = null;
  mockQueryBuilder.error = null;
  buildPricingBasisSnapshotMock.mockReturnValue(SNAPSHOT_SENTINEL);
});

describe('insertLineItemForPart — the matched tier’s listed price', () => {
  // One tier: orders >= 10 list at 50.00 (base 40 × 1.25 at qty 10).
  const tiers = [makeTier({ id: 't10', quantity: 10, markup_percent: 25, unit_price: 50 })];

  it('quotes the tier’s listed price and rounds the total to cents', async () => {
    getComputedPartCostMock.mockResolvedValue(40);
    mockQueryBuilder.data = { id: 'li-1' };

    await insertLineItemForPart('q1', 'co-1', 'part-1', 12, tiers, 0);

    expect(mockQueryBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        unit_price: 50,
        quantity: 12,
        total_price: 600,
        markup_percent: 25,
        source_tier_id: 't10',
        is_quote_override: false,
        basis_unknown: false,
      }),
    );
  });

  it('quotes the SAME price well above the break — setup is not re-amortized', async () => {
    // The regression this whole rule exists for: a part listing 50.00 at its
    // qty-10 break quotes 50.00 at 500, not a cheaper number recomputed at 500.
    getComputedPartCostMock.mockResolvedValue(40);
    mockQueryBuilder.data = { id: 'li-1' };

    await insertLineItemForPart('q1', 'co-1', 'part-1', 500, tiers, 0);

    expect(mockQueryBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ unit_price: 50, total_price: 25000, source_tier_id: 't10' }),
    );
  });

  it('snapshots base_cost_per_unit at the BREAK qty, so the row’s arithmetic holds', async () => {
    // unit_price = base_cost_per_unit × (1 + markup/100) is what the column
    // records, so the base must come from the qty the price was derived at (10)
    // — never the order qty (500), where setup amortizes differently.
    getComputedPartCostMock.mockResolvedValue(40);
    mockQueryBuilder.data = { id: 'li-1' };

    await insertLineItemForPart('q1', 'co-1', 'part-1', 500, tiers, 0);

    expect(getComputedPartCostMock).toHaveBeenCalledWith('part-1', 10);
    const written = (mockQueryBuilder.insert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(written.base_cost_per_unit).toBe(40);
    expect(
      Math.round(written.base_cost_per_unit * (1 + written.markup_percent / 100) * 100) / 100,
    ).toBe(written.unit_price);
  });

  it('below the lowest break, snaps to that break’s listed price', async () => {
    getComputedPartCostMock.mockResolvedValue(40);
    mockQueryBuilder.data = { id: 'li-1' };

    await insertLineItemForPart('q1', 'co-1', 'part-1', 3, tiers, 0);

    expect(mockQueryBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ unit_price: 50, total_price: 150, source_tier_id: 't10' }),
    );
  });

  it('takes price/markup from the override and flags is_quote_override', async () => {
    getComputedPartCostMock.mockResolvedValue(40);
    mockQueryBuilder.data = { id: 'li-1' };

    await insertLineItemForPart('q1', 'co-1', 'part-1', 4, tiers, 0, {
      unit_price: 75.5,
      markup_percent: 60,
    });

    expect(mockQueryBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        unit_price: 75.5,
        markup_percent: 60,
        source_tier_id: 't10', // markup tier still resolved so drift checks can run
        total_price: 302,
        is_quote_override: true,
      }),
    );
  });

  it('throws when no priced tier applies and no override is supplied', async () => {
    getComputedPartCostMock.mockResolvedValue(40);
    await expect(
      insertLineItemForPart('q1', 'co-1', 'part-1', 5, [makeTier({ markup_percent: null })], 0),
    ).rejects.toThrow(/no priced pricing tiers/);
    expect(mockQueryBuilder.insert).not.toHaveBeenCalled();
  });

  it('still writes the tier price when the base cost cannot be computed', async () => {
    // The price comes off the ladder, so a part that momentarily can't cost
    // still quotes correctly — only the base_cost_per_unit snapshot goes null.
    getComputedPartCostMock.mockResolvedValue(null);
    mockQueryBuilder.data = { id: 'li-1' };

    await insertLineItemForPart(
      'q1',
      'co-1',
      'part-1',
      2,
      [makeTier({ id: 't10', quantity: 10, markup_percent: 25, unit_price: 42 })],
      0,
    );

    expect(mockQueryBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ unit_price: 42, total_price: 84, base_cost_per_unit: null }),
    );
  });
});

describe('updateLineItemQuantity — walks the frozen price list', () => {
  it('takes unit_price from the snapshot tier, without re-costing', async () => {
    mockQueryBuilder.data = {
      id: 'li-1',
      part_id: 'part-1',
      is_quote_override: false,
      basis_unknown: false,
      pricing_basis_snapshot: SNAPSHOT,
      unit_price: 99,
      source_tier_id: 't1',
    };

    await updateLineItemQuantity('li-1', 100);

    // The frozen ladder lists 45.50 at t100 → 45.50 × 100 = 4550. No cost call:
    // a quantity move reads the price list, it does not re-derive a price.
    expect(getComputedPartCostMock).not.toHaveBeenCalled();
    expect(mockQueryBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        quantity: 100,
        unit_price: 45.5,
        source_tier_id: 't100',
        total_price: 4550,
      }),
    );
  });

  it('holds that price above the break instead of drifting below it', async () => {
    mockQueryBuilder.data = {
      id: 'li-1',
      part_id: 'part-1',
      is_quote_override: false,
      basis_unknown: false,
      pricing_basis_snapshot: SNAPSHOT,
      unit_price: 45.5,
      source_tier_id: 't100',
    };

    await updateLineItemQuantity('li-1', 400);

    expect(mockQueryBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 400, unit_price: 45.5, total_price: 18200 }),
    );
  });

  it('keeps the override price pinned and only changes qty/total', async () => {
    mockQueryBuilder.data = {
      id: 'li-1',
      part_id: 'part-1',
      is_quote_override: true,
      basis_unknown: false,
      pricing_basis_snapshot: SNAPSHOT,
      unit_price: 20,
      source_tier_id: 't10',
    };

    await updateLineItemQuantity('li-1', 5);

    expect(getComputedPartCostMock).not.toHaveBeenCalled();
    expect(mockQueryBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 5, unit_price: 20, total_price: 100 }),
    );
  });

  it('keeps the stored unit_price for basis_unknown rows', async () => {
    mockQueryBuilder.data = {
      id: 'li-1',
      part_id: 'part-1',
      is_quote_override: false,
      basis_unknown: true,
      pricing_basis_snapshot: SNAPSHOT_SENTINEL,
      unit_price: 12.5,
      source_tier_id: 't10',
    };

    await updateLineItemQuantity('li-1', 8);

    expect(getComputedPartCostMock).not.toHaveBeenCalled();
    expect(mockQueryBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 8, unit_price: 12.5, total_price: 100 }),
    );
  });
});

describe('repriceLineItemToCurrent — the current ladder’s listed price', () => {
  const currentTiers = [
    makeTier({ id: 't50', quantity: 50, markup_percent: 30, unit_price: 41.11 }),
  ];

  it('throws for override rows', async () => {
    mockQueryBuilder.data = { id: 'li-1', part_id: 'part-1', is_quote_override: true, quantity: 50 };

    await expect(repriceLineItemToCurrent('li-1', currentTiers)).rejects.toThrow(
      /Override line items cannot be repriced/,
    );
  });

  it('throws when current tiers have no usable markup tier', async () => {
    mockQueryBuilder.data = { id: 'li-1', part_id: 'part-1', is_quote_override: false, quantity: 50 };

    await expect(
      repriceLineItemToCurrent('li-1', [makeTier({ markup_percent: null })]),
    ).rejects.toThrow(/no priced tiers/);
  });

  it('takes the current tier’s listed price, refreshes the base and the snapshot', async () => {
    mockQueryBuilder.data = { id: 'li-1', part_id: 'part-1', is_quote_override: false, quantity: 50 };
    // t50 lists 41.11 (base 31.62 × 1.30 at qty 50); total 41.11 × 50 = 2055.5.
    getComputedPartCostMock.mockResolvedValue(31.62);

    await repriceLineItemToCurrent('li-1', currentTiers);

    expect(getComputedPartCostMock).toHaveBeenCalledWith('part-1', 50);
    expect(mockQueryBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        unit_price: 41.11,
        source_tier_id: 't50',
        markup_percent: 30,
        base_cost_per_unit: 31.62,
        total_price: 2055.5,
        pricing_basis_snapshot: SNAPSHOT_SENTINEL,
        basis_unknown: false,
      }),
    );
  });

  it('re-costs at the matched BREAK, not the line qty, when they differ', async () => {
    // Line sits at 500 but the ladder tops out at 50: the price is t50's listed
    // price, so the refreshed base must be the one behind it (qty 50).
    mockQueryBuilder.data = { id: 'li-1', part_id: 'part-1', is_quote_override: false, quantity: 500 };
    getComputedPartCostMock.mockResolvedValue(31.62);

    await repriceLineItemToCurrent('li-1', currentTiers);

    expect(getComputedPartCostMock).toHaveBeenCalledWith('part-1', 50);
    expect(mockQueryBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({ unit_price: 41.11, total_price: 20555 }),
    );
  });
});
