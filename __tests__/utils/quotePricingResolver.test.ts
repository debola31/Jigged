import { describe, it, expect } from 'vitest';
import type { PartPricingTier } from '@/types/partPricing';
import { resolveTier } from '@/utils/quotePricingResolver';

function makeTier(partial: Partial<PartPricingTier>): PartPricingTier {
  return {
    id: partial.id ?? `tier-${partial.quantity ?? 0}`,
    part_id: 'part-1',
    company_id: 'co-1',
    sequence: partial.sequence ?? 0,
    quantity: partial.quantity ?? 1,
    base_cost_per_unit: partial.base_cost_per_unit ?? 0,
    markup_percent: partial.markup_percent ?? null,
    unit_price: partial.unit_price ?? null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...partial,
  };
}

describe('resolveTier', () => {
  const tiers: PartPricingTier[] = [
    makeTier({ id: 't1', quantity: 1, unit_price: 1209.03 }),
    makeTier({ id: 't10', quantity: 10, unit_price: 1095.83 }),
    makeTier({ id: 't100', quantity: 100, unit_price: 1051.76 }),
    makeTier({ id: 't1000', quantity: 1000, unit_price: 1024.22 }),
  ];

  it('picks the highest tier with quantity <= order qty (in-between)', () => {
    const r = resolveTier(tiers, 50);
    expect(r).not.toBeNull();
    expect(r!.unit_price).toBe(1095.83);
    expect(r!.source_tier_id).toBe('t10');
    expect(r!.matched_tier_quantity).toBe(10);
    expect(r!.below_min).toBe(false);
  });

  it('picks the exact tier on a boundary match', () => {
    const r = resolveTier(tiers, 100);
    expect(r!.source_tier_id).toBe('t100');
    expect(r!.unit_price).toBe(1051.76);
  });

  it('falls back to the lowest tier when below the minimum break', () => {
    const r = resolveTier(tiers, 0);
    expect(r!.source_tier_id).toBe('t1');
    expect(r!.unit_price).toBe(1209.03);
    expect(r!.below_min).toBe(true);
  });

  it('uses the highest tier when order qty exceeds all breaks', () => {
    const r = resolveTier(tiers, 5000);
    expect(r!.source_tier_id).toBe('t1000');
    expect(r!.unit_price).toBe(1024.22);
    expect(r!.below_min).toBe(false);
  });

  it('handles a single-tier part', () => {
    const single: PartPricingTier[] = [makeTier({ id: 'only', quantity: 1, unit_price: 999 })];
    const r = resolveTier(single, 50);
    expect(r!.source_tier_id).toBe('only');
    expect(r!.unit_price).toBe(999);
    expect(r!.below_min).toBe(false);
  });

  it('returns null when no tier has a unit price', () => {
    const noPrices: PartPricingTier[] = [makeTier({ quantity: 1, unit_price: null })];
    expect(resolveTier(noPrices, 10)).toBeNull();
  });

  it('returns null on non-finite order qty', () => {
    expect(resolveTier(tiers, NaN)).toBeNull();
    expect(resolveTier(tiers, Infinity)).toBeNull();
  });

  it('skips unpriced tiers when picking the match', () => {
    const mixed: PartPricingTier[] = [
      makeTier({ id: 't1', quantity: 1, unit_price: 1209.03 }),
      makeTier({ id: 't10-unpriced', quantity: 10, unit_price: null }),
      makeTier({ id: 't100', quantity: 100, unit_price: 1051.76 }),
    ];
    const r = resolveTier(mixed, 50);
    expect(r!.source_tier_id).toBe('t1');
    expect(r!.unit_price).toBe(1209.03);
  });

  it('is robust to unsorted tier inputs', () => {
    const shuffled: PartPricingTier[] = [
      makeTier({ id: 't100', quantity: 100, unit_price: 1051.76 }),
      makeTier({ id: 't1', quantity: 1, unit_price: 1209.03 }),
      makeTier({ id: 't10', quantity: 10, unit_price: 1095.83 }),
    ];
    const r = resolveTier(shuffled, 50);
    expect(r!.source_tier_id).toBe('t10');
  });
});
