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
 * Replace the full set of tiers for a part (upsert + delete diff by sequence).
 * Recomputes base_cost_per_unit and (when not overridden) unit_price from the
 * current routing so the stored values stay coherent.
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
    const { baseCostPerUnit, unitPrice: computedUnitPrice } = breakdown
      ? calculateTierPricing(breakdown, tier.quantity, tier.markup_percent)
      : { baseCostPerUnit: 0, unitPrice: null };

    const finalUnitPrice = tier.is_price_override ? tier.unit_price : computedUnitPrice;

    if (tier.id) {
      keepIds.add(tier.id);
      const { error } = await supabase
        .from('part_pricing_tiers')
        .update({
          sequence: tier.sequence,
          quantity: tier.quantity,
          base_cost_per_unit: baseCostPerUnit,
          markup_percent: tier.markup_percent,
          unit_price: finalUnitPrice,
          is_price_override: tier.is_price_override,
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
          unit_price: finalUnitPrice,
          is_price_override: tier.is_price_override,
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
 * Recalculate base_cost_per_unit for every tier on a part from the current
 * routing. When a tier is not price-overridden, also refresh unit_price from
 * the computed markup. Overridden tiers keep their unit_price.
 */
export async function recalculateTiers(partId: string): Promise<PartPricingTier[]> {
  const supabase = getSupabase();
  const tiers = await getTiersForPart(partId);
  if (tiers.length === 0) return [];

  const breakdown = await calculateRoutingCost(partId);
  if (!breakdown) return tiers;

  for (const tier of tiers) {
    const { baseCostPerUnit, unitPrice } = calculateTierPricing(
      breakdown,
      tier.quantity,
      tier.markup_percent,
    );
    const update: Record<string, number | null> = { base_cost_per_unit: baseCostPerUnit };
    if (!tier.is_price_override) {
      update.unit_price = unitPrice;
    }
    const { error } = await supabase
      .from('part_pricing_tiers')
      .update(update)
      .eq('id', tier.id);
    if (error) throw error;
  }

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
