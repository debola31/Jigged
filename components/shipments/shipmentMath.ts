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
 * The carrier the shipment moves on, vs the carrier whose account pays for it.
 *
 * The packing slip prints these one above the other, so a mismatch reads as a
 * contradiction to whoever opens the box:
 *
 *     Carrier: FedEx
 *     Freight: Freight collect (their account) — UPS ••••72W9
 *
 * It is not always wrong — a shop can move a box on one carrier and bill
 * another's account — so this returns a message to WARN with, never to block.
 * Returns null when there is nothing to say: no account, no carrier chosen yet,
 * freight doesn't apply to this method, or the two agree.
 *
 * Case- and whitespace-insensitive, because the account's carrier is free text
 * ("ups", "UPS ") while the form's is a fixed option.
 */
export function carrierAccountMismatch(
  shipmentCarrier: string,
  accountCarrier: string,
): string | null {
  const chosen = shipmentCarrier.trim();
  const account = accountCarrier.trim();
  if (!chosen || !account) return null;
  if (chosen.toLowerCase() === account.toLowerCase()) return null;
  return `Shipping ${chosen} but billing the ${account} account — the packing slip will show both.`;
}
