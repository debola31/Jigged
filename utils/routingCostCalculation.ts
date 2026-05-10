import { getRoutingForPart } from '@/utils/routingsAccess';
import { getBomForPart } from '@/utils/bomAccess';

export interface CostWarning {
  type:
    | 'empty_operation'
    | 'missing_labor_rate'
    | 'missing_material_cost'
    | 'no_operations'
    | 'missing_external_pricing';
  message: string;
  node_id?: string;
  material_id?: string;
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
  quantity: number;
  unit: string;
  cost_per_unit: number;
  cost: number;
}

export interface RoutingCostBreakdown {
  labor_items: LaborItem[];
  material_items: MaterialItem[];
  total_labor_cost: number;
  total_setup_cost: number;
  total_material_cost: number;
  total_cost: number;
  warnings: CostWarning[];
}

/**
 * Calculate the full cost breakdown for a part's routing + BOM.
 *
 * Internal ops are priced via (cycle + setup) × COALESCE(override, wc rate).
 * External ops are priced via external_unit_price + external_setup_cost — the
 * unit price contributes to per-unit cost, the setup cost is one-time.
 * Materials come from `parts_bom` (BOM is part-attached now, not routing-attached).
 *
 * Returns null if the part has no routing AND no BOM.
 */
export async function calculateRoutingCost(partId: string): Promise<RoutingCostBreakdown | null> {
  const [routing, bomLines] = await Promise.all([
    getRoutingForPart(partId),
    getBomForPart(partId),
  ]);

  if (!routing && bomLines.length === 0) return null;

  const warnings: CostWarning[] = [];
  const laborItems: LaborItem[] = [];
  const materialItems: MaterialItem[] = [];

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
        const unitPrice = op.external_unit_price !== null ? Number(op.external_unit_price) : null;
        const setupCost = op.external_setup_cost !== null ? Number(op.external_setup_cost) : null;
        if (unitPrice === null && setupCost === null) {
          warnings.push({
            type: 'missing_external_pricing',
            message: `${operationName}: external op has no unit price or setup cost`,
            node_id: op.id,
          });
          continue;
        }
        laborItems.push({
          operation_name: operationName,
          run_time_minutes: 0,
          setup_time_minutes: 0,
          labor_rate: 0,
          cost: Math.round((unitPrice ?? 0) * 100) / 100,
          setup_cost: Math.round((setupCost ?? 0) * 100) / 100,
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

  for (const line of bomLines) {
    const child = line.child_part;
    const itemName = child.part_name;

    if (child.cost_per_unit === null || child.cost_per_unit === undefined) {
      warnings.push({
        type: 'missing_material_cost',
        message: `${itemName}: no cost per unit set`,
        material_id: line.id,
      });
      continue;
    }

    const materialCost = Number(line.quantity) * Number(child.cost_per_unit);
    materialItems.push({
      item_name: itemName,
      quantity: Number(line.quantity),
      unit: line.unit || child.primary_unit || '',
      cost_per_unit: Number(child.cost_per_unit),
      cost: Math.round(materialCost * 100) / 100,
    });
  }

  const totalLaborCost =
    Math.round(laborItems.reduce((sum, item) => sum + item.cost, 0) * 100) / 100;
  const totalSetupCost =
    Math.round(laborItems.reduce((sum, item) => sum + item.setup_cost, 0) * 100) / 100;
  const totalMaterialCost =
    Math.round(materialItems.reduce((sum, item) => sum + item.cost, 0) * 100) / 100;

  return {
    labor_items: laborItems,
    material_items: materialItems,
    total_labor_cost: totalLaborCost,
    total_setup_cost: totalSetupCost,
    total_material_cost: totalMaterialCost,
    total_cost: Math.round((totalLaborCost + totalMaterialCost) * 100) / 100,
    warnings,
  };
}

export interface TierPricing {
  baseCostPerUnit: number;
  unitPrice: number | null;
}

/**
 * Compute per-unit base cost and unit price for a given quantity tier.
 *
 * Run labor and materials are already per-unit in the breakdown.
 * Setup is one-time, so it amortizes across the tier quantity:
 *   baseCostPerUnit = run_per_unit + material_per_unit + (total_setup / quantity)
 * unitPrice = null if markup is null (signals "no price yet"); otherwise
 *   baseCostPerUnit × (1 + markupPercent / 100).
 */
export function calculateTierPricing(
  breakdown: RoutingCostBreakdown,
  quantity: number,
  markupPercent: number | null,
): TierPricing {
  const qty = Math.max(quantity, 1);
  const runPerUnit = breakdown.total_labor_cost;
  const materialPerUnit = breakdown.total_material_cost;
  const setupPerUnit = breakdown.total_setup_cost / qty;
  const baseCostPerUnit = Math.round((runPerUnit + materialPerUnit + setupPerUnit) * 100) / 100;

  const unitPrice =
    markupPercent == null || Number.isNaN(markupPercent)
      ? null
      : Math.round(baseCostPerUnit * (1 + markupPercent / 100) * 100) / 100;

  return { baseCostPerUnit, unitPrice };
}
