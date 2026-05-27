/**
 * Part pricing tier — the "estimate" layer. Lives on the Part (not the Quote).
 * Each tier represents a quantity break-point with its own markup/price.
 *
 * `base_cost_per_unit` was dropped in migration 20260514 — the base is no
 * longer stored. Callers that need it call `getComputedPartCost(partId,
 * tier.quantity)` to compute live (which also cascades through the BOM at
 * the cascaded qty).
 *
 * `unit_price` is also no longer stored — the DB column was dropped. The
 * field stays on this interface because every consumer (quote form, PDF,
 * pricing resolver) reads it from `getTiersWithComputedPrices`, which fills
 * it live from the routing + BOM rollup. `getTiersForPart` shapes it as
 * `null` so the bought-parts read path (which skips the live compute) is
 * still type-safe.
 */
export interface PartPricingTier {
  id: string;
  part_id: string;
  company_id: string;
  sequence: number;
  quantity: number;
  markup_percent: number | null;
  unit_price: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * Input shape for creating/updating a tier. `id` is present for existing
 * tiers (identifies which row to update) and absent for new ones.
 *
 * `markup_percent` is the source of truth on a part tier. Unit prices are
 * always derived as `base_cost × (1 + markup/100)` at read time.
 */
export interface PartPricingTierInput {
  id?: string;
  sequence: number;
  quantity: number;
  markup_percent: number | null;
}
