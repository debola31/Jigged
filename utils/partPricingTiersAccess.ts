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
 */
export async function replaceTiersForPart(
  companyId: string,
  partId: string,
  tiers: PartPricingTierInput[],
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
  const keepIds = new Set<string>();

  for (const tier of tiers) {
    const { baseCostPerUnit, unitPrice } = breakdown
      ? calculateTierPricing(breakdown, tier.quantity, tier.markup_percent)
      : { baseCostPerUnit: 0, unitPrice: null };

    if (tier.id) {
      keepIds.add(tier.id);
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
      const { data, error } = await supabase
        .from('part_pricing_tiers')
        .insert({
          part_id: partId,
          company_id: companyId,
          sequence: tier.sequence,
          quantity: tier.quantity,
          base_cost_per_unit: baseCostPerUnit,
          markup_percent: tier.markup_percent,
          unit_price: unitPrice,
        })
        .select('id')
        .single();
      if (error) throw error;
      if (data?.id) keepIds.add(String(data.id));
    }
  }

  const toDelete = [...existingIds].filter((id) => !keepIds.has(id));
  if (toDelete.length > 0) {
    const { error } = await supabase
      .from('part_pricing_tiers')
      .delete()
      .in('id', toDelete);
    if (error) throw error;
  }

  return getTiersForPart(partId);
}

/**
 * Copy pricing tiers from one part to another. Source qty + markup are copied
 * verbatim; unit_price and base_cost_per_unit are recomputed against the
 * target part's own routing so the prices reflect target-part economics.
 */
export async function copyTiersFromPart(
  companyId: string,
  sourcePartId: string,
  targetPartId: string,
): Promise<PartPricingTier[]> {
  const sourceTiers = await getTiersForPart(sourcePartId);
  if (sourceTiers.length === 0) return getTiersForPart(targetPartId);

  // Existing target tiers are replaced — copy semantics, not merge.
  const inputs: PartPricingTierInput[] = sourceTiers.map((t, i) => ({
    sequence: (i + 1) * 10,
    quantity: t.quantity,
    markup_percent: t.markup_percent,
  }));

  return replaceTiersForPart(companyId, targetPartId, inputs);
}

/**
 * Delete a single tier.
 */
export async function deleteTier(tierId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from('part_pricing_tiers').delete().eq('id', tierId);
  if (error) throw error;
}
