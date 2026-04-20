import { getSupabase } from '@/lib/supabase';
import type { QuoteLineItem } from '@/types/quote';
import type { PartPricingTier } from '@/types/partPricing';

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
        description,
        category_id,
        part_categories (
          id,
          name,
          default_markup_percent
        )
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
 * Snapshot a tier into a new line item for a quote. Called once per selected
 * tier during createQuote. The snapshot is immutable — later edits to the
 * tier do not flow back into an existing line item.
 */
export async function insertLineItemFromTier(
  quoteId: string,
  companyId: string,
  tier: PartPricingTier,
  sequence: number,
): Promise<QuoteLineItem> {
  const supabase = getSupabase();
  if (tier.unit_price == null) {
    throw new Error(
      `Cannot create quote line item: tier ${tier.id} has no unit price. Set a markup or override price first.`,
    );
  }
  const totalPrice = Math.round(tier.unit_price * tier.quantity * 100) / 100;

  const { data, error } = await supabase
    .from('quote_line_items')
    .insert({
      quote_id: quoteId,
      company_id: companyId,
      part_id: tier.part_id,
      source_tier_id: tier.id,
      sequence,
      quantity: tier.quantity,
      unit_price: tier.unit_price,
      total_price: totalPrice,
      markup_percent: tier.markup_percent,
      base_cost_per_unit: tier.base_cost_per_unit,
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
