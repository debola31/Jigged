/**
 * Routings Data Access Layer
 *
 * Functions for CRUD operations on routings, nodes, and edges.
 * Each part has exactly one routing (1:1 relationship).
 * Routing names are auto-generated from the part number.
 */

import { getSupabase } from '@/lib/supabase';
import type {
  Routing,
  RoutingNode,
  RoutingEdge,
  RoutingWithPart,
  RoutingWithStats,
  RoutingWithGraph,
  RoutingNodeFormData,
} from '@/types/routings';

// ============================================
// Routing CRUD Operations
// ============================================

/**
 * Get the routing for a specific part (1:1 relationship).
 * Returns null if the part has no routing.
 */
export async function getRoutingForPart(partId: string): Promise<RoutingWithGraph | null> {
  const supabase = getSupabase();

  // Fetch routing for this part
  const { data: routing, error: routingError } = await supabase
    .from('routings')
    .select(`
      *,
      part:parts(id, part_number, description)
    `)
    .eq('part_id', partId)
    .maybeSingle();

  if (routingError) {
    console.error('Error fetching routing for part:', routingError);
    throw routingError;
  }

  if (!routing) return null;

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
    .eq('routing_id', routing.id)
    .order('created_at', { ascending: true });

  if (nodesError) {
    console.error('Error fetching routing nodes:', nodesError);
    throw nodesError;
  }

  // Fetch edges
  const { data: edges, error: edgesError } = await supabase
    .from('routing_edges')
    .select('*')
    .eq('routing_id', routing.id);

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
 * Get routing summary for a part (lightweight, for display).
 */
export async function getRoutingSummaryForPart(
  partId: string
): Promise<{ id: string; nodeCount: number; totalRunTime: number | null } | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('routings')
    .select(`
      id,
      routing_nodes(id, run_time_per_unit)
    `)
    .eq('part_id', partId)
    .maybeSingle();

  if (error) {
    console.error('Error fetching routing summary:', error);
    throw error;
  }

  if (!data) return null;

  const nodes = (data.routing_nodes as Array<{ id: string; run_time_per_unit: number | null }>) || [];
  const totalRun = nodes.reduce((sum, n) => sum + (n.run_time_per_unit || 0), 0);

  return {
    id: data.id,
    nodeCount: nodes.length,
    totalRunTime: totalRun || null,
  };
}

/**
 * Get all routings for a company (for admin/listing purposes).
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

  interface RoutingRow {
    id: string;
    company_id: string;
    part_id: string;
    name: string;
    description: string | null;
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
    if (error.code === 'PGRST116') return null;
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
      setup_time: formData.setup_time
        ? parseFloat(formData.setup_time)
        : 0,
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
      setup_time: formData.setup_time
        ? parseFloat(formData.setup_time)
        : 0,
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
 */
export async function saveRoutingGraph(
  routingId: string,
  nodes: Array<{
    id: string;
    isNew?: boolean;
    operationTypeId: string;
    runTimePerUnit: number | null;
    setupTime?: number;
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

  if (deletedEdgeIds.length > 0) {
    const { error: deleteEdgesError } = await supabase
      .from('routing_edges')
      .delete()
      .in('id', deletedEdgeIds);
    if (deleteEdgesError) throw deleteEdgesError;
  }

  if (deletedNodeIds.length > 0) {
    const { error: deleteNodesError } = await supabase
      .from('routing_nodes')
      .delete()
      .in('id', deletedNodeIds);
    if (deleteNodesError) throw deleteNodesError;
  }

  const nodeIdMap = new Map<string, string>();

  for (const node of nodes) {
    if (node.isNew) {
      const { data, error } = await supabase
        .from('routing_nodes')
        .insert({
          routing_id: routingId,
          operation_type_id: node.operationTypeId,
          run_time_per_unit: node.runTimePerUnit,
          setup_time: node.setupTime ?? 0,
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
          setup_time: node.setupTime ?? 0,
          instructions: node.instructions,
          materials: node.materials || [],
          updated_at: new Date().toISOString(),
        })
        .eq('id', node.id);
      if (error) throw error;
      nodeIdMap.set(node.id, node.id);
    }
  }

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
  setupTime?: number;
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
 * Routing name is auto-generated as "Routing - {part_number}".
 *
 * @param companyId - Company ID
 * @param partId - Part ID (required, 1:1 relationship)
 * @param routingId - Existing routing ID (null for create mode)
 * @param pendingNodes - Nodes from the workflow builder
 * @param pendingEdges - Edges from the workflow builder
 * @param originalNodeIds - Original node IDs to track deletions (edit mode only)
 * @param originalEdgeIds - Original edge IDs to track deletions (edit mode only)
 */
export async function saveRoutingWithGraph(
  companyId: string,
  partId: string,
  routingId: string | null,
  pendingNodes: PendingNode[],
  pendingEdges: PendingEdge[],
  originalNodeIds: Set<string>,
  originalEdgeIds: Set<string>
): Promise<Routing> {
  const supabase = getSupabase();
  const isEditMode = !!routingId;

  // Get the part number for auto-naming
  const { data: partData, error: partError } = await supabase
    .from('parts')
    .select('part_number')
    .eq('id', partId)
    .single();

  if (partError) throw partError;
  const autoName = `Routing - ${partData.part_number}`;

  // Step 1: Create or update the routing
  let routing: Routing;
  if (isEditMode) {
    const { data, error } = await supabase
      .from('routings')
      .update({
        name: autoName,
        updated_at: new Date().toISOString(),
      })
      .eq('id', routingId)
      .select()
      .single();
    if (error) throw error;
    routing = data;
  } else {
    const { data, error } = await supabase
      .from('routings')
      .insert({
        company_id: companyId,
        part_id: partId,
        name: autoName,
      })
      .select()
      .single();
    if (error) throw error;
    routing = data;
  }

  // Step 2: Determine which nodes/edges to delete, create, or update
  const currentNodeIds = new Set(pendingNodes.map((n) => n.tempId));
  const currentEdgeIds = new Set(pendingEdges.map((e) => e.tempId));

  const nodesToDelete = [...originalNodeIds].filter((id) => !currentNodeIds.has(id));
  const edgesToDelete = [...originalEdgeIds].filter((id) => !currentEdgeIds.has(id));

  // Step 3: Delete removed edges first
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
  const nodeIdMap = new Map<string, string>();

  for (const node of pendingNodes) {
    const isTempId = node.tempId.startsWith('temp-');
    const isExisting = originalNodeIds.has(node.tempId);

    if (isTempId || !isExisting) {
      const { data, error } = await supabase
        .from('routing_nodes')
        .insert({
          routing_id: routing.id,
          operation_type_id: node.operationTypeId,
          run_time_per_unit: node.runTimePerUnit,
          setup_time: node.setupTime ?? 0,
          instructions: node.instructions,
          metadata: {},
          materials: node.materials || [],
        })
        .select()
        .single();
      if (error) throw error;
      nodeIdMap.set(node.tempId, data.id);
    } else {
      const { error } = await supabase
        .from('routing_nodes')
        .update({
          operation_type_id: node.operationTypeId,
          run_time_per_unit: node.runTimePerUnit,
          setup_time: node.setupTime ?? 0,
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
