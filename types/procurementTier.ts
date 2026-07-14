/**
 * Procurement tier sheet for bought parts — `part_procurement_tiers` table.
 *
 * One **part-level** tier sheet per part: each row is a
 * (min_quantity, cost_per_unit) point. Vendor is NOT a dimension of the sheet —
 * it lives on the part as `parts.preferred_vendor_id`, a supplier ("who we PO
 * from") label that never gates cost.
 *
 * Resolved at read time via `get_procurement_cost(part_id, qty)`, which picks
 * the cheapest non-expired tier where `min_quantity <= qty`. Returns zero rows
 * when nothing matches (no fallback to a parts column); `compute_part_cost_at_qty`
 * additionally floors to the lowest tier when qty is below every break.
 */
export interface ProcurementTier {
  id: string;
  part_id: string;
  min_quantity: number;
  cost_per_unit: number;
  quoted_at: string | null;
  expires_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Form-shape payload used by the Add / Edit tier modals. Numeric fields are
 * carried as strings (the inputs are MUI `TextField type="number"`) and
 * parsed before insert/update.
 */
export interface ProcurementTierFormData {
  part_id: string;
  min_quantity: string;
  cost_per_unit: string;
  quoted_at: string | null;
  expires_at: string | null;
  notes: string;
}

export const EMPTY_PROCUREMENT_TIER_FORM: ProcurementTierFormData = {
  part_id: '',
  min_quantity: '',
  cost_per_unit: '',
  quoted_at: null,
  expires_at: null,
  notes: '',
};

export function procurementTierToFormData(
  tier: ProcurementTier,
): ProcurementTierFormData {
  return {
    part_id: tier.part_id,
    min_quantity: String(tier.min_quantity),
    cost_per_unit: String(tier.cost_per_unit),
    quoted_at: tier.quoted_at,
    expires_at: tier.expires_at,
    notes: tier.notes ?? '',
  };
}

/**
 * Return shape of the `get_procurement_cost(p_part_id, p_qty)` RPC.
 *
 * - The RPC returns at most one row (`source='tier'`) when a live, non-expired
 *   tier matched. `tier_id` identifies which tier won. `vendor_id` is the
 *   part's preferred-vendor **label** (display only) — cost is part-level and
 *   vendor-independent.
 * - When nothing matches, the RPC returns zero rows. The TS wrapper normalises
 *   that to a `null` result; callers must handle the null.
 */
export interface ProcurementCostResult {
  unit_cost: number | null;
  vendor_id: string | null;
  tier_id: string | null;
  source: 'tier';
}
