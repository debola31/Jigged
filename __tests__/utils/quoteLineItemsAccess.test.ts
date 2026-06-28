import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ComputedPartPricingTier } from '@/types/partPricing';

// Chainable Supabase mock. The builder returns itself for every chain
// method and exposes `.data` / `.error` so `await chain.single()` resolves
// to the builder and destructures cleanly — same shape as the other
// *Access tests (see quotesAccess.test.ts / procurementTiersAccess.test.ts).
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
  getTypedSupabase: () => mockSupabase,
  createClient: () => mockSupabase,
  supabase: mockSupabase,
}));

// Pure resolver collaborators are unit-tested in quotePricingResolver.test.ts.
// Here we stub them so each test isolates the arithmetic and payload-building
// inside quoteLineItemsAccess itself.
const { resolveTierMock, resolveTierFromSnapshotMock, buildPricingBasisSnapshotMock } = vi.hoisted(
  () => ({
    resolveTierMock: vi.fn(),
    resolveTierFromSnapshotMock: vi.fn(),
    buildPricingBasisSnapshotMock: vi.fn(),
  }),
);
vi.mock('@/utils/quotePricingResolver', () => ({
  resolveTier: resolveTierMock,
  resolveTierFromSnapshot: resolveTierFromSnapshotMock,
  buildPricingBasisSnapshot: buildPricingBasisSnapshotMock,
}));

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

describe('insertLineItemForPart', () => {
  const tiers = [makeTier({ id: 't10', quantity: 10, markup_percent: 25, unit_price: 33.333 })];

  it('rounds total_price to cents (Math.round(unit*qty*100)/100)', async () => {
    // 33.333 * 3 = 99.999 -> rounds up to 100.00
    resolveTierMock.mockReturnValue({ unit_price: 33.333, source_tier_id: 't10' });
    getComputedPartCostMock.mockResolvedValue(20);
    mockQueryBuilder.data = { id: 'li-1' };

    await insertLineItemForPart('q1', 'co-1', 'part-1', 3, tiers, 0);

    expect(mockQueryBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ unit_price: 33.333, quantity: 3, total_price: 100 }),
    );
  });

  it('uses the resolved tier price, source, and the matched tier markup (no override)', async () => {
    resolveTierMock.mockReturnValue({ unit_price: 50, source_tier_id: 't10' });
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
        is_quote_override: false,
        basis_unknown: false,
      }),
    );
  });

  it('takes price/markup from the override and flags is_quote_override', async () => {
    resolveTierMock.mockReturnValue({ unit_price: 50, source_tier_id: 't10' });
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
        source_tier_id: 't10', // still resolved so drift checks can run
        total_price: 302,
        is_quote_override: true,
      }),
    );
  });

  it('throws when no tier resolves and no override is supplied', async () => {
    resolveTierMock.mockReturnValue(null);

    await expect(insertLineItemForPart('q1', 'co-1', 'part-1', 5, tiers, 0)).rejects.toThrow(
      /no priced pricing tiers/,
    );
    expect(mockQueryBuilder.insert).not.toHaveBeenCalled();
  });

  it('snapshots base_cost_per_unit as null when cost computation throws', async () => {
    resolveTierMock.mockReturnValue({ unit_price: 50, source_tier_id: 't10' });
    getComputedPartCostMock.mockRejectedValue(new Error('missing labor rate'));
    mockQueryBuilder.data = { id: 'li-1' };

    await insertLineItemForPart('q1', 'co-1', 'part-1', 2, tiers, 0);

    expect(mockQueryBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ base_cost_per_unit: null, basis_unknown: false, total_price: 100 }),
    );
  });
});

describe('updateLineItemQuantity', () => {
  it('recomputes unit_price from the frozen snapshot and total from the new qty', async () => {
    mockQueryBuilder.data = {
      id: 'li-1',
      is_quote_override: false,
      basis_unknown: false,
      pricing_basis_snapshot: SNAPSHOT_SENTINEL,
      unit_price: 99,
      source_tier_id: 't1',
    };
    resolveTierFromSnapshotMock.mockReturnValue({ unit_price: 45.5, source_tier_id: 't100' });

    await updateLineItemQuantity('li-1', 100);

    expect(resolveTierFromSnapshotMock).toHaveBeenCalledWith(SNAPSHOT_SENTINEL, 100);
    expect(mockQueryBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        quantity: 100,
        unit_price: 45.5,
        source_tier_id: 't100',
        total_price: 4550,
      }),
    );
  });

  it('keeps the override price pinned and only changes qty/total', async () => {
    mockQueryBuilder.data = {
      id: 'li-1',
      is_quote_override: true,
      basis_unknown: false,
      pricing_basis_snapshot: SNAPSHOT_SENTINEL,
      unit_price: 20,
      source_tier_id: 't10',
    };

    await updateLineItemQuantity('li-1', 5);

    expect(resolveTierFromSnapshotMock).not.toHaveBeenCalled();
    expect(mockQueryBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 5, unit_price: 20, total_price: 100 }),
    );
  });

  it('keeps the stored unit_price for basis_unknown rows', async () => {
    mockQueryBuilder.data = {
      id: 'li-1',
      is_quote_override: false,
      basis_unknown: true,
      pricing_basis_snapshot: SNAPSHOT_SENTINEL,
      unit_price: 12.5,
      source_tier_id: 't10',
    };

    await updateLineItemQuantity('li-1', 8);

    expect(resolveTierFromSnapshotMock).not.toHaveBeenCalled();
    expect(mockQueryBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 8, unit_price: 12.5, total_price: 100 }),
    );
  });
});

describe('repriceLineItemToCurrent', () => {
  const currentTiers = [makeTier({ id: 't50', quantity: 50, markup_percent: 30 })];

  it('throws for override rows', async () => {
    mockQueryBuilder.data = { id: 'li-1', is_quote_override: true, quantity: 50 };

    await expect(repriceLineItemToCurrent('li-1', currentTiers)).rejects.toThrow(
      /Override line items cannot be repriced/,
    );
  });

  it('throws when current tiers have no usable tier', async () => {
    mockQueryBuilder.data = { id: 'li-1', is_quote_override: false, quantity: 50 };
    resolveTierMock.mockReturnValue(null);

    await expect(repriceLineItemToCurrent('li-1', currentTiers)).rejects.toThrow(
      /no priced tiers/,
    );
  });

  it('repriced row recomputes price, markup, total and rebuilds the snapshot', async () => {
    mockQueryBuilder.data = { id: 'li-1', is_quote_override: false, quantity: 50 };
    resolveTierMock.mockReturnValue({ unit_price: 41.111, source_tier_id: 't50' });

    await repriceLineItemToCurrent('li-1', currentTiers);

    expect(mockQueryBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        unit_price: 41.111,
        source_tier_id: 't50',
        markup_percent: 30,
        total_price: 2055.55, // round(41.111 * 50 * 100) / 100
        pricing_basis_snapshot: SNAPSHOT_SENTINEL,
        basis_unknown: false,
      }),
    );
  });
});
