import { getTypedSupabase as getSupabase } from '@/lib/supabase';
import { friendlyErrorMessage } from '@/lib/supabaseErrors';
import type {
  ProcurementCostResult,
  ProcurementTier,
  ProcurementTierFormData,
} from '@/types/procurementTier';

const TIER_COLUMNS =
  'id, part_id, min_quantity, cost_per_unit, quoted_at, expires_at, notes, created_at, updated_at';

/**
 * Coerce numeric columns coming back from PostgREST. Supabase serializes
 * Postgres `numeric` as JSON strings to preserve precision; our app code
 * works with plain numbers.
 */
function normalizeTierRow(row: Record<string, unknown>): ProcurementTier {
  return {
    id: row.id as string,
    part_id: row.part_id as string,
    min_quantity: Number(row.min_quantity),
    cost_per_unit: Number(row.cost_per_unit),
    quoted_at: (row.quoted_at as string | null) ?? null,
    expires_at: (row.expires_at as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

/**
 * Get the part-level procurement tier sheet, ordered by `min_quantity` ascending.
 *
 * One sheet per part — vendor is a supplier label on the part
 * (`parts.preferred_vendor_id`), not a dimension of the cost tiers.
 */
export async function getTiersForPart(
  partId: string,
): Promise<ProcurementTier[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('part_procurement_tiers')
    .select(TIER_COLUMNS)
    .eq('part_id', partId)
    .order('min_quantity', { ascending: true });

  if (error) {
    console.error('Error fetching procurement tiers:', error);
    throw error;
  }

  return (data ?? []).map((row) =>
    normalizeTierRow(row as Record<string, unknown>),
  );
}

function validateTierForm(formData: ProcurementTierFormData): {
  min_quantity: number;
  cost_per_unit: number;
} {
  if (!formData.part_id) {
    throw new Error('Part is required');
  }
  const min_quantity = parseFloat(formData.min_quantity);
  if (!Number.isFinite(min_quantity) || min_quantity <= 0) {
    throw new Error('Minimum quantity must be greater than zero');
  }
  const cost_per_unit = parseFloat(formData.cost_per_unit);
  if (!Number.isFinite(cost_per_unit) || cost_per_unit <= 0) {
    throw new Error('Cost per unit must be greater than zero');
  }
  if (
    formData.quoted_at &&
    formData.expires_at &&
    formData.quoted_at > formData.expires_at
  ) {
    throw new Error('Expiration date must be on or after the quote date');
  }
  return { min_quantity, cost_per_unit };
}

function isDuplicateBreakError(err: { code?: string } | null | undefined): boolean {
  return err?.code === '23505';
}

/**
 * Insert a single procurement tier row.
 *
 * Surfaces the duplicate-break (23505) error as a friendly message because the
 * unique index on (part_id, min_quantity) is the most likely thing to trip a
 * user adding multiple tiers in quick succession.
 */
export async function addTier(
  formData: ProcurementTierFormData,
): Promise<ProcurementTier> {
  const { min_quantity, cost_per_unit } = validateTierForm(formData);
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('part_procurement_tiers')
    .insert({
      part_id: formData.part_id,
      min_quantity,
      cost_per_unit,
      quoted_at: formData.quoted_at,
      expires_at: formData.expires_at,
      notes: formData.notes.trim() || null,
    })
    .select(TIER_COLUMNS)
    .single();

  if (error) {
    console.error('Error adding procurement tier:', error);
    if (isDuplicateBreakError(error)) {
      throw new Error(
        'A tier already exists at this break. Edit the existing tier instead.',
      );
    }
    throw error;
  }
  return normalizeTierRow(data as Record<string, unknown>);
}

/**
 * Update an existing procurement tier row.
 *
 * The tier id is the source of truth; (part_id, min_quantity) may change, in
 * which case the unique index can still trip — surface the same friendly
 * message.
 */
export async function updateTier(
  tierId: string,
  formData: ProcurementTierFormData,
): Promise<ProcurementTier> {
  const { min_quantity, cost_per_unit } = validateTierForm(formData);
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('part_procurement_tiers')
    .update({
      min_quantity,
      cost_per_unit,
      quoted_at: formData.quoted_at,
      expires_at: formData.expires_at,
      notes: formData.notes.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', tierId)
    .select(TIER_COLUMNS)
    .single();

  if (error) {
    console.error('Error updating procurement tier:', error);
    if (isDuplicateBreakError(error)) {
      throw new Error(
        'A tier already exists at this break. Edit the existing tier instead.',
      );
    }
    throw error;
  }
  return normalizeTierRow(data as Record<string, unknown>);
}

export async function deleteTier(tierId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('part_procurement_tiers')
    .delete()
    .eq('id', tierId);
  if (error) {
    console.error('Error deleting procurement tier:', error);
    throw new Error(
      friendlyErrorMessage(error, {
        entity: 'procurement tier',
        fallback: 'Failed to delete procurement tier.',
      }),
    );
  }
}

/**
 * Resolve the per-unit procurement cost of a part for a target quantity.
 *
 * Wraps the `get_procurement_cost(p_part_id, p_qty)` SQL function. Per the
 * RPC's documented contract this works for ANY part (bought-with-tiers,
 * bought-without-tiers, made-snapshot) — callers MUST NOT add a "is this a
 * bought part" guard before invoking. `vendor_id` in the result is the part's
 * preferred-vendor label (display only), not a tier dimension.
 */
export async function getProcurementCost(
  partId: string,
  qty: number,
): Promise<ProcurementCostResult> {
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error('Quantity must be greater than zero');
  }
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('get_procurement_cost', {
    p_part_id: partId,
    p_qty: qty,
  });

  if (error) {
    console.error('Error calling get_procurement_cost:', error);
    throw error;
  }

  // The SQL function returns at most one row (zero when no tier matches —
  // the parts.cost_per_unit fallback was removed in migration 20260514).
  // PostgREST hands us back an array; some Supabase typings flatten
  // single-row TABLE results to an object. Handle both shapes defensively;
  // empty / null means "no matching tier" and we normalise to a null cost.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    return { unit_cost: null, vendor_id: null, tier_id: null, source: 'tier' };
  }
  const r = row as Record<string, unknown>;
  return {
    unit_cost: r.unit_cost == null ? null : Number(r.unit_cost),
    vendor_id: (r.vendor_id as string | null) ?? null,
    tier_id: (r.tier_id as string | null) ?? null,
    source: 'tier',
  };
}
