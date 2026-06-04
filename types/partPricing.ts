/**
 * Part pricing tier — the "estimate" layer. Lives on the Part (not the Quote).
 * Each tier represents a quantity break-point with its own markup.
 *
 * `base_cost_per_unit` was dropped in migration 20260514 — the base is no
 * longer stored. `unit_price` was dropped at the same time. Both derive
 * live from the routing + BOM rollup. Callers that need a price use
 * `getTiersWithComputedPrices`, which returns the `ComputedPartPricingTier`
 * shape below.
 */
export interface PartPricingTier {
  id: string;
  part_id: string;
  company_id: string;
  sequence: number;
  quantity: number;
  markup_percent: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * `PartPricingTier` plus the live-computed `unit_price`. Returned by
 * `getTiersWithComputedPrices`. `unit_price` is null when the underlying
 * cost can't be resolved (bought part missing procurement tier, made part
 * with an unpriced BOM child, missing labor rate, etc.) — same condition
 * that drives the quote form's "no usable tier" warning.
 */
export interface ComputedPartPricingTier extends PartPricingTier {
  unit_price: number | null;
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
