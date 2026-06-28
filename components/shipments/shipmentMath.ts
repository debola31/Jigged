/**
 * Pure shipment-quantity math for the packing-slip form. No React, no
 * Supabase, no MUI — so it unit-tests without mounting the form or
 * instantiating a browser client. ShipmentForm imports these; the
 * row/summary renderers map the results to colour + copy.
 */

/**
 * Per-line shipping consequence — what the entered "Ship Now" quantity
 * actually does to the line. `qtyRemaining` already nets out prior
 * shipments (qty_ordered − qty_shipped_prior), so qty === qtyRemaining
 * closes the line out. This is the spine of the "don't silently ship in
 * full" fix: the pre-filled number now states its own outcome.
 */
export type ShipConsequence =
  | { kind: 'none' }
  | { kind: 'full' }
  | { kind: 'partial'; leftover: number }
  | { kind: 'over'; excess: number };

export function lineShipConsequence(
  qtyInput: string,
  qtyRemaining: number,
): ShipConsequence {
  const parsed = Number(qtyInput);
  const qty = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  if (qty <= 0) return { kind: 'none' };
  if (qty > qtyRemaining) return { kind: 'over', excess: qty - qtyRemaining };
  if (qty === qtyRemaining) return { kind: 'full' };
  return { kind: 'partial', leftover: qtyRemaining - qty };
}

/**
 * Slip-level projection: given every line on the job and the quantity
 * shipped now per job_part, what fulfillment status the job lands in
 * once this slip commits, plus the unit/part counts for the summary.
 * Mirrors compute_job_fulfillment_status server-side (all parts fully
 * shipped → fully; any part with shipments → partially) so the preview
 * matches the post-commit cascade rather than guessing.
 */
export interface SlipProjection {
  unitsNow: number;
  linesShipping: number;
  partsComplete: number;
  partsTotal: number;
  projectedStatus: 'fully_shipped' | 'partially_shipped' | 'unshipped';
}

export function projectSlip(
  lines: Array<{ job_part_id: string; qty_ordered: number; qty_shipped_prior: number }>,
  shipNowByPart: Map<string, number>,
): SlipProjection {
  let unitsNow = 0;
  let linesShipping = 0;
  let partsComplete = 0;
  let anyShipped = false;
  for (const l of lines) {
    const shipNow = Math.max(0, shipNowByPart.get(l.job_part_id) ?? 0);
    const projectedShipped = l.qty_shipped_prior + shipNow;
    if (shipNow > 0) {
      unitsNow += shipNow;
      linesShipping += 1;
    }
    if (projectedShipped > 0) anyShipped = true;
    if (l.qty_ordered > 0 && projectedShipped >= l.qty_ordered) partsComplete += 1;
  }
  const partsTotal = lines.length;
  const projectedStatus: SlipProjection['projectedStatus'] =
    partsTotal > 0 && partsComplete === partsTotal
      ? 'fully_shipped'
      : anyShipped
        ? 'partially_shipped'
        : 'unshipped';
  return { unitsNow, linesShipping, partsComplete, partsTotal, projectedStatus };
}

export const PROJECTED_STATUS_LABEL: Record<SlipProjection['projectedStatus'], string> = {
  fully_shipped: 'Fully Shipped',
  partially_shipped: 'Partially Shipped',
  unshipped: 'Unshipped',
};
