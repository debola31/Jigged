import { getSupabase } from '@/lib/supabase';
import { assertDeleted, toFriendlyError } from '@/lib/supabaseErrors';
import type { Json } from '@/types/database';
import type { QuoteLineItem } from '@/types/quote';
import type { ComputedPartPricingTier } from '@/types/partPricing';
import {
  resolveTier,
  resolveTierFromSnapshot,
  resolveMarkupAtQty,
  buildPricingBasisSnapshot,
} from '@/utils/quotePricingResolver';
import { getComputedPartCost, getComputedPartChargeBase } from '@/utils/partsAccess';

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
  leadTimeText?: string | null,
): Promise<QuoteLineItem> {
  const supabase = getSupabase();

  let unitPrice: number;
  let markupPercent: number | null;
  let sourceTierId: string | null;
  // Quantity the price basis was evaluated at — the matched tier's break, not
  // the order quantity (see `basisQuantity` below).
  let basisQuantity: number;

  if (override) {
    unitPrice = override.unit_price;
    markupPercent = override.markup_percent;
    const resolvedMarkup = resolveMarkupAtQty(tiers, orderQuantity);
    sourceTierId = resolvedMarkup?.source_tier_id ?? null;
    basisQuantity = resolvedMarkup?.matched_tier_quantity ?? orderQuantity;
  } else {
    // The tier ladder is the shop's declared price list: the price listed at a
    // break holds for that break's whole band. `resolveTier` returns exactly
    // the number the part page shows for the matched tier, so a quote can never
    // disagree with the part it was priced from.
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
    basisQuantity = resolved.matched_tier_quantity ?? orderQuantity;
  }

  // Base cost at the quantity the PRICE was derived from — the matched tier's
  // break, not the order quantity. Setup amortization makes the base a function
  // of quantity, so snapshotting it at the order qty would break the row's own
  // arithmetic: `unit_price = base_cost_per_unit × (1 + markup/100)` is the
  // invariant this column exists to record.
  //
  // It is the CHARGE base, for that same reason: a material charged at price is
  // already inside the number markup was applied to. `true_cost_per_unit` is the
  // same figure with every charge basis ignored, so the line can state its own
  // effective margin without re-deriving anything later.
  let baseCost: number | null;
  let trueCost: number | null;
  try {
    [baseCost, trueCost] = await Promise.all([
      getComputedPartChargeBase(partId, basisQuantity),
      getComputedPartCost(partId, basisQuantity),
    ]);
  } catch {
    // A costing GAP (no tier, no labour rate, no outside unit price) already
    // arrives as null through the normal return — this catches what still
    // raises: a BOM line whose unit has no conversion to the child's primary
    // unit. Snapshot a null either way so the breakdown view can fall through
    // to its computed-live fallback rather than persisting wrong data.
    baseCost = null;
    trueCost = null;
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
      true_cost_per_unit: trueCost,
      is_quote_override: !!override,
      // Per-item lead time (per-part, denormalized onto each line row). Blank
      // ⇒ NULL, i.e. this line uses the quote-level lead time.
      lead_time_text: leadTimeText && leadTimeText.trim() !== '' ? leadTimeText : null,
      pricing_basis_snapshot: basisSnapshot as unknown as Json,
      basis_unknown: false,
    })
    .select('*')
    .single();

  if (error) {
    console.error('Error inserting quote line item:', error);
    throw toFriendlyError(error, { entity: 'line item' });
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
      // Walk the FROZEN ladder captured at quote time, not the part's current
      // tiers — moving to another quantity is quantity-curve movement, not a
      // reprice, so a tier edit since creation must not leak in here. The
      // snapshot stores each tier's listed price, which is the price the band
      // carries, so this lands on the same number the part page shows.
      const resolved = resolveTierFromSnapshot(snapshot, newQuantity);
      if (resolved) {
        newUnitPrice = resolved.unit_price;
        newSourceTierId = resolved.source_tier_id;
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
    throw toFriendlyError(error, { entity: 'line item' });
  }
  return data as unknown as QuoteLineItem;
}

/**
 * Update only a line item's per-item lead time (free text). Kept separate from
 * `updateLineItemQuantity` — lead time carries no pricing, so it must persist
 * even when the quantity is unchanged (and must NOT trigger a price recompute).
 * Blank ⇒ NULL, i.e. the line falls back to the quote-level lead time.
 */
export async function updateLineItemLeadTime(
  lineItemId: string,
  leadTimeText: string | null,
): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('quote_line_items')
    .update({
      lead_time_text: leadTimeText && leadTimeText.trim() !== '' ? leadTimeText : null,
    })
    .eq('id', lineItemId);
  if (error) {
    console.error('Error updating line item lead time:', error);
    throw toFriendlyError(error, { entity: 'line item' });
  }
}

/**
 * Set or clear a one-off price on an EXISTING line item.
 *
 * `unitPrice` non-null pins that price and flags `is_quote_override`; null
 * clears the override and returns the line to its frozen tier basis (the price
 * the snapshot ladder lists at this quantity).
 *
 * This exists because `reconcileQuoteLineItems` used to read `block.override`
 * only on the INSERT paths: on an existing line, setting, changing or clearing a
 * custom price was accepted by the form and silently dropped on save. The old
 * part-level toggle made that easy to miss; an always-editable price field would
 * have made it a lie on every keystroke.
 *
 * `markup_percent` is deliberately nulled on override and left null on clear —
 * the quote form has no markup input, and the row's markup is only meaningful
 * when the price came off the ladder.
 */
export async function updateLineItemOverride(
  lineItemId: string,
  unitPrice: number | null,
): Promise<QuoteLineItem> {
  const supabase = getSupabase();

  const { data: existing, error: fetchError } = await supabase
    .from('quote_line_items')
    .select('*')
    .eq('id', lineItemId)
    .single();
  if (fetchError) {
    console.error('Error loading line item for override update:', fetchError);
    throw fetchError;
  }
  const row = existing as unknown as QuoteLineItem;

  let newUnitPrice: number;
  let newSourceTierId = row.source_tier_id;
  let newMarkup: number | null = null;

  if (unitPrice !== null) {
    newUnitPrice = unitPrice;
  } else {
    // Clearing: fall back to the FROZEN ladder, not current tiers — dropping an
    // override is not an opt-in to a tier change made since the quote was
    // written. That stays the explicit "Update to current price" action.
    const snapshot = row.pricing_basis_snapshot;
    const resolved =
      snapshot && !row.basis_unknown ? resolveTierFromSnapshot(snapshot, row.quantity) : null;
    if (!resolved) {
      // No basis to return to (pre-snapshot row, or a part that had no priced
      // tier when quoted). Keep the agreed price and just drop the flag rather
      // than inventing one or refusing the edit.
      newUnitPrice = row.unit_price;
    } else {
      newUnitPrice = resolved.unit_price;
      newSourceTierId = resolved.source_tier_id;
      newMarkup =
        snapshot?.tiers.find((t) => t.id === resolved.source_tier_id)?.markup_percent ?? null;
    }
  }

  const newTotal = Math.round(newUnitPrice * row.quantity * 100) / 100;

  const { data, error } = await supabase
    .from('quote_line_items')
    .update({
      unit_price: newUnitPrice,
      source_tier_id: newSourceTierId,
      markup_percent: newMarkup,
      total_price: newTotal,
      is_quote_override: unitPrice !== null,
    })
    .eq('id', lineItemId)
    .select('*')
    .single();
  if (error) {
    console.error('Error updating line item override:', error);
    throw toFriendlyError(error, { entity: 'line item' });
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

  // Reprice onto the part's CURRENT ladder — the listed price at the break this
  // quantity falls in, which is the number the part page shows today.
  const resolved = resolveTier(currentTiers, row.quantity);
  if (!resolved) {
    throw new Error('Cannot reprice: this part has no priced tiers in the current tier table.');
  }
  const newUnitPrice = resolved.unit_price;
  const newSourceTierId: string | null = resolved.source_tier_id;
  const matchedTier = currentTiers.find((t) => t.id === resolved.source_tier_id);
  const newMarkup = matchedTier?.markup_percent ?? null;

  // Base at the matched break — the quantity the new price was derived from, so
  // `unit_price = base_cost_per_unit × (1 + markup/100)` still holds on the row.
  // Charge base for that arithmetic; true cost alongside it for margin.
  const baseQty = resolved.matched_tier_quantity ?? row.quantity;
  let base: number | null;
  let trueBase: number | null;
  try {
    [base, trueBase] = await Promise.all([
      getComputedPartChargeBase(row.part_id, baseQty),
      getComputedPartCost(row.part_id, baseQty),
    ]);
  } catch {
    base = null;
    trueBase = null;
  }

  const newSnapshot = buildPricingBasisSnapshot(
    currentTiers,
    row.quantity,
    newSourceTierId,
  );
  const newTotal = Math.round(newUnitPrice * row.quantity * 100) / 100;

  const { data, error } = await supabase
    .from('quote_line_items')
    .update({
      unit_price: newUnitPrice,
      source_tier_id: newSourceTierId,
      markup_percent: newMarkup,
      // Refreshed alongside the price it belongs to — leaving the create-time
      // base here would leave the row asserting an arithmetic that no longer
      // holds, and it is what cost-vs-sell reporting reads.
      base_cost_per_unit: base,
      true_cost_per_unit: trueBase,
      total_price: newTotal,
      pricing_basis_snapshot: newSnapshot as unknown as Json,
      basis_unknown: false,
    })
    .eq('id', lineItemId)
    .select('*')
    .single();
  if (error) {
    console.error('Error repricing line item:', error);
    throw toFriendlyError(error, { entity: 'line item' });
  }
  return data as unknown as QuoteLineItem;
}

/**
 * Delete a single line item by id (used by updateQuote's reconcile path
 * when the user removes a part from an existing quote).
 */
export async function deleteLineItem(lineItemId: string): Promise<void> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('quote_line_items')
    .delete()
    .eq('id', lineItemId)
    .select('id');
  if (error) {
    console.error('Error deleting quote line item:', error);
    throw toFriendlyError(error, { entity: 'line item' });
  }
  assertDeleted(data, 'line item');
}

/**
 * Delete every line item on a quote. Used by bulk delete and by re-snapshot
 * flows that rebuild the full list.
 */
// No row-count assertion here, unlike deleteLineItem: clearing a quote that already has no line
// items is a normal outcome (the re-snapshot flow calls this before rebuilding), so zero rows
// would report a failure for an operation that did exactly what was asked.
export async function clearLineItemsForQuote(quoteId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from('quote_line_items').delete().eq('quote_id', quoteId);
  if (error) {
    console.error('Error clearing quote line items:', error);
    throw toFriendlyError(error, { entity: 'line item' });
  }
}
