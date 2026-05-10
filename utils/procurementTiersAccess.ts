import { getSupabase } from '@/lib/supabase';
import type {
  ProcurementCostResult,
  ProcurementTier,
  ProcurementTierFormData,
  ProcurementTierGroup,
} from '@/types/procurementTier';

const TIER_COLUMNS =
  'id, part_id, vendor_id, min_quantity, cost_per_unit, quoted_at, expires_at, notes, created_at, updated_at';

/** Threshold (days) for the "expiring soon" badge in the procurement panel. */
const EXPIRING_SOON_DAYS = 30;

const INTERNAL_ESTIMATE_LABEL = 'Internal estimate';

/**
 * Coerce numeric columns coming back from PostgREST. Supabase serializes
 * Postgres `numeric` as JSON strings to preserve precision; our app code
 * works with plain numbers.
 */
function normalizeTierRow(row: Record<string, unknown>): ProcurementTier {
  return {
    id: row.id as string,
    part_id: row.part_id as string,
    vendor_id: (row.vendor_id as string | null) ?? null,
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
 * Pick the most recent (latest) non-null date string from a list.
 * Date strings are ISO yyyy-mm-dd so a lexical max works.
 */
function maxDate(dates: (string | null)[]): string | null {
  let best: string | null = null;
  for (const d of dates) {
    if (!d) continue;
    if (best === null || d > best) best = d;
  }
  return best;
}

/**
 * Pick the earliest (smallest) non-null date string from a list.
 * Date strings are ISO yyyy-mm-dd so a lexical min works.
 */
function minDate(dates: (string | null)[]): string | null {
  let best: string | null = null;
  for (const d of dates) {
    if (!d) continue;
    if (best === null || d < best) best = d;
  }
  return best;
}

function todayIso(): string {
  // Use local-timezone date so that "expires today" matches the user's day.
  // Procurement quotes are date-only — no timezone semantics in the DB.
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(fromIso + 'T00:00:00');
  const to = Date.parse(toIso + 'T00:00:00');
  if (!Number.isFinite(from) || !Number.isFinite(to)) return Number.POSITIVE_INFINITY;
  return Math.round((to - from) / (1000 * 60 * 60 * 24));
}

/**
 * Group rows by vendor_id (null bucketed as "Internal estimate"), order each
 * group by min_quantity ASC, and derive the group-level quoted_at /
 * expires_at / expiry-flag fields the UI badge reads.
 *
 * Returned groups are ordered:
 *   1. real vendors (alphabetized by name) first
 *   2. then "Internal estimate" (vendor_id=null), if any
 * so the user sees committed vendor sheets above sketches.
 */
function groupTiersByVendor(
  tiers: ProcurementTier[],
  vendorNames: Map<string, string>,
): ProcurementTierGroup[] {
  const today = todayIso();
  const buckets = new Map<string, ProcurementTier[]>();
  // Keyed by vendor_id (or '__internal__' for null) so the Map preserves
  // each distinct vendor.
  for (const tier of tiers) {
    const key = tier.vendor_id ?? '__internal__';
    const list = buckets.get(key);
    if (list) list.push(tier);
    else buckets.set(key, [tier]);
  }

  const groups: ProcurementTierGroup[] = [];
  for (const [key, rows] of buckets.entries()) {
    rows.sort((a, b) => a.min_quantity - b.min_quantity);
    const vendor_id = key === '__internal__' ? null : key;
    const vendor_name =
      vendor_id === null
        ? INTERNAL_ESTIMATE_LABEL
        : vendorNames.get(vendor_id) ?? '(unknown vendor)';
    const quoted_at = maxDate(rows.map((r) => r.quoted_at));
    const expires_at = minDate(rows.map((r) => r.expires_at));
    let is_expiring = false;
    let is_expired = false;
    if (expires_at) {
      const delta = daysBetween(today, expires_at);
      is_expired = delta < 0;
      is_expiring = !is_expired && delta <= EXPIRING_SOON_DAYS;
    }
    groups.push({
      vendor_id,
      vendor_name,
      quoted_at,
      expires_at,
      is_expiring,
      is_expired,
      tiers: rows,
    });
  }

  groups.sort((a, b) => {
    // Real vendors first, then internal estimate.
    if (a.vendor_id === null && b.vendor_id !== null) return 1;
    if (a.vendor_id !== null && b.vendor_id === null) return -1;
    return a.vendor_name.localeCompare(b.vendor_name);
  });

  return groups;
}

/**
 * Get the procurement tier groups for a part.
 *
 * Single round trip: fetches the tier rows + their joined vendor name in one
 * query, then groups in memory. Tiers without a vendor end up in the
 * "Internal estimate" group.
 */
export async function getTiersForPart(
  partId: string,
): Promise<ProcurementTierGroup[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('part_procurement_tiers')
    .select(`${TIER_COLUMNS}, vendor:vendors(id, name)`)
    .eq('part_id', partId)
    .order('min_quantity', { ascending: true });

  if (error) {
    console.error('Error fetching procurement tiers:', error);
    throw error;
  }

  type RawRow = Record<string, unknown> & {
    vendor:
      | { id: string; name: string }
      | Array<{ id: string; name: string }>
      | null;
  };

  const rawRows = (data ?? []) as RawRow[];
  const tiers = rawRows.map(normalizeTierRow);

  // Build the vendor-name map from the joined rows so we don't issue a
  // second roundtrip.
  const vendorNames = new Map<string, string>();
  for (const row of rawRows) {
    const v = Array.isArray(row.vendor) ? row.vendor[0] : row.vendor;
    if (v?.id) vendorNames.set(v.id, v.name);
  }

  return groupTiersByVendor(tiers, vendorNames);
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
 * Surfaces the duplicate-break (23505) error as a friendly message because
 * the unique index on (part_id, vendor_id, min_quantity) is the most likely
 * thing to trip a user adding multiple tiers in quick succession.
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
      vendor_id: formData.vendor_id,
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
        'A tier already exists at this break for this vendor. Edit the existing tier instead.',
      );
    }
    throw error;
  }
  return normalizeTierRow(data as Record<string, unknown>);
}

/**
 * Update an existing procurement tier row.
 *
 * The tier id is the source of truth; (part_id, vendor_id, min_quantity)
 * may all change, in which case the unique index can still trip — surface
 * the same friendly message.
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
      vendor_id: formData.vendor_id,
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
        'A tier already exists at this break for this vendor. Edit the existing tier instead.',
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
    throw error;
  }
}

/**
 * Resolve the per-unit procurement cost of a part for a target quantity.
 *
 * Wraps the `get_procurement_cost(p_part_id, p_qty)` SQL function. Per the
 * RPC's documented contract this works for ANY part (bought-with-tiers,
 * bought-without-tiers, made-snapshot) — callers MUST NOT add a "is this a
 * bought part" guard before invoking.
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

  // The SQL function returns a TABLE with one row; PostgREST hands us back
  // an array. Some Supabase typings flatten single-row TABLE results to an
  // object — handle both shapes defensively.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    return { unit_cost: null, vendor_id: null, tier_id: null, source: 'fallback' };
  }
  const r = row as Record<string, unknown>;
  return {
    unit_cost: r.unit_cost == null ? null : Number(r.unit_cost),
    vendor_id: (r.vendor_id as string | null) ?? null,
    tier_id: (r.tier_id as string | null) ?? null,
    source: (r.source as 'tier' | 'fallback') ?? 'fallback',
  };
}
