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

// Update payload type for user_company_access. Used where the patch
// object is built conditionally and would otherwise be inferred as
// Record<string, unknown>, which the typed .update(...) rejects.
type UserCompanyAccessUpdate = Database['public']['Tables']['user_company_access']['Update'];
import type {
  OperatorJob,
  OperatorJobDetail,
  Station,
  JobCompleteResponse,
  JobTraveler,
  JobTravelerOperation,
  JobNote,
  JobNoteMedia,
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
  part_description: string | null;
}

// The single operation an operator detail view is built around.
interface CurrentOpForDetail {
  id: string;
  operation_name: string;
  status: string;
  instructions: string | null;
  estimated_setup_minutes: number | null;
  estimated_run_minutes_per_unit: number | null;
  work_center_id: string | null;
  work_center_name: string | null;
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
      parts(part_name, description),
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
    parts: { part_name: string; description: string | null } | { part_name: string; description: string | null }[] | null;
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
    part_description: partsJoin?.description ?? null,
  };
}

/**
 * Assemble the OperatorJobDetail (session, estimate, progress, materials)
 * around a resolved part header + a single "current" operation. Used by
 * getOperatorOperationDetail (resolves a specific op by id).
 */
async function assembleJobPartDetail(
  header: PartHeaderForDetail,
  currentOp: CurrentOpForDetail | null,
): Promise<OperatorJobDetail> {
  const supabase = getSupabase();
  const jobPartId = header.id;

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
    part_description: header.part_description,
    part_quantity: header.quantity,
    production_status: header.production_status,
    operation_id: currentOp?.id || null,
    operation_name: currentOp?.operation_name || null,
    operation_status: currentOp?.status || null,
    operation_instructions: currentOp?.instructions ?? null,
    operation_work_center_id: currentOp?.work_center_id ?? null,
    operation_work_center_name: currentOp?.work_center_name ?? null,
    estimated_minutes: estimatedMinutes,
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
    .select('id, job_part_id, operation_name, status, instructions, estimated_setup_minutes, estimated_run_minutes_per_unit, work_center_id, work_center:work_centers(name)')
    .eq('id', jobOperationId)
    .single();

  if (error || !op) return null;

  const header = await loadPartHeader(op.job_part_id, companyId);
  if (!header) return null; // not this company's job

  const wcJoin = Array.isArray(op.work_center) ? op.work_center[0] : op.work_center;
  const currentOp: CurrentOpForDetail = {
    id: op.id,
    operation_name: op.operation_name,
    status: op.status,
    instructions: op.instructions,
    estimated_setup_minutes: op.estimated_setup_minutes,
    estimated_run_minutes_per_unit: op.estimated_run_minutes_per_unit,
    work_center_id: op.work_center_id,
    work_center_name: wcJoin?.name ?? null,
  };

  const detail = await assembleJobPartDetail(header, currentOp);
  // Surface (but don't enforce) sequence: warn if earlier steps aren't done.
  detail.predecessors_incomplete = !(await isJobOperationReady(op.id));
  return detail;
}

// ============================================================================
// OPERATION ACTIONS — keyed on job_operation_id
// ============================================================================

/**
 * Mark a single operation complete. This is the operator's one-tap action —
 * there is no separate "start" step, no pause, and no on-job timer. We record
 * who completed the step (job_operations.completed_by = the signed-in auth user)
 * and when, then roll the result up to the job_part (which a DB trigger cascades
 * to the job).
 *
 * Time-on-job is intentionally NOT tracked: operators complete in a single tap,
 * so there's no reliable session duration to record (the operator_sessions table
 * and the job_operations actual-time columns were removed with this flow).
 *
 * Completing an earlier-than-final step moves the part to 'in_progress'; the
 * last remaining step moves it to 'completed'. No notes or material-consumption
 * confirmation here: job notes live at the job level (job_notes) and material
 * consumption is driven by the part BOM.
 */
export async function completeOperation(
  jobOperationId: string,
): Promise<JobCompleteResponse> {
  const supabase = getSupabase();

  const { data: op, error: opError } = await supabase
    .from('job_operations')
    .select('id, job_id, job_part_id, started_at')
    .eq('id', jobOperationId)
    .single();
  if (opError || !op) throw new Error('Operation not found.');

  // completed_by references auth.users(id) (NOT user_company_access.id), so we
  // record the signed-in auth user — same as the admin completeJobOperation path.
  const { data: { user } } = await supabase.auth.getUser();

  const now = new Date().toISOString();

  await supabase
    .from('job_operations')
    .update({
      status: 'completed',
      completed_at: now,
      completed_by: user?.id ?? null,
      started_at: op.started_at ?? now,
    })
    .eq('id', jobOperationId);

  // Per-part rollup: are all ops on THIS part now done?
  const { data: remaining } = await supabase
    .from('job_operations')
    .select('id')
    .eq('job_part_id', op.job_part_id)
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
      .eq('id', op.job_part_id)
      .not('production_status', 'in', '("cancelled")');
  } else {
    // Work has begun even though there was no explicit "start". Move a
    // not-yet-started part to in_progress (the guard skips parts already
    // in_progress/completed/cancelled, leaving their started_at untouched).
    await supabase
      .from('job_parts')
      .update({
        production_status: 'in_progress',
        started_at: now,
        status_changed_at: now,
        updated_at: now,
      })
      .eq('id', op.job_part_id)
      .not('production_status', 'in', '("in_progress","completed","cancelled")');
  }

  // The job_parts trigger has cascaded production_status to the job; read it
  // back for the job_completed flag.
  let jobCompleted = false;
  if (partCompleted) {
    const { data: jobRow } = await supabase
      .from('jobs')
      .select('production_status')
      .eq('id', op.job_id)
      .single();
    jobCompleted = jobRow?.production_status === 'completed';
  }

  return { success: true, job_completed: jobCompleted };
}

/**
 * Undo a completion: put the operation back to 'pending' and recompute the
 * part's status. Backs the operator "Undo completion" action for a step marked
 * done by mistake. Clears completed_at / completed_by.
 *
 * The part can no longer be 'completed' (we just un-completed one of its ops):
 * if any other op is still completed the part is 'in_progress', otherwise it
 * returns to 'not_started'. The job_parts trigger cascades the recomputed
 * status to the job (e.g. a completed job reopens to in_progress).
 */
export async function revertOperationCompletion(
  jobOperationId: string,
): Promise<void> {
  const supabase = getSupabase();

  const { data: op, error: opError } = await supabase
    .from('job_operations')
    .select('id, job_part_id')
    .eq('id', jobOperationId)
    .single();
  if (opError || !op) throw new Error('Operation not found.');

  const now = new Date().toISOString();

  await supabase
    .from('job_operations')
    .update({
      status: 'pending',
      completed_at: null,
      completed_by: null,
    })
    .eq('id', jobOperationId);

  const { data: stillCompleted } = await supabase
    .from('job_operations')
    .select('id')
    .eq('job_part_id', op.job_part_id)
    .eq('status', 'completed');

  const hasCompleted = !!stillCompleted && stillCompleted.length > 0;

  await supabase
    .from('job_parts')
    .update({
      production_status: hasCompleted ? 'in_progress' : 'not_started',
      completed_at: null,
      status_changed_at: now,
      updated_at: now,
    })
    .eq('id', op.job_part_id)
    .not('production_status', 'in', '("cancelled")');
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
      id, job_id, part_id, production_status, quantity,
      parts(part_name, description),
      jobs!inner(id, job_number, created_at, due_date, customer_po_number, company_id, customers(name))
    `)
    .eq('id', jobPartId)
    .eq('jobs.company_id', companyId)
    .single();

  if (error || !part) return null;

  type PartRow = {
    id: string;
    job_id: string;
    part_id: string;
    production_status: string;
    quantity: number;
    parts: { part_name: string; description: string | null } | { part_name: string; description: string | null }[] | null;
    jobs: {
      id: string;
      job_number: string;
      created_at: string | null;
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
    };
  });

  return {
    job_part_id: p.id,
    job_id: p.job_id,
    part_id: p.part_id,
    job_number: jobJoin?.job_number ?? '',
    customer_name: customerJoin?.name ?? null,
    part_name: partsJoin?.part_name ?? null,
    part_description: partsJoin?.description ?? null,
    quantity: p.quantity,
    order_date: jobJoin?.created_at ?? null,
    due_date: jobJoin?.due_date ?? null,
    customer_po_number: jobJoin?.customer_po_number ?? null,
    production_status: p.production_status,
    operations,
  };
}

// One read shape backs the whole job feed (traveler read-only + operation page).
// Each note carries its optional step tag (job_operations) and its media so the
// feed renders thumbnails without a second round-trip.
const JOB_NOTE_SELECT =
  'id, job_id, job_operation_id, body, created_at, ' +
  'author:user_company_access(name), ' +
  'operation:job_operations(operation_name, sequence), ' +
  'media:job_note_media(id, note_id, storage_path, thumbnail_path, kind, mime_type, width, height)';

type JobNoteRow = {
  id: string;
  job_id: string;
  job_operation_id: string | null;
  body: string | null;
  created_at: string;
  author: { name: string | null } | { name: string | null }[] | null;
  operation:
    | { operation_name: string | null; sequence: number | null }
    | { operation_name: string | null; sequence: number | null }[]
    | null;
  media: Array<{
    id: string;
    note_id: string;
    storage_path: string;
    thumbnail_path: string | null;
    kind: string;
    mime_type: string | null;
    width: number | null;
    height: number | null;
  }> | null;
};

function mapJobNoteRow(n: JobNoteRow): JobNote {
  const author = Array.isArray(n.author) ? n.author[0] : n.author;
  const op = Array.isArray(n.operation) ? n.operation[0] : n.operation;
  const operationLabel = op?.operation_name
    ? op.sequence != null
      ? `Op ${op.sequence} · ${op.operation_name}`
      : op.operation_name
    : null;
  const media: JobNoteMedia[] = (n.media ?? []).map((m) => ({
    id: m.id,
    note_id: m.note_id,
    storage_path: m.storage_path,
    thumbnail_path: m.thumbnail_path,
    kind: m.kind === 'video' ? 'video' : 'photo',
    mime_type: m.mime_type,
    width: m.width,
    height: m.height,
  }));
  return {
    id: n.id,
    job_id: n.job_id,
    job_operation_id: n.job_operation_id,
    operation_label: operationLabel,
    body: n.body,
    created_at: n.created_at,
    author_name: author?.name ?? null,
    media,
  };
}

/**
 * The job feed (newest first): one append-only stream per job. Returns both
 * job-level notes and operation-scoped notes — operation notes roll up here
 * automatically because they still carry job_id. Each note includes its step
 * tag label (if any) and its attached media. Backs both the traveler (read-only)
 * and the operation page.
 */
export async function getJobNotes(
  jobId: string,
  companyId: string,
): Promise<JobNote[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('job_notes')
    .select(JOB_NOTE_SELECT)
    .eq('job_id', jobId)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);

  return ((data ?? []) as unknown as JobNoteRow[]).map(mapJobNoteRow);
}

/**
 * Append a note to the job feed. `authorId` is the author's user_company_access
 * id (from getCurrentOperator); RLS requires it to match the caller's access row.
 *
 * `opts.jobOperationId` is the optional step tag. The operation page always
 * passes it (with `jobPartId`) so operator captures are step-scoped; the
 * read-only traveler never calls this. `body` may be null/blank for a media-only
 * note — callers must guarantee body-or-media (a fully empty note is useless);
 * the returned note's `media` is empty until media is attached via
 * addJobNoteMedia.
 */
export async function addJobNote(
  jobId: string,
  companyId: string,
  authorId: string,
  body: string | null,
  opts?: { jobPartId?: string | null; jobOperationId?: string | null },
): Promise<JobNote> {
  const supabase = getSupabase();

  const trimmed = body?.trim() || null;

  const { data, error } = await supabase
    .from('job_notes')
    .insert({
      company_id: companyId,
      job_id: jobId,
      author_id: authorId,
      body: trimmed,
      job_part_id: opts?.jobPartId ?? null,
      job_operation_id: opts?.jobOperationId ?? null,
    })
    .select(JOB_NOTE_SELECT)
    .single();

  if (error) {
    throw new Error(
      friendlyErrorMessage(error, {
        entity: 'note',
        fallback: 'Failed to add note.',
      }),
    );
  }

  return mapJobNoteRow(data as unknown as JobNoteRow);
}
