import type { Part } from '@/types/part';

/**
 * Where a part sits on the "can I actually quote this yet?" spectrum.
 *
 * Derived purely from the part's structure plus the same priceability signal
 * the data layer uses (`compute_part_cost_explain` / `get_priceable_part_ids`,
 * both backed by `compute_part_cost_at_qty`), so the workspace completeness
 * chip can never disagree with the parts-list ✓/⚠ column.
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

  // Made parts that have some structure but still don't resolve to a price
  // (missing labour rates / material costs) get a guidance banner. Bought parts
  // surface the same gap INLINE in the Cost card instead (a red starter tier in
  // PartProcurementPricingPanel), so we emit no banner for them — the chip still
  // reads "Needs cost", but the workspace doesn't double up with a yellow alert.
  const nextStep =
    part.source === 'bought'
      ? null
      : 'This part isn’t priceable yet — check that operations have labour rates and materials have costs.';

  return {
    state: 'needs_cost',
    color: 'warning',
    label: 'Needs cost',
    nextStep,
    targetTab: 'workspace',
  };
}
