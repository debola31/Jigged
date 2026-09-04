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
 * `good` and `scrapped` are separate because they answer different questions:
 * together they retire the vendor's outstanding balance (so the step stops
 * reading "at the vendor"), but only `good` counts toward the step being done.
 * 98 good + 2 scrapped of 100 closes the slip and leaves the step short — which
 * is exactly what an in-house op says at 98 good of 100.
 */
export type OutsideReceiptConsequence =
  | { kind: 'none' }
  | { kind: 'closes' }
  | { kind: 'partial'; stillOut: number }
  | { kind: 'over'; excess: number };

export function outsideReceiptConsequence(
  goodInput: string | number,
  scrappedInput: string | number,
  outstanding: number,
): OutsideReceiptConsequence {
  const num = (v: string | number) => {
    const p = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(p) ? Math.max(0, p) : 0;
  };
  const total = num(goodInput) + num(scrappedInput);
  const out = Math.max(0, outstanding);
  if (total <= 0) return { kind: 'none' };
  if (total > out) return { kind: 'over', excess: total - out };
  if (total === out) return { kind: 'closes' };
  return { kind: 'partial', stillOut: out - total };
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
