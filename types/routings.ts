/**
 * Routings Module Types
 *
 * Types for the visual workflow-based routing system that supports
 * parallel and series operations.
 */

import type { Node, Edge } from '@xyflow/react';

// ============================================
// Core Database Entities
// ============================================

/**
 * Material reference for a routing node.
 */
export interface RoutingNodeMaterial {
  inventory_item_id: string;
  quantity: number;
  unit: string;
}

/**
 * A routing is a workflow diagram that defines how a part is manufactured.
 * It consists of nodes (operations) connected by edges (dependencies).
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
 * A node in the routing workflow diagram representing a single operation.
 * Nodes are connected by edges to define execution flow.
 */
export interface RoutingNode {
  id: string;
  routing_id: string;
  operation_type_id: string;
  run_time_per_unit: number | null;
  setup_time: number;
  instructions: string | null;
  metadata: Record<string, unknown>;
  materials: RoutingNodeMaterial[];
  created_at: string;
  updated_at: string;
}

/**
 * An edge connecting two nodes in the routing workflow.
 * The source node must complete before the target node can start.
 */
export interface RoutingEdge {
  id: string;
  routing_id: string;
  source_node_id: string;
  target_node_id: string;
  created_at: string;
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
    part_number: string;
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
 * Routing node with operation type information for display.
 */
export interface RoutingNodeWithOperation extends RoutingNode {
  operation_type: {
    id: string;
    name: string;
    labor_rate: number | null;
    resource_group_id: string | null;
    resource_group?: {
      id: string;
      name: string;
    } | null;
  } | null;
}

/**
 * Full routing data with all nodes and edges for the workflow builder.
 */
export interface RoutingWithGraph extends Routing {
  part: {
    id: string;
    part_number: string;
    description: string | null;
  } | null;
  nodes: RoutingNodeWithOperation[];
  edges: RoutingEdge[];
}

// ============================================
// React Flow Types
// ============================================

/**
 * Data stored in each React Flow operation node.
 */
export interface OperationNodeData {
  [key: string]: unknown;
  nodeId: string;
  operationTypeId: string;
  operationName: string;
  resourceGroupName: string | null;
  runTimePerUnit: number | null;
  setupTime: number;
  instructions: string | null;
  laborRate: number | null;
  materials: RoutingNodeMaterial[];
}

/**
 * React Flow node type for operation nodes.
 */
export type FlowOperationNode = Node<OperationNodeData, 'operation'>;

/**
 * React Flow edge type for connections.
 */
export type FlowEdge = Edge;

// ============================================
// Form Data Types
// ============================================

// RoutingFormData removed — Step 1 of wizard eliminated.
// Routing name is auto-generated from part number.
// Routing is always scoped to a part via URL context.

/**
 * Form data for creating/editing a routing node.
 */
export interface RoutingNodeFormData {
  operation_type_id: string;
  run_time_per_unit: string;
  setup_time: string;
  instructions: string;
  materials: RoutingNodeMaterial[];
}

/**
 * Empty node form data for new node creation.
 */
export const EMPTY_NODE_FORM: RoutingNodeFormData = {
  operation_type_id: '',
  run_time_per_unit: '',
  setup_time: '',
  instructions: '',
  materials: [],
};

// ============================================
// Utility Functions
// ============================================

// routingToFormData removed — no longer needed with Step 1 elimination.

/**
 * Convert a RoutingNode entity to form data.
 */
export function nodeToFormData(node: RoutingNode): RoutingNodeFormData {
  return {
    operation_type_id: node.operation_type_id,
    run_time_per_unit: node.run_time_per_unit !== null ? String(node.run_time_per_unit) : '',
    setup_time: node.setup_time ? String(node.setup_time) : '',
    instructions: node.instructions || '',
    materials: node.materials || [],
  };
}

/**
 * Convert database nodes and edges to React Flow format.
 */
export function toFlowElements(
  nodes: RoutingNodeWithOperation[],
  edges: RoutingEdge[]
): { nodes: FlowOperationNode[]; edges: FlowEdge[] } {
  const flowNodes: FlowOperationNode[] = nodes.map((node, index) => ({
    id: node.id,
    type: 'operation',
    // Position will be calculated by dagre layout
    position: { x: index * 250, y: 100 },
    data: {
      nodeId: node.id,
      operationTypeId: node.operation_type_id,
      operationName: node.operation_type?.name || 'Unknown Operation',
      resourceGroupName: node.operation_type?.resource_group?.name || null,
      runTimePerUnit: node.run_time_per_unit,
      setupTime: node.setup_time,
      instructions: node.instructions,
      laborRate: node.operation_type?.labor_rate || null,
      materials: node.materials || [],
    },
  }));

  const flowEdges: FlowEdge[] = edges.map((edge) => ({
    id: edge.id,
    source: edge.source_node_id,
    target: edge.target_node_id,
    type: 'smoothstep',
    animated: false,
  }));

  return { nodes: flowNodes, edges: flowEdges };
}

/**
 * Calculate total time for a routing given a quantity.
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

  // Sub-minute: show seconds
  if (minutes < 1) {
    const seconds = Math.round(minutes * 60);
    return `${seconds} sec`;
  }

  if (minutes < 60) {
    // Show whole minutes, or 1 decimal if fractional
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
