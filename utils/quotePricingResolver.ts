import type { ComputedPartPricingTier } from '@/types/partPricing';
import type { PricingBasisSnapshot } from '@/types/quote';

export interface ResolvedTier {
  unit_price: number;
  source_tier_id: string | null;
  matched_tier_quantity: number | null;
  below_min: boolean;
}

/**
 * Resolve which pricing tier applies for a given order quantity.
 *
 * The matched tier is the one with the largest `quantity` that is still
 * `<= orderQuantity`. If `orderQuantity` is below the lowest tier, the
 * lowest tier is used as a fallback and `below_min` is set so the UI can
 * surface a warning.
 *
 * Tiers without a `unit_price` (e.g. base cost not yet computed) are
 * skipped — the resolver only considers priced tiers.
 *
 * Returns `null` when no priced tier is available.
 */
export function resolveTier(
  tiers: ComputedPartPricingTier[],
  orderQuantity: number,
): ResolvedTier | null {
  if (!Number.isFinite(orderQuantity)) return null;

  const priced = tiers
    .filter((t) => t.unit_price !== null && Number.isFinite(t.unit_price))
    .sort((a, b) => a.quantity - b.quantity);
  if (priced.length === 0) return null;

  const lowest = priced[0];
  if (orderQuantity < lowest.quantity) {
    return {
      unit_price: lowest.unit_price as number,
      source_tier_id: lowest.id,
      matched_tier_quantity: lowest.quantity,
      below_min: true,
    };
  }

  let match = lowest;
  for (const tier of priced) {
    if (tier.quantity <= orderQuantity) {
      match = tier;
    } else {
      break;
    }
  }

  return {
    unit_price: match.unit_price as number,
    source_tier_id: match.id,
    matched_tier_quantity: match.quantity,
    below_min: false,
  };
}

/**
 * Resolve a tier from a frozen `PricingBasisSnapshot` instead of live
 * `ComputedPartPricingTier[]`. Used on quote-edit when the user changes
 * quantity — the recomputed price must come from the snapshotted tiers
 * (frozen-by-default), NOT from the part's current tier table. Otherwise
 * a tier change since quote creation would silently affect what looks
 * like normal quantity-curve movement.
 *
 * Returns null if the snapshot has no priced tiers (impossible in practice
 * — snapshots are only written when a resolved tier exists — but keeps
 * the resolver signature consistent with `resolveTier`).
 */
export function resolveTierFromSnapshot(
  snapshot: PricingBasisSnapshot,
  orderQuantity: number,
): ResolvedTier | null {
  if (!Number.isFinite(orderQuantity)) return null;

  const tiers = [...snapshot.tiers].sort((a, b) => a.quantity - b.quantity);
  if (tiers.length === 0) return null;

  const lowest = tiers[0];
  if (orderQuantity < lowest.quantity) {
    return {
      unit_price: lowest.unit_price,
      source_tier_id: lowest.id,
      matched_tier_quantity: lowest.quantity,
      below_min: true,
    };
  }

  let match = lowest;
  for (const tier of tiers) {
    if (tier.quantity <= orderQuantity) {
      match = tier;
    } else {
      break;
    }
  }

  return {
    unit_price: match.unit_price,
    source_tier_id: match.id,
    matched_tier_quantity: match.quantity,
    below_min: false,
  };
}

/**
 * Build a `PricingBasisSnapshot` from the live tier list at create-time.
 * Only priced tiers are captured — null-price tiers are filtered out so
 * the snapshot is always usable for later resolution.
 *
 * `resolvedTierId` should be the tier whose price was used for the line.
 * For override lines pass `null` (no tier was resolved).
 */
export function buildPricingBasisSnapshot(
  tiers: ComputedPartPricingTier[],
  orderQuantity: number,
  resolvedTierId: string | null,
): PricingBasisSnapshot {
  const priced = tiers
    .filter(
      (t): t is ComputedPartPricingTier & { unit_price: number } =>
        t.unit_price !== null && Number.isFinite(t.unit_price),
    )
    .map((t) => ({
      id: t.id,
      quantity: t.quantity,
      unit_price: t.unit_price,
      markup_percent: t.markup_percent,
    }))
    .sort((a, b) => a.quantity - b.quantity);

  return {
    tiers: priced,
    resolved_tier_id: resolvedTierId,
    resolved_quantity: orderQuantity,
    captured_at: new Date().toISOString(),
  };
}

/**
 * Compare a frozen `PricingBasisSnapshot` against the part's CURRENT
 * computed tier table. Returns true when ANY tier the snapshot saw has
 * shifted price, OR when a snapshotted tier id has disappeared, OR when
 * a new priced tier has appeared. Quantity-curve movement (the user
 * changing order qty without the underlying tier changing) is NOT drift.
 *
 * Floating-point comparison uses a small epsilon to absorb rounding from
 * the live cost rollup; tier changes from human input always exceed it.
 */
export function isDrifted(
  snapshot: PricingBasisSnapshot,
  currentTiers: ComputedPartPricingTier[],
): boolean {
  const EPSILON = 0.005;
  const current = currentTiers
    .filter(
      (t): t is ComputedPartPricingTier & { unit_price: number } =>
        t.unit_price !== null && Number.isFinite(t.unit_price),
    )
    .map((t) => ({
      id: t.id,
      quantity: t.quantity,
      unit_price: t.unit_price,
    }));

  const snap = snapshot.tiers;
  if (snap.length !== current.length) return true;

  const currentById = new Map(current.map((t) => [t.id, t]));
  for (const s of snap) {
    const c = currentById.get(s.id);
    if (!c) return true;
    if (c.quantity !== s.quantity) return true;
    if (Math.abs(c.unit_price - s.unit_price) > EPSILON) return true;
  }
  return false;
}

/**
 * Degraded drift check for pre-snapshot rows (`basis_unknown = true`).
 * The historical basis is unknown so the comparison falls back to:
 * "would the same order quantity resolve to a different price today than
 * what the line stores?". Returns true when the current resolved tier
 * price differs from the line's stored `unit_price`. Override lines never
 * count as drifted (`is_quote_override` callers should short-circuit).
 *
 * This is the "Option C" path locked in #317 — Option A (backfill from
 * current tiers) was explicitly rejected because it would silently report
 * "no drift" on lines that genuinely drifted before the snapshot column
 * existed.
 */
export function isDriftedDegraded(
  storedUnitPrice: number,
  storedQuantity: number,
  currentTiers: ComputedPartPricingTier[],
): boolean {
  const resolved = resolveTier(currentTiers, storedQuantity);
  if (!resolved) return false;
  const EPSILON = 0.005;
  return Math.abs(resolved.unit_price - storedUnitPrice) > EPSILON;
}
