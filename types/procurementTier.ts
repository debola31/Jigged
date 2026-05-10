/**
 * Procurement tier sheets for bought parts — `part_procurement_tiers` table.
 *
 * Each row is one (vendor, min_quantity, cost_per_unit) point on a vendor's
 * tier sheet for a specific part. `vendor_id` may be NULL to represent an
 * "internal estimate" — a sketch cost added before sourcing is finalized.
 *
 * Tier ordering within a vendor's sheet is derived from `min_quantity`
 * ascending (no separate `sequence` column on the table — see the migration
 * header).
 *
 * Resolved at read time via the `get_procurement_cost(part_id, qty)` RPC,
 * which picks the cheapest non-expired tier where `min_quantity <= qty`
 * across all vendors and falls back to `parts.cost_per_unit` when no tier
 * matches.
 */
export interface ProcurementTier {
  id: string;
  part_id: string;
  vendor_id: string | null;
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
  vendor_id: string | null;
  min_quantity: string;
  cost_per_unit: string;
  quoted_at: string | null;
  expires_at: string | null;
  notes: string;
}

export const EMPTY_PROCUREMENT_TIER_FORM: ProcurementTierFormData = {
  part_id: '',
  vendor_id: null,
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
    vendor_id: tier.vendor_id,
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
 * - `source='tier'` — a live, non-expired tier matched. `vendor_id` and
 *   `tier_id` identify which tier won.
 * - `source='fallback'` — no tier matched (or the part has no tiers / is a
 *   made part). `unit_cost` is `parts.cost_per_unit` and `vendor_id` /
 *   `tier_id` are both NULL.
 *
 * Per the RPC's documented contract, callers MUST NOT add a "is this a
 * bought part" guard before invoking — the function handles all part kinds.
 */
export interface ProcurementCostResult {
  unit_cost: number | null;
  vendor_id: string | null;
  tier_id: string | null;
  source: 'tier' | 'fallback';
}

/**
 * UI-side grouping. The access layer groups raw `part_procurement_tiers`
 * rows by `vendor_id` (NULL grouped under "Internal estimate") and presents
 * each group as a single "tier sheet" the panel renders.
 *
 * `quoted_at` / `expires_at` are derived from the rows in the group:
 * - `quoted_at` is the most recent non-null quoted_at across the group's
 *   tiers.
 * - `expires_at` is the earliest non-null expires_at across the group's
 *   tiers (so the badge shows the closest expiry).
 * - `is_expiring` / `is_expired` are computed from `expires_at` + today.
 *
 * Tiers within the group are ordered by `min_quantity ASC`.
 */
export interface ProcurementTierGroup {
  vendor_id: string | null;
  vendor_name: string;
  quoted_at: string | null;
  expires_at: string | null;
  is_expiring: boolean;
  is_expired: boolean;
  tiers: ProcurementTier[];
}
