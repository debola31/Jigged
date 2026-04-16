import { getRoutingForPart } from '@/utils/routingsAccess';

export interface CostWarning {
  type: 'missing_run_time' | 'missing_labor_rate' | 'missing_material_cost' | 'no_operations';
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
 * Labor: per operation, (run_time_per_unit / 60) × labor_rate, plus setup.
 * Materials: routing-level (not per-operation) — Σ(quantity × cost_per_unit)
 * across the routing's material list.
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

  // Labor cost per operation
  for (const node of routing.nodes) {
    const operationName = node.operation_type?.name || 'Unknown Operation';

    if (node.run_time_per_unit === null || node.run_time_per_unit === undefined) {
      warnings.push({
        type: 'missing_run_time',
        message: `${operationName}: missing run time`,
        node_id: node.id,
      });
    } else if (!node.operation_type?.labor_rate) {
      warnings.push({
        type: 'missing_labor_rate',
        message: `${operationName}: missing labor rate`,
        node_id: node.id,
      });
    } else {
      const laborCost = (node.run_time_per_unit / 60) * node.operation_type.labor_rate;
      const setupCost = ((node.setup_time || 0) / 60) * node.operation_type.labor_rate;
      laborItems.push({
        operation_name: operationName,
        run_time_minutes: node.run_time_per_unit,
        setup_time_minutes: node.setup_time || 0,
        labor_rate: node.operation_type.labor_rate,
        cost: Math.round(laborCost * 100) / 100,
        setup_cost: Math.round(setupCost * 100) / 100,
      });
    }
  }

  // Material cost across the routing (joined inventory item already loaded)
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
