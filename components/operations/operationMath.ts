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
