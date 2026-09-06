import * as Sentry from '@sentry/nextjs';

import { getSupabase } from '@/lib/supabase';
import { toFriendlyError } from '@/lib/supabaseErrors';
import { toError } from '@/lib/supabaseErrors';
import type {
  PartPricingTier,
  PartPricingTierInput,
  ComputedPartPricingTier,
} from '@/types/partPricing';
import { getComputedPartChargeBase, addPartPricingNote } from '@/utils/partsAccess';
import { calculateRoutingCost } from '@/utils/routingCostCalculation';
import { getCompany, readCompanyPricingDefaults } from '@/utils/companyAccess';
import { getCurrentMember } from '@/utils/operatorAccess';
import { unitPriceFromBase } from '@/utils/quotePricingResolver';

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
 * The tier ladder with each tier's `unit_price` computed AT THAT TIER'S OWN
 * QUANTITY, through the one canonical engine (`getComputedPartChargeBase`), so
 * no TS/SQL split can make two screens disagree. Drives the quote-form tier
 * ladder, the drift snapshot, and the Pricing card's tier table. A null markup
 * or an unresolvable base yields `unit_price = null` so the "no usable tier"
 * check still fires.
 *
 * **This IS the order price, not just the price at a breakpoint.** A tier's
 * listed price holds for its whole band (founder rule, 2026-08-07): a quote
 * resolves the tier with `resolveTier` and takes the number shown here, so the
 * part page and the quote can never disagree. A companion `getPartPriceAtQty`
 * once recomputed the base at the *order* quantity instead — the pre-2026-08-07
 * rule — and survived unused, with a doc comment here still calling it the real
 * price path. Both are gone.
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
          cost_per_unit: tier.cost_per_unit ?? null,
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
          cost_per_unit: tier.cost_per_unit ?? null,
          markup_percent: tier.markup_percent,
        });
      if (error) throw toFriendlyError(error, { entity: 'pricing tier' });
    }
  }

  return getTiersForPart(partId);
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
    // `.rpc()` is deliberately excluded from Sentry's Supabase integration, so
    // nothing files this unless we do. It went unfiled once already: on
    // 2026-08-19 this RPC hit the 8s statement timeout (57014) for a whole
    // afternoon, the parts list drew every part as Incomplete, and the only
    // trace anywhere was a console line in one user's browser.
    Sentry.captureException(toError(error, 'get_priceable_part_ids'), {
      tags: { area: 'part-pricing' },
    });
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

  // "Is there a cost", not "is there a routing". A made part whose operations
  // were all deleted still HAS a routing row and rolls up to $0; a markup there
  // would make it quotable for nothing, which is worse than not being quotable.
  //
  // The two sources diverge because a bought part's cost now lives ON its tier
  // row. Such a part already HAS rows the moment anyone records a cost, so
  // "no tiers yet" is the wrong question for it — what it can still be missing
  // is a markup.
  let unpriced: PartPricingTier[] = [];
  if (source === 'bought') {
    const costed = existing.filter((t) => t.cost_per_unit !== null);
    if (costed.length === 0) return false;
    unpriced = costed.filter((t) => t.markup_percent === null);
    if (unpriced.length === 0) return false;
  } else {
    if (existing.length > 0) return false;
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

  // Bought: fill the default into the costed rows that lack a markup, leaving
  // every id, quantity and row count alone — a quote line's drift check compares
  // exactly those, so inventing or renumbering rows here would flag every quote
  // on the part as drifted without a single price moving.
  // Made: the part has no rows at all, so create the one starter break.
  await replaceTiersForPart(
    companyId,
    partId,
    source === 'bought'
      ? existing.map((t) => ({
          id: t.id,
          sequence: t.sequence,
          quantity: t.quantity,
          cost_per_unit: t.cost_per_unit,
          markup_percent: unpriced.some((u) => u.id === t.id) ? markup : t.markup_percent,
        }))
      : [{ sequence: 10, quantity: 1, markup_percent: markup }],
  );

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
