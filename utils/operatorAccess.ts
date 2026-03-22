/**
 * Operator View utilities.
 *
 * With Supabase Auth, operators authenticate using email/password via
 * supabase.auth.signInWithPassword(). Most operations now use direct
 * Supabase client calls with RLS policies.
 *
 * This file provides:
 * - Admin CRUD operations for operators (list, get, update, delete)
 * - Session helper utilities
 *
 * NOTE: Operators are now stored in user_company_access with role='operator'.
 * The legacy 'operators' table is deprecated.
 */

import { getSupabase } from '@/lib/supabase';
import type {
  OperatorJob,
  OperatorJobDetail,
  OperatorSession,
  ActiveSession,
  Station,
  JobStartRequest,
  JobStopRequest,
  JobCompleteRequest,
  JobCompleteResponse,
  MaterialConfirmation,
} from '@/types/operator';
import type { RoutingNodeMaterial } from '@/types/routings';
import type { InventoryItemWithRelations } from '@/types/inventory';
import { removeStockGraceful } from '@/utils/inventoryAccess';

// Operator type from user_company_access
interface OperatorAccess {
  id: string;
  user_id: string;
  company_id: string;
  role: string;
  name: string | null;
  created_at: string;
}

// ============================================================================
// ADMIN OPERATOR CRUD (uses user_company_access)
// ============================================================================

/**
 * List all operators for a company (admin).
 */
export async function listOperators(companyId: string): Promise<OperatorAccess[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('user_company_access')
    .select('id, company_id, user_id, name, role, created_at')
    .eq('company_id', companyId)
    .eq('role', 'operator')
    .order('name');

  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * Get a single operator by ID (admin).
 */
export async function getOperator(operatorId: string): Promise<OperatorAccess> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('user_company_access')
    .select('id, company_id, user_id, name, role, created_at')
    .eq('id', operatorId)
    .eq('role', 'operator')
    .single();

  if (error) throw new Error(error.message);
  return data;
}

/**
 * Update an operator (admin).
 * Note: Email changes require updating auth.users via service role key.
 */
export async function updateOperator(
  operatorId: string,
  request: { name?: string }
): Promise<OperatorAccess> {
  const supabase = getSupabase();

  const updates: Record<string, unknown> = {};
  if (request.name !== undefined) updates.name = request.name;

  const { data, error } = await supabase
    .from('user_company_access')
    .update(updates)
    .eq('id', operatorId)
    .select('id, company_id, user_id, name, role, created_at')
    .single();

  if (error) throw new Error(error.message);
  return data;
}

/**
 * Delete an operator (admin).
 * Note: This only deletes the user_company_access record. The Supabase auth user
 * may still exist and can be used for other roles.
 */
export async function deleteOperator(operatorId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('user_company_access')
    .delete()
    .eq('id', operatorId);

  if (error) throw new Error(error.message);
}

// ============================================================================
// OPERATOR SESSION HELPERS (Direct Supabase queries)
// ============================================================================

/**
 * Get the current user's company access record for use in the operator view.
 * Returns null if not authenticated or not a member of this company.
 */
export async function getCurrentOperator(companyId: string): Promise<{
  id: string;
  name: string | null;
  user_id: string;
} | null> {
  const supabase = getSupabase();

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;

  const { data: operatorAccess } = await supabase
    .from('user_company_access')
    .select('id, name, user_id')
    .eq('user_id', session.user.id)
    .eq('company_id', companyId)
    .single();

  return operatorAccess;
}

// ============================================================================
// DAG READINESS HELPERS
// ============================================================================

/**
 * Get ready operations for a specific station using DAG-aware logic.
 * Calls the get_ready_operations_for_station DB function which checks
 * routing_edges to ensure all predecessor operations are completed/skipped.
 */
async function getReadyOperationsForStation(
  companyId: string,
  operationTypeId: string
): Promise<Map<string, { jobOperationId: string; operationName: string; status: string }>> {
  const supabase = getSupabase();

  const { data, error } = await supabase.rpc('get_ready_operations_for_station', {
    p_company_id: companyId,
    p_operation_type_id: operationTypeId,
  });

  if (error) {
    console.error('Error fetching ready operations for station:', error);
    return new Map();
  }

  const result = new Map<string, { jobOperationId: string; operationName: string; status: string }>();
  for (const row of data || []) {
    result.set(row.job_id, {
      jobOperationId: row.job_operation_id,
      operationName: row.operation_name,
      status: row.op_status,
    });
  }

  return result;
}

/**
 * Check if a specific job operation is ready to start by verifying
 * all predecessor nodes in the routing DAG are completed/skipped.
 * Returns true if no routing is linked (backward compat).
 */
async function isJobOperationReady(
  jobId: string,
  routingNodeId: string | null
): Promise<boolean> {
  if (!routingNodeId) return true;

  const supabase = getSupabase();

  // Find predecessor edges
  const { data: edges } = await supabase
    .from('routing_edges')
    .select('source_node_id')
    .eq('target_node_id', routingNodeId);

  if (!edges || edges.length === 0) return true; // root node

  // Check if any predecessor job_operations are NOT completed/skipped
  const sourceNodeIds = edges.map((e: { source_node_id: string }) => e.source_node_id);
  const { data: unfinishedPreds } = await supabase
    .from('job_operations')
    .select('id')
    .eq('job_id', jobId)
    .in('routing_node_id', sourceNodeIds)
    .not('status', 'in', '("completed","skipped")');

  return !unfinishedPreds || unfinishedPreds.length === 0;
}

/**
 * Get list of jobs available for the operator.
 * Optionally filtered by operation type (station).
 * When filtered by station, only shows jobs where the operation at that
 * station is "ready" — all predecessor operations in the routing are done.
 */
export async function getOperatorJobs(
  companyId: string,
  operationTypeId?: string
): Promise<OperatorJob[]> {
  const supabase = getSupabase();

  // Get jobs for this company
  const { data: jobs, error } = await supabase
    .from('jobs')
    .select(`
      id, job_number, status,
      customers(name),
      parts(description, part_number)
    `)
    .eq('company_id', companyId)
    .in('status', ['pending', 'in_progress', 'released'])
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  if (!jobs) return [];

  // When filtering by station, use DAG-aware readiness check
  if (operationTypeId) {
    const readyOps = await getReadyOperationsForStation(companyId, operationTypeId);

    const result: OperatorJob[] = [];

    for (const job of jobs) {
      const readyOp = readyOps.get(job.id);
      if (!readyOp) continue; // Operation at this station is not ready

      // Check if someone is working on this operation
      let currentOperatorName: string | null = null;
      const { data: sessionData } = await supabase
        .from('operator_sessions')
        .select('operator_id')
        .eq('job_operation_id', readyOp.jobOperationId)
        .is('ended_at', null)
        .single();

      if (sessionData?.operator_id) {
        const { data: opData } = await supabase
          .from('user_company_access')
          .select('name')
          .eq('id', sessionData.operator_id)
          .single();
        currentOperatorName = opData?.name || null;
      }

      result.push({
        id: job.id,
        job_number: job.job_number,
        customer_name: (job.customers as { name: string } | null)?.name || null,
        part_name: (job.parts as { description: string; part_number: string } | null)?.description || null,
        part_number: (job.parts as { description: string; part_number: string } | null)?.part_number || null,
        status: job.status,
        operation_id: readyOp.jobOperationId,
        operation_name: readyOp.operationName,
        operation_status: readyOp.status,
        current_operator_name: currentOperatorName,
      });
    }

    return result;
  }

  // No station filter — show all jobs (overview mode, no DAG filtering)
  const result: OperatorJob[] = [];

  for (const job of jobs) {
    const { data: ops } = await supabase
      .from('job_operations')
      .select('id, operation_name, status, operation_type_id')
      .eq('job_id', job.id);

    const currentOp = ops?.find((op: { id: string; operation_name: string; status: string; operation_type_id: string }) =>
      op.status === 'pending' || op.status === 'in_progress'
    );

    let currentOperatorName: string | null = null;
    if (currentOp) {
      const { data: sessionData } = await supabase
        .from('operator_sessions')
        .select('operator_id')
        .eq('job_operation_id', currentOp.id)
        .is('ended_at', null)
        .single();

      if (sessionData?.operator_id) {
        const { data: opData } = await supabase
          .from('user_company_access')
          .select('name')
          .eq('id', sessionData.operator_id)
          .single();
        currentOperatorName = opData?.name || null;
      }
    }

    result.push({
      id: job.id,
      job_number: job.job_number,
      customer_name: (job.customers as { name: string } | null)?.name || null,
      part_name: (job.parts as { description: string; part_number: string } | null)?.description || null,
      part_number: (job.parts as { description: string; part_number: string } | null)?.part_number || null,
      status: job.status,
      operation_id: currentOp?.id || null,
      operation_name: currentOp?.operation_name || null,
      operation_status: currentOp?.status || null,
      current_operator_name: currentOperatorName,
    });
  }

  return result;
}

/**
 * Get detailed job information.
 */
export async function getOperatorJobDetail(
  jobId: string,
  companyId: string,
  operationTypeId?: string
): Promise<OperatorJobDetail | null> {
  const supabase = getSupabase();

  const { data: job, error } = await supabase
    .from('jobs')
    .select(`
      id, job_number, status,
      customers(name),
      parts(description, part_number)
    `)
    .eq('id', jobId)
    .eq('company_id', companyId)
    .single();

  if (error || !job) return null;

  // Get operations for this job
  let opsQuery = supabase
    .from('job_operations')
    .select('id, operation_name, status, instructions, estimated_setup_hours, estimated_run_hours_per_unit, operation_type_id, routing_node_id')
    .eq('job_id', jobId);

  if (operationTypeId) {
    opsQuery = opsQuery.eq('operation_type_id', operationTypeId);
  }

  const { data: ops } = await opsQuery;

  let currentOp = ops?.find((op: { id: string; operation_name: string; status: string; instructions: string | null; estimated_setup_hours: number | null; estimated_run_hours_per_unit: number | null; operation_type_id: string; routing_node_id: string | null }) =>
    op.status === 'pending' || op.status === 'in_progress'
  ) || null;

  // Check DAG readiness: if the operation is pending, verify predecessors are done
  if (currentOp && currentOp.status === 'pending') {
    const ready = await isJobOperationReady(jobId, currentOp.routing_node_id);
    if (!ready) {
      currentOp = null; // Not ready — hide from operator
    }
  }

  // Get active session for this operation
  let activeSessionId: string | null = null;
  let sessionStartedAt: string | null = null;
  let currentOperatorId: string | null = null;
  let currentOperatorName: string | null = null;

  if (currentOp) {
    const { data: sessionData } = await supabase
      .from('operator_sessions')
      .select('id, started_at, operator_id')
      .eq('job_operation_id', currentOp.id)
      .is('ended_at', null)
      .single();

    if (sessionData) {
      activeSessionId = sessionData.id;
      sessionStartedAt = sessionData.started_at;
      currentOperatorId = sessionData.operator_id;

      // Look up operator name from user_company_access
      if (sessionData.operator_id) {
        const { data: opData } = await supabase
          .from('user_company_access')
          .select('name')
          .eq('id', sessionData.operator_id)
          .single();
        currentOperatorName = opData?.name || null;
      }
    }
  }

  // Calculate estimated hours
  let estimatedHours: number | null = null;
  if (currentOp) {
    const setup = Number(currentOp.estimated_setup_hours) || 0;
    const runPer = Number(currentOp.estimated_run_hours_per_unit) || 0;
    estimatedHours = setup + runPer;
  }

  return {
    id: job.id,
    job_number: job.job_number,
    customer_name: (job.customers as { name: string } | null)?.name || null,
    part_name: (job.parts as { description: string; part_number: string } | null)?.description || null,
    part_number: (job.parts as { description: string; part_number: string } | null)?.part_number || null,
    status: job.status,
    operation_id: currentOp?.id || null,
    operation_name: currentOp?.operation_name || null,
    operation_status: currentOp?.status || null,
    instructions: currentOp?.instructions || null,
    estimated_hours: estimatedHours,
    active_session_id: activeSessionId,
    session_started_at: sessionStartedAt,
    current_operator_id: currentOperatorId,
    current_operator_name: currentOperatorName,
  };
}

/**
 * Start working on a job.
 */
export async function startJob(
  jobId: string,
  operatorId: string,
  companyId: string,
  request: JobStartRequest
): Promise<OperatorSession> {
  const supabase = getSupabase();

  // 1. Find the matching job_operation
  const { data: jobOp, error: opError } = await supabase
    .from('job_operations')
    .select('*')
    .eq('job_id', jobId)
    .eq('operation_type_id', request.operation_type_id)
    .in('status', ['pending', 'in_progress'])
    .single();

  if (opError || !jobOp) {
    throw new Error('No pending operation found for this job and station');
  }

  // 1b. Verify DAG predecessors are satisfied before starting
  if (jobOp.status === 'pending') {
    const ready = await isJobOperationReady(jobId, jobOp.routing_node_id);
    if (!ready) {
      throw new Error('Cannot start this operation: predecessor operations are not yet completed');
    }
  }

  // 2. Auto-stop any existing active session for this operator
  const { data: existing } = await supabase
    .from('operator_sessions')
    .select('id')
    .eq('operator_id', operatorId)
    .is('ended_at', null);

  if (existing && existing.length > 0) {
    await supabase
      .from('operator_sessions')
      .update({ ended_at: new Date().toISOString() })
      .eq('id', existing[0].id);
  }

  // 3. Create new session
  const now = new Date().toISOString();
  const { data: session, error: sessionError } = await supabase
    .from('operator_sessions')
    .insert({
      company_id: companyId,
      operator_id: operatorId,
      job_id: jobId,
      job_operation_id: jobOp.id,
      operation_type_id: request.operation_type_id,
      started_at: now,
    })
    .select()
    .single();

  if (sessionError) throw new Error(sessionError.message);

  // 4. Update job_operation to in_progress
  await supabase
    .from('job_operations')
    .update({ status: 'in_progress', started_at: now })
    .eq('id', jobOp.id);

  return {
    id: session.id,
    operator_id: operatorId,
    job_id: jobId,
    job_operation_id: jobOp.id,
    operation_type_id: request.operation_type_id,
    started_at: now,
    ended_at: null,
    notes: null,
  };
}

/**
 * Stop (pause) work on a job.
 */
export async function stopJob(
  jobId: string,
  operatorId: string,
  request?: JobStopRequest
): Promise<OperatorSession> {
  const supabase = getSupabase();

  // Find active session for this job
  const { data: session, error } = await supabase
    .from('operator_sessions')
    .select('*')
    .eq('operator_id', operatorId)
    .eq('job_id', jobId)
    .is('ended_at', null)
    .single();

  if (error || !session) {
    throw new Error('No active session found');
  }

  const now = new Date().toISOString();

  // End the session
  await supabase
    .from('operator_sessions')
    .update({
      ended_at: now,
      notes: request?.notes || null,
    })
    .eq('id', session.id);

  // Calculate duration
  const started = new Date(session.started_at);
  const ended = new Date(now);
  const durationSeconds = Math.floor((ended.getTime() - started.getTime()) / 1000);

  return {
    id: session.id,
    operator_id: operatorId,
    job_id: jobId,
    job_operation_id: session.job_operation_id,
    operation_type_id: session.operation_type_id,
    started_at: session.started_at,
    ended_at: now,
    notes: request?.notes || null,
    duration_seconds: durationSeconds,
  };
}

/**
 * Get expected materials for a job operation from its routing node.
 * Also fetches current inventory levels for each material.
 */
export async function getOperationMaterials(
  jobOperationId: string
): Promise<MaterialConfirmation[]> {
  const supabase = getSupabase();

  // 1. Get the routing_node_id from job_operations
  const { data: jobOp, error: opError } = await supabase
    .from('job_operations')
    .select('routing_node_id')
    .eq('id', jobOperationId)
    .single();

  if (opError || !jobOp?.routing_node_id) {
    return []; // No routing linked
  }

  // 2. Get materials from the routing node
  const { data: routingNode, error: rnError } = await supabase
    .from('routing_nodes')
    .select('materials')
    .eq('id', jobOp.routing_node_id)
    .single();

  if (rnError || !routingNode?.materials) {
    return [];
  }

  const materials = routingNode.materials as RoutingNodeMaterial[];
  if (materials.length === 0) {
    return [];
  }

  // 3. Batch-fetch inventory items for current stock and names
  const itemIds = materials.map((m) => m.inventory_item_id);
  const { data: items } = await supabase
    .from('inventory_items')
    .select('id, name, primary_unit, quantity')
    .in('id', itemIds);

  const itemMap = new Map<string, { name: string; primary_unit: string; quantity: number }>();
  for (const item of items || []) {
    itemMap.set(item.id, {
      name: item.name,
      primary_unit: item.primary_unit,
      quantity: item.quantity,
    });
  }

  // 4. Build MaterialConfirmation array
  return materials
    .filter((m) => itemMap.has(m.inventory_item_id))
    .map((m) => {
      const item = itemMap.get(m.inventory_item_id)!;
      return {
        inventory_item_id: m.inventory_item_id,
        item_name: item.name,
        expected_quantity: m.quantity,
        confirmed_quantity: m.quantity, // Pre-filled with expected
        unit: m.unit,
        current_stock: item.quantity,
        primary_unit: item.primary_unit,
      };
    });
}

/**
 * Mark a job operation as complete.
 */
export async function completeJob(
  jobId: string,
  operatorId: string,
  request: JobCompleteRequest
): Promise<JobCompleteResponse> {
  const supabase = getSupabase();

  // Find active session for this job
  const { data: session, error } = await supabase
    .from('operator_sessions')
    .select('*')
    .eq('operator_id', operatorId)
    .eq('job_id', jobId)
    .is('ended_at', null)
    .single();

  if (error || !session) {
    throw new Error('No active session found');
  }

  const now = new Date().toISOString();

  // 1. End the session
  await supabase
    .from('operator_sessions')
    .update({
      ended_at: now,
      notes: request.notes || null,
    })
    .eq('id', session.id);

  // 2. Mark job_operation as completed
  if (session.job_operation_id) {
    await supabase
      .from('job_operations')
      .update({
        status: 'completed',
        completed_at: now,
      })
      .eq('id', session.job_operation_id);
  }

  // 3. Check if all operations are complete
  const { data: remaining } = await supabase
    .from('job_operations')
    .select('id')
    .eq('job_id', jobId)
    .not('status', 'in', '("completed","skipped")');

  const jobCompleted = !remaining || remaining.length === 0;

  if (jobCompleted) {
    await supabase
      .from('jobs')
      .update({ status: 'completed' })
      .eq('id', jobId);
  }

  // 4. Deplete inventory for confirmed materials
  if (request.materials && request.materials.length > 0) {
    for (const material of request.materials) {
      if (material.confirmed_quantity > 0) {
        await removeStockGraceful(
          material.inventory_item_id,
          material.confirmed_quantity,
          material.unit,
          `Operation completion`,
          jobId,
          session.job_operation_id || undefined,
          operatorId,
          operatorId
        );
      }
    }
  }

  // Calculate duration
  const started = new Date(session.started_at);
  const ended = new Date(now);
  const durationSeconds = Math.floor((ended.getTime() - started.getTime()) / 1000);

  return {
    success: true,
    session_id: session.id,
    duration_seconds: durationSeconds,
    job_completed: jobCompleted,
  };
}

/**
 * Get the operator's current active session, if any.
 */
export async function getActiveSession(
  operatorId: string
): Promise<ActiveSession | null> {
  const supabase = getSupabase();

  const { data: session } = await supabase
    .from('operator_sessions')
    .select(`
      id, job_id, job_operation_id, operation_type_id, started_at, notes,
      jobs(job_number),
      job_operations(operation_name)
    `)
    .eq('operator_id', operatorId)
    .is('ended_at', null)
    .single();

  if (!session) return null;

  return {
    id: session.id,
    operator_id: operatorId,
    job_id: session.job_id,
    job_number: (session.jobs as { job_number: string } | null)?.job_number || null,
    job_operation_id: session.job_operation_id,
    operation_name: (session.job_operations as { operation_name: string } | null)?.operation_name || null,
    operation_type_id: session.operation_type_id,
    started_at: session.started_at,
    notes: session.notes,
  };
}

/**
 * Get work session history for an operator.
 */
export async function getOperatorSessions(
  operatorId: string,
  limit: number = 50
): Promise<OperatorSession[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('operator_sessions')
    .select(`
      id, operator_id, job_id, job_operation_id, operation_type_id,
      started_at, ended_at, notes,
      jobs(job_number),
      job_operations(operation_name)
    `)
    .eq('operator_id', operatorId)
    .order('started_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);

  interface SessionRow {
    id: string;
    operator_id: string;
    job_id: string;
    job_operation_id: string | null;
    operation_type_id: string;
    started_at: string;
    ended_at: string | null;
    notes: string | null;
    jobs: { job_number: string } | null;
    job_operations: { operation_name: string } | null;
  }

  return (data || []).map((s: SessionRow) => {
    let durationSeconds: number | undefined;
    if (s.ended_at) {
      const started = new Date(s.started_at);
      const ended = new Date(s.ended_at);
      durationSeconds = Math.floor((ended.getTime() - started.getTime()) / 1000);
    }

    return {
      id: s.id,
      operator_id: s.operator_id,
      job_id: s.job_id,
      job_operation_id: s.job_operation_id,
      operation_type_id: s.operation_type_id,
      started_at: s.started_at,
      ended_at: s.ended_at,
      notes: s.notes,
      duration_seconds: durationSeconds,
      job_number: s.jobs?.job_number || null,
      operation_name: s.job_operations?.operation_name || null,
    };
  });
}

// ============================================================================
// STATION UTILITIES
// ============================================================================

/**
 * Get all operation types (stations) for a company.
 * Used by the station dropdown selector in the operator view.
 */
export async function getStationOperationTypes(
  companyId: string
): Promise<Station[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('operation_types')
    .select('id, name')
    .eq('company_id', companyId)
    .order('name');

  if (error) throw new Error(error.message);

  return (data || []).map((ot: { id: string; name: string }) => ({
    id: ot.id,
    name: ot.name,
  }));
}

/**
 * Get the display name for a station (operation type) by its ID.
 */
export async function getStationName(
  stationId: string
): Promise<string | null> {
  const supabase = getSupabase();

  const { data } = await supabase
    .from('operation_types')
    .select('name')
    .eq('id', stationId)
    .single();

  return data?.name || null;
}

/**
 * Get stations (operation types) that have pending/in-progress operations for a specific job.
 * Used when an operator scans a job QR code to determine which station(s) to offer.
 */
export async function getStationsForJob(
  jobId: string,
  companyId: string
): Promise<Array<{ id: string; name: string }>> {
  const supabase = getSupabase();

  // Verify the job belongs to this company
  const { data: job } = await supabase
    .from('jobs')
    .select('id')
    .eq('id', jobId)
    .eq('company_id', companyId)
    .single();

  if (!job) return [];

  const { data: ops } = await supabase
    .from('job_operations')
    .select('operation_type_id, operation_types(name)')
    .eq('job_id', jobId)
    .in('status', ['pending', 'in_progress']);

  if (!ops || ops.length === 0) return [];

  // Deduplicate by operation_type_id
  const seen = new Set<string>();
  const stations: Array<{ id: string; name: string }> = [];
  for (const op of ops) {
    if (op.operation_type_id && !seen.has(op.operation_type_id)) {
      seen.add(op.operation_type_id);
      const otData = op.operation_types as unknown as { name: string } | null;
      stations.push({
        id: op.operation_type_id,
        name: otData?.name || 'Unknown Station',
      });
    }
  }

  return stations;
}
