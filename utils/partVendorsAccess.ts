/**
 * The approved vendor list, price sheets and "Use as part cost" — the browser access layer
 * (plan §3.8, §5.3 "Access layer").
 *
 * Writes are RPCs only: `save_part_vendor` (which revives an archived row on its own — the
 * (part, vendor) pair IS identity), `archive_part_vendor`, and `apply_part_cost_from_vendor`,
 * THE ONLY PURCHASING WRITER OF `part_pricing_tiers`. This file never touches that table: a PO
 * price is a frozen term of a document, never a cost record, and the apply refuses unless what it
 * writes is exactly what was previewed.
 *
 * Counts THROW on failure. A consequence count that could not be taken reads "couldn't count",
 * never 0 — a 0 claims nothing is affected (lib/purchasing/sourcing.ts).
 */
import { z } from 'zod';

import { getSupabase } from '@/lib/supabase';
import type { Json } from '@/types/database';
import { factorLabel } from '@/lib/purchasing/purchaseUnits';
import { PART_VENDOR_STATUSES, type PartVendorStatus } from '@/lib/purchasing/vendorPoStatus';
import type { SourcingPreview } from '@/lib/purchasing/sourcing';
import { ID_CHUNK } from '@/lib/queryLimits';
import {
  chunkIds,
  one,
  parsePurchasingResult,
  preparePurchaseUnits,
  present,
  purchasingReadFailure,
  purchasingRpcFailure,
  resolvePartUnit,
} from '@/utils/purchasingShared';
import type {
  ApplyPartCostResult,
  ArchivePartVendorResult,
  PartCostPreview,
  PartVendorChanges,
  PartVendorLastPurchase,
  PartVendorList,
  PartVendorRow,
  SavePartVendorInput,
  SavePartVendorResult,
  VendorPartRow,
} from '@/types/partVendor';

const ENTITY = 'part vendor';

type JsonObject = { [key: string]: Json };

function status(value: string): PartVendorStatus {
  return (PART_VENDOR_STATUSES as readonly string[]).includes(value)
    ? (value as PartVendorStatus)
    : present<PartVendorStatus>(null, `an approved-vendor status ("${value}")`);
}

const numOrNull = (v: number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));
const expired = (validUntil: string | null, today: string) => validUntil !== null && validUntil < today;

// ------------------------------------------------------------------------------------------------
// Reads
// ------------------------------------------------------------------------------------------------

/**
 * A part's vendors — the Buying tab. Live rows whose vendor is live, each with its price breaks,
 * per-sheet dates (and whether the sheet has expired, by the caller's date) and Last PO price.
 * `null` when the caller cannot see the part.
 */
export async function listPartVendors(partId: string, options: { today: string }): Promise<PartVendorList | null> {
  const supabase = getSupabase();
  const op = "load the part's vendors";
  const [partRes, rowsRes, lastRes] = await Promise.all([
    supabase
      .from('parts')
      .select('id, part_name, source, primary_unit, preferred_vendor_id, parts_unit_conversions(from_unit, to_primary_factor)')
      .eq('id', partId)
      .maybeSingle(),
    supabase
      .from('part_vendors')
      .select(
        'id, part_id, vendor_id, status, status_note, vendor_part_number, purchase_unit, lead_time_days, minimum_order_quantity, quoted_on, valid_until, notes, created_at, updated_at, vendors!inner(id, name, deleted_at), part_vendor_price_breaks(id, min_quantity, unit_price, source, vendor_rfq_response_id)',
      )
      .eq('part_id', partId)
      .is('deleted_at', null)
      .is('vendors.deleted_at', null),
    supabase
      .from('part_vendor_last_purchase')
      .select(
        'vendor_id, vendor_purchase_order_id, po_number, ordered_on, vendor_purchase_order_line_id, quantity, unit, unit_price, unit_price_per_stock_unit, stock_unit, stock_factor',
      )
      .eq('part_id', partId),
  ]);
  if (partRes.error) throw purchasingReadFailure(partRes.error, op, 'part');
  if (rowsRes.error) throw purchasingReadFailure(rowsRes.error, op, ENTITY);
  if (lastRes.error) throw purchasingReadFailure(lastRes.error, op, ENTITY);
  const part = partRes.data;
  if (!part) return null;

  const conversions = (part.parts_unit_conversions ?? []).map((c) => ({
    from_unit: c.from_unit,
    to_primary_factor: Number(c.to_primary_factor),
  }));
  const lastByVendor = new Map<string, PartVendorLastPurchase>();
  for (const r of lastRes.data ?? []) {
    if (!r.vendor_id || !r.vendor_purchase_order_id || !r.po_number || !r.vendor_purchase_order_line_id || !r.unit) continue;
    if (r.unit_price === null) continue;
    lastByVendor.set(r.vendor_id, {
      vendorPurchaseOrderId: r.vendor_purchase_order_id,
      poNumber: r.po_number,
      orderedOn: r.ordered_on,
      lineId: r.vendor_purchase_order_line_id,
      quantity: Number(r.quantity),
      unit: r.unit,
      unitPrice: Number(r.unit_price),
      unitPricePerStockUnit: numOrNull(r.unit_price_per_stock_unit),
      stockUnit: r.stock_unit,
      stockFactor: numOrNull(r.stock_factor),
    });
  }

  const rows: PartVendorRow[] = [];
  for (const r of rowsRes.data ?? []) {
    const vendor = one(r.vendors);
    if (!vendor) continue;
    const basis = resolvePartUnit(r.purchase_unit, part.primary_unit, conversions);
    rows.push({
      id: r.id,
      partId: r.part_id,
      vendorId: r.vendor_id,
      vendorName: vendor.name,
      status: status(r.status),
      statusNote: r.status_note,
      vendorPartNumber: r.vendor_part_number,
      purchaseUnit: r.purchase_unit,
      purchaseFactor: basis.kind === 'incomparable' ? null : basis.factor,
      factorLabel: factorLabel(basis),
      leadTimeDays: r.lead_time_days,
      minimumOrderQuantity: numOrNull(r.minimum_order_quantity),
      quotedOn: r.quoted_on,
      validUntil: r.valid_until,
      isExpired: expired(r.valid_until, options.today),
      notes: r.notes,
      isPreferred: part.preferred_vendor_id === r.vendor_id,
      breaks: (r.part_vendor_price_breaks ?? [])
        .map((b) => ({
          id: b.id,
          minQuantity: Number(b.min_quantity),
          unitPrice: Number(b.unit_price),
          source: b.source === 'rfq' ? ('rfq' as const) : ('manual' as const),
          vendorRfqResponseId: b.vendor_rfq_response_id,
        }))
        .sort((a, b) => a.minQuantity - b.minQuantity),
      lastPurchase: lastByVendor.get(r.vendor_id) ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  }
  rows.sort(
    (a, b) =>
      Number(b.isPreferred) - Number(a.isPreferred) ||
      a.vendorName.localeCompare(b.vendorName, undefined, { sensitivity: 'base' }),
  );

  return {
    part: {
      id: part.id,
      partName: part.part_name,
      source: part.source,
      stockUnit: part.primary_unit,
      preferredVendorId: part.preferred_vendor_id,
      conversions,
    },
    rows,
    preferredVendorMissing: part.preferred_vendor_id !== null && !rows.some((r) => r.isPreferred),
  };
}

/** The parts a vendor supplies (live rows on live parts) — the vendor page's "Parts supplied". */
export async function listVendorParts(vendorId: string, options: { today: string }): Promise<VendorPartRow[]> {
  const { data, error } = await getSupabase()
    .from('part_vendors')
    .select(
      'id, part_id, status, vendor_part_number, purchase_unit, lead_time_days, minimum_order_quantity, quoted_on, valid_until, parts!inner(id, part_name, description, source, deleted_at, preferred_vendor_id)',
    )
    .eq('vendor_id', vendorId)
    .is('deleted_at', null)
    .is('parts.deleted_at', null);
  if (error) throw purchasingReadFailure(error, 'load the parts this vendor supplies', ENTITY);

  const rows: VendorPartRow[] = [];
  for (const r of data ?? []) {
    const part = one(r.parts);
    if (!part) continue;
    rows.push({
      partVendorId: r.id,
      partId: r.part_id,
      partName: part.part_name,
      description: part.description,
      partSource: part.source,
      status: status(r.status),
      vendorPartNumber: r.vendor_part_number,
      purchaseUnit: r.purchase_unit,
      leadTimeDays: r.lead_time_days,
      minimumOrderQuantity: numOrNull(r.minimum_order_quantity),
      quotedOn: r.quoted_on,
      validUntil: r.valid_until,
      isExpired: expired(r.valid_until, options.today),
      isPreferred: part.preferred_vendor_id === vendorId,
    });
  }
  return rows.sort((a, b) => a.partName.localeCompare(b.partName, undefined, { sensitivity: 'base', numeric: true }));
}

// ------------------------------------------------------------------------------------------------
// Writes
// ------------------------------------------------------------------------------------------------

function changesJson(changes: PartVendorChanges | undefined, purchaseUnit: string | undefined): JsonObject {
  const out: JsonObject = {};
  if (!changes) return out;
  if (changes.status !== undefined) out.status = changes.status;
  if (changes.statusNote !== undefined) out.status_note = changes.statusNote;
  if (changes.vendorPartNumber !== undefined) out.vendor_part_number = changes.vendorPartNumber;
  if (purchaseUnit !== undefined) out.purchase_unit = purchaseUnit;
  else if (changes.purchaseUnit !== undefined) out.purchase_unit = changes.purchaseUnit;
  if (changes.leadTimeDays !== undefined) out.lead_time_days = changes.leadTimeDays;
  if (changes.minimumOrderQuantity !== undefined) out.minimum_order_quantity = changes.minimumOrderQuantity;
  if (changes.quotedOn !== undefined) out.quoted_on = changes.quotedOn;
  if (changes.validUntil !== undefined) out.valid_until = changes.validUntil;
  if (changes.notes !== undefined) out.notes = changes.notes;
  return out;
}

const saveResultSchema = z
  .object({
    part_vendor_id: z.string(),
    created: z.boolean(),
    revived: z.boolean(),
    preferred: z.boolean(),
  })
  .transform(
    (r): SavePartVendorResult => ({
      partVendorId: r.part_vendor_id,
      created: r.created,
      revived: r.revived,
      preferred: r.preferred,
    }),
  );

/**
 * Add, edit or revive a vendor on a part's list (`save_part_vendor`). Adding a vendor that was
 * archived brings the same row back. A given `priceBreaks` replaces the whole sheet; left out, the
 * sheet is untouched. The sheet's unit is stored as the part's conversion first when it is a preset
 * or a new "Another unit…".
 */
export async function savePartVendor(input: SavePartVendorInput): Promise<SavePartVendorResult> {
  let unit: string | undefined;
  const typed = input.changes?.purchaseUnit;
  if (typed !== undefined && typed !== null && typed.trim() !== '') {
    const resolved = await preparePurchaseUnits([
      { key: 'unit', partId: input.partId, unit: typed, unitFactor: input.purchaseUnitFactor ?? null },
    ]);
    unit = resolved.get('unit');
  }

  const { data, error } = await getSupabase().rpc('save_part_vendor', {
    p_part_id: input.partId,
    p_vendor_id: input.vendorId,
    p_changes: changesJson(input.changes, unit),
    p_price_breaks:
      input.priceBreaks === undefined || input.priceBreaks === null
        ? undefined
        : input.priceBreaks.map((b) => ({ min_quantity: b.minQuantity, unit_price: b.unitPrice })),
    p_make_preferred: Boolean(input.makePreferred),
  });
  if (error) throw purchasingRpcFailure(error, "save the part's vendor", ENTITY);
  return parsePurchasingResult(saveResultSchema, data, "save the part's vendor");
}

const archiveResultSchema = z
  .object({
    part_vendor_id: z.string(),
    archived: z.boolean(),
    cleared_preferred: z.boolean(),
  })
  .transform(
    (r): ArchivePartVendorResult => ({
      partVendorId: r.part_vendor_id,
      archived: r.archived,
      clearedPreferred: r.cleared_preferred,
    }),
  );

/** Take a vendor off a part's list (archive; the sheet is kept). Clears the preference if it was preferred. */
export async function archivePartVendor(partVendorId: string): Promise<ArchivePartVendorResult> {
  const { data, error } = await getSupabase().rpc('archive_part_vendor', { p_part_vendor_id: partVendorId });
  if (error) throw purchasingRpcFailure(error, "remove the vendor from the part's list", ENTITY);
  return parsePurchasingResult(archiveResultSchema, data, "remove the vendor from the part's list");
}

const nullableNumber = z
  .number()
  .nullish()
  .transform((v) => v ?? null);

const previewSchema = z.object({
  part_vendor_id: z.string(),
  part_id: z.string(),
  part_name: z.string(),
  vendor_id: z.string(),
  vendor_name: z.string(),
  purchase_unit: z.string(),
  stock_unit: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  stock_factor: z.number(),
  quoted_on: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  valid_until: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  tiers: z.array(
    z.object({
      tier_id: z.string(),
      quantity: z.number(),
      markup_percent: nullableNumber,
      current_cost: nullableNumber,
      proposed_cost: z.number(),
      current_price: nullableNumber,
      proposed_price: nullableNumber,
      vendor_min_quantity: nullableNumber,
      vendor_unit_price: nullableNumber,
      below_vendor_minimum: z.boolean(),
    }),
  ),
  inserts: z.array(
    z.object({
      quantity: z.number(),
      proposed_cost: z.number(),
      markup_percent: z.number(),
      vendor_min_quantity: nullableNumber,
      vendor_unit_price: nullableNumber,
    }),
  ),
  open_quote_count: z.number(),
  bom_parent_part_count: z.number(),
  warnings: z.array(z.string()),
});

/**
 * What "Use as part cost" would write, written nowhere (`preview_part_cost_from_vendor`, INVOKER).
 * Refused with a sentence for a made part, an expired or empty sheet, or an archived row.
 */
export async function previewPartCostFromVendor(partVendorId: string, today: string): Promise<PartCostPreview> {
  const op = 'preview the part cost';
  const { data, error } = await getSupabase().rpc('preview_part_cost_from_vendor', {
    p_part_vendor_id: partVendorId,
    p_today: today,
  });
  if (error) throw purchasingRpcFailure(error, op, 'part cost');
  const p = parsePurchasingResult(previewSchema, data, op);
  return {
    partVendorId: p.part_vendor_id,
    partId: p.part_id,
    partName: p.part_name,
    vendorId: p.vendor_id,
    vendorName: p.vendor_name,
    purchaseUnit: p.purchase_unit,
    stockUnit: p.stock_unit,
    stockFactor: p.stock_factor,
    quotedOn: p.quoted_on,
    validUntil: p.valid_until,
    tiers: p.tiers.map((t) => ({
      tierId: t.tier_id,
      quantity: t.quantity,
      markupPercent: t.markup_percent,
      currentCost: t.current_cost,
      proposedCost: t.proposed_cost,
      currentPrice: t.current_price,
      proposedPrice: t.proposed_price,
      vendorMinQuantity: t.vendor_min_quantity,
      vendorUnitPrice: t.vendor_unit_price,
      belowVendorMinimum: t.below_vendor_minimum,
    })),
    inserts: p.inserts.map((t) => ({
      quantity: t.quantity,
      proposedCost: t.proposed_cost,
      markupPercent: t.markup_percent,
      vendorMinQuantity: t.vendor_min_quantity,
      vendorUnitPrice: t.vendor_unit_price,
    })),
    openQuoteCount: p.open_quote_count,
    bomParentPartCount: p.bom_parent_part_count,
    warnings: p.warnings,
    // The database's own words, so the apply compares exactly what it computed.
    expected: data,
  };
}

/** The preview in the shape `sourcingPreviewRows` (lib/purchasing/sourcing.ts) renders. */
export function toSourcingPreview(preview: PartCostPreview): SourcingPreview {
  const below = preview.tiers.find((t) => t.belowVendorMinimum);
  return {
    vendorName: preview.vendorName,
    stockUnit: preview.stockUnit,
    purchaseUnit: preview.purchaseUnit,
    vendorMinimumQuantity: below?.vendorMinQuantity ?? null,
    tiers: preview.tiers.map((t) => ({
      tierId: t.tierId,
      quantity: t.quantity,
      currentCost: t.currentCost,
      proposedCost: t.proposedCost,
      markupPercent: t.markupPercent,
      currentPrice: t.currentPrice,
      proposedPrice: t.proposedPrice,
      belowVendorMinimum: t.belowVendorMinimum,
    })),
    inserts: preview.inserts.map((t) => ({
      tierId: null,
      quantity: t.quantity,
      currentCost: null,
      proposedCost: t.proposedCost,
      markupPercent: t.markupPercent,
    })),
  };
}

const applyResultSchema = z
  .object({
    part_id: z.string(),
    part_vendor_id: z.string(),
    updated_tier_ids: z.array(z.string()),
    inserted_tier_ids: z.array(z.string()),
  })
  .transform(
    (r): ApplyPartCostResult => ({
      partId: r.part_id,
      partVendorId: r.part_vendor_id,
      updatedTierIds: r.updated_tier_ids,
      insertedTierIds: r.inserted_tier_ids,
    }),
  );

/**
 * Apply "Use as part cost" — through `apply_part_cost_from_vendor` and nothing else. Pass the
 * preview's `expected` unchanged; the RPC refuses ("changed since you previewed") when the part's
 * pricing or the sheet moved, and otherwise updates the tiers IN PLACE (same ids and quantities,
 * markups untouched) or inserts them at 0% when the part had none.
 */
export async function applyPartCostFromVendor(
  partVendorId: string,
  today: string,
  expected: Json,
): Promise<ApplyPartCostResult> {
  const op = 'use the vendor price as the part cost';
  const { data, error } = await getSupabase().rpc('apply_part_cost_from_vendor', {
    p_part_vendor_id: partVendorId,
    p_today: today,
    p_expected: expected,
  });
  if (error) throw purchasingRpcFailure(error, op, 'part cost');
  return parsePurchasingResult(applyResultSchema, data, op);
}

// ------------------------------------------------------------------------------------------------
// Consequence counts — THROW on failure, never a 0 for "couldn't count"
// ------------------------------------------------------------------------------------------------

/** The part and every assembly above it in any BOM (one query per BOM level, never per row). */
async function partAndAncestors(partId: string, op: string): Promise<string[]> {
  const supabase = getSupabase();
  const seen = new Set<string>([partId]);
  let frontier = [partId];
  for (let depth = 0; frontier.length > 0 && depth < 50; depth++) {
    const next: string[] = [];
    for (const chunk of chunkIds(frontier)) {
      const { data, error } = await supabase.from('parts_bom').select('parent_part_id').in('child_part_id', chunk);
      if (error) throw purchasingReadFailure(error, op, 'part');
      for (const row of data ?? []) {
        if (!seen.has(row.parent_part_id)) {
          seen.add(row.parent_part_id);
          next.push(row.parent_part_id);
        }
      }
    }
    frontier = next;
  }
  return [...seen];
}

/**
 * Open quotes with this part on them, directly or through any assembly above it — the quotes
 * that will show "Pricing changed". The same rule `preview_part_cost_from_vendor` counts with
 * (`is_quote_open`, the caller's date). Throws when it cannot count.
 */
export async function countOpenQuotesWithPart(partId: string, today: string): Promise<number> {
  const op = 'count the open quotes with this part';
  const ids = await partAndAncestors(partId, op);
  const supabase = getSupabase();
  const openQuotes = (chunk: string[], head: boolean) =>
    supabase
      .from('quotes')
      .select('id, quote_line_items!inner(part_id)', { count: 'exact', head })
      .in('quote_line_items.part_id', chunk)
      .eq('status', 'active')
      .is('converted_at', null)
      .is('deleted_at', null)
      .or(`expiration_date.is.null,expiration_date.gte.${today}`);

  if (ids.length <= ID_CHUNK) {
    const { count, error } = await openQuotes(ids, true);
    if (error) throw purchasingReadFailure(error, op, 'quote');
    return present(count, 'the open quote count');
  }
  // More parts than one request can name: collect the quote ids per chunk and count them once.
  const quoteIds = new Set<string>();
  for (const chunk of chunkIds(ids)) {
    const { data, count, error } = await openQuotes(chunk, false);
    if (error) throw purchasingReadFailure(error, op, 'quote');
    const rows = data ?? [];
    if ((count ?? rows.length) > rows.length) throw new Error(`Failed to ${op}: there are too many to count here.`);
    for (const q of rows) quoteIds.add(q.id);
  }
  return quoteIds.size;
}

/** Live parts that use this one as material, at any BOM level — they re-cost. Throws when it cannot count. */
export async function countBomParents(partId: string): Promise<number> {
  const op = 'count the parts that use this part';
  const ancestors = (await partAndAncestors(partId, op)).filter((id) => id !== partId);
  if (ancestors.length === 0) return 0;
  let total = 0;
  for (const chunk of chunkIds(ancestors)) {
    const { count, error } = await getSupabase()
      .from('parts')
      .select('id', { count: 'exact', head: true })
      .in('id', chunk)
      .is('deleted_at', null);
    if (error) throw purchasingReadFailure(error, op, 'part');
    total += present(count, 'the parent part count');
  }
  return total;
}
