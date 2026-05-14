import { getSupabase } from '@/lib/supabase';
import type { PartPricingTier, PartPricingTierInput } from '@/types/partPricing';
import { getComputedPartCost } from '@/utils/partsAccess';

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
 * Also writes parts.markup_rate_id from `opts.rateId`. Two callers, two
 * intents:
 *   - applyRateToPart() passes the rate's id, so the part stays linked to
 *     that rate after the snapshot.
 *   - The PartPricing manual-edit path omits opts.rateId, which writes
 *     markup_rate_id = null and flips the part to "Custom". This guarantees
 *     that any tier write keeps the link state consistent with intent —
 *     impossible to accidentally retain a stale rate link after an edit.
 */
export async function replaceTiersForPart(
  companyId: string,
  partId: string,
  tiers: PartPricingTierInput[],
  opts: { rateId?: string | null } = {},
): Promise<PartPricingTier[]> {
  const supabase = getSupabase();

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
    // Compute the base cost live at this tier's quantity. The SQL function
    // amortizes setup over the passed qty and cascades through the BOM at
    // cumulative qty per sub-assembly.
    let unitPrice: number | null = null;
    try {
      const baseCost = await getComputedPartCost(partId, tier.quantity);
      if (baseCost !== null && tier.markup_percent !== null) {
        unitPrice = baseCost * (1 + tier.markup_percent / 100);
      }
    } catch {
      // compute_part_cost RAISES on missing labor rates / external pricing /
      // unit conversions. Store unit_price as null so the UI surfaces the
      // gap rather than persisting a wrong price.
      unitPrice = null;
    }

    if (tier.id) {
      const { error } = await supabase
        .from('part_pricing_tiers')
        .update({
          sequence: tier.sequence,
          quantity: tier.quantity,
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
          markup_percent: tier.markup_percent,
          unit_price: unitPrice,
        });
      if (error) throw error;
    }
  }

  // Sync the part's rate link with the caller's intent. A rate-apply path
  // passes the rate id; a manual-edit path omits it and the part flips to
  // Custom (null). Done last so the FK update reflects a successful tier
  // write — a partial failure leaves the link state matching the row state.
  const nextRateId = opts.rateId ?? null;
  const { error: rateLinkErr } = await supabase
    .from('parts')
    .update({ markup_rate_id: nextRateId })
    .eq('id', partId);
  if (rateLinkErr) throw rateLinkErr;

  return getTiersForPart(partId);
}

/**
 * Update only the part's markup_rate_id without touching its tiers. Used by
 * the PartPricing "Switch to Custom" affordance, which flips the part to
 * Custom while preserving the current tier values as the editable starting
 * point. Pass `null` to clear, or a rate id to link without re-snapshotting
 * (the apply-rate paths in markupRatesAccess already handle re-snapshotting).
 */
export async function setPartMarkupRate(
  partId: string,
  rateId: string | null,
): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('parts')
    .update({ markup_rate_id: rateId })
    .eq('id', partId);
  if (error) throw error;
}

/**
 * Delete a single tier.
 */
export async function deleteTier(tierId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from('part_pricing_tiers').delete().eq('id', tierId);
  if (error) throw error;
}
