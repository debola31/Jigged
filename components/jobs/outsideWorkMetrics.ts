/**
 * Days at the vendor, BUCKETED — shared by every surface that reports a receipt
 * so the analytics boundary is drawn once.
 *
 * Bucketed rather than raw because a per-slip duration answers nothing the
 * bucket does not, and because 21 days is already the shop-facing threshold the
 * vendor page paints red — so the boundary matches the one the product draws.
 * It describes the JOB, never the person: it is derived from one shipment's ship
 * date, and nothing accumulates across jobs.
 */
export function daysAtVendorBucket(shippedAt: string | null): string {
  if (!shippedAt) return 'unknown';
  const days = (Date.now() - Date.parse(shippedAt)) / 86_400_000;
  if (days < 1) return 'same_day';
  if (days <= 3) return '1_3d';
  if (days <= 7) return '4_7d';
  if (days <= 21) return '8_21d';
  return 'over_21d';
}
