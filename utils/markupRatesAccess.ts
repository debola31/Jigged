import { getSupabase } from '@/lib/supabase';
import type {
  MarkupRate,
  MarkupRateFormData,
  MarkupRateBreakpoint,
} from '@/types/markupRates';
import type { PartPricingTierInput } from '@/types/partPricing';
import { replaceTiersForPart } from '@/utils/partPricingTiersAccess';

/**
 * Fetch all markup rates for a company, sorted by name ascending. The
 * company's seeded "Default" / "Volume tiers" / "Premium small batch" rates
 * are real DB rows so they're included like any other.
 */
export async function getAllMarkupRates(companyId: string): Promise<MarkupRate[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('markup_rates')
    .select('*')
    .eq('company_id', companyId)
    .order('name', { ascending: true });

  if (error) {
    console.error('Error fetching markup rates:', error);
    throw error;
  }

  return (data || []) as MarkupRate[];
}

export async function getMarkupRate(rateId: string): Promise<MarkupRate | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('markup_rates')
    .select('*')
    .eq('id', rateId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching markup rate:', error);
    throw error;
  }

  return (data as MarkupRate) ?? null;
}

export async function createMarkupRate(
  companyId: string,
  formData: MarkupRateFormData,
): Promise<MarkupRate> {
  const supabase = getSupabase();

  // If this rate is being created as the default, demote any existing default
  // first so the partial unique index doesn't reject the insert.
  if (formData.is_default) {
    await clearOtherDefaults(companyId, null);
  }

  const payload = {
    company_id: companyId,
    name: formData.name.trim(),
    breakpoints: normalizeBreakpoints(formData.breakpoints),
    is_default: formData.is_default,
  };

  const { data, error } = await supabase
    .from('markup_rates')
    .insert(payload)
    .select('*')
    .single();

  if (error) {
    console.error('Error creating markup rate:', error);
    throw error;
  }

  return data as MarkupRate;
}

/**
 * Result of an update that cascaded to linked parts. `partsUpdated` is the
 * count of parts whose tiers were re-snapshotted from the new breakpoints;
 * `partsFailed` lists per-part errors so the edit UI can surface them instead
 * of swallowing them silently.
 */
export interface MarkupRateUpdateResult {
  rate: MarkupRate;
  partsUpdated: number;
  partsFailed: Array<{ partId: string; error: string }>;
}

export async function updateMarkupRate(
  rateId: string,
  formData: MarkupRateFormData,
): Promise<MarkupRateUpdateResult> {
  const supabase = getSupabase();

  // Promoting this rate to default? Demote any existing default in the same
  // company first. We need company_id for the cleanup query so look it up.
  if (formData.is_default) {
    const { data: existing, error: lookupErr } = await supabase
      .from('markup_rates')
      .select('company_id')
      .eq('id', rateId)
      .single();
    if (lookupErr) {
      console.error('Error looking up markup rate for default-update:', lookupErr);
      throw lookupErr;
    }
    await clearOtherDefaults(existing.company_id, rateId);
  }

  const payload = {
    name: formData.name.trim(),
    breakpoints: normalizeBreakpoints(formData.breakpoints),
    is_default: formData.is_default,
  };

  const { data, error } = await supabase
    .from('markup_rates')
    .update(payload)
    .eq('id', rateId)
    .select('*')
    .single();

  if (error) {
    console.error('Error updating markup rate:', error);
    throw error;
  }

  const rate = data as MarkupRate;

  // Cascade: every part linked to this rate gets its tiers re-snapshotted from
  // the new breakpoints. Per-part unit_price recomputes against each part's
  // own routing inside replaceTiersForPart.
  const cascade = await cascadeRateUpdateToParts(rate.company_id, rate.id);

  return { rate, partsUpdated: cascade.updated, partsFailed: cascade.failed };
}

/**
 * Set is_default=false on every rate in the company except `keepRateId`.
 * Called before promoting a rate to default so the partial unique index
 * `markup_rates_one_default_per_company` doesn't reject the write.
 *
 * Pass `keepRateId = null` when creating a new default rate (no existing row
 * to preserve). Otherwise pass the rate id being promoted.
 */
async function clearOtherDefaults(
  companyId: string,
  keepRateId: string | null,
): Promise<void> {
  const supabase = getSupabase();
  let query = supabase
    .from('markup_rates')
    .update({ is_default: false })
    .eq('company_id', companyId)
    .eq('is_default', true);
  if (keepRateId) query = query.neq('id', keepRateId);

  const { error } = await query;
  if (error) {
    console.error('Error clearing other defaults:', error);
    throw error;
  }
}

/**
 * Get the company's current default markup rate, or null if none is set.
 */
export async function getDefaultMarkupRate(companyId: string): Promise<MarkupRate | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('markup_rates')
    .select('*')
    .eq('company_id', companyId)
    .eq('is_default', true)
    .maybeSingle();

  if (error) {
    console.error('Error fetching default markup rate:', error);
    throw error;
  }
  return (data as MarkupRate) ?? null;
}

function breakpointsToTierInputs(rate: MarkupRate): PartPricingTierInput[] {
  return [...rate.breakpoints]
    .sort((a, b) => a.qty - b.qty)
    .map((bp, i) => ({
      sequence: (i + 1) * 10,
      quantity: bp.qty,
      markup_percent: bp.markup_percent,
    }));
}

/**
 * Apply a specific markup rate to a single part: replaces the part's tiers
 * with the rate's breakpoints and links the part to that rate. Used by the
 * per-part PartPricing UI and by the bulk-apply flow.
 */
export async function applyRateToPart(
  companyId: string,
  partId: string,
  rateId: string,
): Promise<void> {
  const rate = await getMarkupRate(rateId);
  if (!rate) {
    throw new Error(`Markup rate ${rateId} not found`);
  }
  const tiers = breakpointsToTierInputs(rate);
  await replaceTiersForPart(companyId, partId, tiers, { rateId: rate.id });
}

/**
 * Snapshot the company's default markup rate's breakpoints into a part's
 * pricing tiers. Used by createPart to give new parts an initial set of
 * tier rows without the user having to apply a rate manually.
 *
 * No-op if the company has no default rate set, or if the default has no
 * breakpoints. Errors are non-fatal — part creation must still succeed
 * even if the auto-apply step fails.
 */
export async function applyDefaultRateToPart(
  companyId: string,
  partId: string,
): Promise<void> {
  const defaultRate = await getDefaultMarkupRate(companyId);
  if (!defaultRate || defaultRate.breakpoints.length === 0) return;

  const tiers = breakpointsToTierInputs(defaultRate);
  await replaceTiersForPart(companyId, partId, tiers, { rateId: defaultRate.id });
}

/**
 * Re-apply a rate's current breakpoints to every part linked to it. Called
 * after a rate edit so the live-link semantic holds: editing a rate updates
 * every part whose markup_rate_id points to it. Sequential per-part to keep
 * recompute logic simple — pilot scale (hundreds of parts per company) is
 * fine; revisit if a single rate ends up linked to thousands of parts.
 */
export async function cascadeRateUpdateToParts(
  companyId: string,
  rateId: string,
): Promise<{ updated: number; failed: Array<{ partId: string; error: string }> }> {
  const supabase = getSupabase();

  const { data: linkedParts, error } = await supabase
    .from('parts')
    .select('id')
    .eq('company_id', companyId)
    .eq('markup_rate_id', rateId);

  if (error) {
    console.error('Error fetching parts linked to rate:', error);
    throw error;
  }

  const ids = ((linkedParts || []) as Array<{ id: string }>).map((r) => r.id);
  if (ids.length === 0) return { updated: 0, failed: [] };

  const failed: Array<{ partId: string; error: string }> = [];
  let updated = 0;
  for (const partId of ids) {
    try {
      await applyRateToPart(companyId, partId, rateId);
      updated += 1;
    } catch (err) {
      failed.push({
        partId,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }
  return { updated, failed };
}

/**
 * Apply a rate to many parts in one shot. Each part gets its tiers replaced
 * with the rate's breakpoints and its markup_rate_id set. Iterates
 * sequentially so a single failure doesn't abort the whole batch — failures
 * are collected and returned alongside the successes.
 */
export async function bulkApplyMarkupRate(
  companyId: string,
  partIds: string[],
  rateId: string,
): Promise<{ succeeded: string[]; failed: Array<{ partId: string; error: string }> }> {
  if (partIds.length === 0) return { succeeded: [], failed: [] };

  const rate = await getMarkupRate(rateId);
  if (!rate) {
    throw new Error(`Markup rate ${rateId} not found`);
  }

  const succeeded: string[] = [];
  const failed: Array<{ partId: string; error: string }> = [];
  for (const partId of partIds) {
    try {
      await applyRateToPart(companyId, partId, rateId);
      succeeded.push(partId);
    } catch (err) {
      failed.push({
        partId,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }
  return { succeeded, failed };
}

export async function deleteMarkupRate(rateId: string): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase.from('markup_rates').delete().eq('id', rateId);

  if (error) {
    console.error('Error deleting markup rate:', error);
    throw error;
  }
}

export async function bulkDeleteMarkupRates(rateIds: string[]): Promise<void> {
  if (rateIds.length === 0) return;
  const supabase = getSupabase();

  const { error } = await supabase.from('markup_rates').delete().in('id', rateIds);

  if (error) {
    console.error('Error bulk deleting markup rates:', error);
    throw error;
  }
}

/**
 * Check whether a rate name is already in use within the company. The optional
 * `excludeId` lets the edit form ignore the row being edited.
 */
export async function checkMarkupRateNameExists(
  companyId: string,
  name: string,
  excludeId?: string,
): Promise<boolean> {
  const supabase = getSupabase();

  let query = supabase
    .from('markup_rates')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .ilike('name', name.trim());

  if (excludeId) query = query.neq('id', excludeId);

  const { count, error } = await query;

  if (error) {
    console.error('Error checking markup rate name uniqueness:', error);
    throw error;
  }

  return (count ?? 0) > 0;
}

/**
 * Sort breakpoints by qty ascending and drop any with non-positive values.
 * Called before insert/update so the stored array always has a canonical shape.
 */
function normalizeBreakpoints(breakpoints: MarkupRateBreakpoint[]): MarkupRateBreakpoint[] {
  return breakpoints
    .filter((bp) => Number.isFinite(bp.qty) && bp.qty > 0 && Number.isFinite(bp.markup_percent))
    .map((bp) => ({ qty: Math.floor(bp.qty), markup_percent: Number(bp.markup_percent) }))
    .sort((a, b) => a.qty - b.qty);
}
