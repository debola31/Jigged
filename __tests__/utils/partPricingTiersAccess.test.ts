import { describe, it, expect, vi, beforeEach } from 'vitest';

// Awaitable query-builder mock: getTiersForPart awaits
// `.from().select().eq().order()`, and `await <non-thenable>` resolves to the
// object itself, so destructuring `{ data, error }` reads these props.
const { mockBuilder, mockSupabase } = vi.hoisted(() => {
  const builder: Record<string, unknown> = {};
  ['from', 'select', 'eq', 'order'].forEach((m) => {
    builder[m] = vi.fn(() => builder);
  });
  builder.data = null;
  builder.error = null;
  const supabase = { from: vi.fn(() => builder), rpc: vi.fn() };
  return { mockBuilder: builder, mockSupabase: supabase };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
}));

// The one canonical engine — every price (made or bought) derives from it, so a
// tier's price and a quote at that qty can't disagree. Price paths read the
// CHARGE base, not true cost (#727): markup applies to what materials are
// charged into the part at, so a BOM line set to charge its child at price is
// already inside the number. The two are equal until someone sets that toggle.
vi.mock('@/utils/partsAccess', () => ({
  getComputedPartCost: vi.fn(),
  getComputedPartChargeBase: vi.fn(),
  getPartCostExplain: vi.fn(),
}));

import { getTiersWithComputedPrices } from '@/utils/partPricingTiersAccess';
import { getComputedPartChargeBase } from '@/utils/partsAccess';

const mockComputedPartCost = vi.mocked(getComputedPartChargeBase);

function tierRow(partial: { id: string; quantity: number; markup_percent: number | null }) {
  return {
    id: partial.id,
    part_id: 'part-1',
    company_id: 'co-1',
    sequence: 0,
    quantity: partial.quantity,
    markup_percent: partial.markup_percent,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

describe('getTiersWithComputedPrices — one engine for made and bought', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuilder.error = null;
  });

  it('prices each tier as base(tierQty) × markup via the canonical engine', async () => {
    mockBuilder.data = [
      tierRow({ id: 't1', quantity: 1, markup_percent: 122.96 }),
      tierRow({ id: 't10', quantity: 10, markup_percent: 100 }),
    ];
    // Base cost is per tier quantity (a step-function part costs less per unit
    // at higher qty).
    mockComputedPartCost.mockImplementation(async (_partId, qty) => (qty === 1 ? 25 : 20));

    const tiers = await getTiersWithComputedPrices('part-1');

    expect(tiers).toHaveLength(2);
    expect(tiers[0].unit_price).toBe(55.74); // 25 × (1 + 122.96/100)
    expect(tiers[1].unit_price).toBe(40); // 20 × (1 + 100/100)
    // Base cost resolved at EACH tier's own quantity — not a single qty.
    expect(mockComputedPartCost).toHaveBeenCalledWith('part-1', 1);
    expect(mockComputedPartCost).toHaveBeenCalledWith('part-1', 10);
  });

  it('applies markup then rounds once (single-round cost-plus)', async () => {
    mockBuilder.data = [tierRow({ id: 't1', quantity: 1, markup_percent: 100 })];
    mockComputedPartCost.mockResolvedValue(1.114);

    const tiers = await getTiersWithComputedPrices('part-1');

    // 1.114 × 2 = 2.228 → rounds once to 2.23 (base is NOT pre-rounded).
    expect(tiers[0].unit_price).toBe(2.23);
  });

  it('leaves unit_price null when the base cost cannot resolve', async () => {
    mockBuilder.data = [tierRow({ id: 't1', quantity: 1, markup_percent: 50 })];
    mockComputedPartCost.mockResolvedValue(null);

    const tiers = await getTiersWithComputedPrices('part-1');
    expect(tiers[0].unit_price).toBeNull();
  });

  it('leaves unit_price null when markup is null (no price yet)', async () => {
    mockBuilder.data = [tierRow({ id: 't1', quantity: 1, markup_percent: null })];
    mockComputedPartCost.mockResolvedValue(25);

    const tiers = await getTiersWithComputedPrices('part-1');
    expect(tiers[0].unit_price).toBeNull();
  });

  it('leaves unit_price null when markup is NaN (guards a corrupt rate)', async () => {
    mockBuilder.data = [tierRow({ id: 't1', quantity: 1, markup_percent: Number.NaN })];
    mockComputedPartCost.mockResolvedValue(25);

    const tiers = await getTiersWithComputedPrices('part-1');
    expect(tiers[0].unit_price).toBeNull();
  });
});

