/**
 * Routings Module Types
 *
 * Types for the linear routing system. A routing is an ordered list of
 * operations plus a routing-level material list. Operations are ordered by
 * `sequence` (steps of 10 leave room for inserts).
 */

// ============================================
// Core Database Entities
// ============================================

/**
 * A routing is an ordered list of operations that defines how a part is
 * manufactured, plus the materials needed for the job as a whole. There
 * is exactly one routing per part.
 */
export interface Routing {
  id: string;
  company_id: string;
  part_id: string;
  name: string;
  description: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A single operation in the routing, ordered by `sequence`.
 */
export interface RoutingNode {
  id: string;
  routing_id: string;
  operation_type_id: string;
  run_time_per_unit: number | null;
  setup_time: number;
  metadata: Record<string, unknown>;
  sequence: number;
  created_at: string;
  updated_at: string;
}

/**
 * A material listed on the routing. Materials are routing-level, not per
 * operation, and snapshot into job_materials when a job is created.
 */
export interface RoutingMaterial {
  id: string;
  routing_id: string;
  inventory_item_id: string;
  quantity: number;
  unit: string;
  sequence: number;
  created_at: string;
  updated_at: string;
}

// ============================================
// Entities with Relations
// ============================================

/**
 * Routing with related part information for display in lists.
 */
export interface RoutingWithPart extends Routing {
  part: {
    id: string;
    part_name: string;
    description: string | null;
  } | null;
}

/**
 * Routing with node count and total time estimates for display.
 */
export interface RoutingWithStats extends RoutingWithPart {
  nodes_count: number;
  total_run_time_per_unit: number | null;
}

/**
 * Routing node joined with its operation type for display.
 */
export interface RoutingNodeWithOperation extends RoutingNode {
  operation_type: {
    id: string;
    name: string;
    labor_rate: number | null;
  } | null;
}

/**
 * Routing material joined with its inventory item for display and costing.
 */
export interface RoutingMaterialWithItem extends RoutingMaterial {
  inventory_item: {
    id: string;
    name: string;
    primary_unit: string;
    cost_per_unit: number | null;
  } | null;
}

/**
 * Full routing data: ordered operations + routing-level materials.
 * Used by the linear builder, viewer, and cost calculator.
 */
export interface RoutingWithGraph extends Routing {
  part: {
    id: string;
    part_name: string;
    description: string | null;
  } | null;
  nodes: RoutingNodeWithOperation[];
  materials: RoutingMaterialWithItem[];
}

// ============================================
// Form Data Types
// ============================================

/**
 * Form data for creating/editing a routing operation. Inline-edited in the
 * linear list — no modal.
 */
export interface RoutingNodeFormData {
  operation_type_id: string;
  run_time_per_unit: string;
  setup_time: string;
}

export const EMPTY_NODE_FORM: RoutingNodeFormData = {
  operation_type_id: '',
  run_time_per_unit: '',
  setup_time: '',
};

/**
 * Form data for creating/editing a routing material.
 */
export interface RoutingMaterialFormData {
  inventory_item_id: string;
  quantity: string;
  unit: string;
}

export const EMPTY_MATERIAL_FORM: RoutingMaterialFormData = {
  inventory_item_id: '',
  quantity: '',
  unit: '',
};

// ============================================
// Utility Functions
// ============================================

export function nodeToFormData(node: RoutingNode): RoutingNodeFormData {
  return {
    operation_type_id: node.operation_type_id,
    run_time_per_unit: node.run_time_per_unit !== null ? String(node.run_time_per_unit) : '',
    setup_time: node.setup_time ? String(node.setup_time) : '',
  };
}

export function materialToFormData(material: RoutingMaterial): RoutingMaterialFormData {
  return {
    inventory_item_id: material.inventory_item_id,
    quantity: String(material.quantity),
    unit: material.unit,
  };
}

/**
 * Sum setup + per-unit run time across all operations in a routing.
 */
export function calculateRoutingTime(
  nodes: RoutingNodeWithOperation[],
  quantity: number = 1
): { runTime: number; setupTime: number; totalTime: number } {
  let runTime = 0;
  let setupTime = 0;

  for (const node of nodes) {
    runTime += (node.run_time_per_unit || 0) * quantity;
    setupTime += node.setup_time || 0;
  }

  return {
    runTime,
    setupTime,
    totalTime: setupTime + runTime,
  };
}

/**
 * Format time in minutes to a human-readable string.
 */
export function formatTime(minutes: number | null): string {
  if (minutes === null || minutes === 0) return '—';

  if (minutes < 1) {
    const seconds = Math.round(minutes * 60);
    return `${seconds} sec`;
  }

  if (minutes < 60) {
    const display = Number.isInteger(minutes) ? minutes : Math.round(minutes * 10) / 10;
    return `${display} min`;
  }

  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);

  if (mins === 0) {
    return `${hours} hr`;
  }

  return `${hours} hr ${mins} min`;
}
