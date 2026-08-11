/**
 * Bill of Materials lines — `parts_bom` table.
 *
 * Replaces the old `routing_materials`. BOM is now part-attached (one BOM per
 * parent part) rather than routing-attached, which lets a sub-assembly part
 * appear as a child of multiple parents without per-routing duplication.
 *
 * `notes` was dropped in 20260504_drop_parts_bom_notes — usability review
 * confirmed it was unused noise on the Materials panel.
 */
export interface BomLine {
  id: string;
  parent_part_id: string;
  child_part_id: string;
  quantity: number;
  unit: string;
  sequence: number;
  /**
   * When true, the consuming order draws `ceil(order_qty × per-part quantity)`
   * whole units of this material (discrete stock — a steel strip you can't cut
   * a fraction of). When false (default), consumption is fractional. Drives the
   * ceiling branch in `compute_part_cost_at_qty` / `calculateRoutingCost`.
   */
  consume_whole_units: boolean;
  /**
   * What this child contributes to the parent's rollup (#727).
   *
   * `'cost'` (default) — our cost of the child, i.e. its charge base.
   * `'price'` — the child's marked-up price, from its own pricing tier.
   *
   * Per-line, not per-part: a shop may charge material at price on customer
   * jobs and at cost on internal stock-making work orders.
   */
  charge_basis: ChargeBasis;
  created_at: string;
  updated_at: string;
}

/** What a BOM line contributes to its parent's rollup. */
export type ChargeBasis = 'cost' | 'price';

/**
 * What a NEWLY ADDED BOM line is charged at (#727), in precedence order:
 *
 *   1. A made child is always our cost. Marking up in-house work is a
 *      transfer-pricing decision that belongs on that part's own Pricing card,
 *      not something a material picker should do silently.
 *   2. Otherwise, however this part's OTHER purchased materials are already set.
 *      A part with a stance keeps it, so adding one more material can never drop
 *      the panel into "mixed".
 *   3. Otherwise the shop's default, so a shop that always marks up purchased
 *      material says so once instead of on every part.
 *
 * `partStance` is null when the part has no purchased materials yet, or when its
 * existing ones disagree — in both cases there is no stance to inherit.
 */
export function chargeBasisForNewLine(
  childSource: 'made' | 'bought',
  partStance: ChargeBasis | null,
  shopDefault: ChargeBasis,
): ChargeBasis {
  if (childSource !== 'bought') return 'cost';
  return partStance ?? shopDefault;
}

export const CHARGE_BASIS_LABELS: Record<ChargeBasis, string> = {
  cost: 'Our cost',
  price: 'Marked-up price',
};

export interface BomLineFormData {
  child_part_id: string;
  quantity: string;
  unit: string;
  consume_whole_units: boolean;
  charge_basis: ChargeBasis;
}

export interface BomLineWithChildPart extends BomLine {
  child_part: {
    id: string;
    part_name: string;
    description: string | null;
    primary_unit: string | null;
    is_stocked: boolean;
    source: 'made' | 'bought';
    /**
     * Batch qty at which this (made) child's cost is amortized when consumed as
     * a material — NULL = value at the cascaded consumed qty (default). Lets the
     * BOM panel show a pinned child's fixed cost basis. Always null for bought
     * children.
     */
    costing_batch_quantity: number | null;
  };
}

/**
 * "Where used" view: a BOM row joined with the parent part for showing this
 * part's parents on the part detail page.
 */
export interface BomLineWithParentPart extends BomLine {
  parent_part: {
    id: string;
    part_name: string;
    description: string | null;
  };
}

export const EMPTY_BOM_FORM: BomLineFormData = {
  child_part_id: '',
  quantity: '',
  unit: '',
  consume_whole_units: false,
  charge_basis: 'cost',
};

export function bomLineToFormData(bomLine: BomLine): BomLineFormData {
  return {
    child_part_id: bomLine.child_part_id,
    quantity: String(bomLine.quantity),
    unit: bomLine.unit,
    consume_whole_units: bomLine.consume_whole_units,
    charge_basis: bomLine.charge_basis,
  };
}
