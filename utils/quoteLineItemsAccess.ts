import { getSupabase } from '@/lib/supabase';
import type { QuoteLineItem } from '@/types/quote';
import type { PartPricingTier } from '@/types/partPricing';
import { resolveTier } from '@/utils/quotePricingResolver';
import { getComputedPartCost } from '@/utils/partsAccess';

/**
 * Load line items for a quote (ordered by sequence) with the part joined in.
 */
export async function getLineItemsForQuote(quoteId: string): Promise<QuoteLineItem[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('quote_line_items')
    .select(`
      *,
      parts (
        id,
        part_name,
        description
      )
    `)
    .eq('quote_id', quoteId)
    .order('sequence', { ascending: true });

  if (error) {
    console.error('Error fetching quote line items:', error);
    throw error;
  }
  return (data || []) as QuoteLineItem[];
}

/**
 * Optional one-off price override the user typed on the quote form for a
 * single tier. When present, the snapshot uses these values and flips the
 * `is_quote_override` flag for the chip on the cost-breakdown view.
 */
export interface QuoteLineItemOverride {
  unit_price: number;
  markup_percent: number | null;
}

/**
 * Snapshot a single (part, order_quantity) commitment into a new line item.
 * The unit price is auto-resolved from the part's tier table (highest tier with
 * `tier_qty <= order_qty`) unless an explicit override is supplied. The matched
 * tier id is recorded in `source_tier_id` so the PDF can highlight which break
 * was used.
 */
export async function insertLineItemForPart(
  quoteId: string,
  companyId: string,
  partId: string,
  orderQuantity: number,
  tiers: PartPricingTier[],
  sequence: number,
  override?: QuoteLineItemOverride,
): Promise<QuoteLineItem> {
  const supabase = getSupabase();

  let unitPrice: number;
  let markupPercent: number | null;
  let sourceTierId: string | null;

  if (override) {
    unitPrice = override.unit_price;
    markupPercent = override.markup_percent;
    const resolved = resolveTier(tiers, orderQuantity);
    sourceTierId = resolved?.source_tier_id ?? null;
  } else {
    const resolved = resolveTier(tiers, orderQuantity);
    if (!resolved) {
      throw new Error(
        'Cannot create quote line item: this part has no priced pricing tiers. Add tiers on the part page first.',
      );
    }
    unitPrice = resolved.unit_price;
    sourceTierId = resolved.source_tier_id;
    const matchedTier = tiers.find((t) => t.id === resolved.source_tier_id);
    markupPercent = matchedTier?.markup_percent ?? null;
  }

  // Snapshot the base cost live at the order quantity. The SQL function
  // cascades through the BOM at cumulative qty per sub-assembly, so this
  // matches what `quote_line_items.base_cost_per_unit` should freeze for
  // the historical record. Tier rows no longer carry base_cost_per_unit.
  let baseCost: number | null;
  try {
    baseCost = await getComputedPartCost(partId, orderQuantity);
  } catch {
    // Cost RAISES on missing labor rates / external pricing / unit
    // conversions. Snapshot a null so the breakdown view can fall through
    // to its computed-live fallback rather than persisting wrong data.
    baseCost = null;
  }

  const totalPrice = Math.round(unitPrice * orderQuantity * 100) / 100;

  const { data, error } = await supabase
    .from('quote_line_items')
    .insert({
      quote_id: quoteId,
      company_id: companyId,
      part_id: partId,
      source_tier_id: sourceTierId,
      sequence,
      quantity: orderQuantity,
      unit_price: unitPrice,
      total_price: totalPrice,
      markup_percent: markupPercent,
      base_cost_per_unit: baseCost,
      is_quote_override: !!override,
    })
    .select('*')
    .single();

  if (error) {
    console.error('Error inserting quote line item:', error);
    throw error;
  }
  return data as QuoteLineItem;
}

/**
 * Delete every line item on a quote. Used by bulk delete and by re-snapshot
 * flows that rebuild the full list.
 */
export async function clearLineItemsForQuote(quoteId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from('quote_line_items').delete().eq('quote_id', quoteId);
  if (error) {
    console.error('Error clearing quote line items:', error);
    throw error;
  }
}
