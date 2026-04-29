/**
 * Part pricing tier — the "estimate" layer. Lives on the Part (not the Quote).
 * Each tier represents a quantity break-point with its own markup/price.
 * Setup cost amortizes into baseCostPerUnit at the tier's quantity.
 */
export interface PartPricingTier {
  id: string;
  part_id: string;
  company_id: string;
  sequence: number;
  quantity: number;
  base_cost_per_unit: number | null;
  markup_percent: number | null;
  unit_price: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * Input shape for creating/updating a tier. `id` is present for existing
 * tiers (identifies which row to update) and absent for new ones.
 *
 * `markup_percent` is the source of truth on a part tier. `unit_price` is
 * always derived as `base_cost × (1 + markup/100)`. Typing a unit price
 * directly back-calculates and stores the markup; there is no lock concept.
 */
export interface PartPricingTierInput {
  id?: string;
  sequence: number;
  quantity: number;
  markup_percent: number | null;
}
