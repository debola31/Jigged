import { getSupabase } from '@/lib/supabase';
import { toFriendlyError } from '@/lib/supabaseErrors';
import { friendlyErrorMessage } from '@/lib/supabaseErrors';
import type {
  PartPricingTier,
  PartPricingTierInput,
  ComputedPartPricingTier,
} from '@/types/partPricing';
import {
  getComputedPartChargeBase,
  getComputedPartCost,
  addPartPricingNote,
} from '@/utils/partsAccess';
import { calculateRoutingCost } from '@/utils/routingCostCalculation';
import { getCompany, readCompanyPricingDefaults } from '@/utils/companyAccess';
import { getCurrentMember } from '@/utils/operatorAccess';
import { resolveMarkupAtQty, unitPriceFromBase } from '@/utils/quotePricingResolver';

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
 * The price of a part at a specific quantity — the SINGLE SOURCE OF TRUTH the
 * Pricing card, the quote form, and the persisted quote line all use.
 *
 * `base_cost` comes from the ONE canonical engine (via
 * `getComputedPartChargeBase`) at the ACTUAL qty; the markup is the tier that
 * applies at that qty; `unit_price = base × (1 + markup/100)`. Because base is
 * computed at the exact qty (not read off a step-function tier ladder), the
 * number is exact at every qty and identical wherever it's shown. A caller that
 * already has the tier list passes it in to skip the extra fetch; otherwise the
 * tiers are loaded here.
 *
 * **The base is the CHARGE base, not the true cost** (#727): markup applies to
 * what we charge ourselves for the materials, so a BOM line set to charge its
 * child at price is already inside `base_cost`. The two are the same number
 * until someone sets that toggle.
 */
export interface PartPriceAtQty {
  base_cost: number | null;
  markup_percent: number | null;
  unit_price: number | null;
  source_tier_id: string | null;
  below_min: boolean;
}

export async function getPartPriceAtQty(
  partId: string,
  qty: number,
  tiers?: ReadonlyArray<{ id: string; quantity: number; markup_percent: number | null }>,
): Promise<PartPriceAtQty> {
  const ladder = tiers ?? (await getTiersForPart(partId));
  const [resolved, base] = await Promise.all([
    Promise.resolve(resolveMarkupAtQty(ladder, qty)),
    getComputedPartChargeBase(partId, qty).catch(() => null),
  ]);
  const unit_price = resolved ? unitPriceFromBase(base, resolved.markup_percent) : null;
  return {
    base_cost: base,
    markup_percent: resolved?.markup_percent ?? null,
    unit_price,
    source_tier_id: resolved?.source_tier_id ?? null,
    below_min: resolved?.below_min ?? false,
  };
}

/**
 * The tier ladder with each tier's `unit_price` computed AT THAT TIER'S OWN
 * QUANTITY, all through the one canonical engine (`getComputedPartChargeBase` —
 * the same one `getPartPriceAtQty` uses, so no TS/SQL split can make two screens
 * disagree). Drives the quote-form tier ladder, the drift snapshot, and the
 * Pricing card's tier table. A null markup or an unresolvable base yields
 * `unit_price = null` so the "no usable tier" check still fires.
 *
 * Note: this is the price AT each breakpoint. The actual order/line price is
 * `getPartPriceAtQty(part, orderQty)` — base at the real qty × the resolved
 * tier's markup — which every consuming surface uses so between-breakpoint
 * orders are exact, not snapped to a breakpoint.
 */
export async function getTiersWithComputedPrices(
  partId: string,
): Promise<ComputedPartPricingTier[]> {
  const tiers = await getTiersForPart(partId);
  if (tiers.length === 0) return [];

  return Promise.all(
    tiers.map(async (t) => {
      const base = await getComputedPartChargeBase(partId, t.quantity).catch(() => null);
      return { ...t, unit_price: unitPriceFromBase(base, t.markup_percent) };
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
 * Each part owns its markup directly — there is no shared/named markup-rate
 * layer. A tier row with a NULL `markup_percent` is an unfilled row (the part
 * reads as "no markup / not priceable" until the user fills it).
 */
export async function replaceTiersForPart(
  companyId: string,
  partId: string,
  tiers: PartPricingTierInput[],
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
  // passes a fresh set of inputs without ids (e.g., replacing every tier in
  // one save) doesn't 409 against the rows it's about to obsolete.
  const keepIds = new Set(
    tiers.map((t) => t.id).filter((id): id is string => Boolean(id)),
  );
  const toDelete = [...existingIds].filter((id) => !keepIds.has(id));
  if (toDelete.length > 0) {
    const { error } = await supabase
      .from('part_pricing_tiers')
      .delete()
      .in('id', toDelete);
    if (error) throw toFriendlyError(error, { entity: 'pricing tier' });
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
      if (error) throw toFriendlyError(error, { entity: 'pricing tier' });
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
      if (error) throw toFriendlyError(error, { entity: 'pricing tier' });
    }
  }

  return getTiersForPart(partId);
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

/**
 * Give a part its first pricing tier, at the shop's starting markup, the moment
 * it first has a cost — so "costed" and "quotable" happen together (#727).
 *
 * **Why this is not in the Pricing card.** It used to be, as an effect that
 * noticed a cost had appeared and wrote a tier. Two problems, both real:
 *
 *   1. It ran AFTER the routing/BOM save had already refreshed the page, so the
 *      workspace re-derived priceability in the gap and flashed "this part can't
 *      be quoted yet" for a second before correcting itself. The user watched
 *      the app change its mind.
 *   2. An automatic write inside an explicit-Save card kept reaching around that
 *      card's own guards — it ate a staged Min qty once and a staged operation
 *      edit once, both caught by E2E.
 *
 * Called from the workspace's post-mutation refresh instead, BEFORE the refresh
 * lands: the tier exists by the time anything re-reads priceability, so there is
 * one transition rather than two.
 *
 * Returns true when it wrote a tier. No-ops (cheaply, in this order) when the
 * part already has tiers, or has no cost to mark up yet.
 */
export async function ensureStarterPricingTier(
  companyId: string,
  partId: string,
  source: 'made' | 'bought',
): Promise<boolean> {
  const existing = await getTiersForPart(partId);
  if (existing.length > 0) return false;

  // "Is there a cost", not "is there a routing". A made part whose operations
  // were all deleted still HAS a routing row and rolls up to $0; a markup there
  // would make it quotable for nothing, which is worse than not being quotable.
  if (source === 'bought') {
    const cost = await getComputedPartCost(partId, 1).catch(() => null);
    if (cost === null) return false;
  } else {
    const breakdown = await calculateRoutingCost(partId, 1).catch(() => null);
    const hasPricedWork =
      !!breakdown &&
      (breakdown.labor_items.length > 0 || breakdown.material_items.length > 0);
    if (!hasPricedWork) return false;
  }

  const company = await getCompany(companyId);
  // No company row, no starting markup to apply — writing 0 would be inventing a
  // number the shop never chose.
  if (!company) return false;
  const starters = readCompanyPricingDefaults(company);
  const markup = source === 'bought' ? starters.bought : starters.made;

  await replaceTiersForPart(companyId, partId, [
    { sequence: 10, quantity: 1, markup_percent: markup },
  ]);

  // Audit trail: a pricing row that appears with no trace is what the notes feed
  // exists to prevent.
  try {
    const operator = await getCurrentMember(companyId);
    if (operator) {
      await addPartPricingNote(
        partId,
        companyId,
        operator.id,
        `Pricing started automatically at ${markup}% markup — your shop default for ${
          source === 'bought' ? 'parts you buy' : 'parts you make'
        } — so this part can be quoted. Adjust it any time.`,
      );
    }
  } catch (noteErr) {
    console.error('Failed to log starter pricing note:', noteErr);
  }
  return true;
}
