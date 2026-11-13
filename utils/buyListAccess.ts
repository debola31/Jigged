/**
 * "Shortages" — the access layer that feeds `lib/purchasing/buyList.ts` (plan §3.10, criterion B3).
 *
 * IT ONLY PROPOSES. Nothing here writes: a person reads the list and creates a draft PO through
 * `createVendorPo` (or starts an RFQ for the "No vendor chosen" group).
 *
 * A FIXED NUMBER OF READS, never one per row — six, in parallel, whatever the shop's size (the
 * N+1 lesson of issue #68, pinned by the test):
 *   1. job_parts   open job parts on live jobs, each with its job, its part's BOM lines (top-level
 *                  materials only) and what has shipped (bought parts still to ship)
 *   2. parts       live bought parts: on hand, reorder point, preferred vendor, units, cost tiers,
 *                  and the approved-vendor rows with their price breaks
 *   3. inventory_transactions   what open jobs have already taken (issued, per job and part)
 *   4. part_on_order            sent and draft quantities, in stock units
 *   5. vendor_purchase_orders   live drafts, for "Add to draft PO-1043"
 *   6. part_vendor_last_purchase  Last PO prices
 * Each read takes at most one PostgREST page (BUY_LIST_READ_CAP) with an exact count, so a capped
 * read is NAMED in `truncatedSources` — the silent `.range(0, 999)` of 87df208 is what this
 * replaces.
 */
import { getSupabase } from '@/lib/supabase';
import { requiredQuantity, resolveUnitBasis } from '@/lib/materialRequirements';
import { vendorPoLineAmount } from '@/lib/purchasing/amount';
import {
  buildBuyList,
  evaluateBuyListPart,
  type BuyListDemand,
  type BuyListDraftRef,
  type BuyListPart,
  type BuyListRow,
  type BuyListVendorChoice,
  type BuyListVendorOption,
} from '@/lib/purchasing/buyList';
import { defaultPartLinePrice, type PriceDefault, type PriceSheet } from '@/lib/purchasing/priceDefault';
import { PART_VENDOR_STATUSES, type PartVendorStatus } from '@/lib/purchasing/vendorPoStatus';
import { sumDecimal } from '@/lib/money';
import { one, purchasingReadFailure, resolvePartUnit } from '@/utils/purchasingShared';
import {
  BUY_LIST_READ_CAP,
  type BuyListPriceInputs,
  type BuyListPricedGroup,
  type BuyListPricedRow,
  type BuyListResult,
  type BuyListSnapshot,
  type BuyListSource,
  type BuyListVendorPrice,
} from '@/types/buyList';

/** Job parts still being made draw their BOM; finished ones have drawn it. */
const MATERIAL_OPEN_STATUSES = new Set(['not_started', 'in_progress']);

function partVendorStatus(value: string): PartVendorStatus | null {
  return (PART_VENDOR_STATUSES as readonly string[]).includes(value) ? (value as PartVendorStatus) : null;
}

/** Load everything the list is built from: six reads, in parallel, none per row. */
export async function loadBuyListSnapshot(companyId: string): Promise<BuyListSnapshot> {
  const supabase = getSupabase();
  const last = BUY_LIST_READ_CAP - 1;
  const op = 'load the buy list';

  const [jobPartsRes, partsRes, issuedRes, onOrderRes, draftsRes, lastRes] = await Promise.all([
    supabase
      .from('job_parts')
      .select(
        `id, job_id, part_id, quantity, production_status, fulfillment_status,
         jobs!inner(id, job_number, due_date, production_status, deleted_at),
         parts!job_parts_part_id_fkey(id, part_name, source, deleted_at, parts_bom!parts_bom_parent_part_id_fkey(id, child_part_id, quantity, unit)),
         shipment_line_items(quantity, shipments(voided_at))`,
        { count: 'exact' },
      )
      .eq('company_id', companyId)
      .is('jobs.deleted_at', null)
      .neq('jobs.production_status', 'cancelled')
      .neq('production_status', 'cancelled')
      // Still being made (its material is still to issue), or not fully shipped (a bought part
      // is `completed` the moment the job exists, so its shipping is what is still open).
      .or('production_status.in.(not_started,in_progress),fulfillment_status.neq.fully_shipped')
      .order('id', { ascending: true })
      .range(0, last),
    supabase
      .from('parts')
      .select(
        `id, part_name, source, primary_unit, quantity, reorder_point, preferred_vendor_id,
         parts_unit_conversions(from_unit, to_primary_factor),
         part_pricing_tiers(quantity, cost_per_unit),
         part_vendors(id, vendor_id, status, purchase_unit, minimum_order_quantity, lead_time_days, valid_until, deleted_at, vendors(id, name, deleted_at), part_vendor_price_breaks(min_quantity, unit_price))`,
        { count: 'exact' },
      )
      .eq('company_id', companyId)
      .eq('source', 'bought')
      .is('deleted_at', null)
      .order('part_name', { ascending: true })
      .range(0, last),
    supabase
      .from('inventory_transactions')
      .select('job_id, part_id, converted_quantity, jobs!inner(production_status, deleted_at)', { count: 'exact' })
      .eq('company_id', companyId)
      .eq('type', 'depletion')
      .not('job_id', 'is', null)
      .is('jobs.deleted_at', null)
      .in('jobs.production_status', [...MATERIAL_OPEN_STATUSES])
      .order('created_at', { ascending: true })
      .range(0, last),
    supabase
      .from('part_on_order')
      .select('part_id, on_order_quantity, on_draft_quantity', { count: 'exact' })
      .eq('company_id', companyId)
      .range(0, last),
    supabase
      .from('vendor_purchase_orders')
      .select('id, po_number, vendor_id, created_at', { count: 'exact' })
      .eq('company_id', companyId)
      .is('issued_at', null)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .range(0, last),
    supabase
      .from('part_vendor_last_purchase')
      .select('part_id, vendor_id, po_number, ordered_on, unit, unit_price, stock_factor', { count: 'exact' })
      .eq('company_id', companyId)
      .range(0, last),
  ]);
  if (jobPartsRes.error) throw purchasingReadFailure(jobPartsRes.error, op, 'job');
  if (partsRes.error) throw purchasingReadFailure(partsRes.error, op, 'part');
  if (issuedRes.error) throw purchasingReadFailure(issuedRes.error, op, 'stock');
  if (onOrderRes.error) throw purchasingReadFailure(onOrderRes.error, op, 'purchase order');
  if (draftsRes.error) throw purchasingReadFailure(draftsRes.error, op, 'purchase order');
  if (lastRes.error) throw purchasingReadFailure(lastRes.error, op, 'purchase order');

  const truncatedSources: BuyListSource[] = [];
  const capped = (source: BuyListSource, res: { data: unknown[] | null; count: number | null }) => {
    const rows = res.data?.length ?? 0;
    if ((res.count ?? rows) > rows) truncatedSources.push(source);
  };
  capped('job_parts', jobPartsRes);
  capped('parts', partsRes);
  capped('issued', issuedRes);
  capped('on_order', onOrderRes);
  capped('drafts', draftsRes);
  capped('last_purchases', lastRes);

  // On order and on draft, per part, in stock units.
  const onOrder = new Map<string, { onOrder: number; onDraft: number }>();
  for (const row of onOrderRes.data ?? []) {
    if (!row.part_id) continue;
    onOrder.set(row.part_id, { onOrder: Number(row.on_order_quantity ?? 0), onDraft: Number(row.on_draft_quantity ?? 0) });
  }

  // Issued per (job, part): the job-level figure every one of the job's lines carries.
  const issued = new Map<string, number>();
  for (const row of issuedRes.data ?? []) {
    if (!row.job_id || !row.part_id) continue;
    const key = `${row.job_id}:${row.part_id}`;
    issued.set(key, (issued.get(key) ?? 0) + (Number(row.converted_quantity) || 0));
  }

  // The parts, with their vendors and price inputs.
  const parts: BuyListPart[] = [];
  const priceInputsByPart: Record<string, BuyListPriceInputs> = {};
  const unitFacts = new Map<string, { stockUnit: string | null; conversions: Map<string, number> }>();
  for (const p of partsRes.data ?? []) {
    const conversions = (p.parts_unit_conversions ?? []).map((c) => ({
      from_unit: c.from_unit,
      to_primary_factor: Number(c.to_primary_factor),
    }));
    unitFacts.set(p.id, {
      stockUnit: p.primary_unit,
      conversions: new Map(conversions.map((c) => [c.from_unit, c.to_primary_factor])),
    });

    const vendors: BuyListVendorOption[] = [];
    const sheetsByVendor: Record<string, PriceSheet> = {};
    for (const pv of p.part_vendors ?? []) {
      if (pv.deleted_at) continue;
      const vendor = one(pv.vendors);
      const status = partVendorStatus(pv.status);
      if (!vendor || !status) continue;
      const basis = resolvePartUnit(pv.purchase_unit, p.primary_unit, conversions);
      const factor = basis.kind === 'incomparable' ? null : basis.factor;
      vendors.push({
        partVendorId: pv.id,
        vendorId: pv.vendor_id,
        vendorName: vendor.name,
        status,
        vendorArchived: vendor.deleted_at !== null,
        purchaseUnit: basis.unit || pv.purchase_unit,
        purchaseFactor: factor,
        minimumOrderQuantity: pv.minimum_order_quantity === null ? null : Number(pv.minimum_order_quantity),
        leadTimeDays: pv.lead_time_days,
      });
      const breaks = (pv.part_vendor_price_breaks ?? []).map((b) => ({
        minQuantity: Number(b.min_quantity),
        unitPrice: Number(b.unit_price),
      }));
      if (factor !== null && breaks.length > 0) {
        sheetsByVendor[pv.vendor_id] = {
          vendorName: vendor.name,
          status,
          purchaseUnit: basis.unit,
          stockFactor: factor,
          validUntil: pv.valid_until,
          breaks,
        };
      }
    }
    const placed = onOrder.get(p.id);
    parts.push({
      partId: p.id,
      partName: p.part_name,
      source: p.source,
      stockUnit: p.primary_unit,
      onHand: Number(p.quantity) || 0,
      onOrder: placed?.onOrder ?? 0,
      onDraft: placed?.onDraft ?? 0,
      reorderPoint: p.reorder_point === null ? null : Number(p.reorder_point),
      isArchived: false,
      preferredVendorId: p.preferred_vendor_id,
      vendors,
    });
    priceInputsByPart[p.id] = {
      sheetsByVendor,
      lastPurchases: [],
      costTiers: (p.part_pricing_tiers ?? []).map((t) => ({
        quantity: Number(t.quantity),
        costPerUnit: t.cost_per_unit === null ? null : Number(t.cost_per_unit),
      })),
    };
  }

  for (const r of lastRes.data ?? []) {
    if (!r.part_id || !r.vendor_id || !r.po_number || !r.unit || r.stock_factor === null) continue;
    const inputs = priceInputsByPart[r.part_id];
    if (!inputs) continue;
    inputs.lastPurchases.push({
      vendorId: r.vendor_id,
      poNumber: r.po_number,
      orderedOn: r.ordered_on,
      isSent: true, // the view counts sent, unarchived POs only
      isArchived: false,
      unitPrice: r.unit_price === null ? null : Number(r.unit_price),
      unit: r.unit,
      stockFactor: Number(r.stock_factor),
    });
  }

  // Demand: BOM material still to issue on job parts being made, and bought parts still to ship.
  const demand: BuyListDemand[] = [];
  for (const jp of jobPartsRes.data ?? []) {
    const job = one(jp.jobs);
    const part = one(jp.parts);
    if (!job || !part || part.deleted_at) continue;

    if (MATERIAL_OPEN_STATUSES.has(jp.production_status)) {
      for (const line of part.parts_bom ?? []) {
        const facts = unitFacts.get(line.child_part_id);
        if (!facts) continue; // not a live bought part: the list never proposes it
        const basis = resolveUnitBasis(line.unit, facts.stockUnit, facts.conversions.get(line.unit) ?? null);
        const inBom = requiredQuantity(Number(jp.quantity) || 0, Number(line.quantity) || 0);
        demand.push({
          kind: 'material',
          partId: line.child_part_id,
          jobId: job.id,
          jobNumber: job.job_number,
          jobPartId: jp.id,
          madePartName: part.part_name,
          dueDate: job.due_date,
          requiredInStockUnit:
            basis.kind === 'incomparable' ? null : basis.kind === 'same' ? inBom : inBom * basis.factor,
          issued: issued.get(`${job.id}:${line.child_part_id}`) ?? 0,
        });
      }
    }

    if (part.source === 'bought' && jp.fulfillment_status !== 'fully_shipped') {
      const shipped = (jp.shipment_line_items ?? [])
        .filter((s) => !one(s.shipments)?.voided_at)
        .reduce((n, s) => n + Number(s.quantity), 0);
      const stillToShip = Math.max(0, Number(jp.quantity) - shipped);
      if (stillToShip > 0) {
        demand.push({
          kind: 'bought_part',
          partId: part.id,
          jobId: job.id,
          jobNumber: job.job_number,
          jobPartId: jp.id,
          dueDate: job.due_date,
          stillToShip,
        });
      }
    }
  }

  // The newest live draft per vendor.
  const draftsByVendor: Record<string, BuyListDraftRef> = {};
  for (const d of draftsRes.data ?? []) {
    if (!draftsByVendor[d.vendor_id]) draftsByVendor[d.vendor_id] = { vendorPurchaseOrderId: d.id, poNumber: d.po_number };
  }

  return { parts, demand, draftsByVendor, priceInputsByPart, truncatedSources };
}

/**
 * The default price for a buy-list row from `vendor`, at `quantity` — the suggestion's own, or one
 * somebody TYPED on the list (a price break can move with it). `lib/purchasing/priceDefault` over
 * the snapshot's own inputs for that part, so the list's price and a re-price for a typed quantity
 * are one rule, and neither makes a request.
 */
export function priceBuyListRowAt(
  snapshot: Pick<BuyListSnapshot, 'priceInputsByPart'>,
  row: Pick<BuyListRow, 'partId' | 'purchaseUnit' | 'purchaseFactor'>,
  vendor: { vendorId: string; vendorName: string } | null,
  quantity: number,
  today: string,
): PriceDefault {
  const inputs = snapshot.priceInputsByPart[row.partId];
  return defaultPartLinePrice({
    vendorId: vendor?.vendorId ?? '',
    vendorName: vendor?.vendorName ?? '',
    quantity,
    unit: row.purchaseUnit,
    stockFactor: row.purchaseFactor,
    today,
    sheet: vendor ? (inputs?.sheetsByVendor[vendor.vendorId] ?? null) : null,
    lastPurchases: inputs?.lastPurchases ?? [],
    costTiers: inputs?.costTiers ?? [],
  });
}

function priceFor(
  snapshot: BuyListSnapshot,
  row: Pick<BuyListRow, 'partId' | 'suggestedQuantity' | 'purchaseUnit' | 'purchaseFactor'>,
  vendor: { vendorId: string; vendorName: string } | null,
  today: string,
): { price: PriceDefault; amount: number | null } {
  const price = priceBuyListRowAt(snapshot, row, vendor, row.suggestedQuantity, today);
  return { price, amount: vendorPoLineAmount(row.suggestedQuantity, price.unitPrice) };
}

/**
 * Build the priced list from a loaded snapshot (pure). Re-run it with new `chosenVendors` when
 * "Buy from" changes — no read needed. `today` is the caller's local date (sheet validity).
 */
export function buildBuyListFromSnapshot(
  snapshot: BuyListSnapshot,
  options: { today: string; chosenVendors?: Record<string, BuyListVendorChoice | undefined> },
): BuyListResult {
  const list = buildBuyList({
    parts: snapshot.parts,
    demand: snapshot.demand,
    chosenVendors: options.chosenVendors,
    draftsByVendor: snapshot.draftsByVendor,
  });
  const partsById = new Map(snapshot.parts.map((p) => [p.partId, p]));
  const demandByPart = new Map<string, BuyListDemand[]>();
  for (const d of snapshot.demand) demandByPart.set(d.partId, [...(demandByPart.get(d.partId) ?? []), d]);

  const groups: BuyListPricedGroup[] = list.groups.map((group) => {
    const rows: BuyListPricedRow[] = group.rows.map((row) => {
      const own = priceFor(snapshot, row, row.vendor, options.today);
      const part = partsById.get(row.partId);
      const vendorPrices: BuyListVendorPrice[] = [];
      if (part) {
        const usable = part.vendors
          .filter((v) => v.status !== 'disapproved' && !v.vendorArchived)
          .sort((a, b) => Number(b.status === 'approved') - Number(a.status === 'approved') || a.vendorName.localeCompare(b.vendorName));
        for (const v of usable) {
          const evaluated = evaluateBuyListPart(part, demandByPart.get(part.partId) ?? [], {
            vendorId: v.vendorId,
            vendorName: v.vendorName,
          }).row;
          if (!evaluated) continue;
          const priced = priceFor(snapshot, evaluated, v, options.today);
          vendorPrices.push({
            vendorId: v.vendorId,
            vendorName: v.vendorName,
            partVendorId: v.partVendorId,
            status: v.status,
            purchaseUnit: evaluated.purchaseUnit,
            suggestedQuantity: evaluated.suggestedQuantity,
            price: priced.price,
            amount: priced.amount,
          });
        }
      }
      return { ...row, price: own.price, amount: own.amount, vendorPrices };
    });
    return {
      ...group,
      rows,
      total: sumDecimal(rows.map((r) => r.amount).filter((a): a is number => a !== null)),
    };
  });

  return {
    ...list,
    groups,
    truncated: snapshot.truncatedSources.length > 0,
    truncatedSources: snapshot.truncatedSources,
    snapshot,
  };
}

/**
 * The shop's "Shortages" list (the hub's Shortages tab, and MCP `get_buy_list`). Reads only.
 * `today` is the caller's local date; `chosenVendors` carries the page's "Buy from" picks.
 */
export async function getBuyList(
  companyId: string,
  options: { today: string; chosenVendors?: Record<string, BuyListVendorChoice | undefined> },
): Promise<BuyListResult> {
  const snapshot = await loadBuyListSnapshot(companyId);
  return buildBuyListFromSnapshot(snapshot, options);
}
