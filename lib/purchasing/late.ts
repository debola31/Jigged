/**
 * Is a vendor PO — or one of its lines — late? The TypeScript mirror of
 * `public.is_vendor_purchase_order_late(status, expected_on, today)`.
 *
 * Late means: still owed something — status `sent` or `partially_received` for a PO, `open` or
 * `partially_received` for a line — with an expected date strictly before the caller's local
 * calendar date. One predicate serves both, exactly as the SQL does: pass a PO's status with the
 * view's `next_expected_on` (the earliest expected date over its outstanding lines), or a line's
 * status with its own `expected_on`. A draft was never promised; a received, closed or
 * no-receipt line owes nothing.
 *
 * `today` is always the caller's date (`todayLocalISODate()`), never the server's: Postgres runs in
 * UTC, which rolls into tomorrow every evening in the Americas and would make a PO due today read
 * as overdue at 8pm.
 *
 * Pinned to the SQL by `__tests__/fixtures/vendorPoLateCases.json`, which both suites read.
 */

/** The statuses that still owe something: PO `sent` / `partially_received`, line `open` / `partially_received`. */
export const LATE_ELIGIBLE_STATUSES: readonly string[] = ['sent', 'open', 'partially_received'];

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** The mirror of `is_vendor_purchase_order_late`, for a PO status or a line status. */
export function isVendorPoLate(
  status: string | null | undefined,
  expectedOn: string | null | undefined,
  today: string | null | undefined,
): boolean {
  if (!status || !LATE_ELIGIBLE_STATUSES.includes(status)) return false;
  if (!expectedOn || !today) return false;
  if (!DATE_ONLY.test(expectedOn) || !DATE_ONLY.test(today)) return false;
  // Zero-padded ISO dates order correctly as text, with no timezone in sight.
  return expectedOn < today;
}
