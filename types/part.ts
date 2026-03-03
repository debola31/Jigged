/**
 * Pricing tier for volume-based pricing
 */
export interface PricingTier {
  qty: number;
  price: number;
}

/**
 * Part record from database
 */
export interface Part {
  id: string;
  company_id: string;
  part_number: string;
  description: string | null;
  pricing: PricingTier[];
  created_at: string;
  updated_at: string;
  // Optional relation counts (populated by getPartWithRelations)
  quotes_count?: number;
  jobs_count?: number;
  // Optional routing info (populated by getPartWithRelations)
  routing?: {
    id: string;
    nodes_count: number;
    total_run_time_per_unit: number | null;
  } | null;
}

/**
 * Form data for creating/editing parts
 */
export interface PartFormData {
  part_number: string;
  description: string;
  pricing: PricingTier[];
}

/**
 * Empty form defaults for NEW parts only
 */
export const EMPTY_PART_FORM: PartFormData = {
  part_number: '',
  description: '',
  pricing: [{ qty: 1, price: 0 }],
};

/**
 * Sort pricing tiers by quantity ascending
 */
export function sortPricingTiers(tiers: PricingTier[]): PricingTier[] {
  return [...tiers].sort((a, b) => a.qty - b.qty);
}

/**
 * Convert Part to PartFormData for edit forms.
 * Sorts pricing tiers on load but preserves existing structure.
 */
export function partToFormData(part: Part): PartFormData {
  return {
    part_number: part.part_number,
    description: part.description || '',
    pricing: part.pricing.length > 0 ? sortPricingTiers(part.pricing) : [{ qty: 1, price: 0 }],
  };
}

/**
 * Get the applicable unit price for a given order quantity.
 * Finds the highest qty tier that is <= the order quantity.
 *
 * @example
 * const pricing = [{ qty: 1, price: 100 }, { qty: 10, price: 90 }, { qty: 50, price: 80 }];
 * getUnitPrice(pricing, 25) // Returns 90 (qty 10 tier applies)
 * getUnitPrice(pricing, 5)  // Returns 100 (qty 1 tier applies)
 * getUnitPrice(pricing, 50) // Returns 80 (qty 50 tier applies)
 */
export function getUnitPrice(pricing: PricingTier[], orderQty: number): number | null {
  if (!pricing || pricing.length === 0) return null;

  const sorted = sortPricingTiers(pricing);
  // Find highest tier where qty <= orderQty
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].qty <= orderQty) {
      return sorted[i].price;
    }
  }
  // If no tier applies (orderQty < smallest tier), return first tier price
  return sorted[0]?.price ?? null;
}

/**
 * Validate pricing tiers for form submission.
 * Returns errors (blocking) and warnings (non-blocking).
 */
export function validatePricingTiers(tiers: PricingTier[]): {
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Empty is valid (cost-plus pricing)
  if (tiers.length === 0) {
    return { errors, warnings };
  }

  // Check for qty=1 tier (warning only, not error)
  if (!tiers.some((t) => t.qty === 1)) {
    warnings.push('No quantity 1 tier defined - base price will be undefined');
  }

  // Validate each tier
  const qtys = new Set<number>();
  tiers.forEach((tier, i) => {
    if (!Number.isInteger(tier.qty) || tier.qty < 1) {
      errors.push(`Tier ${i + 1}: Quantity must be a positive integer`);
    }
    if (tier.price < 0) {
      errors.push(`Tier ${i + 1}: Price cannot be negative`);
    }
    if (qtys.has(tier.qty)) {
      errors.push(`Tier ${i + 1}: Duplicate quantity ${tier.qty}`);
    }
    qtys.add(tier.qty);
  });

  return { errors, warnings };
}
