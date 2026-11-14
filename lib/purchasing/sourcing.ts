/**
 * "Use as part cost" — words for the preview (plan §3.8 "Approved vendors, price sheets, sourcing").
 *
 * The DATABASE does the maths: `preview_part_cost_from_vendor` proposes each tier's new cost (the
 * vendor's price at that tier's quantity ÷ the unit factor), and `apply_part_cost_from_vendor` is the
 * only purchasing writer of `part_pricing_tiers` — in place, keeping tier ids, quantities and
 * markups, and refusing if anything changed since the preview. These helpers only turn that preview
 * into rows and sentences, so the dialog can never show a number the database did not compute.
 *
 * A consequence count that FAILED is `null` and reads "couldn't count" — never 0, which would
 * claim nothing is affected.
 */
import { formatUnitPrice } from '@/lib/money';
import { formatUnitQuantity, unitLabel } from '@/lib/purchasing/purchaseUnits';

/** One tier in `preview_part_cost_from_vendor`'s result (an existing tier, or one to insert). */
export interface SourcingPreviewTier {
  /** `null` for a tier the apply will insert (the part has none yet). */
  tierId: string | null;
  /** In the part's stock unit. */
  quantity: number;
  currentCost: number | null;
  proposedCost: number;
  /** Unchanged by the apply; inserted tiers start at the 0% starter markup. */
  markupPercent: number | null;
  currentPrice?: number | null;
  proposedPrice?: number | null;
  belowVendorMinimum?: boolean;
}

export interface SourcingPreview {
  vendorName: string;
  stockUnit: string | null;
  /** The vendor's purchase unit, for the minimum-order note. */
  purchaseUnit: string;
  /** The vendor's lowest break, in its purchase unit. */
  vendorMinimumQuantity?: number | null;
  tiers: readonly SourcingPreviewTier[];
  inserts?: readonly SourcingPreviewTier[];
}

export interface SourcingPreviewRow {
  key: string;
  isNew: boolean;
  quantityLabel: string;
  costBefore: string;
  costAfter: string;
  costChanged: boolean;
  markupLabel: string;
  priceBefore: string;
  priceAfter: string;
  priceChanged: boolean;
  note: string | null;
}

/** A quote flags "Pricing changed" only past half a cent; the preview uses the same line. */
const DRIFT = 0.005;

function changed(before: number | null | undefined, after: number | null | undefined): boolean {
  const a = before ?? null;
  const b = after ?? null;
  if (a === null || b === null) return a !== b;
  return Math.abs(a - b) > DRIFT;
}

function percent(n: number): string {
  return `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
}

/** The preview as rows: quantity · cost now → new · markup unchanged · price now → new. */
export function sourcingPreviewRows(preview: SourcingPreview): SourcingPreviewRow[] {
  const stock = preview.stockUnit ? ` ${unitLabel(preview.stockUnit)}` : '';
  const minimumNote =
    preview.vendorMinimumQuantity !== null && preview.vendorMinimumQuantity !== undefined
      ? `Below ${preview.vendorName}'s ${formatUnitQuantity(preview.vendorMinimumQuantity)} ${unitLabel(preview.purchaseUnit)} minimum`
      : `Below ${preview.vendorName}'s minimum order`;

  const toRow = (tier: SourcingPreviewTier, key: string, isNew: boolean): SourcingPreviewRow => {
    let markupLabel = 'No markup set';
    if (tier.markupPercent !== null && Number.isFinite(tier.markupPercent)) {
      markupLabel = `${percent(tier.markupPercent)} · ${isNew ? 'new' : 'unchanged'}`;
    }
    return {
      key,
      isNew,
      quantityLabel: `${formatUnitQuantity(tier.quantity)}${stock}`,
      costBefore: formatUnitPrice(tier.currentCost),
      costAfter: formatUnitPrice(tier.proposedCost),
      costChanged: changed(tier.currentCost, tier.proposedCost),
      markupLabel,
      priceBefore: formatUnitPrice(tier.currentPrice ?? null),
      priceAfter: formatUnitPrice(tier.proposedPrice ?? null),
      priceChanged: changed(tier.currentPrice, tier.proposedPrice),
      note: tier.belowVendorMinimum ? minimumNote : null,
    };
  };

  return [
    ...preview.tiers.map((t, i) => toRow(t, t.tierId ?? `tier-${i}`, false)),
    ...(preview.inserts ?? []).map((t, i) => toRow(t, `new-${i}`, true)),
  ];
}

/**
 * What applying changes elsewhere, in plain words. `null` means the count failed — said as
 * "couldn't count", never as 0.
 */
export function sourcingConsequences(counts: { openQuoteCount: number | null; bomParentCount: number | null }): string[] {
  const { openQuoteCount: quotes, bomParentCount: parents } = counts;

  let quoteLine: string;
  if (quotes === null || !Number.isFinite(quotes)) {
    quoteLine = 'Quotes keep their prices; couldn\'t count the open quotes with this part.';
  } else if (quotes === 0) {
    quoteLine = 'Quotes keep their prices; no open quotes include this part.';
  } else {
    quoteLine = `Quotes keep their prices; ${quotes} open ${quotes === 1 ? 'quote' : 'quotes'} with this part will show Pricing changed.`;
  }

  let parentLine: string;
  if (parents === null || !Number.isFinite(parents)) {
    parentLine = 'Couldn\'t count the parts using it as material.';
  } else if (parents === 0) {
    parentLine = 'No parts use it as material.';
  } else {
    parentLine = parents === 1 ? '1 part using it as material re-costs.' : `${parents} parts using it as material re-cost.`;
  }

  return [quoteLine, parentLine, 'Existing jobs keep their frozen cost.'];
}
