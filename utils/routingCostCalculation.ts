import { getRoutingForPart } from '@/utils/routingsAccess';

export interface CostWarning {
  type: 'empty_operation' | 'missing_labor_rate' | 'missing_material_cost' | 'no_operations';
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
 * Calculate the full cost breakdown for a part's routing.
 *
 * Labor (per operation): (run_time_per_unit / 60) × labor_rate, plus setup.
 * Setup-only operations (run = 0, setup > 0) are fully supported — their run
 * cost is 0 and setup cost is the whole labor contribution.
 * Materials: routing-level — Σ(quantity × cost_per_unit).
 *
 * Returns null if the part has no routing.
 */
export async function calculateRoutingCost(partId: string): Promise<RoutingCostBreakdown | null> {
  const routing = await getRoutingForPart(partId);
  if (!routing) return null;

  const warnings: CostWarning[] = [];
  const laborItems: LaborItem[] = [];
  const materialItems: MaterialItem[] = [];

  if (routing.nodes.length === 0) {
    warnings.push({
      type: 'no_operations',
      message: 'Routing has no operations defined',
    });
    return {
      labor_items: [],
      material_items: [],
      total_labor_cost: 0,
      total_setup_cost: 0,
      total_material_cost: 0,
      total_cost: 0,
      warnings,
    };
  }

  for (const node of routing.nodes) {
    const operationName = node.operation_type?.name || 'Unknown Operation';
    const runMinutes = node.run_time_per_unit ?? 0;
    const setupMinutes = node.setup_time ?? 0;
    const hasAnyTime = runMinutes > 0 || setupMinutes > 0;

    if (!hasAnyTime) {
      warnings.push({
        type: 'empty_operation',
        message: `${operationName}: no run or setup time set`,
        node_id: node.id,
      });
      continue;
    }

    const laborRate = node.operation_type?.labor_rate;
    if (!laborRate) {
      warnings.push({
        type: 'missing_labor_rate',
        message: `${operationName}: missing labor rate`,
        node_id: node.id,
      });
      continue;
    }

    const runCost = (runMinutes / 60) * laborRate;
    const setupCost = (setupMinutes / 60) * laborRate;
    laborItems.push({
      operation_name: operationName,
      run_time_minutes: runMinutes,
      setup_time_minutes: setupMinutes,
      labor_rate: laborRate,
      cost: Math.round(runCost * 100) / 100,
      setup_cost: Math.round(setupCost * 100) / 100,
    });
  }

  for (const mat of routing.materials) {
    const invItem = mat.inventory_item;
    if (!invItem) {
      warnings.push({
        type: 'missing_material_cost',
        message: `Material: inventory item not found (${mat.inventory_item_id})`,
        material_id: mat.id,
      });
      continue;
    }

    if (invItem.cost_per_unit === null || invItem.cost_per_unit === undefined) {
      warnings.push({
        type: 'missing_material_cost',
        message: `${invItem.name}: no cost per unit set`,
        material_id: mat.id,
      });
      continue;
    }

    const materialCost = mat.quantity * invItem.cost_per_unit;
    materialItems.push({
      item_name: invItem.name,
      quantity: mat.quantity,
      unit: mat.unit || invItem.primary_unit,
      cost_per_unit: invItem.cost_per_unit,
      cost: Math.round(materialCost * 100) / 100,
    });
  }

  const totalLaborCost = Math.round(laborItems.reduce((sum, item) => sum + item.cost, 0) * 100) / 100;
  const totalSetupCost = Math.round(laborItems.reduce((sum, item) => sum + item.setup_cost, 0) * 100) / 100;
  const totalMaterialCost = Math.round(materialItems.reduce((sum, item) => sum + item.cost, 0) * 100) / 100;

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
