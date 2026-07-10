import type { Part } from '@/types/part';

/**
 * Where a part sits on the "can I actually quote this yet?" spectrum.
 *
 * Derived purely from the part's structure plus the same priceability verdict
 * the data layer uses. `compute_part_cost_explain.is_priceable` (detail) and
 * `get_priceable_part_ids` (list) now enforce the *identical* structural rule —
 * every part in the BOM tree has a markup, every op is priced, every purchased
 * leaf has a vendor cost — so the workspace and the parts-list ✓/⚠ column can
 * never disagree (locked by an agreement test).
 *
 * Honest by construction (per the no-silent-fallback principle): we never
 * invent a reason a part can't be priced — `isPriceable` is ground truth, and
 * the guidance only names a real structural next step the user can take.
 */
export type PartSetupState = 'ready' | 'needs_setup' | 'needs_cost';

export interface PartSetupStatus {
  state: PartSetupState;
  /** MUI theme palette key — never a hardcoded colour (design-system rule). */
  color: 'success' | 'info' | 'warning';
  /** Short chip label. */
  label: string;
  /** One-line "do this next" guidance, or null when nothing is needed. */
  nextStep: string | null;
  /** Tab the "fix it" guidance points the user at. */
  targetTab: 'workspace';
}

/**
 * Compute a part's setup status from its structure + whether it is priceable.
 *
 * @param part        part with routing + bom counts (from getPartWithRelations)
 * @param isPriceable whether the cost computation resolves to a number
 */
export function getPartSetupStatus(
  part: Pick<Part, 'source' | 'routing' | 'bom_lines_count'>,
  isPriceable: boolean,
): PartSetupStatus {
  if (isPriceable) {
    return {
      state: 'ready',
      color: 'success',
      label: 'Ready to quote',
      nextStep: null,
      targetTab: 'workspace',
    };
  }

  const routingOps = part.routing?.nodes_count ?? 0;
  const bomLines = part.bom_lines_count ?? 0;

  // A made part with nothing defined yet: a neutral "start here", not a warning.
  if (part.source === 'made' && routingOps === 0 && bomLines === 0) {
    return {
      state: 'needs_setup',
      color: 'info',
      label: 'Needs setup',
      nextStep:
        'Add operations (and any materials) so this part can be costed and quoted.',
      targetTab: 'workspace',
    };
  }

  // Made parts that have some structure but still don't resolve to a price get
  // a guidance banner. The banner itself (WorkspaceTab) lists the concrete gaps
  // — which sub-part has no markup, which op has no rate, which leaf has no cost
  // — with links; this string is only a fallback. Bought parts surface the same
  // gap INLINE in the Cost card instead (a red starter tier in
  // PartProcurementPricingPanel), so we emit no banner for them (null) — the
  // workspace doesn't double up with a yellow alert.
  const nextStep =
    part.source === 'bought'
      ? null
      : 'This part isn’t priceable yet — a sub-part markup, operation rate, or material cost still needs setting up.';

  return {
    state: 'needs_cost',
    color: 'warning',
    label: 'Needs cost',
    nextStep,
    targetTab: 'workspace',
  };
}
