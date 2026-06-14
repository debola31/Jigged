/**
 * Operator View utilities.
 *
 * With Supabase Auth, operators authenticate using email/password via
 * supabase.auth.signInWithPassword(). Most operations now use direct
 * Supabase client calls with RLS policies.
 *
 * NOTE: Operators are stored in user_company_access with role='operator'.
 * The legacy 'operators' table is deprecated.
 *
 * Multi-part jobs (refactor): a job carries N child job_parts, and ALL
 * operator-facing work is keyed on `job_part_id`. The operator-jobs list at
 * a station shows one row per (job, part) where the station's operation is
 * ready on THAT part. Start/Stop/Complete operate within a single job_part.
 */

// Typed Supabase client (typed-client rollout). Aliased so the 19 call
// sites stay untouched. See CLAUDE.md "Typed Supabase client".
import { getTypedSupabase as getSupabase } from '@/lib/supabase';
import { friendlyErrorMessage } from '@/lib/supabaseErrors';
import type { Database } from '@/types/database';
import { calculateActualRunMinutes } from '@/utils/sessionDuration';

// Update payload type for user_company_access. Used where the patch
// object is built conditionally and would otherwise be inferred as
// Record<string, unknown>, which the typed .update(...) rejects.
type UserCompanyAccessUpdate = Database['public']['Tables']['user_company_access']['Update'];
import type {
  OperatorJob,
  OperatorJobDetail,
  OperatorJobPartSummary,
  OperatorSession,
  ActiveSession,
  Station,
  JobStartRequest,
  JobStopRequest,
  JobCompleteResponse,
  JobTraveler,
  JobTravelerOperation,
  JobNote,
} from '@/types/operator';

// Operator type from user_company_access. role and created_at are
// nullable in the DB schema (text DEFAULT 'operator'; timestamptz
// DEFAULT now()) but never null at read time because of the defaults.
// Mirroring the DB shape here keeps the typed select returns happy
// without papering the gap with per-site casts.
interface OperatorAccess {
  id: string;
  user_id: string;
  company_id: string;
  role: string | null;
  name: string | null;
  created_at: string | null;
}

// ============================================================================
// ADMIN OPERATOR CRUD (uses user_company_access)
// ============================================================================

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

export async function updateOperator(
  operatorId: string,
  request: { name?: string }
): Promise<OperatorAccess> {
  const supabase = getSupabase();

  const updates: UserCompanyAccessUpdate = {};
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

export async function deleteOperator(operatorId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('user_company_access')
    .delete()
    .eq('id', operatorId);

  if (error) {
    console.error('Error deleting operator:', error);
    throw new Error(
      friendlyErrorMessage(error, {
        entity: 'operator',
        fallback: 'Failed to remove operator.',
      }),
    );
  }
}

// ============================================================================
// OPERATOR SESSION HELPERS
// ============================================================================

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
// READINESS HELPERS (per-job_part sequence-based DAG)
// ============================================================================

/**
 * Check whether a specific job_operation is ready to start. An operation is
 * ready when every job_operation with a lower sequence WITHIN ITS OWN job_part
 * is completed.
 */
async function isJobOperationReady(jobOperationId: string | null): Promise<boolean> {
  if (!jobOperationId) return true;

  const supabase = getSupabase();

  const { data: op } = await supabase
    .from('job_operations')
    .select('sequence, job_part_id')
    .eq('id', jobOperationId)
    .single();

  if (!op) return true;

  const { data: unfinishedPreds } = await supabase
    .from('job_operations')
    .select('id')
    .eq('job_part_id', op.job_part_id)
    .lt('sequence', op.sequence)
    .neq('status', 'completed');

  return !unfinishedPreds || unfinishedPreds.length === 0;
}

interface ReadyRow {
  job_id: string;
  job_part_id: string;
  job_operation_id: string;
  operation_name: string;
  op_status: string;
  job_number: string;
  part_id: string;
  part_name: string;
  part_description: string | null;
  part_quantity: number;
}

async function getReadyOperationsForStation(
  companyId: string,
  workCenterId: string,
): Promise<ReadyRow[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase.rpc('get_ready_operations_for_station', {
    p_company_id: companyId,
    p_work_center_id: workCenterId,
  });

  if (error) {
    console.error('Error fetching ready operations for station:', error);
    return [];
  }

  return (data || []) as ReadyRow[];
}

// ============================================================================
// STATION-SCOPED JOB LIST
// ============================================================================

/**
 * List the work an operator can pick up at the current station. Each row is a
 * (job, job_part) pair where the station's operation is ready or in-progress.
 */
export async function getOperatorJobs(
  companyId: string,
  operationTypeId?: string,
): Promise<OperatorJob[]> {
  const supabase = getSupabase();

  if (!operationTypeId) {
    // No station selected — return an empty list. The UI prompts the operator
    // to pick a station first; we don't show "all jobs" because the station
    // is the primary navigation key.
    return [];
  }

  const readyRows = await getReadyOperationsForStation(companyId, operationTypeId);
  if (readyRows.length === 0) return [];

  const jobPartIds = readyRows.map((r) => r.job_part_id);
  const operationIds = readyRows.map((r) => r.job_operation_id);

  // Fetch per-part progress (count of ops total + completed per part).
  const { data: partOps } = await supabase
    .from('job_operations')
    .select('job_part_id, status')
    .in('job_part_id', jobPartIds);

  type PartOpRow = { job_part_id: string; status: string };
  const progressByPart = new Map<string, { total: number; done: number }>();
  for (const row of (partOps ?? []) as PartOpRow[]) {
    const acc = progressByPart.get(row.job_part_id) ?? { total: 0, done: 0 };
    acc.total += 1;
    if (row.status === 'completed') acc.done += 1;
    progressByPart.set(row.job_part_id, acc);
  }

  // Look up active sessions on the listed operations to surface "currently
  // worked by …".
  const { data: activeSessions } = await supabase
    .from('operator_sessions')
    .select('job_operation_id, operator_id')
    .in('job_operation_id', operationIds)
    .is('ended_at', null);

  type ActiveRow = { job_operation_id: string; operator_id: string };
  const operatorIdByOp = new Map<string, string>();
  for (const s of (activeSessions ?? []) as ActiveRow[]) {
    operatorIdByOp.set(s.job_operation_id, s.operator_id);
  }

  const operatorIds = Array.from(new Set(Array.from(operatorIdByOp.values())));
  const operatorNameById = new Map<string, string>();
  if (operatorIds.length > 0) {
    const { data: nameRows } = await supabase
      .from('user_company_access')
      .select('id, name')
      .in('id', operatorIds);
    type NameRow = { id: string; name: string | null };
    for (const r of (nameRows ?? []) as NameRow[]) {
      if (r.name) operatorNameById.set(r.id, r.name);
    }
  }

  // Fetch each part's current status + customer (one query per (jobs, job_parts)).
  const jobIds = Array.from(new Set(readyRows.map((r) => r.job_id)));
  const { data: jobMeta } = await supabase
    .from('jobs')
    .select('id, customers(name)')
    .in('id', jobIds);
  type JobMeta = { id: string; customers: { name: string } | null };
  const customerByJob = new Map<string, string | null>();
  for (const j of (jobMeta ?? []) as JobMeta[]) {
    customerByJob.set(j.id, j.customers?.name ?? null);
  }

  const { data: partStatusRows } = await supabase
    .from('job_parts')
    .select('id, production_status')
    .in('id', jobPartIds);
  type PartStatus = { id: string; production_status: string };
  const statusByPart = new Map<string, string>();
  for (const r of (partStatusRows ?? []) as PartStatus[]) {
    statusByPart.set(r.id, r.production_status);
  }

  return readyRows.map((row) => {
    const progress = progressByPart.get(row.job_part_id) ?? { total: 0, done: 0 };
    const opOperatorId = operatorIdByOp.get(row.job_operation_id) ?? null;
    return {
      id: row.job_part_id,
      job_id: row.job_id,
      job_number: row.job_number,
      customer_name: customerByJob.get(row.job_id) ?? null,
      part_name: row.part_name,
      part_quantity: row.part_quantity,
      production_status: statusByPart.get(row.job_part_id) ?? 'not_started',
      operation_id: row.job_operation_id,
      operation_name: row.operation_name,
      operation_status: row.op_status,
      current_operator_name: opOperatorId ? operatorNameById.get(opOperatorId) ?? null : null,
      operations_total: progress.total,
      operations_completed: progress.done,
    };
  });
}

// ============================================================================
// PER-PART JOB DETAIL (the page where Start/Stop/Complete lives)
// ============================================================================

// Header fields shared by the per-part and per-operation detail views.
interface PartHeaderForDetail {
  id: string;
  job_id: string;
  quantity: number;
  production_status: string;
  job_number: string;
  customer_name: string | null;
  part_name: string | null;
}

// The single operation an operator detail view is built around.
interface CurrentOpForDetail {
  id: string;
  operation_name: string;
  status: string;
  estimated_setup_minutes: number | null;
  estimated_run_minutes_per_unit: number | null;
}

/**
 * Load the job_part header (job/customer/part) scoped to a company. Shared by
 * the per-part and per-operation detail views.
 */
async function loadPartHeader(
  jobPartId: string,
  companyId: string,
): Promise<PartHeaderForDetail | null> {
  const supabase = getSupabase();

  const { data: part, error } = await supabase
    .from('job_parts')
    .select(`
      id, job_id, production_status, quantity,
      parts(part_name),
      jobs!inner(id, job_number, customers(name))
    `)
    .eq('id', jobPartId)
    .eq('jobs.company_id', companyId)
    .single();

  if (error || !part) return null;

  type PartRow = {
    id: string;
    job_id: string;
    production_status: string;
    quantity: number;
    parts: { part_name: string } | { part_name: string }[] | null;
    jobs: { id: string; job_number: string; customers: { name: string } | { name: string }[] | null } | null;
  };
  const p = part as PartRow;
  const partsJoin = Array.isArray(p.parts) ? p.parts[0] : p.parts;
  const jobJoin = p.jobs;
  const customerJoin = jobJoin
    ? Array.isArray(jobJoin.customers) ? jobJoin.customers[0] : jobJoin.customers
    : null;

  return {
    id: p.id,
    job_id: p.job_id,
    quantity: p.quantity,
    production_status: p.production_status,
    job_number: jobJoin?.job_number ?? '',
    customer_name: customerJoin?.name ?? null,
    part_name: partsJoin?.part_name ?? null,
  };
}

/**
 * Assemble the OperatorJobDetail (session, estimate, progress, materials)
 * around a resolved part header + a single "current" operation. Shared by
 * getOperatorJobPartDetail (resolves the op by station/sequence) and
 * getOperatorOperationDetail (resolves a specific op by id).
 */
async function assembleJobPartDetail(
  header: PartHeaderForDetail,
  currentOp: CurrentOpForDetail | null,
): Promise<OperatorJobDetail> {
  const supabase = getSupabase();
  const jobPartId = header.id;

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

  let estimatedMinutes: number | null = null;
  if (currentOp) {
    const setup = Number(currentOp.estimated_setup_minutes) || 0;
    const runPer = Number(currentOp.estimated_run_minutes_per_unit) || 0;
    estimatedMinutes = setup + runPer;
  }

  // Per-part progress: count all ops on THIS part, not the whole job.
  const { data: allOps } = await supabase
    .from('job_operations')
    .select('status')
    .eq('job_part_id', jobPartId);

  type OpStatus = { status: string };
  const allRows = (allOps ?? []) as OpStatus[];
  const operationsTotal = allRows.length;
  const operationsCompleted = allRows.filter((op) => op.status === 'completed').length;

  return {
    id: header.id,
    job_id: header.job_id,
    job_number: header.job_number,
    customer_name: header.customer_name,
    part_name: header.part_name,
    part_quantity: header.quantity,
    production_status: header.production_status,
    operation_id: currentOp?.id || null,
    operation_name: currentOp?.operation_name || null,
    operation_status: currentOp?.status || null,
    estimated_minutes: estimatedMinutes,
    active_session_id: activeSessionId,
    session_started_at: sessionStartedAt,
    current_operator_id: currentOperatorId,
    current_operator_name: currentOperatorName,
    operations_total: operationsTotal,
    operations_completed: operationsCompleted,
  };
}

/**
 * Detail view for ONE specific job_operation (the traveler taps a step). It
 * never resolves by station or sequence and never gates on readiness — the
 * operator chose this exact step, and shops may run out of order. Returns an
 * OperatorJobDetail so the action UI has a single shape to render.
 */
export async function getOperatorOperationDetail(
  jobOperationId: string,
  companyId: string,
): Promise<OperatorJobDetail | null> {
  const supabase = getSupabase();

  const { data: op, error } = await supabase
    .from('job_operations')
    .select('id, job_part_id, operation_name, status, estimated_setup_minutes, estimated_run_minutes_per_unit')
    .eq('id', jobOperationId)
    .single();

  if (error || !op) return null;

  const header = await loadPartHeader(op.job_part_id, companyId);
  if (!header) return null; // not this company's job

  const currentOp: CurrentOpForDetail = {
    id: op.id,
    operation_name: op.operation_name,
    status: op.status,
    estimated_setup_minutes: op.estimated_setup_minutes,
    estimated_run_minutes_per_unit: op.estimated_run_minutes_per_unit,
  };

  const detail = await assembleJobPartDetail(header, currentOp);
  // Surface (but don't enforce) sequence: warn if earlier steps aren't done.
  detail.predecessors_incomplete = !(await isJobOperationReady(op.id));
  return detail;
}

/**
 * Parts hub for a scanned job — every job_part on the job, with a summary of
 * its next-ready operation. Used when an operator scans a multi-part job QR.
 */
export async function getOperatorJobParts(
  jobId: string,
  companyId: string,
): Promise<OperatorJobPartSummary[]> {
  const supabase = getSupabase();

  // Verify the job belongs to this company.
  const { data: job } = await supabase
    .from('jobs')
    .select('id')
    .eq('id', jobId)
    .eq('company_id', companyId)
    .single();
  if (!job) return [];

  const { data: parts } = await supabase
    .from('job_parts')
    .select(`
      id, job_id, sequence, quantity, production_status,
      parts(part_name, description)
    `)
    .eq('job_id', jobId)
    .order('sequence', { ascending: true });

  type PartRow = {
    id: string;
    job_id: string;
    sequence: number;
    quantity: number;
    production_status: string;
    parts: { part_name: string; description: string | null } | { part_name: string; description: string | null }[] | null;
  };
  const partRows = (parts ?? []) as PartRow[];
  if (partRows.length === 0) return [];

  // Pull all operations for these parts in one round-trip.
  const partIds = partRows.map((p) => p.id);
  const { data: ops } = await supabase
    .from('job_operations')
    .select('id, job_part_id, sequence, operation_name, status')
    .in('job_part_id', partIds)
    .order('sequence', { ascending: true });

  type OpRow = {
    id: string;
    job_part_id: string;
    sequence: number;
    operation_name: string;
    status: string;
  };
  const opsByPart = new Map<string, OpRow[]>();
  for (const op of (ops ?? []) as OpRow[]) {
    const arr = opsByPart.get(op.job_part_id) ?? [];
    arr.push(op);
    opsByPart.set(op.job_part_id, arr);
  }

  return partRows.map((part) => {
    const partsJoin = Array.isArray(part.parts) ? part.parts[0] : part.parts;
    const partOps = opsByPart.get(part.id) ?? [];

    const total = partOps.length;
    const done = partOps.filter((o) => o.status === 'completed').length;

    // Pick the first pending or in-progress op. For pending, ensure predecessors are done.
    let nextOp: OpRow | null = null;
    for (const op of partOps) {
      if (op.status === 'in_progress') {
        nextOp = op;
        break;
      }
      if (op.status === 'pending') {
        const earlierUnfinished = partOps.some(
          (prev) => prev.sequence < op.sequence && prev.status !== 'completed',
        );
        if (!earlierUnfinished) {
          nextOp = op;
          break;
        }
      }
    }

    return {
      id: part.id,
      job_id: part.job_id,
      part_name: partsJoin?.part_name ?? 'Part',
      part_description: partsJoin?.description ?? null,
      quantity: part.quantity,
      production_status: part.production_status,
      next_operation_name: nextOp?.operation_name ?? null,
      next_operation_id: nextOp?.id ?? null,
      operations_total: total,
      operations_completed: done,
    };
  });
}

// ============================================================================
// SESSION ACTIONS — keyed on job_part_id
// ============================================================================

/**
 * Start working on a job_part at a station. Finds the matching pending or
 * in-progress operation on this part and creates an operator_session.
 */
export async function startJob(
  jobPartId: string,
  operatorId: string,
  companyId: string,
  request: JobStartRequest,
): Promise<OperatorSession> {
  const supabase = getSupabase();

  const { data: part } = await supabase
    .from('job_parts')
    .select('job_id')
    .eq('id', jobPartId)
    .single();
  if (!part) {
    throw new Error('Job part not found.');
  }

  // 1. Resolve the job_operation to start. When the traveler taps a specific
  // step, request.job_operation_id pins the exact operation (two steps can
  // share a work center, so resolving by work center alone is ambiguous).
  // Otherwise (station-QR flow) resolve by work center as before. The request
  // field is named `operation_type_id` for source-compatibility; its value is
  // a work_center_id.
  if (!request.job_operation_id && !request.operation_type_id) {
    throw new Error('A station or operation is required to start work.');
  }

  let opQuery = supabase
    .from('job_operations')
    .select('*')
    .eq('job_part_id', jobPartId)
    .in('status', ['pending', 'in_progress']);

  opQuery = request.job_operation_id
    ? opQuery.eq('id', request.job_operation_id)
    : opQuery.eq('work_center_id', request.operation_type_id as string);

  const { data: jobOp, error: opError } = await opQuery.single();

  if (opError || !jobOp) {
    throw new Error('No pending operation found for this part and station');
  }

  // NOTE: we intentionally do NOT block on predecessor readiness. Shops work
  // out of order, so an operator may start any pending/in-progress step from
  // the traveler. The UI surfaces a non-blocking "earlier steps not complete"
  // warning instead of preventing the start.

  // 2. Auto-stop any existing active session for this operator.
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

  // 3. Create new session. Prefer the resolved operation's own work center
  // (correct when the traveler pinned a specific step); fall back to the
  // requested station for the work-center-resolution path.
  const sessionWorkCenterId = jobOp.work_center_id ?? request.operation_type_id;
  if (!sessionWorkCenterId) {
    throw new Error('This operation has no work center assigned and cannot be started.');
  }
  const now = new Date().toISOString();
  const { data: session, error: sessionError } = await supabase
    .from('operator_sessions')
    .insert({
      company_id: companyId,
      operator_id: operatorId,
      job_id: part.job_id,
      job_operation_id: jobOp.id,
      work_center_id: sessionWorkCenterId,
      started_at: now,
    })
    .select()
    .single();

  if (sessionError) throw new Error(sessionError.message);

  // 4. Mark op + part in_progress.
  await supabase
    .from('job_operations')
    .update({ status: 'in_progress', started_at: now })
    .eq('id', jobOp.id);

  await supabase
    .from('job_parts')
    .update({
      production_status: 'in_progress',
      status_changed_at: now,
      started_at: now, // started_at is set only the first time per the trigger logic
      updated_at: now,
    })
    .eq('id', jobPartId)
    .not('production_status', 'in', '("in_progress","completed","cancelled")');

  return {
    id: session.id,
    operator_id: operatorId,
    job_id: part.job_id,
    job_operation_id: jobOp.id,
    operation_type_id: sessionWorkCenterId, // OperatorSession type holds the work_center id under this legacy field name
    started_at: now,
    ended_at: null,
    notes: null,
  };
}

/**
 * Stop (pause) work on a job_part. Closes the operator's active session for
 * the part without changing the operation status (still in_progress).
 */
export async function stopJob(
  jobPartId: string,
  operatorId: string,
  request?: JobStopRequest,
): Promise<OperatorSession> {
  const supabase = getSupabase();

  const { data: part } = await supabase
    .from('job_parts')
    .select('job_id')
    .eq('id', jobPartId)
    .single();
  if (!part) throw new Error('Job part not found.');

  const { data: session, error } = await supabase
    .from('operator_sessions')
    .select('*')
    .eq('operator_id', operatorId)
    .eq('job_id', part.job_id)
    .is('ended_at', null)
    .single();

  if (error || !session) {
    throw new Error('No active session found');
  }

  const now = new Date().toISOString();

  await supabase
    .from('operator_sessions')
    .update({
      ended_at: now,
      notes: request?.notes || null,
    })
    .eq('id', session.id);

  // operator_sessions.started_at has DEFAULT now() in the schema, so
  // every inserted row is non-null in practice. The generated type still
  // sees `string | null` (DEFAULT without NOT NULL), so we assert.
  const startedAt = session.started_at ?? now;
  const started = new Date(startedAt);
  const ended = new Date(now);
  const durationSeconds = Math.floor((ended.getTime() - started.getTime()) / 1000);

  return {
    id: session.id,
    operator_id: operatorId,
    job_id: part.job_id,
    job_operation_id: session.job_operation_id,
    operation_type_id: session.work_center_id,
    started_at: startedAt,
    ended_at: now,
    notes: request?.notes || null,
    duration_seconds: durationSeconds,
  };
}

/**
 * Mark the current operation on a job_part complete. Closes the operator
 * session, computes actual run minutes, marks the operation completed, and
 * — if it was the last op on the part — flips the job_part to 'completed'
 * (the database trigger then aggregates that into jobs.production_status).
 *
 * No completion notes or material-consumption confirmation: job notes now live
 * at the job level (job_notes) and material consumption is driven by the part
 * BOM, not tracked here. This is a direct action with no confirmation dialog.
 */
export async function completeJob(
  jobPartId: string,
  operatorId: string,
): Promise<JobCompleteResponse> {
  const supabase = getSupabase();

  const { data: part } = await supabase
    .from('job_parts')
    .select('job_id')
    .eq('id', jobPartId)
    .single();
  if (!part) throw new Error('Job part not found.');

  const { data: session, error } = await supabase
    .from('operator_sessions')
    .select('*')
    .eq('operator_id', operatorId)
    .eq('job_id', part.job_id)
    .is('ended_at', null)
    .single();

  if (error || !session) {
    throw new Error('No active session found');
  }

  const now = new Date().toISOString();

  await supabase
    .from('operator_sessions')
    .update({ ended_at: now })
    .eq('id', session.id);

  let actualRunMinutes: number | null = null;
  if (session.job_operation_id) {
    const { data: allSessions } = await supabase
      .from('operator_sessions')
      .select('started_at, ended_at')
      .eq('job_operation_id', session.job_operation_id)
      .not('ended_at', 'is', null);

    if (allSessions && allSessions.length > 0) {
      actualRunMinutes = calculateActualRunMinutes(
        allSessions as { started_at: string; ended_at: string }[],
      );
    }
  }

  if (session.job_operation_id) {
    await supabase
      .from('job_operations')
      .update({
        status: 'completed',
        completed_at: now,
        actual_run_minutes: actualRunMinutes,
      })
      .eq('id', session.job_operation_id);
  }

  // Per-part rollup: are all ops on THIS part now done?
  const { data: remaining } = await supabase
    .from('job_operations')
    .select('id')
    .eq('job_part_id', jobPartId)
    .neq('status', 'completed');

  const partCompleted = !remaining || remaining.length === 0;

  if (partCompleted) {
    await supabase
      .from('job_parts')
      .update({
        production_status: 'completed',
        completed_at: now,
        status_changed_at: now,
        updated_at: now,
      })
      .eq('id', jobPartId)
      .not('production_status', 'in', '("cancelled")');
  }

  // After the part flips, check if EVERY part on the job is done — for the
  // "job_completed" return flag. The DB trigger has already cascaded the
  // production_status; we just read it back.
  let jobCompleted = false;
  if (partCompleted) {
    const { data: jobRow } = await supabase
      .from('jobs')
      .select('production_status')
      .eq('id', part.job_id)
      .single();
    jobCompleted = jobRow?.production_status === 'completed';
  }

  // DB DEFAULT now() on started_at; never null at read time. See note
  // in stopSession() above.
  const started = new Date(session.started_at ?? now);
  const ended = new Date(now);
  const durationSeconds = Math.floor((ended.getTime() - started.getTime()) / 1000);

  return {
    success: true,
    session_id: session.id,
    duration_seconds: durationSeconds,
    job_completed: jobCompleted,
  };
}

// ============================================================================
// SESSION HISTORY
// ============================================================================

export async function getActiveSession(
  operatorId: string,
): Promise<ActiveSession | null> {
  const supabase = getSupabase();

  const { data: session } = await supabase
    .from('operator_sessions')
    .select(`
      id, job_id, job_operation_id, work_center_id, started_at, notes,
      jobs(job_number),
      job_operations(operation_name)
    `)
    .eq('operator_id', operatorId)
    .is('ended_at', null)
    .single();

  if (!session) return null;

  type JobJoin = { job_number: string };
  type OpJoin = { operation_name: string };
  const jobJoin = Array.isArray(session.jobs) ? session.jobs[0] : (session.jobs as JobJoin | null);
  const opJoin = Array.isArray(session.job_operations)
    ? session.job_operations[0]
    : (session.job_operations as OpJoin | null);

  return {
    id: session.id,
    operator_id: operatorId,
    job_id: session.job_id,
    job_number: jobJoin?.job_number ?? null,
    job_operation_id: session.job_operation_id,
    operation_name: opJoin?.operation_name ?? null,
    operation_type_id: session.work_center_id,
    // DB DEFAULT now() — non-null in practice; fall back to '' for the
    // theoretical case where a row was inserted with explicit NULL.
    started_at: session.started_at ?? '',
    notes: session.notes,
  };
}

export async function getOperatorSessions(
  operatorId: string,
  limit: number = 50,
): Promise<OperatorSession[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('operator_sessions')
    .select(`
      id, operator_id, job_id, job_operation_id, work_center_id,
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
    work_center_id: string;
    // Schema has DEFAULT now() but no NOT NULL constraint; mirror that
    // here so the typed select's row shape lines up. Consumers below
    // fall back to '' for the theoretical NULL case.
    started_at: string | null;
    ended_at: string | null;
    notes: string | null;
    jobs: { job_number: string } | { job_number: string }[] | null;
    job_operations: { operation_name: string } | { operation_name: string }[] | null;
  }

  return (data || []).map((s: SessionRow) => {
    let durationSeconds: number | undefined;
    if (s.ended_at && s.started_at) {
      const started = new Date(s.started_at);
      const ended = new Date(s.ended_at);
      durationSeconds = Math.floor((ended.getTime() - started.getTime()) / 1000);
    }
    const jobJoin = Array.isArray(s.jobs) ? s.jobs[0] : s.jobs;
    const opJoin = Array.isArray(s.job_operations) ? s.job_operations[0] : s.job_operations;

    return {
      id: s.id,
      operator_id: s.operator_id,
      job_id: s.job_id,
      job_operation_id: s.job_operation_id,
      operation_type_id: s.work_center_id,
      started_at: s.started_at ?? '',
      ended_at: s.ended_at,
      notes: s.notes,
      duration_seconds: durationSeconds,
      job_number: jobJoin?.job_number || null,
      operation_name: opJoin?.operation_name || null,
    };
  });
}

// ============================================================================
// STATION UTILITIES
// ============================================================================

export async function getStationOperationTypes(
  companyId: string,
): Promise<Station[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('work_centers')
    .select('id, name')
    .eq('company_id', companyId)
    .order('name');

  if (error) throw new Error(error.message);

  return (data || []).map((wc: { id: string; name: string }) => ({
    id: wc.id,
    name: wc.name,
  }));
}

export async function getStationName(
  stationId: string,
): Promise<string | null> {
  const supabase = getSupabase();

  const { data } = await supabase
    .from('work_centers')
    .select('name')
    .eq('id', stationId)
    .single();

  return data?.name || null;
}

// ============================================================================
// JOB TRAVELER (all operations for a job_part) + JOB NOTES
// ============================================================================

/**
 * The full traveler for a single job_part: header info plus EVERY operation in
 * sequence (not just the "current" one). Backs the operator traveler view the
 * operator lands on when they scan a job QR — they pick which step to action.
 */
export async function getJobPartTraveler(
  jobPartId: string,
  companyId: string,
): Promise<JobTraveler | null> {
  const supabase = getSupabase();

  const { data: part, error } = await supabase
    .from('job_parts')
    .select(`
      id, job_id, production_status, quantity,
      parts(part_name, description),
      jobs!inner(id, job_number, due_date, customer_po_number, company_id, customers(name))
    `)
    .eq('id', jobPartId)
    .eq('jobs.company_id', companyId)
    .single();

  if (error || !part) return null;

  type PartRow = {
    id: string;
    job_id: string;
    production_status: string;
    quantity: number;
    parts: { part_name: string; description: string | null } | { part_name: string; description: string | null }[] | null;
    jobs: {
      id: string;
      job_number: string;
      due_date: string | null;
      customer_po_number: string | null;
      customers: { name: string } | { name: string }[] | null;
    } | null;
  };
  const p = part as PartRow;
  const partsJoin = Array.isArray(p.parts) ? p.parts[0] : p.parts;
  const jobJoin = p.jobs;
  const customerJoin = jobJoin
    ? Array.isArray(jobJoin.customers) ? jobJoin.customers[0] : jobJoin.customers
    : null;

  const { data: ops } = await supabase
    .from('job_operations')
    .select('id, sequence, operation_name, instructions, status, estimated_setup_minutes, estimated_run_minutes_per_unit, work_center_id, work_center:work_centers(name)')
    .eq('job_part_id', jobPartId)
    .order('sequence', { ascending: true });

  type OpRow = {
    id: string;
    sequence: number;
    operation_name: string;
    instructions: string | null;
    status: string;
    estimated_setup_minutes: number | null;
    estimated_run_minutes_per_unit: number | null;
    work_center_id: string | null;
    work_center: { name: string } | { name: string }[] | null;
  };
  const opRows = (ops ?? []) as OpRow[];

  // Resolve "in progress by {name}" for the operations that have an open session.
  const inProgressOpIds = opRows.filter((o) => o.status === 'in_progress').map((o) => o.id);
  const operatorNameByOp = new Map<string, string>();
  if (inProgressOpIds.length > 0) {
    const { data: sessions } = await supabase
      .from('operator_sessions')
      .select('job_operation_id, operator_id')
      .in('job_operation_id', inProgressOpIds)
      .is('ended_at', null);
    type SessRow = { job_operation_id: string | null; operator_id: string };
    const opByOperator = (sessions ?? []) as SessRow[];
    const operatorIds = Array.from(new Set(opByOperator.map((s) => s.operator_id)));
    const nameById = new Map<string, string>();
    if (operatorIds.length > 0) {
      const { data: names } = await supabase
        .from('user_company_access')
        .select('id, name')
        .in('id', operatorIds);
      type NameRow = { id: string; name: string | null };
      for (const n of (names ?? []) as NameRow[]) {
        if (n.name) nameById.set(n.id, n.name);
      }
    }
    for (const s of opByOperator) {
      if (s.job_operation_id) {
        operatorNameByOp.set(s.job_operation_id, nameById.get(s.operator_id) ?? '');
      }
    }
  }

  const operations: JobTravelerOperation[] = opRows.map((op) => {
    const wcJoin = Array.isArray(op.work_center) ? op.work_center[0] : op.work_center;
    return {
      id: op.id,
      sequence: op.sequence,
      operation_name: op.operation_name,
      instructions: op.instructions,
      work_center_id: op.work_center_id,
      work_center_name: wcJoin?.name ?? null,
      status: op.status,
      setup_minutes: Number(op.estimated_setup_minutes) || 0,
      cycle_minutes: Number(op.estimated_run_minutes_per_unit) || 0,
      active_operator_name: operatorNameByOp.get(op.id) || null,
    };
  });

  return {
    job_part_id: p.id,
    job_id: p.job_id,
    job_number: jobJoin?.job_number ?? '',
    customer_name: customerJoin?.name ?? null,
    part_name: partsJoin?.part_name ?? null,
    part_description: partsJoin?.description ?? null,
    quantity: p.quantity,
    due_date: jobJoin?.due_date ?? null,
    customer_po_number: jobJoin?.customer_po_number ?? null,
    production_status: p.production_status,
    operations,
  };
}

/**
 * Job-level notes feed (newest first). General notes about the job, not tied to
 * any operation. Authored by operators/admins over time.
 */
export async function getJobNotes(
  jobId: string,
  companyId: string,
): Promise<JobNote[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('job_notes')
    .select('id, job_id, body, created_at, author:user_company_access(name)')
    .eq('job_id', jobId)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);

  type NoteRow = {
    id: string;
    job_id: string;
    body: string;
    created_at: string;
    author: { name: string | null } | { name: string | null }[] | null;
  };

  return ((data ?? []) as NoteRow[]).map((n) => {
    const author = Array.isArray(n.author) ? n.author[0] : n.author;
    return {
      id: n.id,
      job_id: n.job_id,
      body: n.body,
      created_at: n.created_at,
      author_name: author?.name ?? null,
    };
  });
}

/**
 * Append a job-level note. `authorId` is the author's user_company_access id
 * (from getCurrentOperator); RLS requires it to match the caller's access row.
 */
export async function addJobNote(
  jobId: string,
  companyId: string,
  authorId: string,
  body: string,
): Promise<JobNote> {
  const supabase = getSupabase();

  const trimmed = body.trim();
  if (!trimmed) throw new Error('Note cannot be empty.');

  const { data, error } = await supabase
    .from('job_notes')
    .insert({
      company_id: companyId,
      job_id: jobId,
      author_id: authorId,
      body: trimmed,
    })
    .select('id, job_id, body, created_at, author:user_company_access(name)')
    .single();

  if (error) {
    throw new Error(
      friendlyErrorMessage(error, {
        entity: 'note',
        fallback: 'Failed to add note.',
      }),
    );
  }

  type NoteRow = {
    id: string;
    job_id: string;
    body: string;
    created_at: string;
    author: { name: string | null } | { name: string | null }[] | null;
  };
  const n = data as NoteRow;
  const author = Array.isArray(n.author) ? n.author[0] : n.author;
  return {
    id: n.id,
    job_id: n.job_id,
    body: n.body,
    created_at: n.created_at,
    author_name: author?.name ?? null,
  };
}
