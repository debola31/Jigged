/**
 * The shape of a new purchase order, for the `vendor po created` event (docs/telemetry.md).
 *
 * Every surface that creates a PO — the form, Duplicate, the buy list, an RFQ award — sends the
 * SAME counts, so the event answers one question across all of them: how much of a PO the price
 * default filled in, and how much a person typed. Here once so the call sites cannot drift into
 * counting the same lines differently.
 *
 * Counts only. Never a price, a part, a vendor or a job: those are the shop's business data.
 *
 * The call site still writes every property key literally — `posthog.capture('vendor po created',
 * { surface, part_line_count: shape.partLineCount, … })` — because the registry check reads keys
 * off the object literal and a spread would hide them (scripts/analyticsEventsCheck.ts).
 */
import type { VendorPoLineKind, VendorPoPriceSource } from '@/types/vendorPo';

/** One line as created: its kind, whether it names a job, and where its price came from. */
export interface VendorPoCreatedLine {
  lineKind: VendorPoLineKind;
  jobId?: string | null;
  /** The price that was saved; `null` or omitted = to be confirmed (TBC). */
  unitPrice?: number | null;
  /** The source saved with it. A price with no source is stored as `manual` (typed). */
  priceSource?: VendorPoPriceSource | null;
}

export interface VendorPoCreatedShape {
  partLineCount: number;
  outsideLineCount: number;
  otherLineCount: number;
  /** Lines that name a job (outside lines always do, through their routing step). */
  jobLinkedLineCount: number;
  priceSheetLineCount: number;
  lastPoPriceLineCount: number;
  estimatePriceLineCount: number;
  vendorServicePriceLineCount: number;
  rfqPriceLineCount: number;
  typedPriceLineCount: number;
  unpricedLineCount: number;
}

/** Count a new PO's lines by kind and by where each price came from. */
export function vendorPoCreatedShape(lines: readonly VendorPoCreatedLine[]): VendorPoCreatedShape {
  const shape: VendorPoCreatedShape = {
    partLineCount: 0,
    outsideLineCount: 0,
    otherLineCount: 0,
    jobLinkedLineCount: 0,
    priceSheetLineCount: 0,
    lastPoPriceLineCount: 0,
    estimatePriceLineCount: 0,
    vendorServicePriceLineCount: 0,
    rfqPriceLineCount: 0,
    typedPriceLineCount: 0,
    unpricedLineCount: 0,
  };
  for (const line of lines) {
    if (line.lineKind === 'part') shape.partLineCount += 1;
    else if (line.lineKind === 'outside_service') shape.outsideLineCount += 1;
    else shape.otherLineCount += 1;

    if (line.lineKind === 'outside_service' || line.jobId) shape.jobLinkedLineCount += 1;

    if (line.unitPrice === null || line.unitPrice === undefined) {
      shape.unpricedLineCount += 1;
      continue;
    }
    switch (line.priceSource) {
      case 'price_sheet':
        shape.priceSheetLineCount += 1;
        break;
      case 'last_po':
        shape.lastPoPriceLineCount += 1;
        break;
      case 'estimate':
        shape.estimatePriceLineCount += 1;
        break;
      case 'vendor_service':
        shape.vendorServicePriceLineCount += 1;
        break;
      case 'rfq':
        shape.rfqPriceLineCount += 1;
        break;
      default:
        // `manual`, or a price sent with no source — the database stores both as typed.
        shape.typedPriceLineCount += 1;
    }
  }
  return shape;
}
