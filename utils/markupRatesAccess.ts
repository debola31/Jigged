import { getSupabase } from '@/lib/supabase';
import type {
  MarkupRate,
  MarkupRateFormData,
  MarkupRateBreakpoint,
} from '@/types/markupRates';
import type { PartPricingTierInput } from '@/types/partPricing';
import { replaceTiersForPart } from '@/utils/partPricingTiersAccess';

/**
 * Fetch all markup rates for a company. Sorted by name ascending.
 *
 * Built-in rates are NOT included — callers that need them mixed with DB rates
 * should concatenate `BUILT_IN_MARKUP_RATES` themselves so it's explicit at
 * the call site.
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
    description: formData.description.trim() || null,
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

export async function updateMarkupRate(
  rateId: string,
  formData: MarkupRateFormData,
): Promise<MarkupRate> {
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
    description: formData.description.trim() || null,
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

  return data as MarkupRate;
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

  const tiers: PartPricingTierInput[] = [...defaultRate.breakpoints]
    .sort((a, b) => a.qty - b.qty)
    .map((bp, i) => ({
      sequence: (i + 1) * 10,
      quantity: bp.qty,
      markup_percent: bp.markup_percent,
    }));

  await replaceTiersForPart(companyId, partId, tiers);
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
