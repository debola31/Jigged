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

// A frozen snapshot carrying one markup tier (t100 @ qty 100, 20% markup) — the
// edit path resolves markup from here, then re-costs base live at the new qty.
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

describe('insertLineItemForPart — single-source pricing (base@qty × markup)', () => {
  // One tier: markup 25% for orders >= 10.
  const tiers = [makeTier({ id: 't10', quantity: 10, markup_percent: 25 })];

  it('prices at base(orderQty) × markup, rounds unit and total to cents', async () => {
    // base 26.6664 × 1.25 = 33.3330 → 33.33; total = 33.33 × 3 = 99.99.
    getComputedPartCostMock.mockResolvedValue(26.6664);
    mockQueryBuilder.data = { id: 'li-1' };

    await insertLineItemForPart('q1', 'co-1', 'part-1', 3, tiers, 0);

    expect(mockQueryBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        unit_price: 33.33,
        quantity: 3,
        total_price: 99.99,
        base_cost_per_unit: 26.6664,
        markup_percent: 25,
        source_tier_id: 't10',
        is_quote_override: false,
        basis_unknown: false,
      }),
    );
  });

  it('base × markup with the tier that applies at the order qty', async () => {
    // qty 12 >= 10 → tier t10, markup 25; base 40 × 1.25 = 50; total 600.
    getComputedPartCostMock.mockResolvedValue(40);
    mockQueryBuilder.data = { id: 'li-1' };

    await insertLineItemForPart('q1', 'co-1', 'part-1', 12, tiers, 0);

    expect(mockQueryBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        unit_price: 50,
        source_tier_id: 't10',
        markup_percent: 25,
        total_price: 600,
        base_cost_per_unit: 40,
      }),
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

  it('throws when no markup tier applies and no override is supplied', async () => {
    getComputedPartCostMock.mockResolvedValue(40);
    await expect(
      insertLineItemForPart('q1', 'co-1', 'part-1', 5, [makeTier({ markup_percent: null })], 0),
    ).rejects.toThrow(/no priced pricing tiers/);
    expect(mockQueryBuilder.insert).not.toHaveBeenCalled();
  });

  it('falls back to the resolved tier price when the live base cost is null', async () => {
    // base null (cost can't compute) → fall back to the ladder's priced tier so
    // the line still gets a sensible price instead of NaN.
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

describe('updateLineItemQuantity — re-cost base at new qty × frozen markup', () => {
  it('recomputes unit_price from base(newQty) × the snapshot markup', async () => {
    mockQueryBuilder.data = {
      id: 'li-1',
      part_id: 'part-1',
      is_quote_override: false,
      basis_unknown: false,
      pricing_basis_snapshot: SNAPSHOT,
      unit_price: 99,
      source_tier_id: 't1',
    };
    // base(100) = 40; markup from snapshot tier t100 = 20% → unit 48; total 4800.
    getComputedPartCostMock.mockResolvedValue(40);

    await updateLineItemQuantity('li-1', 100);

    expect(getComputedPartCostMock).toHaveBeenCalledWith('part-1', 100);
    expect(mockQueryBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        quantity: 100,
        unit_price: 48,
        source_tier_id: 't100',
        total_price: 4800,
      }),
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

describe('repriceLineItemToCurrent — base(lineQty) × current markup', () => {
  const currentTiers = [makeTier({ id: 't50', quantity: 50, markup_percent: 30 })];

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

  it('recomputes base(lineQty) × current markup, total, and rebuilds the snapshot', async () => {
    mockQueryBuilder.data = { id: 'li-1', part_id: 'part-1', is_quote_override: false, quantity: 50 };
    // base(50) = 31.62; markup 30% → 41.106 → 41.11; total 41.11 × 50 = 2055.5.
    getComputedPartCostMock.mockResolvedValue(31.62);

    await repriceLineItemToCurrent('li-1', currentTiers);

    expect(getComputedPartCostMock).toHaveBeenCalledWith('part-1', 50);
    expect(mockQueryBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        unit_price: 41.11,
        source_tier_id: 't50',
        markup_percent: 30,
        total_price: 2055.5,
        pricing_basis_snapshot: SNAPSHOT_SENTINEL,
        basis_unknown: false,
      }),
    );
  });
});
