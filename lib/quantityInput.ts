/**
 * Shared validation for user-typed order / pricing-tier quantities.
 *
 * Quantities are universally decimal-capable. The whole-number assumption only
 * ever held for count units ("you can't sell 2.5 widgets"); parts measured by
 * length / weight / volume / area are legitimately fractional (e.g. 0.32 inches
 * of material). Rather than gate on the part's unit category — a blunt rule that
 * mishandles half-dozens and 1.5-hour billing — we allow decimals everywhere and
 * cap precision uniformly.
 *
 * 4 decimal places is the manufacturing-practical ceiling: it covers machining
 * "tenths" (0.0001") and fractional-inch conversions (3/16" = 0.1875, itself 4
 * dp), without inviting noise like 0.333333. The DB quantity columns are
 * unbounded `numeric`, so this module — not the schema — is the precision
 * authority. Used by PartPricing tier rows and the QuoteForm order-qty input.
 */
export const MAX_QUANTITY_DECIMALS = 4;

const QUANTITY_INPUT_REGEX = new RegExp(`^\\d*\\.?\\d{0,${MAX_QUANTITY_DECIMALS}}$`);

/**
 * True when `value` is an acceptable in-progress quantity input string: digits
 * with an optional decimal point and up to {@link MAX_QUANTITY_DECIMALS}
 * fractional digits. The empty string is allowed (a cleared field). No sign, no
 * thousands separators. Use in an onChange handler to reject keystrokes that
 * would push the value past the precision cap.
 */
export function isValidQuantityInput(value: string): boolean {
  return QUANTITY_INPUT_REGEX.test(value);
}

/**
 * Save-time guard: a parsed quantity is valid when it is finite, strictly
 * positive, and within the precision cap. Defends the persisted value against
 * paste / programmatic paths that bypass the per-keystroke {@link
 * isValidQuantityInput} check.
 */
export function isValidQuantityValue(n: number): boolean {
  if (!Number.isFinite(n) || n <= 0) return false;
  const scaled = n * 10 ** MAX_QUANTITY_DECIMALS;
  return Math.abs(scaled - Math.round(scaled)) < 1e-9;
}
