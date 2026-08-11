import { getSupabase } from '@/lib/supabase';
import { getRoutingForPart } from '@/utils/routingsAccess';
import { getBomForPart } from '@/utils/bomAccess';
import {
  getComputedPartCost,
  getComputedPartChargeBase,
  getPartCostExplain,
  getPartChargePrice,
} from '@/utils/partsAccess';

export interface CostWarning {
  type:
    | 'empty_operation'
    | 'missing_labor_rate'
    | 'missing_material_cost'
    | 'missing_child_markup'
    | 'no_operations'
    | 'missing_external_pricing';
  /**
   * Backwards-compatible single-string rendering of the warning. Newer
   * callers should prefer `child_part_name` + `detail` (when present) so
   * the part name can be styled as a link separately from the detail.
   */
  message: string;
  node_id?: string;
  material_id?: string;
  /** For `missing_material_cost`: the child part that needs a cost set. */
  child_part_id?: string;
  /** For `missing_material_cost`: drives the suggested fix in the warning copy. */
  child_part_source?: 'made' | 'bought';
  /**
   * For `missing_material_cost`: the offending leaf's display name. The
   * Pricing-card warning renderer wraps this in a link to that part so
   * the part name itself is the click target — replacing the old trailing
   * "Open child →" affordance.
   */
  child_part_name?: string;
  /**
   * For `missing_material_cost`: the part of the warning copy that comes
   * after the part name (e.g. "no priced tier covers qty 6"). Lets the
   * renderer compose `<Link>{name}</Link> {detail}` without parsing the
   * full `message` string.
   */
  detail?: string;
}

export interface LaborItem {
  operation_name: string;
  run_time_minutes: number;
  setup_time_minutes: number;
  labor_rate: number;
  cost: number;
  setup_cost: number;
}

export interface MaterialItem {
  item_name: string;
  /** Per-parent-unit BOM quantity in `unit` (e.g. 0.05 strips/part). */
  quantity: number;
  unit: string;
  /**
   * The rate that goes INTO the rollup, per the child's primary unit at the
   * valuation qty (pinned batch or consumed): the child's cost on a `'cost'`
   * line, its marked-up price on a `'price'` line. True cost is
   * `true_cost_per_unit`; the two are equal on a `'cost'` line.
   */
  cost_per_unit: number;
  /** Per-parent-unit contribution at the charged rate (ceiling-adjusted when whole-unit). */
  cost: number;
  /**
   * Per-parent-unit contribution at the TRUE cost rate — every charge basis in
   * the tree ignored. Sums into `total_material_true_cost`, which is what the
   * Cost card's "Material markup / unit" row is measured against.
   *
   * The per-unit rate, the basis and the markup behind it used to live here too,
   * to be frozen onto `quote_materials`. That table is gone (it had been
   * write-only since 2026-04-30), so only the number with a reader remains.
   */
  true_cost: number;
  /** `quantity` converted to the child's primary unit — per parent unit. */
  qty_in_primary: number;
  /** Whether this line ceilings consumption to whole units. */
  consume_whole_units: boolean;
  /**
   * Total units of this material consumed across the whole order at the qty the
   * breakdown was computed for (`ceil(order_qty × qty_in_primary)` in whole-unit
   * mode; `order_qty × qty_in_primary` fractional). Null-safe for display of
   * "this order needs N strips".
   */
  units_consumed: number;
}

export interface RoutingCostBreakdown {
  labor_items: LaborItem[];
  material_items: MaterialItem[];
  total_labor_cost: number;
  total_setup_cost: number;
  /** null when any BOM line is missing a priced cost — mirrors the SQL
   * `compute_part_cost_at_qty` behavior of propagating NULL up the tree.
   * This is the CHARGE base contribution: markup applies on top of it. */
  total_material_cost: number | null;
  /** null when total_material_cost is null. */
  total_cost: number | null;
  /**
   * The same two totals at TRUE cost — every charge basis ignored. Equal to
   * their charged counterparts until a line charges its child at price; the
   * difference is the material markup baked into the price, and the denominator
   * for effective margin.
   */
  total_material_true_cost: number | null;
  total_true_cost: number | null;
  /** false when any BOM line could not be priced (unit conversion missing,
   * cost lookup threw, or child returned null). Callers that display a
   * Base/unit or Unit price must blank those values when this is false. */
  materials_complete: boolean;
  warnings: CostWarning[];
}

/**
 * Calculate the per-unit cost breakdown for a part's routing + BOM at a
 * given parent quantity.
 *
 * Run labor and external unit prices contribute per-unit. Setup costs and
 * external setup costs are one-time per parent batch — they live in
 * `total_setup_cost` and are NOT amortized at this layer (callers like
 * `calculateTierPricing` divide by the tier qty to spread them).
 *
 * BOM child rates come from the SQL rollup at the child's valuation qty — a
 * made child at its costing lot size, a bought child at the cascaded qty
 * actually consumed across the parent batch. Setup amortization for
 * sub-assemblies falls out of that recursion: a sub-assembly's setup divided by
 * the cascaded qty contributes `sub_setup / parent_qty` per parent unit.
 *
 * Each line produces TWO numbers (#727): the CHARGED rate — the child's charge
 * base on a `'cost'` line, its marked-up price on a `'price'` line — and the
 * TRUE cost. Markup applies to the charged totals; effective margin is measured
 * against the true ones. Every line defaults to `'cost'`, and then the two are
 * the same number.
 *
 * Returns null if the part has no routing AND no BOM.
 */
export async function calculateRoutingCost(
  partId: string,
  qty: number = 1,
): Promise<RoutingCostBreakdown | null> {
  const safeQty = Number.isFinite(qty) && qty > 0 ? qty : 1;

  const [routing, bomLines] = await Promise.all([
    getRoutingForPart(partId),
    getBomForPart(partId),
  ]);

  if (!routing && bomLines.length === 0) return null;

  const warnings: CostWarning[] = [];
  const laborItems: LaborItem[] = [];
  const materialItems: MaterialItem[] = [];
  // Flips to false on the first BOM line we can't price (missing unit
  // conversion, cost-lookup throw, or null child cost). When false, the
  // total_material_cost + total_cost become null so the UI can't quietly
  // render a tier built on $0-treated-as-missing material.
  let materialsComplete = true;

  if (routing && routing.operations.length === 0) {
    warnings.push({
      type: 'no_operations',
      message: 'Routing has no operations defined',
    });
  }

  if (routing) {
    for (const op of routing.operations) {
      const wc = op.work_center;
      const operationName = wc?.name || 'Unknown Operation';

      if (wc?.kind === 'external') {
        // External (vendor) work bills once per part — a unit price only, no
        // setup cost (setup is an internal-only concept).
        const unitPrice = op.external_unit_price !== null ? Number(op.external_unit_price) : null;
        if (unitPrice === null) {
          warnings.push({
            type: 'missing_external_pricing',
            message: `${operationName}: external op has no unit price`,
            node_id: op.id,
          });
          continue;
        }
        laborItems.push({
          operation_name: operationName,
          run_time_minutes: 0,
          setup_time_minutes: 0,
          labor_rate: 0,
          cost: Math.round(unitPrice * 100) / 100,
          setup_cost: 0,
        });
        continue;
      }

      const cycleMinutes = op.cycle_minutes_per_unit ?? 0;
      const setupMinutes = op.setup_minutes ?? 0;
      const hasAnyTime = cycleMinutes > 0 || setupMinutes > 0;
      if (!hasAnyTime) {
        warnings.push({
          type: 'empty_operation',
          message: `${operationName}: no run or setup time set`,
          node_id: op.id,
        });
        continue;
      }

      const laborRate = op.labor_rate_override ?? wc?.labor_rate ?? null;
      if (laborRate === null) {
        warnings.push({
          type: 'missing_labor_rate',
          message: `${operationName}: missing labor rate (no override and work center has no default)`,
          node_id: op.id,
        });
        continue;
      }

      const runCost = (Number(cycleMinutes) / 60) * Number(laborRate);
      const setupCost = (Number(setupMinutes) / 60) * Number(laborRate);
      laborItems.push({
        operation_name: operationName,
        run_time_minutes: Number(cycleMinutes),
        setup_time_minutes: Number(setupMinutes),
        labor_rate: Number(laborRate),
        cost: Math.round(runCost * 100) / 100,
        setup_cost: Math.round(setupCost * 100) / 100,
      });
    }
  }

  if (bomLines.length > 0) {
    // Batch-load unit conversion factors for any BOM line whose unit differs
    // from its child's primary_unit. The SQL cost function does the same
    // resolution internally; here we need it because the parent-unit
    // material contribution = qty_in_primary × child_cost_per_primary, and
    // qty_in_primary is what we feed to compute_part_cost_at_qty too.
    const conversionLookups = bomLines
      .filter(
        (l) =>
          l.child_part.primary_unit !== null &&
          l.unit !== l.child_part.primary_unit,
      )
      .map((l) => ({ child_id: l.child_part.id, from_unit: l.unit }));

    const conversionMap = new Map<string, number>();
    if (conversionLookups.length > 0) {
      const supabase = getSupabase();
      const partIds = [...new Set(conversionLookups.map((c) => c.child_id))];
      const fromUnits = [...new Set(conversionLookups.map((c) => c.from_unit))];
      const { data: convs, error: convErr } = await supabase
        .from('parts_unit_conversions')
        .select('part_id, from_unit, to_primary_factor')
        .in('part_id', partIds)
        .in('from_unit', fromUnits);
      if (convErr) {
        console.error('Error loading parts_unit_conversions:', convErr);
        throw convErr;
      }
      for (const row of (convs ?? []) as Array<{
        part_id: string;
        from_unit: string;
        to_primary_factor: number;
      }>) {
        conversionMap.set(`${row.part_id}:${row.from_unit}`, Number(row.to_primary_factor));
      }
    }

    for (const line of bomLines) {
      const child = line.child_part;
      const itemName = child.part_name;
      const bomQty = Number(line.quantity);
      const bomUnit = line.unit;
      const childPrimary = child.primary_unit;
      // Treat an empty bom.unit as "in the child's primary unit" — the UI
      // sometimes omits the unit on legacy rows and the cost shouldn't
      // unsplit on that.
      const effectiveBomUnit = bomUnit && bomUnit.trim() !== '' ? bomUnit : childPrimary;

      let qtyInPrimary: number;
      if (childPrimary !== null && effectiveBomUnit !== null && effectiveBomUnit !== childPrimary) {
        const factor = conversionMap.get(`${child.id}:${effectiveBomUnit}`);
        if (factor === undefined) {
          const detail = `no unit conversion from "${effectiveBomUnit}" to "${childPrimary}" — add one on the child part`;
          warnings.push({
            type: 'missing_material_cost',
            message: `${itemName}: ${detail}`,
            detail,
            material_id: line.id,
            child_part_id: child.id,
            child_part_name: itemName,
            child_part_source: child.source,
          });
          materialsComplete = false;
          continue;
        }
        qtyInPrimary = bomQty * factor;
      } else {
        qtyInPrimary = bomQty;
      }

      // Units of the child physically consumed across the parent batch of
      // safeQty. Whole-unit lines ceiling to discrete stock (a strip you can't
      // cut a fraction of); fractional lines are exact and equal the prior
      // cascaded qty.
      const unitsConsumed = line.consume_whole_units
        ? Math.ceil(safeQty * qtyInPrimary)
        : safeQty * qtyInPrimary;

      // A MADE child is valued at its standard costing lot size (the run its
      // cost amortizes over), fixed regardless of how many this order draws. A
      // BOUGHT child is valued at what we actually consume (procurement tier /
      // floor). Mirrors compute_part_cost_at_qty exactly.
      const pinned = child.source === 'made';
      const childValQty = pinned ? (child.costing_batch_quantity ?? 1) : unitsConsumed;

      // Two numbers per child, always:
      //   childChargeBase — what a 'cost' line contributes. The child's rollup
      //     HONORING its own declarations, so a material markup declared inside
      //     the child survives the hop up instead of evaporating here.
      //   childTrueCost  — every basis in the subtree ignored. Margin denominator.
      // They are the same number until someone sets the toggle somewhere below.
      let childChargeBase: number | null = null;
      let childTrueCost: number | null = null;
      try {
        [childChargeBase, childTrueCost] = await Promise.all([
          getComputedPartChargeBase(child.id, childValQty),
          getComputedPartCost(child.id, childValQty),
        ]);
      } catch (err) {
        const detail = `cost lookup failed (${(err as Error).message})`;
        warnings.push({
          type: 'missing_material_cost',
          message: `${itemName}: ${detail}`,
          detail,
          material_id: line.id,
          child_part_id: child.id,
          child_part_name: itemName,
          child_part_source: child.source,
        });
        materialsComplete = false;
        continue;
      }

      if (childChargeBase === null || childTrueCost === null) {
        // Surface the deepest offending bought leaf via the explain RPC. The
        // BOM panel uses this to render an actionable tooltip with the leaf's
        // name + a link to its detail page. Explain at the same valuation qty
        // the cost function actually used (batch-pinned or consumed).
        let leafHint = '';
        try {
          const explain = await getPartCostExplain(child.id, childValQty);
          const firstLeaf = explain.missing_leaves[0];
          if (firstLeaf) {
            leafHint =
              firstLeaf.part_id === child.id
                ? `no priced tier covers qty ${formatQty(childValQty)}`
                : `no priced tier covers qty ${formatQty(firstLeaf.qty_required)} for ${firstLeaf.part_name}`;
          }
        } catch {
          // If explain itself fails (e.g. cycle), fall back to a generic message.
        }
        if (!leafHint) {
          leafHint =
            child.source === 'bought'
              ? `no priced tier covers qty ${formatQty(childValQty)} — add a procurement tier on the child part`
              : `no priced tier in the BOM subtree covers the cascaded qty — open the child`;
        }
        warnings.push({
          type: 'missing_material_cost',
          message: `${itemName}: ${leafHint}`,
          detail: leafHint,
          material_id: line.id,
          child_part_id: child.id,
          child_part_name: itemName,
          child_part_source: child.source,
        });
        materialsComplete = false;
        continue;
      }

      // What this line actually charges the parent. On a 'price' line the rate
      // is the child's marked-up price, resolved in SQL against the child's own
      // pricing tier — one implementation of the tier-band rule, not a second
      // copy of it here in another language on a money path.
      let chargedUnitRate = childChargeBase;
      if (line.charge_basis === 'price') {
        const priced = await getPartChargePrice(child.id, childValQty).catch(() => null);
        if (!priced || priced.unit_price === null) {
          const detail =
            'is charged at price but has no markup — add a pricing tier on this material';
          warnings.push({
            type: 'missing_child_markup',
            message: `${itemName}: ${detail}`,
            detail,
            material_id: line.id,
            child_part_id: child.id,
            child_part_name: itemName,
            child_part_source: child.source,
          });
          materialsComplete = false;
          continue;
        }
        chargedUnitRate = priced.unit_price;
      }

      // Per-parent-unit material contribution. The (fractional && not-pinned)
      // path is the LEGACY expression, kept textually identical so every
      // pre-existing BOM line yields a byte-identical cost. Ceiling / pinning
      // take the general (consumed × unit_cost) / batch form.
      const perParentUnit = (rate: number): number =>
        !line.consume_whole_units && !pinned
          ? qtyInPrimary * rate
          : (unitsConsumed * rate) / safeQty;
      materialItems.push({
        item_name: itemName,
        quantity: bomQty,
        unit: effectiveBomUnit || '',
        cost_per_unit: Math.round(chargedUnitRate * 10000) / 10000,
        cost: Math.round(perParentUnit(chargedUnitRate) * 100) / 100,
        true_cost: Math.round(perParentUnit(childTrueCost) * 100) / 100,
        qty_in_primary: qtyInPrimary,
        consume_whole_units: line.consume_whole_units,
        units_consumed: unitsConsumed,
      });
    }
  }

  const totalLaborCost =
    Math.round(laborItems.reduce((sum, item) => sum + item.cost, 0) * 100) / 100;
  const totalSetupCost =
    Math.round(laborItems.reduce((sum, item) => sum + item.setup_cost, 0) * 100) / 100;
  const totalMaterialCost = materialsComplete
    ? Math.round(materialItems.reduce((sum, item) => sum + item.cost, 0) * 100) / 100
    : null;
  const totalCost =
    totalMaterialCost === null
      ? null
      : Math.round((totalLaborCost + totalMaterialCost) * 100) / 100;
  const totalMaterialTrueCost = materialsComplete
    ? Math.round(materialItems.reduce((sum, item) => sum + item.true_cost, 0) * 100) / 100
    : null;
  const totalTrueCost =
    totalMaterialTrueCost === null
      ? null
      : Math.round((totalLaborCost + totalMaterialTrueCost) * 100) / 100;

  return {
    labor_items: laborItems,
    material_items: materialItems,
    total_labor_cost: totalLaborCost,
    total_setup_cost: totalSetupCost,
    total_material_cost: totalMaterialCost,
    total_cost: totalCost,
    total_material_true_cost: totalMaterialTrueCost,
    total_true_cost: totalTrueCost,
    materials_complete: materialsComplete,
    warnings,
  };
}

function formatQty(q: number): string {
  if (Number.isInteger(q)) return String(q);
  return q.toFixed(2).replace(/\.?0+$/, '');
}

export interface TierPricing {
  /** null when the breakdown has incomplete materials — see
   * `RoutingCostBreakdown.materials_complete`. UI should render "—" rather
   * than a misleading number that silently treats unpriced materials as $0.
   * This is the CHARGE base — the number the markup is applied to. */
  baseCostPerUnit: number | null;
  unitPrice: number | null;
  /** The same per-unit figure at TRUE cost. Equal to `baseCostPerUnit` unless a
   * BOM line charges its child at price; the gap is the material markup. */
  trueCostPerUnit: number | null;
}

/**
 * Compute per-unit base cost and unit price for a given quantity tier from
 * an existing breakdown.
 *
 * Run labor and materials are already per-unit in the breakdown.
 * Setup is one-time, so it amortizes across the tier quantity:
 *   baseCostPerUnit = run_per_unit + material_per_unit + (total_setup / quantity)
 * unitPrice = null if markup is null (signals "no price yet"); otherwise
 *   baseCostPerUnit × (1 + markupPercent / 100).
 *
 * Callers that need the canonical truth (cost that cascades sub-assembly
 * tier matching down the BOM at the parent's qty) should use
 * `getComputedPartCost(partId, qty)` directly. This helper is fine for UI
 * tier-pricing display where a per-tier-qty `calculateRoutingCost(partId,
 * qty)` has already done the cascade for materials.
 */
export function calculateTierPricing(
  breakdown: RoutingCostBreakdown,
  quantity: number,
  markupPercent: number | null,
): TierPricing {
  // If any BOM line couldn't be priced, the breakdown's material total is
  // null — there is no honest Base/unit to display.
  if (breakdown.total_material_cost === null) {
    return { baseCostPerUnit: null, unitPrice: null, trueCostPerUnit: null };
  }
  const qty = Math.max(quantity, 1);
  const runPerUnit = breakdown.total_labor_cost;
  const materialPerUnit = breakdown.total_material_cost;
  const setupPerUnit = breakdown.total_setup_cost / qty;
  const baseCostPerUnit = Math.round((runPerUnit + materialPerUnit + setupPerUnit) * 100) / 100;

  const unitPrice =
    markupPercent == null || Number.isNaN(markupPercent)
      ? null
      : Math.round(baseCostPerUnit * (1 + markupPercent / 100) * 100) / 100;

  const trueCostPerUnit =
    breakdown.total_material_true_cost === null
      ? null
      : Math.round(
          (runPerUnit + breakdown.total_material_true_cost + setupPerUnit) * 100,
        ) / 100;

  return { baseCostPerUnit, unitPrice, trueCostPerUnit };
}
