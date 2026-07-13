import { getTypedSupabase as getSupabase } from '@/lib/supabase';
import type { Json } from '@/types/database';
import type { QuoteLineItem } from '@/types/quote';
import type { ComputedPartPricingTier } from '@/types/partPricing';
import {
  resolveTier,
  resolveTierFromSnapshot,
  buildPricingBasisSnapshot,
} from '@/utils/quotePricingResolver';
import { getComputedPartCost } from '@/utils/partsAccess';

/**
 * Cost-plus selling price: base × (1 + markup/100), rounded to cents. Returns
 * null when the base cost or markup is unavailable so callers fall back to a
 * frozen tier/snapshot price rather than emitting a wrong number. Shared by the
 * insert, quantity-edit, and reprice paths so Option-A pricing (price at the
 * real order qty, not a frozen tier breakpoint) is applied identically.
 */
function priceFromBase(base: number | null, markup: number | null | undefined): number | null {
  if (base === null || !Number.isFinite(base) || markup == null || Number.isNaN(markup)) return null;
  return Math.round(base * (1 + markup / 100) * 100) / 100;
}

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
  // The generated Supabase type widens jsonb to `Json` (unknown-ish). The
  // application layer relies on the structured shape we wrote in
  // `buildPricingBasisSnapshot`; cast once at the boundary instead of
  // sprinkling `as` across call sites.
  return (data || []) as unknown as QuoteLineItem[];
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
 * The unit price is auto-resolved from the part's tier table (highest tier
 * with `tier_qty <= order_qty`) unless an explicit override is supplied.
 *
 * The full tier table at create-time is frozen onto the row via
 * `pricing_basis_snapshot` — drift detection on edit compares this snapshot
 * against current tiers, and quantity-curve recomputation on edit also
 * resolves against this snapshot (never against live tiers).
 */
export async function insertLineItemForPart(
  quoteId: string,
  companyId: string,
  partId: string,
  orderQuantity: number,
  tiers: ComputedPartPricingTier[],
  sequence: number,
  override?: QuoteLineItemOverride,
): Promise<QuoteLineItem> {
  const supabase = getSupabase();

  // Snapshot the base cost live at the order quantity. The SQL function
  // cascades through the BOM at cumulative qty per sub-assembly, so this
  // matches what `quote_line_items.base_cost_per_unit` should freeze for
  // the historical record. Tier rows no longer carry base_cost_per_unit.
  // It also drives the Option-A selling price below.
  let baseCost: number | null;
  try {
    baseCost = await getComputedPartCost(partId, orderQuantity);
  } catch {
    // Cost RAISES on missing labor rates / external pricing / unit
    // conversions. Snapshot a null so the breakdown view can fall through
    // to its computed-live fallback rather than persisting wrong data.
    baseCost = null;
  }

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
    sourceTierId = resolved.source_tier_id;
    const matchedTier = tiers.find((t) => t.id === resolved.source_tier_id);
    markupPercent = matchedTier?.markup_percent ?? null;
    // Option A: price at the ACTUAL order qty, not the tier's breakpoint-frozen
    // unit_price. Material cost with whole-unit ceiling / batch pinning is a
    // step function of the order qty (order 20 → 1 strip → $5.45; order 21 → 2
    // strips → $10.38), which the per-breakpoint tier list can't represent. The
    // tier supplies the markup %; the base is the live cost at orderQty. Fall
    // back to the resolved tier price only when the live cost can't compute.
    unitPrice = priceFromBase(baseCost, markupPercent) ?? resolved.unit_price;
  }

  const totalPrice = Math.round(unitPrice * orderQuantity * 100) / 100;

  // Build the basis snapshot from the same tier table that produced the
  // resolved tier. For override lines, `resolved_tier_id` is null but the
  // full tier table is still captured so future drift checks can run.
  const basisSnapshot = buildPricingBasisSnapshot(tiers, orderQuantity, sourceTierId);

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
      pricing_basis_snapshot: basisSnapshot as unknown as Json,
      basis_unknown: false,
    })
    .select('*')
    .single();

  if (error) {
    console.error('Error inserting quote line item:', error);
    throw error;
  }
  return data as unknown as QuoteLineItem;
}

/**
 * Update an existing line item's quantity (and recompute its unit_price
 * from the frozen `pricing_basis_snapshot` — NEVER from current tiers).
 *
 * Override lines: quantity changes update the row but `unit_price` stays
 * pinned at the override value (the snapshot's `resolved_tier_id` is null
 * for overrides; we fall back to the override price stored on the row).
 *
 * `basis_unknown` lines have no snapshot to resolve against, so quantity
 * changes are NOT supported for these — the read path falls back to the
 * stored `unit_price` (degraded behavior, surfaced via the "basis unknown"
 * chip). Callers should disable the qty input for `basis_unknown` rows.
 */
export async function updateLineItemQuantity(
  lineItemId: string,
  newQuantity: number,
): Promise<QuoteLineItem> {
  const supabase = getSupabase();

  const { data: existing, error: fetchError } = await supabase
    .from('quote_line_items')
    .select('*')
    .eq('id', lineItemId)
    .single();
  if (fetchError) {
    console.error('Error loading line item for quantity update:', fetchError);
    throw fetchError;
  }
  const row = existing as unknown as QuoteLineItem;

  let newUnitPrice = row.unit_price;
  let newSourceTierId = row.source_tier_id;

  if (!row.is_quote_override) {
    const snapshot = row.pricing_basis_snapshot;
    if (snapshot && !row.basis_unknown) {
      const resolved = resolveTierFromSnapshot(snapshot, newQuantity);
      if (resolved) {
        newSourceTierId = resolved.source_tier_id;
        // Option A: recompute the base cost live at the NEW qty; the markup %
        // stays frozen from the resolved snapshot tier (selling policy). Falls
        // back to the snapshot's frozen unit_price when the live cost can't
        // compute. Base cost is inherently qty-dependent (ceiling/batch is a
        // step function), so a qty change must re-cost, not read a breakpoint.
        const matched = snapshot.tiers.find((t) => t.id === resolved.source_tier_id);
        let base: number | null;
        try {
          base = await getComputedPartCost(row.part_id, newQuantity);
        } catch {
          base = null;
        }
        newUnitPrice = priceFromBase(base, matched?.markup_percent) ?? resolved.unit_price;
      }
    }
    // basis_unknown rows keep the stored unit_price — there's no
    // historical tier table to walk. The UI prevents qty edits for these,
    // but the read-path fallback is still well-defined.
  }

  const newTotal = Math.round(newUnitPrice * newQuantity * 100) / 100;

  const { data, error } = await supabase
    .from('quote_line_items')
    .update({
      quantity: newQuantity,
      unit_price: newUnitPrice,
      source_tier_id: newSourceTierId,
      total_price: newTotal,
    })
    .eq('id', lineItemId)
    .select('*')
    .single();
  if (error) {
    console.error('Error updating line item quantity:', error);
    throw error;
  }
  return data as unknown as QuoteLineItem;
}

/**
 * Reprice an existing line item against the part's CURRENT tier table —
 * used when the user clicks "Update to current price" on a drifted line.
 * Refreshes both the resolved price and the frozen snapshot so the row
 * becomes the new baseline; subsequent drift checks compare against the
 * current tiers.
 *
 * Override lines are never repriced; this should not be called for them.
 */
export async function repriceLineItemToCurrent(
  lineItemId: string,
  currentTiers: ComputedPartPricingTier[],
): Promise<QuoteLineItem> {
  const supabase = getSupabase();

  const { data: existing, error: fetchError } = await supabase
    .from('quote_line_items')
    .select('*')
    .eq('id', lineItemId)
    .single();
  if (fetchError) {
    console.error('Error loading line item for reprice:', fetchError);
    throw fetchError;
  }
  const row = existing as unknown as QuoteLineItem;
  if (row.is_quote_override) {
    throw new Error('Override line items cannot be repriced — clear the override first.');
  }

  const resolved = resolveTier(currentTiers, row.quantity);
  if (!resolved) {
    throw new Error('Cannot reprice: this part has no priced tiers in the current tier table.');
  }
  const matchedTier = currentTiers.find((t) => t.id === resolved.source_tier_id);
  const newMarkup = matchedTier?.markup_percent ?? null;

  // Option A: reprice at the line's own qty using the live base cost × the
  // current tier's markup (not the tier's breakpoint-frozen unit_price), so a
  // ceiling/batch part reprices to its true per-order-qty cost.
  let base: number | null;
  try {
    base = await getComputedPartCost(row.part_id, row.quantity);
  } catch {
    base = null;
  }
  const newUnitPrice = priceFromBase(base, newMarkup) ?? resolved.unit_price;

  const newSnapshot = buildPricingBasisSnapshot(
    currentTiers,
    row.quantity,
    resolved.source_tier_id,
  );
  const newTotal = Math.round(newUnitPrice * row.quantity * 100) / 100;

  const { data, error } = await supabase
    .from('quote_line_items')
    .update({
      unit_price: newUnitPrice,
      source_tier_id: resolved.source_tier_id,
      markup_percent: newMarkup,
      total_price: newTotal,
      pricing_basis_snapshot: newSnapshot as unknown as Json,
      basis_unknown: false,
    })
    .eq('id', lineItemId)
    .select('*')
    .single();
  if (error) {
    console.error('Error repricing line item:', error);
    throw error;
  }
  return data as unknown as QuoteLineItem;
}

/**
 * Delete a single line item by id (used by updateQuote's reconcile path
 * when the user removes a part from an existing quote).
 */
export async function deleteLineItem(lineItemId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('quote_line_items')
    .delete()
    .eq('id', lineItemId);
  if (error) {
    console.error('Error deleting quote line item:', error);
    throw error;
  }
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
