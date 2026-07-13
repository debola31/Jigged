import { getTypedSupabase as getSupabase } from '@/lib/supabase';
import { friendlyErrorMessage } from '@/lib/supabaseErrors';
import type {
  PartPricingTier,
  PartPricingTierInput,
  ComputedPartPricingTier,
} from '@/types/partPricing';
import {
  calculateRoutingCost,
  calculateTierPricing,
} from '@/utils/routingCostCalculation';
import { getComputedPartCost } from '@/utils/partsAccess';

/**
 * Get all pricing tiers for a part (raw DB shape), ordered by sequence.
 * Callers that need a `unit_price` use `getTiersWithComputedPrices`.
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
 * Single source of truth for tier pricing: load the tier rows (markup % is
 * the user-controlled source of truth), compute the current base cost — from
 * the part's live routing + BOM for made parts, or from its procurement tiers
 * (`compute_part_cost_at_qty`) for bought parts that have no routing — then
 * derive `unit_price = base × (1 + markup/100)` per tier qty. Both part kinds
 * price through this one resolver so no read path can drift.
 *
 * Use this anywhere a user sees a tier price (quote form chip, PDF, the
 * resolved tier picked for a quote line item). The Part detail page already
 * computes the same way via `calculateTierPricing`; this helper unifies the
 * other read paths so they can't drift.
 *
 * When materials are incomplete (a BOM child has no priced procurement tier)
 * `calculateTierPricing` returns `unit_price: null` — the resolver then
 * skips that tier, and the quote form surfaces "no pricing tiers yet" so
 * the user fixes the underlying gap rather than getting a misleading price.
 */
export async function getTiersWithComputedPrices(
  partId: string,
): Promise<ComputedPartPricingTier[]> {
  const tiers = await getTiersForPart(partId);
  if (tiers.length === 0) return [];

  // Compute each tier's base cost AT THAT TIER'S OWN QUANTITY (not a single
  // qty=1 breakdown reused across tiers). This matters once a BOM line uses
  // whole-unit (ceiling) consumption or a batch-pinned child: material cost is
  // then a step function of qty, so a qty=1 base would misprice every tier
  // (issue: a yield part read at qty=1 ceilings to 1 whole strip → ~20× the
  // real per-part material cost). Made parts go through the routing+BOM
  // breakdown; parts with no routing/BOM (bought) fall back to the
  // procurement-cost RPC. Both are the same cost-plus model — base × (1 +
  // markup/100) — and a null markup or unresolvable base yields unit_price =
  // null so the "no usable tier" check still fires.
  //
  // NOTE: the actual quote LINE price is recomputed at the real order qty in
  // quoteLineItemsAccess (Option A) — this per-tier list is the preview/PDF
  // ladder and the source of the resolved markup %, so it must be
  // self-consistent per tier, but between-breakpoint orders are priced by the
  // line path, not by reading a breakpoint here.
  return Promise.all(
    tiers.map(async (t) => {
      const breakdown = await calculateRoutingCost(partId, t.quantity).catch(() => null);
      if (breakdown) {
        const { unitPrice } = calculateTierPricing(breakdown, t.quantity, t.markup_percent);
        return { ...t, unit_price: unitPrice };
      }
      const rawBase = await getComputedPartCost(partId, t.quantity).catch(() => null);
      if (rawBase === null || t.markup_percent == null || Number.isNaN(t.markup_percent)) {
        return { ...t, unit_price: null };
      }
      const baseCostPerUnit = Math.round(rawBase * 100) / 100;
      const unitPrice = Math.round(baseCostPerUnit * (1 + t.markup_percent / 100) * 100) / 100;
      return { ...t, unit_price: unitPrice };
    }),
  );
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
 *
 * Persists tier metadata only: `quantity` (qty break) and `markup_percent`
 * (the user-controlled source of truth). The DB column `unit_price` was
 * dropped — every read recomputes it live via `getTiersWithComputedPrices`
 * so the stored cache can't drift from the underlying routing + BOM.
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
    if (tier.id) {
      const { error } = await supabase
        .from('part_pricing_tiers')
        .update({
          sequence: tier.sequence,
          quantity: tier.quantity,
          markup_percent: tier.markup_percent,
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
  if (error) {
    console.error('Error deleting pricing tier:', error);
    throw new Error(
      friendlyErrorMessage(error, {
        entity: 'pricing tier',
        fallback: 'Failed to delete pricing tier.',
      }),
    );
  }
}

/**
 * Returns the set of part ids in `companyId` that the quote form would
 * accept without warning — same semantic as QuoteForm.hasUsableTier: at
 * least one tier whose live cost via `compute_part_cost_at_qty` resolves
 * to a non-null number. Backed by the `get_priceable_part_ids` RPC so the
 * Parts list can show the "priced" vs "no pricing" state in one round-trip
 * instead of running the routing/BOM walk per row in the browser.
 */
export async function getPriceablePartIds(companyId: string): Promise<Set<string>> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('get_priceable_part_ids', {
    p_company_id: companyId,
  });
  if (error) {
    console.error('Error fetching priceable part ids:', error);
    throw error;
  }
  return new Set((data ?? []) as string[]);
}
