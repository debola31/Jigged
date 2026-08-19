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
 *   1. However this part's OTHER materials are already set. A part with a stance
 *      keeps it, so adding one more can never drop the panel into "mixed".
 *   2. Otherwise the shop's default, so a shop that always charges materials one
 *      way says so once instead of on every part.
 *
 * `partStance` is null when the part has no materials yet, or when its existing
 * ones disagree — in both cases there is nothing coherent to inherit.
 *
 * **Made and bought children are treated identically, deliberately.** Both carry
 * costs and pricing tiers, and the rollup has never distinguished them: the price
 * rung resolves any part with a markup tier. An earlier draft forced made
 * children to cost, inherited from the read-time shop-wide markup this design no
 * longer has — where the argument was that a default applied at bought leaves
 * would double-mark if applied again at a made part above them. With no such
 * default, that argument has nothing to stand on, and charging a sub-assembly at
 * its own price is ordinary transfer pricing. Stacking stays visible: the Cost
 * card's "Material markup / unit" row counts every child charged above cost,
 * whatever its source.
 */
export function chargeBasisForNewLine(
  partStance: ChargeBasis | null,
  shopDefault: ChargeBasis,
): ChargeBasis {
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
