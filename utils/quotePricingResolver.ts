import type { PartPricingTier } from '@/types/partPricing';

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
  tiers: PartPricingTier[],
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
