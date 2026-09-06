/**
 * Pure operation-completion math. No React, no Supabase, no MUI — so it
 * unit-tests without mounting anything. The operator/admin completion forms
 * import these; the renderers map the results to colour + copy.
 *
 * Directly mirrors components/shipments/shipmentMath.ts (lineShipConsequence):
 * partial operation completion is the same "record a subset of an ordered
 * quantity, don't silently complete in full" problem as partial shipping, so
 * it uses the same consequence vocabulary.
 */

/**
 * Per-operation completion consequence — what the entered good-quantity does to
 * the operation. `remaining` already nets out prior non-void completions
 * (target − good_so_far), so qty === remaining finishes the op. Over-completion
 * is WARNED, not blocked (design decision: extra good parts are legitimate; the
 * only hard floor is quantity_good > 0), so `over` is a valid, submittable state.
 */
export type CompletionConsequence =
  | { kind: 'none' }
  | { kind: 'full' }
  | { kind: 'partial'; leftover: number }
  | { kind: 'over'; excess: number };

export function operationCompletionConsequence(
  qtyInput: string | number,
  remaining: number,
): CompletionConsequence {
  const parsed = typeof qtyInput === 'number' ? qtyInput : Number(qtyInput);
  const qty = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  const rem = Math.max(0, remaining);
  if (qty <= 0) return { kind: 'none' };
  if (qty > rem) return { kind: 'over', excess: qty - rem };
  if (qty === rem) return { kind: 'full' };
  return { kind: 'partial', leftover: rem - qty };
}

/**
 * Remaining good quantity for an operation = target (the part's ordered qty)
 * minus good produced so far, clamped ≥ 0 (an over-completed op shows 0
 * remaining, never negative — mirrors getJobPartShipmentSummaries' clamp).
 */
export function operationQtyRemaining(target: number, qtyGood: number): number {
  return Math.max(0, target - qtyGood);
}

/**
 * Human-readable caption for a consequence. Kept here (not in the component) so
 * the copy is asserted by the same unit tests as the math.
 */
export function completionConsequenceCaption(c: CompletionConsequence): string {
  switch (c.kind) {
    case 'none':
      return '';
    case 'full':
      return 'Completes this operation';
    case 'partial':
      return `${c.leftover} will remain`;
    case 'over':
      return `Over by ${c.excess}`;
  }
}

/**
 * What sending this many pieces to the vendor will do — computed here, not in
 * the dialog, so the copy is asserted by the same unit tests as the arithmetic.
 *
 * `over` is a WARNING, never a block. Over-sending is legitimate: you made
 * extras, or the plater wants the whole lot in one rack. The same stance the
 * customer shipment form takes.
 */
export type OutsideSendConsequence =
  | { kind: 'none' }
  | { kind: 'all' }
  | { kind: 'partial'; staying: number }
  | { kind: 'over'; excess: number };

export function outsideSendConsequence(
  qtyInput: string | number,
  toSend: number,
): OutsideSendConsequence {
  const parsed = typeof qtyInput === 'number' ? qtyInput : Number(qtyInput);
  const qty = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  const left = Math.max(0, toSend);
  if (qty <= 0) return { kind: 'none' };
  if (qty > left) return { kind: 'over', excess: qty - left };
  if (qty === left) return { kind: 'all' };
  return { kind: 'partial', staying: left - qty };
}

export function outsideSendCaption(c: OutsideSendConsequence, vendor: string): string {
  switch (c.kind) {
    case 'none':
      return '';
    case 'all':
      return `Sends everything that has not gone to ${vendor} yet.`;
    case 'partial':
      return `${c.staying} will stay in the shop.`;
    case 'over':
      return `That is ${c.excess} more than this step needs. Sending it anyway is fine — it just will not have anywhere to go on this job.`;
  }
}

/**
 * What recording this receipt will do to the slip it is against.
 *
 * GOOD ONLY. What a vendor lost is settled by short-closing the slip, not by a
 * second number here — which also keeps this in step with
 * `operationCompletionConsequence`, since in-house completions are good-only too.
 */
export type OutsideReceiptConsequence =
  | { kind: 'none' }
  | { kind: 'closes' }
  | { kind: 'partial'; stillOut: number }
  | { kind: 'over'; excess: number };

export function outsideReceiptConsequence(
  goodInput: string | number,
  outstanding: number,
): OutsideReceiptConsequence {
  const parsed = typeof goodInput === 'number' ? goodInput : Number(goodInput);
  const good = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  const out = Math.max(0, outstanding);
  if (good <= 0) return { kind: 'none' };
  if (good > out) return { kind: 'over', excess: good - out };
  if (good === out) return { kind: 'closes' };
  return { kind: 'partial', stillOut: out - good };
}

export function outsideReceiptCaption(
  c: OutsideReceiptConsequence,
  vendor: string,
): string {
  switch (c.kind) {
    case 'none':
      return '';
    case 'closes':
      return `Everything on this slip is accounted for.`;
    case 'partial':
      return `${c.stillOut} still at ${vendor} on this slip.`;
    case 'over':
      return `That is ${c.excess} more than went out on this slip. Check the slip number before recording it.`;
  }
}
