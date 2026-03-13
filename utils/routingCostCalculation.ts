import { getSupabase } from '@/lib/supabase';
import { getRoutingForPart } from '@/utils/routingsAccess';

export interface CostWarning {
  type: 'missing_run_time' | 'missing_labor_rate' | 'missing_material_cost' | 'no_operations';
  message: string;
  node_id?: string;
}

export interface LaborItem {
  operation_name: string;
  run_time_minutes: number;
  labor_rate: number;
  cost: number;
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
  total_material_cost: number;
  total_cost: number;
  warnings: CostWarning[];
}

/**
 * Calculate the full cost breakdown for a part's routing.
 *
 * Fetches the routing and inventory item costs, then computes:
 * - Labor: (run_time_per_unit / 60) × labor_rate per node
 * - Materials: Σ(quantity × cost_per_unit) per node
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
      total_material_cost: 0,
      total_cost: 0,
      warnings,
    };
  }

  // Collect all unique inventory_item_ids from all nodes' materials
  const allItemIds = new Set<string>();
  for (const node of routing.nodes) {
    for (const mat of node.materials || []) {
      if (mat.inventory_item_id) {
        allItemIds.add(mat.inventory_item_id);
      }
    }
  }

  // Batch-fetch inventory items for cost lookup
  let inventoryMap = new Map<string, { name: string; cost_per_unit: number | null; primary_unit: string }>();
  if (allItemIds.size > 0) {
    const supabase = getSupabase();
    const { data: items, error } = await supabase
      .from('inventory_items')
      .select('id, name, cost_per_unit, primary_unit')
      .in('id', Array.from(allItemIds));

    if (error) {
      console.error('Error fetching inventory items for cost calculation:', error);
    } else if (items) {
      for (const item of items) {
        inventoryMap.set(item.id, {
          name: item.name,
          cost_per_unit: item.cost_per_unit,
          primary_unit: item.primary_unit,
        });
      }
    }
  }

  // Calculate costs per node
  for (const node of routing.nodes) {
    const operationName = node.operation_type?.name || 'Unknown Operation';

    // Labor cost
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
      laborItems.push({
        operation_name: operationName,
        run_time_minutes: node.run_time_per_unit,
        labor_rate: node.operation_type.labor_rate,
        cost: Math.round(laborCost * 10000) / 10000,
      });
    }

    // Material costs
    for (const mat of node.materials || []) {
      const invItem = inventoryMap.get(mat.inventory_item_id);
      if (!invItem) {
        warnings.push({
          type: 'missing_material_cost',
          message: `${operationName}: inventory item not found (${mat.inventory_item_id})`,
          node_id: node.id,
        });
        continue;
      }

      if (invItem.cost_per_unit === null || invItem.cost_per_unit === undefined) {
        warnings.push({
          type: 'missing_material_cost',
          message: `${operationName}: ${invItem.name} has no cost per unit`,
          node_id: node.id,
        });
        continue;
      }

      const materialCost = mat.quantity * invItem.cost_per_unit;
      materialItems.push({
        item_name: invItem.name,
        quantity: mat.quantity,
        unit: mat.unit || invItem.primary_unit,
        cost_per_unit: invItem.cost_per_unit,
        cost: Math.round(materialCost * 10000) / 10000,
      });
    }
  }

  const totalLaborCost = Math.round(laborItems.reduce((sum, item) => sum + item.cost, 0) * 10000) / 10000;
  const totalMaterialCost = Math.round(materialItems.reduce((sum, item) => sum + item.cost, 0) * 10000) / 10000;

  return {
    labor_items: laborItems,
    material_items: materialItems,
    total_labor_cost: totalLaborCost,
    total_material_cost: totalMaterialCost,
    total_cost: Math.round((totalLaborCost + totalMaterialCost) * 10000) / 10000,
    warnings,
  };
}
