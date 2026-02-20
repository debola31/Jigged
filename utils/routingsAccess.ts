/**
 * Routings Data Access Layer
 *
 * Functions for CRUD operations on routings, nodes, and edges.
 * Supports the visual workflow builder with parallel/series operations.
 */

import { getSupabase } from '@/lib/supabase';
import type {
  Routing,
  RoutingNode,
  RoutingEdge,
  RoutingWithPart,
  RoutingWithStats,
  RoutingWithGraph,
  RoutingNodeWithOperation,
  RoutingFormData,
  RoutingNodeFormData,
} from '@/types/routings';

// ============================================
// Routing CRUD Operations
// ============================================

/**
 * Get all routings for a company with optional filters.
 */
export async function getRoutings(
  companyId: string,
  options?: {
    search?: string;
    partId?: string;
    sortField?: string;
    sortDirection?: 'asc' | 'desc';
  }
): Promise<RoutingWithStats[]> {
  const supabase = getSupabase();
  const { search, partId, sortField = 'name', sortDirection = 'asc' } = options || {};

  let query = supabase
    .from('routings')
    .select(`
      *,
      part:parts(id, part_number, description),
      nodes:routing_nodes(id, run_time_per_unit)
    `)
    .eq('company_id', companyId);

  if (search?.trim()) {
    query = query.or(`name.ilike.%${search}%,description.ilike.%${search}%`);
  }

  if (partId) {
    query = query.eq('part_id', partId);
  }

  query = query.order(sortField, { ascending: sortDirection === 'asc' });

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching routings:', error);
    throw error;
  }

  // Calculate stats from nodes
  interface RoutingRow {
    id: string;
    company_id: string;
    part_id: string | null;
    name: string;
    description: string | null;
    is_default: boolean;
    created_by: string | null;
    created_at: string;
    updated_at: string;
    part: { id: string; part_number: string; description: string | null } | null;
    nodes?: Array<{ id: string; run_time_per_unit: number | null }>;
  }

  return (data || []).map((routing: RoutingRow) => {
    const nodes = routing.nodes || [];
    const totalRun = nodes.reduce(
      (sum: number, n) => sum + (n.run_time_per_unit || 0),
      0
    );

    const { nodes: _, ...rest } = routing;
    return {
      ...rest,
      nodes_count: nodes.length,
      total_run_time_per_unit: totalRun || null,
    } as RoutingWithStats;
  });
}

/**
 * Get a single routing by ID with basic info.
 */
export async function getRouting(routingId: string): Promise<RoutingWithPart | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('routings')
    .select(`
      *,
      part:parts(id, part_number, description)
    `)
    .eq('id', routingId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null; // Not found
    console.error('Error fetching routing:', error);
    throw error;
  }

  return data;
}

/**
 * Get a routing with full graph data (nodes and edges) for the workflow builder.
 */
export async function getRoutingWithGraph(routingId: string): Promise<RoutingWithGraph | null> {
  const supabase = getSupabase();

  // Fetch routing with part
  const { data: routing, error: routingError } = await supabase
    .from('routings')
    .select(`
      *,
      part:parts(id, part_number, description)
    `)
    .eq('id', routingId)
    .single();

  if (routingError) {
    if (routingError.code === 'PGRST116') return null;
    console.error('Error fetching routing:', routingError);
    throw routingError;
  }

  // Fetch nodes with operation types
  const { data: nodes, error: nodesError } = await supabase
    .from('routing_nodes')
    .select(`
      *,
      operation_type:operation_types(
        id,
        name,
        labor_rate,
        resource_group_id,
        resource_group:resource_groups(id, name)
      )
    `)
    .eq('routing_id', routingId)
    .order('created_at', { ascending: true });

  if (nodesError) {
    console.error('Error fetching routing nodes:', nodesError);
    throw nodesError;
  }

  // Fetch edges
  const { data: edges, error: edgesError } = await supabase
    .from('routing_edges')
    .select('*')
    .eq('routing_id', routingId);

  if (edgesError) {
    console.error('Error fetching routing edges:', edgesError);
    throw edgesError;
  }

  return {
    ...routing,
    nodes: nodes || [],
    edges: edges || [],
  };
}

/**
 * Create a new routing.
 */
export async function createRouting(
  companyId: string,
  formData: RoutingFormData
): Promise<Routing> {
  const supabase = getSupabase();

  // If setting as default, unset other defaults for this part
  if (formData.is_default && formData.part_id) {
    await supabase
      .from('routings')
      .update({ is_default: false })
      .eq('company_id', companyId)
      .eq('part_id', formData.part_id)
      .eq('is_default', true);
  }

  const { data, error } = await supabase
    .from('routings')
    .insert({
      company_id: companyId,
      name: formData.name.trim(),
      part_id: formData.part_id || null,
      description: formData.description.trim() || null,
      is_default: formData.is_default,
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating routing:', error);
    throw error;
  }

  return data;
}

/**
 * Update an existing routing.
 */
export async function updateRouting(
  routingId: string,
  formData: RoutingFormData
): Promise<Routing> {
  const supabase = getSupabase();

  // Get current routing to check company_id
  const { data: current, error: fetchError } = await supabase
    .from('routings')
    .select('company_id, part_id')
    .eq('id', routingId)
    .single();

  if (fetchError) throw fetchError;

  // If setting as default, unset other defaults for this part
  if (formData.is_default && formData.part_id) {
    await supabase
      .from('routings')
      .update({ is_default: false })
      .eq('company_id', current.company_id)
      .eq('part_id', formData.part_id)
      .eq('is_default', true)
      .neq('id', routingId);
  }

  const { data, error } = await supabase
    .from('routings')
    .update({
      name: formData.name.trim(),
      part_id: formData.part_id || null,
      description: formData.description.trim() || null,
      is_default: formData.is_default,
      updated_at: new Date().toISOString(),
    })
    .eq('id', routingId)
    .select()
    .single();

  if (error) {
    console.error('Error updating routing:', error);
    throw error;
  }

  return data;
}

/**
 * Delete a routing (cascades to nodes and edges).
 */
export async function deleteRouting(routingId: string): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase.from('routings').delete().eq('id', routingId);

  if (error) {
    console.error('Error deleting routing:', error);
    throw error;
  }
}

/**
 * Clone a routing with all its nodes and edges.
 */
export async function cloneRouting(
  routingId: string,
  newName: string
): Promise<Routing> {
  const supabase = getSupabase();

  // Get original routing with graph
  const original = await getRoutingWithGraph(routingId);
  if (!original) throw new Error('Routing not found');

  // Create new routing
  const { data: newRouting, error: routingError } = await supabase
    .from('routings')
    .insert({
      company_id: original.company_id,
      name: newName.trim(),
      part_id: original.part_id,
      description: original.description,
      is_default: false,
    })
    .select()
    .single();

  if (routingError) throw routingError;

  // Map old node IDs to new node IDs
  const nodeIdMap = new Map<string, string>();

  // Clone nodes
  if (original.nodes.length > 0) {
    for (const node of original.nodes) {
      const { data: newNode, error: nodeError } = await supabase
        .from('routing_nodes')
        .insert({
          routing_id: newRouting.id,
          operation_type_id: node.operation_type_id,
          run_time_per_unit: node.run_time_per_unit,
          instructions: node.instructions,
          metadata: node.metadata,
          materials: node.materials || [],
        })
        .select()
        .single();

      if (nodeError) throw nodeError;
      nodeIdMap.set(node.id, newNode.id);
    }
  }

  // Clone edges with mapped node IDs
  if (original.edges.length > 0) {
    const newEdges = original.edges.map((edge) => ({
      routing_id: newRouting.id,
      source_node_id: nodeIdMap.get(edge.source_node_id)!,
      target_node_id: nodeIdMap.get(edge.target_node_id)!,
    }));

    const { error: edgesError } = await supabase
      .from('routing_edges')
      .insert(newEdges);

    if (edgesError) throw edgesError;
  }

  return newRouting;
}

// ============================================
// Node CRUD Operations
// ============================================

/**
 * Create a new routing node.
 */
export async function createRoutingNode(
  routingId: string,
  formData: RoutingNodeFormData
): Promise<RoutingNode> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('routing_nodes')
    .insert({
      routing_id: routingId,
      operation_type_id: formData.operation_type_id,
      run_time_per_unit: formData.run_time_per_unit
        ? parseFloat(formData.run_time_per_unit)
        : null,
      instructions: formData.instructions.trim() || null,
      metadata: {},
      materials: formData.materials || [],
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating routing node:', error);
    throw error;
  }

  return data;
}

/**
 * Update a routing node.
 */
export async function updateRoutingNode(
  nodeId: string,
  formData: RoutingNodeFormData
): Promise<RoutingNode> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('routing_nodes')
    .update({
      operation_type_id: formData.operation_type_id,
      run_time_per_unit: formData.run_time_per_unit
        ? parseFloat(formData.run_time_per_unit)
        : null,
      instructions: formData.instructions.trim() || null,
      materials: formData.materials || [],
      updated_at: new Date().toISOString(),
    })
    .eq('id', nodeId)
    .select()
    .single();

  if (error) {
    console.error('Error updating routing node:', error);
    throw error;
  }

  return data;
}

/**
 * Delete a routing node (cascades to edges).
 */
export async function deleteRoutingNode(nodeId: string): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase.from('routing_nodes').delete().eq('id', nodeId);

  if (error) {
    console.error('Error deleting routing node:', error);
    throw error;
  }
}

// ============================================
// Edge CRUD Operations
// ============================================

/**
 * Create a new edge between two nodes.
 */
export async function createRoutingEdge(
  routingId: string,
  sourceNodeId: string,
  targetNodeId: string
): Promise<RoutingEdge> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('routing_edges')
    .insert({
      routing_id: routingId,
      source_node_id: sourceNodeId,
      target_node_id: targetNodeId,
    })
    .select()
    .single();

  if (error) {
    // Handle duplicate edge
    if (error.code === '23505') {
      throw new Error('This connection already exists');
    }
    console.error('Error creating routing edge:', error);
    throw error;
  }

  return data;
}

/**
 * Delete an edge.
 */
export async function deleteRoutingEdge(edgeId: string): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase.from('routing_edges').delete().eq('id', edgeId);

  if (error) {
    console.error('Error deleting routing edge:', error);
    throw error;
  }
}

// ============================================
// Bulk Operations for Workflow Builder
// ============================================

/**
 * Save the entire graph from React Flow.
 * This handles adding/removing nodes and edges efficiently.
 */
export async function saveRoutingGraph(
  routingId: string,
  nodes: Array<{
    id: string;
    isNew?: boolean;
    operationTypeId: string;
    runTimePerUnit: number | null;
    instructions: string | null;
    materials: unknown[];
  }>,
  edges: Array<{
    id: string;
    isNew?: boolean;
    sourceNodeId: string;
    targetNodeId: string;
  }>,
  deletedNodeIds: string[],
  deletedEdgeIds: string[]
): Promise<void> {
  const supabase = getSupabase();

  // Delete removed edges first (due to FK constraints)
  if (deletedEdgeIds.length > 0) {
    const { error: deleteEdgesError } = await supabase
      .from('routing_edges')
      .delete()
      .in('id', deletedEdgeIds);

    if (deleteEdgesError) throw deleteEdgesError;
  }

  // Delete removed nodes
  if (deletedNodeIds.length > 0) {
    const { error: deleteNodesError } = await supabase
      .from('routing_nodes')
      .delete()
      .in('id', deletedNodeIds);

    if (deleteNodesError) throw deleteNodesError;
  }

  // Track new node ID mappings (temp ID → real ID)
  const nodeIdMap = new Map<string, string>();

  // Insert new nodes and update existing
  for (const node of nodes) {
    if (node.isNew) {
      const { data, error } = await supabase
        .from('routing_nodes')
        .insert({
          routing_id: routingId,
          operation_type_id: node.operationTypeId,
          run_time_per_unit: node.runTimePerUnit,
          instructions: node.instructions,
          metadata: {},
          materials: node.materials || [],
        })
        .select()
        .single();

      if (error) throw error;
      nodeIdMap.set(node.id, data.id);
    } else {
      const { error } = await supabase
        .from('routing_nodes')
        .update({
          operation_type_id: node.operationTypeId,
          run_time_per_unit: node.runTimePerUnit,
          instructions: node.instructions,
          materials: node.materials || [],
          updated_at: new Date().toISOString(),
        })
        .eq('id', node.id);

      if (error) throw error;
      nodeIdMap.set(node.id, node.id);
    }
  }

  // Insert new edges with mapped node IDs
  const newEdges = edges.filter((e) => e.isNew);
  if (newEdges.length > 0) {
    const edgesToInsert = newEdges.map((edge) => ({
      routing_id: routingId,
      source_node_id: nodeIdMap.get(edge.sourceNodeId) || edge.sourceNodeId,
      target_node_id: nodeIdMap.get(edge.targetNodeId) || edge.targetNodeId,
    }));

    const { error: insertEdgesError } = await supabase
      .from('routing_edges')
      .insert(edgesToInsert);

    if (insertEdgesError) throw insertEdgesError;
  }
}

// ============================================
// Utility Functions
// ============================================

/**
 * Check if a routing name already exists for a company.
 */
export async function checkRoutingNameExists(
  companyId: string,
  name: string,
  excludeId?: string
): Promise<boolean> {
  const supabase = getSupabase();

  let query = supabase
    .from('routings')
    .select('id')
    .eq('company_id', companyId)
    .ilike('name', name.trim());

  if (excludeId) {
    query = query.neq('id', excludeId);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error checking routing name:', error);
    throw error;
  }

  return (data?.length || 0) > 0;
}

/**
 * Get the default routing for a part.
 */
export async function getDefaultRoutingForPart(partId: string): Promise<Routing | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('routings')
    .select('*')
    .eq('part_id', partId)
    .eq('is_default', true)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    console.error('Error fetching default routing:', error);
    throw error;
  }

  return data;
}

/**
 * Bulk delete routings.
 */
export async function bulkDeleteRoutings(routingIds: string[]): Promise<void> {
  if (routingIds.length === 0) return;

  const supabase = getSupabase();
  const BATCH_SIZE = 100;

  for (let i = 0; i < routingIds.length; i += BATCH_SIZE) {
    const batch = routingIds.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('routings').delete().in('id', batch);

    if (error) {
      console.error('Error bulk deleting routings:', error);
      throw error;
    }
  }
}

// ============================================
// Wizard Save Operations
// ============================================

/**
 * Pending node data for wizard memory mode.
 */
interface PendingNode {
  tempId: string;
  operationTypeId: string;
  operationName: string;
  resourceGroupName: string | null;
  laborRate: number | null;
  runTimePerUnit: number | null;
  instructions: string | null;
  materials: unknown[];
}

/**
 * Pending edge data for wizard memory mode.
 */
interface PendingEdge {
  tempId: string;
  sourceNodeId: string;
  targetNodeId: string;
}

/**
 * Save a routing with its complete graph from the wizard.
 * Handles both create and edit modes.
 *
 * @param companyId - Company ID
 * @param routingId - Existing routing ID (null for create mode)
 * @param formData - Routing form data (name, part_id, description, is_default)
 * @param pendingNodes - Nodes from the workflow builder
 * @param pendingEdges - Edges from the workflow builder
 * @param originalNodeIds - Original node IDs to track deletions (edit mode only)
 * @param originalEdgeIds - Original edge IDs to track deletions (edit mode only)
 */
export async function saveRoutingWithGraph(
  companyId: string,
  routingId: string | null,
  formData: RoutingFormData,
  pendingNodes: PendingNode[],
  pendingEdges: PendingEdge[],
  originalNodeIds: Set<string>,
  originalEdgeIds: Set<string>
): Promise<Routing> {
  const supabase = getSupabase();
  const isEditMode = !!routingId;

  // Step 1: Create or update the routing
  let routing: Routing;
  if (isEditMode) {
    routing = await updateRouting(routingId, formData);
  } else {
    routing = await createRouting(companyId, formData);
  }

  // Step 2: Determine which nodes/edges to delete, create, or update
  const currentNodeIds = new Set(pendingNodes.map((n) => n.tempId));
  const currentEdgeIds = new Set(pendingEdges.map((e) => e.tempId));

  // Nodes to delete: in original but not in current
  const nodesToDelete = [...originalNodeIds].filter((id) => !currentNodeIds.has(id));

  // Edges to delete: in original but not in current
  const edgesToDelete = [...originalEdgeIds].filter((id) => !currentEdgeIds.has(id));

  // Step 3: Delete removed edges first (due to FK constraints)
  if (edgesToDelete.length > 0) {
    const { error } = await supabase
      .from('routing_edges')
      .delete()
      .in('id', edgesToDelete);
    if (error) throw error;
  }

  // Step 4: Delete removed nodes
  if (nodesToDelete.length > 0) {
    const { error } = await supabase
      .from('routing_nodes')
      .delete()
      .in('id', nodesToDelete);
    if (error) throw error;
  }

  // Step 5: Create/update nodes and track ID mappings
  const nodeIdMap = new Map<string, string>(); // tempId -> realId

  for (const node of pendingNodes) {
    const isTempId = node.tempId.startsWith('temp-');
    const isExisting = originalNodeIds.has(node.tempId);

    if (isTempId || !isExisting) {
      // Create new node
      const { data, error } = await supabase
        .from('routing_nodes')
        .insert({
          routing_id: routing.id,
          operation_type_id: node.operationTypeId,
          run_time_per_unit: node.runTimePerUnit,
          instructions: node.instructions,
          metadata: {},
          materials: node.materials || [],
        })
        .select()
        .single();

      if (error) throw error;
      nodeIdMap.set(node.tempId, data.id);
    } else {
      // Update existing node
      const { error } = await supabase
        .from('routing_nodes')
        .update({
          operation_type_id: node.operationTypeId,
          run_time_per_unit: node.runTimePerUnit,
          instructions: node.instructions,
          materials: node.materials || [],
          updated_at: new Date().toISOString(),
        })
        .eq('id', node.tempId);

      if (error) throw error;
      nodeIdMap.set(node.tempId, node.tempId);
    }
  }

  // Step 6: Create new edges with mapped node IDs
  const newEdges = pendingEdges.filter(
    (e) => e.tempId.startsWith('temp-') || !originalEdgeIds.has(e.tempId)
  );

  if (newEdges.length > 0) {
    const edgesToInsert = newEdges.map((edge) => ({
      routing_id: routing.id,
      source_node_id: nodeIdMap.get(edge.sourceNodeId) || edge.sourceNodeId,
      target_node_id: nodeIdMap.get(edge.targetNodeId) || edge.targetNodeId,
    }));

    const { error } = await supabase
      .from('routing_edges')
      .insert(edgesToInsert);

    if (error) throw error;
  }

  return routing;
}
