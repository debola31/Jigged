/**
 * The default price on a PO line, and the caption that names where it came from
 * (plan §3.5 "Price default", §3.8 "PO line warnings").
 *
 * TypeScript only, and the one implementation: the PO form, the buy list and the MCP tools all
 * reach it through the access layer, and the line stores the `price_source` it returns. It only
 * proposes — a PO price is a frozen term of the document and is never written back as a cost
 * (only the explicit "Use as part cost" action writes `part_pricing_tiers`).
 *
 * Part lines, first that applies:
 *   1. this vendor's VALID price sheet (`valid_until` null or on/after today): the highest break at
 *      or below the line quantity, compared in stock units;
 *   2. the Last PO price from this vendor — the newest priced line on a SENT, unarchived PO;
 *   3. the part cost estimate: tier `cost_per_unit` at the stock quantity × the line's factor;
 *   4. blank — "to be confirmed", printed TBC, and a QuickBooks push is refused.
 * Outside lines: the vendor service's current price, else the operation's frozen price, with
 * "Job costed at $X" when the two differ. A typed price always wins.
 */
import { formatUnitPrice } from '@/lib/money';
import { roundUnitPrice } from '@/lib/purchasing/amount';
import { convertUnitPrice, formatUnitQuantity, toStockQuantity, unitLabel } from '@/lib/purchasing/purchaseUnits';
import type { PartVendorStatus } from '@/lib/purchasing/vendorPoStatus';

/** `vendor_purchase_order_lines.price_source`. NULL with a NULL price means to be confirmed. */
export const VENDOR_PO_PRICE_SOURCES = ['price_sheet', 'last_po', 'estimate', 'vendor_service', 'rfq', 'manual'] as const;
export type VendorPoPriceSource = (typeof VENDOR_PO_PRICE_SOURCES)[number];

export interface PriceDefault {
  /** Per the line's purchase unit, at the stored 5 places; `null` = to be confirmed. */
  unitPrice: number | null;
  /** What to store in `price_source`; `null` exactly when the price is null. */
  priceSource: VendorPoPriceSource | null;
  /** Names the source: "Acme price sheet · 10+ bar · valid to 3/1/27". */
  caption: string;
  /** Things worth saying that did not change the answer: an expired sheet, a break minimum. */
  warnings: string[];
}

export interface PriceSheetBreak {
  /** In the sheet's purchase unit. */
  minQuantity: number;
  /** Per the sheet's purchase unit. */
  unitPrice: number;
}

/** This vendor's live `part_vendors` row for the part, with its breaks. */
export interface PriceSheet {
  vendorName: string;
  status?: PartVendorStatus | null;
  purchaseUnit: string;
  /** Stock units per sheet purchase unit (the unit's one factor for this part). */
  stockFactor: number;
  validUntil: string | null;
  breaks: readonly PriceSheetBreak[];
}

/** A priced line on an earlier PO for this part — the `part_vendor_last_purchase` candidates. */
export interface LastPurchaseCandidate {
  vendorId: string;
  poNumber: string;
  orderedOn: string | null;
  /** The PO was marked sent. Drafts never set a "last price". */
  isSent: boolean;
  isArchived?: boolean;
  unitPrice: number | null;
  unit: string;
  stockFactor: number;
}

/** A `part_pricing_tiers` row: `quantity` and `costPerUnit` are in the part's stock unit. */
export interface CostTier {
  quantity: number;
  costPerUnit: number | null;
}

export const NO_PRICE_CAPTION = 'No price yet — prints as TBC';
export const TYPED_PRICE_CAPTION = 'Typed';
export const ESTIMATE_CAPTION = 'Part cost estimate';

const QUANTITY_TOLERANCE = 1e-9;

/** "3/1/27" for `2027-03-01`, read straight from the date column with no timezone shift. */
export function formatShortDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return isoDate;
  return `${Number(m[2])}/${Number(m[3])}/${m[1].slice(2)}`;
}

function blank(warnings: string[] = []): PriceDefault {
  return { unitPrice: null, priceSource: null, caption: NO_PRICE_CAPTION, warnings };
}

function typed(price: number | null): PriceDefault {
  if (price === null || !Number.isFinite(price)) return blank();
  return { unitPrice: roundUnitPrice(price), priceSource: 'manual', caption: TYPED_PRICE_CAPTION, warnings: [] };
}

function isUsableFactor(f: number): boolean {
  return Number.isFinite(f) && f > 0;
}

/**
 * The break that applies at `stockQuantity`: the highest whose minimum (in stock units) is at or
 * below it, else the lowest, flagged as below the minimum.
 */
function pickBreak(
  breaks: readonly PriceSheetBreak[],
  sheetFactor: number,
  stockQuantity: number,
): { chosen: PriceSheetBreak; belowMinimum: boolean } | null {
  const usable = breaks
    .filter((b) => Number.isFinite(b.minQuantity) && b.minQuantity > 0 && Number.isFinite(b.unitPrice) && b.unitPrice >= 0)
    .sort((a, b) => a.minQuantity - b.minQuantity);
  if (usable.length === 0) return null;
  const qualifying = usable.filter(
    (b) => toStockQuantity(b.minQuantity, sheetFactor) <= stockQuantity + QUANTITY_TOLERANCE * Math.max(1, stockQuantity),
  );
  if (qualifying.length > 0) return { chosen: qualifying[qualifying.length - 1], belowMinimum: false };
  return { chosen: usable[0], belowMinimum: true };
}

function newestSentPurchase(candidates: readonly LastPurchaseCandidate[], vendorId: string): LastPurchaseCandidate | null {
  let newest: LastPurchaseCandidate | null = null;
  for (const c of candidates) {
    if (c.vendorId !== vendorId || !c.isSent || c.isArchived) continue;
    if (c.unitPrice === null || !Number.isFinite(c.unitPrice) || !isUsableFactor(c.stockFactor)) continue;
    // Newest by order date; among equal dates the first one given wins (pass newest first).
    if (newest === null || (c.orderedOn ?? '') > (newest.orderedOn ?? '')) newest = c;
  }
  return newest;
}

function estimateCost(tiers: readonly CostTier[], stockQuantity: number): number | null {
  const priced = tiers
    .filter((t): t is { quantity: number; costPerUnit: number } =>
      t.costPerUnit !== null && Number.isFinite(t.costPerUnit) && t.costPerUnit >= 0 && Number.isFinite(t.quantity))
    .sort((a, b) => a.quantity - b.quantity);
  if (priced.length === 0) return null;
  const atOrBelow = priced.filter((t) => t.quantity <= stockQuantity + QUANTITY_TOLERANCE * Math.max(1, stockQuantity));
  return (atOrBelow.length > 0 ? atOrBelow[atOrBelow.length - 1] : priced[0]).costPerUnit;
}

/**
 * The default unit price for a PART line, per the line's purchase unit.
 *
 * `typedPrice`: leave it out while the user has not touched the field; pass a number for a price
 * they typed, or `null` for one they deliberately cleared (to be confirmed).
 */
export function defaultPartLinePrice(args: {
  vendorId: string;
  vendorName: string;
  /** In the line's purchase unit. */
  quantity: number;
  unit: string;
  /** Stock units per line purchase unit. */
  stockFactor: number;
  /** The caller's local date, YYYY-MM-DD. */
  today: string;
  sheet?: PriceSheet | null;
  lastPurchases?: readonly LastPurchaseCandidate[];
  costTiers?: readonly CostTier[];
  typedPrice?: number | null;
}): PriceDefault {
  if (args.typedPrice !== undefined) return typed(args.typedPrice);
  if (!isUsableFactor(args.stockFactor)) return blank();

  const warnings: string[] = [];
  const quantity = Number.isFinite(args.quantity) && args.quantity > 0 ? args.quantity : 0;
  const stockQuantity = toStockQuantity(quantity, args.stockFactor);

  // 1. This vendor's valid price sheet. A Do-not-use vendor's sheet is never a price.
  const sheet = args.sheet;
  if (sheet && sheet.status !== 'disapproved' && isUsableFactor(sheet.stockFactor)) {
    if (sheet.validUntil && sheet.validUntil < args.today) {
      warnings.push(`${sheet.vendorName}'s sheet expired ${formatShortDate(sheet.validUntil)} — not used`);
    } else {
      const picked = pickBreak(sheet.breaks, sheet.stockFactor, stockQuantity);
      if (picked) {
        const sheetUnit = unitLabel(sheet.purchaseUnit);
        // Only for a real quantity: before one is typed, "below the minimum" is just noise.
        if (picked.belowMinimum && quantity > 0) {
          warnings.push(`Below ${sheet.vendorName}'s ${formatUnitQuantity(picked.chosen.minQuantity)} ${sheetUnit} minimum`);
        }
        const validity = sheet.validUntil ? ` · valid to ${formatShortDate(sheet.validUntil)}` : '';
        return {
          unitPrice: convertUnitPrice(picked.chosen.unitPrice, sheet.stockFactor, args.stockFactor),
          priceSource: 'price_sheet',
          caption: `${sheet.vendorName} price sheet · ${formatUnitQuantity(picked.chosen.minQuantity)}+ ${sheetUnit}${validity}`,
          warnings,
        };
      }
    }
  }

  // 2. The Last PO price — sent POs to THIS vendor only.
  const last = newestSentPurchase(args.lastPurchases ?? [], args.vendorId);
  if (last && last.unitPrice !== null) {
    const when = last.orderedOn ? ` (${formatShortDate(last.orderedOn)})` : '';
    return {
      unitPrice: convertUnitPrice(last.unitPrice, last.stockFactor, args.stockFactor),
      priceSource: 'last_po',
      caption: `Last PO price · ${last.poNumber}${when}`,
      warnings,
    };
  }

  // 3. The part cost estimate: cost per stock unit at the stock quantity, times the factor.
  const cost = estimateCost(args.costTiers ?? [], stockQuantity);
  if (cost !== null) {
    return { unitPrice: convertUnitPrice(cost, 1, args.stockFactor), priceSource: 'estimate', caption: ESTIMATE_CAPTION, warnings };
  }

  // 4. Nothing: to be confirmed.
  return blank(warnings);
}

/** Two prices differ when they differ at the stored precision. */
function samePrice(a: number, b: number): boolean {
  return roundUnitPrice(a) === roundUnitPrice(b);
}

/** The default unit price for an OUTSIDE-SERVICE line, per piece. */
export function defaultOutsideLinePrice(args: {
  vendorName: string;
  serviceName: string | null;
  /** `vendor_services.unit_price` now; null when the service has no price. */
  vendorServicePrice: number | null;
  /** `job_operations.external_unit_price_snapshot` — what the job was costed at. */
  frozenOperationPrice: number | null;
  typedPrice?: number | null;
}): PriceDefault {
  if (args.typedPrice !== undefined) return typed(args.typedPrice);
  const service = args.vendorServicePrice;
  const frozen = args.frozenOperationPrice;
  const frozenUsable = frozen !== null && Number.isFinite(frozen);
  if (service !== null && Number.isFinite(service)) {
    const name = args.serviceName?.trim()
      ? `${args.vendorName}'s price for ${args.serviceName.trim()}`
      : `${args.vendorName}'s service price`;
    const costed = frozenUsable && !samePrice(service, frozen) ? ` · Job costed at ${formatUnitPrice(frozen)}` : '';
    return { unitPrice: roundUnitPrice(service), priceSource: 'vendor_service', caption: `${name}${costed}`, warnings: [] };
  }
  if (frozenUsable) {
    return { unitPrice: roundUnitPrice(frozen), priceSource: 'estimate', caption: `Job costed at ${formatUnitPrice(frozen)}`, warnings: [] };
  }
  return blank();
}

export interface PartVendorLineNotice {
  /** `quiet`: a caption · `warning`: amber · `blocked`: the line cannot be saved. */
  tone: 'quiet' | 'warning' | 'blocked';
  text: string;
  /** `add_to_list` offers "Add to list" beside a vendor that is not on it. */
  action: 'add_to_list' | null;
}

/**
 * The approved-vendor note under a part line (plan §3.8): nothing for Approved; a quiet caption
 * with "Add to list" for a vendor not on the list (the preferred-vendor backfill makes most lists
 * one row long, so this must not shout); amber for Conditional; Do not use blocks the line — the
 * RPC refuses it too.
 */
export function partVendorLineNotice(args: {
  vendorName: string;
  /** The vendor's `part_vendors.status` for this part; `null` when it has no live row. */
  status: PartVendorStatus | null;
  statusNote?: string | null;
}): PartVendorLineNotice | null {
  const { vendorName, status } = args;
  if (status === 'approved') return null;
  if (status === null) {
    return { tone: 'quiet', text: `${vendorName} isn't on this part's approved vendor list.`, action: 'add_to_list' };
  }
  if (status === 'conditional') {
    const note = args.statusNote?.trim();
    return {
      tone: 'warning',
      text: note ? `${vendorName} is Conditional for this part — ${note}` : `${vendorName} is Conditional for this part.`,
      action: null,
    };
  }
  return { tone: 'blocked', text: `${vendorName} is marked Do not use for this part, so it can't go on this PO.`, action: null };
}
