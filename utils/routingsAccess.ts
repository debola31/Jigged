/**
 * Routings Data Access Layer
 *
 * Linear routing model: a routing is an ordered list of operations
 * (routing_nodes, ordered by `sequence`) plus a routing-level material list
 * (routing_materials). Each part has exactly one routing (1:1).
 */

import { getSupabase } from '@/lib/supabase';
import type {
  Routing,
  RoutingNode,
  RoutingMaterial,
  RoutingMaterialWithItem,
  RoutingWithPart,
  RoutingWithStats,
  RoutingWithGraph,
  RoutingNodeFormData,
  RoutingMaterialFormData,
} from '@/types/routings';

// ============================================
// Routing CRUD
// ============================================

/**
 * Get the routing for a part (1:1). Returns null if the part has no routing.
 */
export async function getRoutingForPart(partId: string): Promise<RoutingWithGraph | null> {
  const supabase = getSupabase();

  const { data: routing, error: routingError } = await supabase
    .from('routings')
    .select(`
      *,
      part:parts(id, part_name, description)
    `)
    .eq('part_id', partId)
    .maybeSingle();

  if (routingError) {
    console.error('Error fetching routing for part:', routingError);
    throw routingError;
  }

  if (!routing) return null;

  return await loadRoutingGraph(routing);
}

/**
 * Lightweight routing summary for a part (for list/detail displays).
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
 * List all routings for a company with stats.
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
      part:parts(id, part_name, description),
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
    part: { id: string; part_name: string; description: string | null } | null;
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
      part:parts(id, part_name, description)
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
 * Get a routing with full operations + materials data.
 */
export async function getRoutingWithGraph(routingId: string): Promise<RoutingWithGraph | null> {
  const supabase = getSupabase();

  const { data: routing, error: routingError } = await supabase
    .from('routings')
    .select(`
      *,
      part:parts(id, part_name, description)
    `)
    .eq('id', routingId)
    .single();

  if (routingError) {
    if (routingError.code === 'PGRST116') return null;
    console.error('Error fetching routing:', routingError);
    throw routingError;
  }

  return await loadRoutingGraph(routing);
}

/**
 * Internal helper: given a routing row, fetch its nodes and materials.
 */
async function loadRoutingGraph(
  routing: Routing & { part: { id: string; part_name: string; description: string | null } | null }
): Promise<RoutingWithGraph> {
  const supabase = getSupabase();

  const { data: nodes, error: nodesError } = await supabase
    .from('routing_nodes')
    .select(`
      *,
      operation_type:operation_types(
        id,
        name,
        labor_rate
      )
    `)
    .eq('routing_id', routing.id)
    .order('sequence', { ascending: true })
    .order('created_at', { ascending: true });

  if (nodesError) {
    console.error('Error fetching routing nodes:', nodesError);
    throw nodesError;
  }

  const { data: materials, error: materialsError } = await supabase
    .from('routing_materials')
    .select(`
      *,
      inventory_item:inventory_items(id, name, primary_unit, cost_per_unit)
    `)
    .eq('routing_id', routing.id)
    .order('sequence', { ascending: true });

  if (materialsError) {
    console.error('Error fetching routing materials:', materialsError);
    throw materialsError;
  }

  return {
    ...routing,
    nodes: nodes || [],
    materials: (materials as RoutingMaterialWithItem[]) || [],
  };
}

/**
 * Delete a routing (cascades to nodes and materials).
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
// Routing Node CRUD
// ============================================

/**
 * Internal helper: compute the next sequence value for a routing.
 * Returns 10 for the first node, then 20, 30, ...
 */
async function getNextNodeSequence(routingId: string): Promise<number> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('routing_nodes')
    .select('sequence')
    .eq('routing_id', routingId)
    .order('sequence', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('Error fetching max node sequence:', error);
    throw error;
  }

  return (data?.sequence ?? 0) + 10;
}

export async function createRoutingNode(
  routingId: string,
  formData: RoutingNodeFormData,
  sequence?: number
): Promise<RoutingNode> {
  const supabase = getSupabase();
  const seq = sequence ?? (await getNextNodeSequence(routingId));

  const { data, error } = await supabase
    .from('routing_nodes')
    .insert({
      routing_id: routingId,
      operation_type_id: formData.operation_type_id,
      run_time_per_unit: formData.run_time_per_unit
        ? parseFloat(formData.run_time_per_unit)
        : null,
      setup_time: formData.setup_time ? parseFloat(formData.setup_time) : 0,
      metadata: {},
      sequence: seq,
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating routing node:', error);
    throw error;
  }

  return data;
}

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
      setup_time: formData.setup_time ? parseFloat(formData.setup_time) : 0,
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

export async function deleteRoutingNode(nodeId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from('routing_nodes').delete().eq('id', nodeId);
  if (error) {
    console.error('Error deleting routing node:', error);
    throw error;
  }
}

// ============================================
// Routing Material CRUD
// ============================================

async function getNextMaterialSequence(routingId: string): Promise<number> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('routing_materials')
    .select('sequence')
    .eq('routing_id', routingId)
    .order('sequence', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('Error fetching max material sequence:', error);
    throw error;
  }

  return (data?.sequence ?? 0) + 10;
}

export async function createRoutingMaterial(
  routingId: string,
  formData: RoutingMaterialFormData,
  sequence?: number
): Promise<RoutingMaterial> {
  const supabase = getSupabase();
  const seq = sequence ?? (await getNextMaterialSequence(routingId));

  const { data, error } = await supabase
    .from('routing_materials')
    .insert({
      routing_id: routingId,
      inventory_item_id: formData.inventory_item_id,
      quantity: parseFloat(formData.quantity),
      unit: formData.unit,
      sequence: seq,
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating routing material:', error);
    throw error;
  }

  return data;
}

export async function updateRoutingMaterial(
  materialId: string,
  formData: RoutingMaterialFormData
): Promise<RoutingMaterial> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('routing_materials')
    .update({
      inventory_item_id: formData.inventory_item_id,
      quantity: parseFloat(formData.quantity),
      unit: formData.unit,
      updated_at: new Date().toISOString(),
    })
    .eq('id', materialId)
    .select()
    .single();

  if (error) {
    console.error('Error updating routing material:', error);
    throw error;
  }

  return data;
}

export async function deleteRoutingMaterial(materialId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from('routing_materials').delete().eq('id', materialId);
  if (error) {
    console.error('Error deleting routing material:', error);
    throw error;
  }
}

// ============================================
// Wizard Save Operations (atomic)
// ============================================

/**
 * Pending operation row from the linear builder.
 *  - tempId: synthetic id for new rows (prefix `temp-node-`); real uuid for existing rows.
 *  - All other fields mirror routing_nodes.
 */
export interface PendingNode {
  tempId: string;
  operationTypeId: string;
  operationName: string;
  laborRate: number | null;
  runTimePerUnit: number | null;
  setupTime: number;
}

/**
 * Pending material row from the linear builder.
 *  - tempId: synthetic id for new rows (prefix `temp-material-`); real uuid for existing rows.
 */
export interface PendingMaterial {
  tempId: string;
  inventoryItemId: string;
  itemName: string;
  quantity: number;
  unit: string;
}

/**
 * Save a routing's full state from the wizard. Handles create + edit modes.
 * Routing name is auto-generated from the part name.
 *
 * Operations and materials are saved with `sequence` matching their position
 * in the input arrays (steps of 10).
 */
export async function saveRoutingWithOperationsAndMaterials(
  companyId: string,
  partId: string,
  routingId: string | null,
  pendingNodes: PendingNode[],
  pendingMaterials: PendingMaterial[],
  originalNodeIds: Set<string>,
  originalMaterialIds: Set<string>
): Promise<Routing> {
  const supabase = getSupabase();
  const isEditMode = !!routingId;

  // Get the part name for auto-naming
  const { data: partData, error: partError } = await supabase
    .from('parts')
    .select('part_name')
    .eq('id', partId)
    .single();

  if (partError) throw partError;
  const autoName = `Routing - ${partData.part_name}`;

  // Step 1: Create or update the routing row
  let routing: Routing;
  if (isEditMode) {
    const { data, error } = await supabase
      .from('routings')
      .update({ name: autoName, updated_at: new Date().toISOString() })
      .eq('id', routingId)
      .select()
      .single();
    if (error) throw error;
    routing = data;
  } else {
    const { data, error } = await supabase
      .from('routings')
      .insert({ company_id: companyId, part_id: partId, name: autoName })
      .select()
      .single();
    if (error) throw error;
    routing = data;
  }

  // Step 2: Diff against the original sets to find deletions
  const currentNodeIds = new Set(pendingNodes.map((n) => n.tempId));
  const currentMaterialIds = new Set(pendingMaterials.map((m) => m.tempId));

  const nodesToDelete = [...originalNodeIds].filter((id) => !currentNodeIds.has(id));
  const materialsToDelete = [...originalMaterialIds].filter((id) => !currentMaterialIds.has(id));

  if (nodesToDelete.length > 0) {
    const { error } = await supabase
      .from('routing_nodes')
      .delete()
      .in('id', nodesToDelete);
    if (error) throw error;
  }

  if (materialsToDelete.length > 0) {
    const { error } = await supabase
      .from('routing_materials')
      .delete()
      .in('id', materialsToDelete);
    if (error) throw error;
  }

  // Step 3: Operations — two-phase update so the (routing_id, sequence) unique
  //   constraint isn't violated while reordering. We push existing rows to
  //   a temporary high-sequence range first, then assign the final sequences.
  //   New rows can be inserted at their final sequence directly (no conflict).
  if (pendingNodes.length > 0) {
    const existingRows = pendingNodes.filter((n) => originalNodeIds.has(n.tempId));
    if (existingRows.length > 0) {
      // Park existing rows at sequences 100000+ so the final write below has
      // a clean slot to write into. Constraint is DEFERRED so even without
      // this, a single statement update would work — but updating per-row
      // is the simpler path.
      let temp = 100000;
      for (const node of existingRows) {
        const { error } = await supabase
          .from('routing_nodes')
          .update({ sequence: temp })
          .eq('id', node.tempId);
        if (error) throw error;
        temp += 10;
      }
    }

    let seq = 10;
    for (const node of pendingNodes) {
      const isExisting = originalNodeIds.has(node.tempId);
      if (isExisting) {
        const { error } = await supabase
          .from('routing_nodes')
          .update({
            operation_type_id: node.operationTypeId,
            run_time_per_unit: node.runTimePerUnit,
            setup_time: node.setupTime ?? 0,
            sequence: seq,
            updated_at: new Date().toISOString(),
          })
          .eq('id', node.tempId);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('routing_nodes')
          .insert({
            routing_id: routing.id,
            operation_type_id: node.operationTypeId,
            run_time_per_unit: node.runTimePerUnit,
            setup_time: node.setupTime ?? 0,
            metadata: {},
            sequence: seq,
          });
        if (error) throw error;
      }
      seq += 10;
    }
  }

  // Step 4: Materials — same two-phase approach
  if (pendingMaterials.length > 0) {
    const existingRows = pendingMaterials.filter((m) => originalMaterialIds.has(m.tempId));
    if (existingRows.length > 0) {
      let temp = 100000;
      for (const mat of existingRows) {
        const { error } = await supabase
          .from('routing_materials')
          .update({ sequence: temp })
          .eq('id', mat.tempId);
        if (error) throw error;
        temp += 10;
      }
    }

    let seq = 10;
    for (const mat of pendingMaterials) {
      const isExisting = originalMaterialIds.has(mat.tempId);
      if (isExisting) {
        const { error } = await supabase
          .from('routing_materials')
          .update({
            inventory_item_id: mat.inventoryItemId,
            quantity: mat.quantity,
            unit: mat.unit,
            sequence: seq,
            updated_at: new Date().toISOString(),
          })
          .eq('id', mat.tempId);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('routing_materials')
          .insert({
            routing_id: routing.id,
            inventory_item_id: mat.inventoryItemId,
            quantity: mat.quantity,
            unit: mat.unit,
            sequence: seq,
          });
        if (error) throw error;
      }
      seq += 10;
    }
  }

  return routing;
}
