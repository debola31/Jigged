/**
 * The PO line amount — the TypeScript mirror of `public.vendor_po_line_amount(qty, price)`.
 *
 * Line amount = round(quantity × unit price, 2), half-up on the exact decimal product; the PO
 * total is the sum of those rounded amounts (plan §3.5 "Money"). The same rule runs in three
 * places — the PO form's live total, the status view's `ordered_amount` / `open_amount`, and the
 * QuickBooks Online `Amount` the Python builder sends — and all three are pinned by
 * `__tests__/fixtures/vendorPoAmountCases.json`. Change the rule there first.
 *
 * A NULL unit price means "to be confirmed": the line has no amount (never $0), prints "TBC",
 * and a QuickBooks push is refused until it is priced.
 */
import {
  formatMoney,
  formatUnitPrice,
  multiplyDecimal,
  MONEY_PLACES,
  roundDecimal,
  sumDecimal,
  UNIT_PRICE_MAX_PLACES,
} from '@/lib/money';

/** `vendor_purchase_order_lines.unit_price` is `numeric(16,5)`. */
export const VENDOR_PO_UNIT_PRICE_PLACES = UNIT_PRICE_MAX_PLACES;

/** What a PO prints for a price that is still to be confirmed. */
export const TO_BE_CONFIRMED = 'TBC';

const UNIT_PRICE_INPUT = new RegExp(`^(\\d+\\.?\\d{0,${VENDOR_PO_UNIT_PRICE_PLACES}}|\\.\\d{1,${VENDOR_PO_UNIT_PRICE_PLACES}})?$`);

/** A unit price at the precision the column stores — what the saved PO will actually say. */
export function roundUnitPrice(price: number): number {
  return roundDecimal(price, VENDOR_PO_UNIT_PRICE_PLACES);
}

/**
 * round(quantity × unit price, 2), or `null` while the price is to be confirmed.
 *
 * The price is first taken at its stored five places, so an amount shown before saving is the
 * amount the database will compute after it.
 */
export function vendorPoLineAmount(quantity: number, unitPrice: number | null | undefined): number | null {
  if (unitPrice === null || unitPrice === undefined) return null;
  if (!Number.isFinite(quantity) || !Number.isFinite(unitPrice)) return null;
  return multiplyDecimal(quantity, roundUnitPrice(unitPrice), MONEY_PLACES);
}

export interface VendorPoTotal {
  /** Sum of the priced lines' rounded amounts. */
  total: number;
  pricedLineCount: number;
  /** Lines still to be confirmed — left out of `total`, never counted as $0. */
  unpricedLineCount: number;
}

/** The PO total: the exact sum of each priced line's rounded amount. */
export function vendorPoTotal(
  lines: ReadonlyArray<{ quantity: number; unitPrice: number | null | undefined }>,
): VendorPoTotal {
  const amounts: number[] = [];
  let unpricedLineCount = 0;
  for (const line of lines) {
    const amount = vendorPoLineAmount(line.quantity, line.unitPrice);
    if (amount === null) unpricedLineCount += 1;
    else amounts.push(amount);
  }
  return { total: sumDecimal(amounts), pricedLineCount: amounts.length, unpricedLineCount };
}

/**
 * An in-progress unit-price string: digits with an optional point and up to five decimals.
 * Empty is allowed (a cleared field, i.e. to be confirmed). No sign, exponent or separators.
 */
export function isValidUnitPriceInput(text: string): boolean {
  return UNIT_PRICE_INPUT.test(text);
}

/** A PO unit price for display: `$0.0125`, or `TBC`. */
export function formatVendorPoUnitPrice(price: number | null | undefined): string {
  return formatUnitPrice(price, { nullText: TO_BE_CONFIRMED });
}

/** A PO line amount or total for display: `$12.50`, or `TBC`. */
export function formatVendorPoAmount(amount: number | null | undefined): string {
  return formatMoney(amount, { nullText: TO_BE_CONFIRMED });
}
