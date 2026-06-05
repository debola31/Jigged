import { describe, it, expect } from 'vitest';
import type { PartPricingTier } from '@/types/partPricing';
import type { PricingBasisSnapshot } from '@/types/quote';
import {
  resolveTier,
  resolveTierFromSnapshot,
  buildPricingBasisSnapshot,
  isDrifted,
  isDriftedDegraded,
} from '@/utils/quotePricingResolver';

function makeTier(partial: Partial<PartPricingTier>): PartPricingTier {
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

function makeSnapshot(
  tiers: Array<{ id: string; quantity: number; unit_price: number; markup_percent?: number | null }>,
  resolvedTierId: string | null,
  resolvedQuantity: number,
): PricingBasisSnapshot {
  return {
    tiers: tiers.map((t) => ({
      id: t.id,
      quantity: t.quantity,
      unit_price: t.unit_price,
      markup_percent: t.markup_percent ?? null,
    })),
    resolved_tier_id: resolvedTierId,
    resolved_quantity: resolvedQuantity,
    captured_at: '2026-06-01T00:00:00Z',
  };
}

describe('resolveTierFromSnapshot — quantity change honors snapshotted basis', () => {
  // Frozen basis was: [1=$100, 10=$90, 100=$80].
  // Even if the part's CURRENT tiers have moved, edit-time qty changes
  // must resolve against this snapshot.
  const snap = makeSnapshot(
    [
      { id: 't1', quantity: 1, unit_price: 100 },
      { id: 't10', quantity: 10, unit_price: 90 },
      { id: 't100', quantity: 100, unit_price: 80 },
    ],
    't10',
    25,
  );

  it('quantity change honors snapshotted basis', () => {
    // User bumps qty from 25 (t10 break) to 150 (t100 break) on edit.
    const r = resolveTierFromSnapshot(snap, 150);
    expect(r).not.toBeNull();
    expect(r!.source_tier_id).toBe('t100');
    expect(r!.unit_price).toBe(80);
  });

  it('falls back to lowest tier when below the snapshot minimum', () => {
    const r = resolveTierFromSnapshot(snap, 0.5);
    expect(r!.source_tier_id).toBe('t1');
    expect(r!.unit_price).toBe(100);
    expect(r!.below_min).toBe(true);
  });

  it('returns the highest tier when qty exceeds every break', () => {
    const r = resolveTierFromSnapshot(snap, 99999);
    expect(r!.source_tier_id).toBe('t100');
  });
});

describe('buildPricingBasisSnapshot', () => {
  it('captures only priced tiers and records the resolved tier', () => {
    const tiers: PartPricingTier[] = [
      makeTier({ id: 't1', quantity: 1, unit_price: 50 }),
      makeTier({ id: 't10', quantity: 10, unit_price: null }), // null filtered out
      makeTier({ id: 't100', quantity: 100, unit_price: 40 }),
    ];
    const snap = buildPricingBasisSnapshot(tiers, 200, 't100');
    expect(snap.tiers.map((t) => t.id)).toEqual(['t1', 't100']);
    expect(snap.resolved_tier_id).toBe('t100');
    expect(snap.resolved_quantity).toBe(200);
    expect(snap.captured_at).toMatch(/T/);
  });

  it('keeps the snapshot tiers sorted by quantity ascending', () => {
    const tiers: PartPricingTier[] = [
      makeTier({ id: 't100', quantity: 100, unit_price: 40 }),
      makeTier({ id: 't1', quantity: 1, unit_price: 50 }),
      makeTier({ id: 't10', quantity: 10, unit_price: 45 }),
    ];
    const snap = buildPricingBasisSnapshot(tiers, 5, 't1');
    expect(snap.tiers.map((t) => t.quantity)).toEqual([1, 10, 100]);
  });
});

describe('isDrifted — drift is flagged when current tier differs from basis', () => {
  const basis = makeSnapshot(
    [
      { id: 't1', quantity: 1, unit_price: 100 },
      { id: 't10', quantity: 10, unit_price: 90 },
    ],
    't10',
    20,
  );

  it('drift is flagged when current tier differs from basis', () => {
    const currentTiers: PartPricingTier[] = [
      makeTier({ id: 't1', quantity: 1, unit_price: 110 }), // moved
      makeTier({ id: 't10', quantity: 10, unit_price: 90 }),
    ];
    expect(isDrifted(basis, currentTiers)).toBe(true);
  });

  it('is NOT flagged when current tiers match the snapshot', () => {
    const currentTiers: PartPricingTier[] = [
      makeTier({ id: 't1', quantity: 1, unit_price: 100 }),
      makeTier({ id: 't10', quantity: 10, unit_price: 90 }),
    ];
    expect(isDrifted(basis, currentTiers)).toBe(false);
  });

  it('flags drift when a snapshotted tier id disappears', () => {
    const currentTiers: PartPricingTier[] = [
      makeTier({ id: 't1', quantity: 1, unit_price: 100 }),
    ];
    expect(isDrifted(basis, currentTiers)).toBe(true);
  });

  it('flags drift when a new priced tier appears', () => {
    const currentTiers: PartPricingTier[] = [
      makeTier({ id: 't1', quantity: 1, unit_price: 100 }),
      makeTier({ id: 't10', quantity: 10, unit_price: 90 }),
      makeTier({ id: 't100', quantity: 100, unit_price: 80 }),
    ];
    expect(isDrifted(basis, currentTiers)).toBe(true);
  });

  it('absorbs sub-cent floating-point noise', () => {
    const currentTiers: PartPricingTier[] = [
      makeTier({ id: 't1', quantity: 1, unit_price: 100.001 }),
      makeTier({ id: 't10', quantity: 10, unit_price: 89.999 }),
    ];
    expect(isDrifted(basis, currentTiers)).toBe(false);
  });
});

describe('isDriftedDegraded — basis_unknown rows', () => {
  it('flags drift when current resolved price differs from stored unit_price', () => {
    const currentTiers: PartPricingTier[] = [
      makeTier({ id: 't1', quantity: 1, unit_price: 100 }),
      makeTier({ id: 't10', quantity: 10, unit_price: 90 }),
    ];
    // Stored row: qty 25 @ $80 (older price). Current resolves to $90 at qty 25.
    expect(isDriftedDegraded(80, 25, currentTiers)).toBe(true);
  });

  it('does not flag when current resolved price matches stored unit_price', () => {
    const currentTiers: PartPricingTier[] = [
      makeTier({ id: 't10', quantity: 10, unit_price: 90 }),
    ];
    expect(isDriftedDegraded(90, 25, currentTiers)).toBe(false);
  });

  it('does not flag when the part has no priced tiers today', () => {
    expect(isDriftedDegraded(80, 25, [])).toBe(false);
  });
});
