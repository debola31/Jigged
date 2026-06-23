import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RoutingCostBreakdown } from '@/utils/routingCostCalculation';

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
  getTypedSupabase: () => mockSupabase,
}));

// calculateRoutingCost is mocked per-test (null = no routing/BOM → bought-part
// path; a breakdown = made-part path). calculateTierPricing stays real so the
// made-part regression test exercises the genuine markup math.
vi.mock('@/utils/routingCostCalculation', async (importActual) => {
  const actual = await importActual<typeof import('@/utils/routingCostCalculation')>();
  return { ...actual, calculateRoutingCost: vi.fn() };
});

vi.mock('@/utils/partsAccess', () => ({
  getComputedPartCost: vi.fn(),
  getPartCostExplain: vi.fn(),
}));

import { getTiersWithComputedPrices } from '@/utils/partPricingTiersAccess';
import { calculateRoutingCost } from '@/utils/routingCostCalculation';
import { getComputedPartCost } from '@/utils/partsAccess';

const mockCalcRoutingCost = vi.mocked(calculateRoutingCost);
const mockComputedPartCost = vi.mocked(getComputedPartCost);

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

describe('getTiersWithComputedPrices — bought parts (no routing/BOM)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuilder.error = null;
  });

  it('prices a bought part as procurement cost × markup (the $55.74 case)', async () => {
    mockBuilder.data = [
      tierRow({ id: 't1', quantity: 1, markup_percent: 122.96 }),
      tierRow({ id: 't10', quantity: 10, markup_percent: 100 }),
    ];
    mockCalcRoutingCost.mockResolvedValue(null); // bought part: no routing/BOM
    mockComputedPartCost.mockImplementation(async (_partId, qty) =>
      qty === 1 ? 25 : 20,
    );

    const tiers = await getTiersWithComputedPrices('part-1');

    expect(tiers).toHaveLength(2);
    // 25 × (1 + 122.96/100) = 55.74 — the manually-typed price is now derived.
    expect(tiers[0].unit_price).toBe(55.74);
    // 20 × (1 + 100/100) = 40.
    expect(tiers[1].unit_price).toBe(40);
    // Base cost is resolved per tier quantity via compute_part_cost_at_qty.
    expect(mockComputedPartCost).toHaveBeenCalledWith('part-1', 1);
    expect(mockComputedPartCost).toHaveBeenCalledWith('part-1', 10);
  });

  it('leaves unit_price null when the base cost cannot resolve (no procurement tier)', async () => {
    mockBuilder.data = [tierRow({ id: 't1', quantity: 1, markup_percent: 50 })];
    mockCalcRoutingCost.mockResolvedValue(null);
    mockComputedPartCost.mockResolvedValue(null);

    const tiers = await getTiersWithComputedPrices('part-1');

    expect(tiers[0].unit_price).toBeNull();
  });

  it('leaves unit_price null when markup is null (no price yet), matching made-part semantics', async () => {
    mockBuilder.data = [tierRow({ id: 't1', quantity: 1, markup_percent: null })];
    mockCalcRoutingCost.mockResolvedValue(null);
    mockComputedPartCost.mockResolvedValue(25);

    const tiers = await getTiersWithComputedPrices('part-1');

    expect(tiers[0].unit_price).toBeNull();
  });
});

describe('getTiersWithComputedPrices — made parts (routing/BOM) unchanged', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuilder.error = null;
  });

  it('prices made parts from the routing breakdown and never calls compute_part_cost_at_qty', async () => {
    mockBuilder.data = [tierRow({ id: 't1', quantity: 1, markup_percent: 100 })];
    const breakdown: RoutingCostBreakdown = {
      labor_items: [],
      material_items: [],
      total_labor_cost: 10,
      total_setup_cost: 0,
      total_material_cost: 5,
      total_cost: 15,
      materials_complete: true,
      warnings: [],
    };
    mockCalcRoutingCost.mockResolvedValue(breakdown);

    const tiers = await getTiersWithComputedPrices('part-1');

    // base = 10 + 5 + 0 = 15; 15 × (1 + 100/100) = 30.
    expect(tiers[0].unit_price).toBe(30);
    // The made-part path must not touch the procurement cost fallback.
    expect(mockComputedPartCost).not.toHaveBeenCalled();
  });
});
