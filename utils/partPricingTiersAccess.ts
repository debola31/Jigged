import { getSupabase } from '@/lib/supabase';
import type { PartPricingTier, PartPricingTierInput } from '@/types/partPricing';
import { calculateRoutingCost, calculateTierPricing } from '@/utils/routingCostCalculation';

/**
 * Get all pricing tiers for a part, ordered by sequence.
 */
export async function getTiersForPart(partId: string): Promise<PartPricingTier[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('part_pricing_tiers')
    .select('*')
    .eq('part_id', partId)
    .order('sequence', { ascending: true });

  if (error) {
    console.error('Error fetching part pricing tiers:', error);
    throw error;
  }
  return (data || []) as PartPricingTier[];
}

/**
 * Get a single tier by id.
 */
export async function getTier(tierId: string): Promise<PartPricingTier | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('part_pricing_tiers')
    .select('*')
    .eq('id', tierId)
    .maybeSingle();

  if (error) {
    console.error('Error fetching tier:', error);
    throw error;
  }
  return data as PartPricingTier | null;
}

/**
 * Replace the full set of tiers for a part (upsert + delete diff).
 * Markup % is the source of truth: unit_price is always recomputed from
 * `base_cost × (1 + markup/100)` against the current routing. There is no
 * lock concept — typing a unit price in the UI back-calculates markup before
 * calling this function, so the markup field captured here always governs.
 *
 * Also updates `parts.markup_rate_id`. `opts.rateId` should be set when the
 * caller is applying a markup rate (the rate's id), and omitted/null when the
 * caller is committing a manual edit — manual edits flip the part to "Custom"
 * (rate_id = null). Centralising this in one access function guarantees the
 * invariant that tier writes and rate-link state stay in sync no matter which
 * UI path triggered the save.
 */
export async function replaceTiersForPart(
  companyId: string,
  partId: string,
  tiers: PartPricingTierInput[],
  opts: { rateId?: string | null } = {},
): Promise<PartPricingTier[]> {
  const supabase = getSupabase();

  const breakdown = await calculateRoutingCost(partId);

  // Fetch existing tiers so we can diff for deletes.
  const { data: existing, error: existingErr } = await supabase
    .from('part_pricing_tiers')
    .select('id, sequence')
    .eq('part_id', partId);
  if (existingErr) throw existingErr;
  const existingIds = new Set(((existing || []) as Array<{ id: string }>).map((r) => r.id));

  // Delete the "no longer present" rows BEFORE the insert/update pass. This
  // frees up the (part_id, sequence) unique-constraint slots so a caller that
  // passes a fresh set of inputs without ids (e.g., applying a markup rate
  // that replaces all current tiers) doesn't 409 against the rows it's about
  // to obsolete.
  const keepIds = new Set(
    tiers.map((t) => t.id).filter((id): id is string => Boolean(id)),
  );
  const toDelete = [...existingIds].filter((id) => !keepIds.has(id));
  if (toDelete.length > 0) {
    const { error } = await supabase
      .from('part_pricing_tiers')
      .delete()
      .in('id', toDelete);
    if (error) throw error;
  }

  for (const tier of tiers) {
    const { baseCostPerUnit, unitPrice } = breakdown
      ? calculateTierPricing(breakdown, tier.quantity, tier.markup_percent)
      : { baseCostPerUnit: 0, unitPrice: null };

    if (tier.id) {
      const { error } = await supabase
        .from('part_pricing_tiers')
        .update({
          sequence: tier.sequence,
          quantity: tier.quantity,
          base_cost_per_unit: baseCostPerUnit,
          markup_percent: tier.markup_percent,
          unit_price: unitPrice,
        })
        .eq('id', tier.id);
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from('part_pricing_tiers')
        .insert({
          part_id: partId,
          company_id: companyId,
          sequence: tier.sequence,
          quantity: tier.quantity,
          base_cost_per_unit: baseCostPerUnit,
          markup_percent: tier.markup_percent,
          unit_price: unitPrice,
        });
      if (error) throw error;
    }
  }

  // Sync the part's rate link with the caller's intent. A rate-apply path
  // passes the rate id; a manual-edit path omits it and the part flips to
  // Custom (null). Done last so the FK update reflects a successful tier write.
  const nextRateId = opts.rateId ?? null;
  const { error: rateLinkErr } = await supabase
    .from('parts')
    .update({ markup_rate_id: nextRateId })
    .eq('id', partId);
  if (rateLinkErr) throw rateLinkErr;

  return getTiersForPart(partId);
}

/**
 * Delete a single tier.
 */
export async function deleteTier(tierId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from('part_pricing_tiers').delete().eq('id', tierId);
  if (error) throw error;
}
