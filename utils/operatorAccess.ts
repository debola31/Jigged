/**
 * Operator View utilities.
 *
 * With Supabase Auth, operators authenticate using email/password via
 * supabase.auth.signInWithPassword(). Most operations now use direct
 * Supabase client calls with RLS policies.
 *
 * NOTE: There is no dedicated "operators" table. Shop-floor users are
 * user_company_access rows with role='operator', but admins/users are company
 * members too and can act in the operator view just the same (see
 * getCurrentMember — deliberately not role-filtered).
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
import { voidAllOperationCompletions } from '@/utils/operationCompletionsAccess';
import type {
  OperatorJob,
  OperatorPlantJob,
  OperatorJobDetail,
  Station,
  JobCompleteResponse,
  JobTraveler,
  JobPartsOverview,
  JobTravelerOperation,
  OutsideOperation,
  JobNote,
  JobNoteMedia,
  PartPreviousNote,
} from '@/types/operator';

// ============================================================================
// CURRENT USER (the signed-in company member — ANY role)
// ============================================================================

/**
 * The signed-in user's user_company_access row for this company — used wherever
 * we need the acting member's account id (job-note author, operation completer,
 * activity attribution). Intentionally NOT role-filtered: operators, users, and
 * admins are all company members, and every one of them can act in the operator
 * view. (There is no separate "operators" table — that legacy table is gone.)
 */
export async function getCurrentMember(companyId: string): Promise<{
  id: string;
  name: string | null;
  user_id: string;
} | null> {
  const supabase = getSupabase();

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;

  const { data: member } = await supabase
    .from('user_company_access')
    .select('id, name, user_id')
    .eq('user_id', session.user.id)
    .eq('company_id', companyId)
    .single();

  return member;
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
  /** jobs.is_hot — the RPC returns rows already ordered hot-first. */
  is_hot: boolean;
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
    // Surface the failure instead of swallowing it into an empty list — a
    // swallowed RPC error is exactly how the jobs.status column bug read as
    // "no jobs" to operators rather than a visible error. Both callers
    // (getOperatorJobs / getAllStationsOperatorJobs) run inside the jobs page's
    // try/catch, which shows this message in an Alert.
    throw new Error(`Failed to load ready operations for station: ${error.message}`);
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
  workCenterId?: string,
): Promise<OperatorJob[]> {
  if (!workCenterId) {
    // No station selected — the station-scoped list needs a station. The
    // whole-plant view is getAllStationsOperatorJobs() instead.
    return [];
  }

  const readyRows = await getReadyOperationsForStation(companyId, workCenterId);
  return buildOperatorJobs(readyRows);
}

/**
 * Whole-plant ("All Stations") job list: the work ready/in-progress across
 * every station, so a roaming operator or lead can see all active jobs without
 * picking one station. Reuses the SAME per-station readiness RPC, called once
 * per station in parallel, then tags each row with its station and enriches
 * once — a single source of truth for "ready" (no duplicated readiness logic).
 * Rows are returned flat; the UI groups them by station.
 */
export async function getAllStationsOperatorJobs(
  companyId: string,
  stations: Station[],
): Promise<OperatorPlantJob[]> {
  const perStation = await Promise.all(
    stations.map(async (station) => {
      const rows = await getReadyOperationsForStation(companyId, station.id);
      return rows.map((row) => ({ row, station }));
    }),
  );
  const tagged = perStation.flat();
  if (tagged.length === 0) return [];

  // job_operation_id is unique per ready row, so we can re-attach each row's
  // station after enrichment without depending on array order.
  const stationByOp = new Map<string, Station>();
  for (const t of tagged) stationByOp.set(t.row.job_operation_id, t.station);

  const jobs = await buildOperatorJobs(tagged.map((t) => t.row));
  return jobs.map((job) => {
    const station = job.operation_id ? stationByOp.get(job.operation_id) : undefined;
    return {
      ...job,
      work_center_id: station?.id ?? null,
      work_center_name: station?.name ?? null,
    };
  });
}

/**
 * Shared enrichment: turn ready rows (from one station or the whole plant) into
 * OperatorJob rows by fetching per-part progress, customer, and part status.
 * Preserves input order (a 1:1 map over readyRows).
 */
async function buildOperatorJobs(readyRows: ReadyRow[]): Promise<OperatorJob[]> {
  if (readyRows.length === 0) return [];
  const supabase = getSupabase();

  const jobPartIds = readyRows.map((r) => r.job_part_id);
  const jobIds = Array.from(new Set(readyRows.map((r) => r.job_id)));
  const currentOpIds = readyRows.map((r) => r.job_operation_id);

  // Independent reads, each already batched via .in(...). Run them in parallel —
  // this is the operator hot path (station polling / whole-plant view), so
  // collapsing round-trips matters most here.
  const [{ data: partOps }, { data: jobMeta }, { data: partStatusRows }, { data: opCompletions }] =
    await Promise.all([
      // Per-part progress (count of ops total + completed per part).
      supabase
        .from('job_operations')
        .select('job_part_id, status')
        .in('job_part_id', jobPartIds),
      // Each job's customer name.
      supabase.from('jobs').select('id, customers(name)').in('id', jobIds),
      // Each part's current production status.
      supabase
        .from('job_parts')
        .select('id, production_status')
        .in('id', jobPartIds),
      // Good pieces recorded (non-void) against each row's CURRENT operation, so
      // the card can show partial progress ("3 of 12 good") on the ready step.
      supabase
        .from('job_operation_completions')
        .select('job_operation_id, quantity_good')
        .in('job_operation_id', currentOpIds)
        .is('voided_at', null),
    ]);

  type PartOpRow = { job_part_id: string; status: string };
  const progressByPart = new Map<string, { total: number; done: number }>();
  for (const row of (partOps ?? []) as PartOpRow[]) {
    const acc = progressByPart.get(row.job_part_id) ?? { total: 0, done: 0 };
    acc.total += 1;
    if (row.status === 'completed') acc.done += 1;
    progressByPart.set(row.job_part_id, acc);
  }

  type JobMeta = { id: string; customers: { name: string } | null };
  const customerByJob = new Map<string, string | null>();
  for (const j of (jobMeta ?? []) as JobMeta[]) {
    customerByJob.set(j.id, j.customers?.name ?? null);
  }

  type PartStatus = { id: string; production_status: string };
  const statusByPart = new Map<string, string>();
  for (const r of (partStatusRows ?? []) as PartStatus[]) {
    statusByPart.set(r.id, r.production_status);
  }

  type OpCompletionRow = { job_operation_id: string; quantity_good: number };
  const goodByOp = new Map<string, number>();
  for (const r of (opCompletions ?? []) as OpCompletionRow[]) {
    goodByOp.set(r.job_operation_id, (goodByOp.get(r.job_operation_id) ?? 0) + Number(r.quantity_good));
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
      is_hot: row.is_hot ?? false,
      production_status: statusByPart.get(row.job_part_id) ?? 'not_started',
      operation_id: row.job_operation_id,
      operation_name: row.operation_name,
      operation_status: row.op_status,
      operations_total: progress.total,
      operations_completed: progress.done,
      // Partial progress on the CURRENT operation (good pieces / order qty).
      current_op_qty_good: goodByOp.get(row.job_operation_id) ?? 0,
    };
  });
}

// ============================================================================
// COMPLETED JOB LIST (the jobs page "Completed" filter)
// ============================================================================

// Cap the "recently completed" list. An operator reaches it to undo a mis-tapped
// completion, so what matters is the LATEST completions, not full history —
// ordered by completed_at desc, this is "the most recent N completed steps".
const COMPLETED_LIST_LIMIT = 50;

// A completed job_operation shaped as a ReadyRow (so buildOperatorJobs can enrich
// it exactly like the ready list), plus the two fields the completed list adds:
// which station it ran at and when it was completed.
interface CompletedOpRow {
  ready: ReadyRow;
  work_center_id: string | null;
  completed_at: string | null;
}

// Fetch the most-recently-completed operations across the given station(s),
// joined to their part/job for the display fields buildOperatorJobs needs.
// Company isolation is enforced two ways: the explicit jobs.company_id filter and
// work_center_id ∈ this company's stations.
async function getCompletedOperationRows(
  companyId: string,
  workCenterIds: string[],
): Promise<CompletedOpRow[]> {
  if (workCenterIds.length === 0) return [];
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('job_operations')
    .select(`
      id, job_id, job_part_id, operation_name, status, completed_at, work_center_id,
      job_parts!inner(
        quantity, part_id,
        parts(part_name, description),
        jobs!inner(job_number, company_id, is_hot)
      )
    `)
    .eq('status', 'completed')
    .eq('job_parts.jobs.company_id', companyId)
    .in('work_center_id', workCenterIds)
    .not('completed_at', 'is', null)
    .order('completed_at', { ascending: false })
    .limit(COMPLETED_LIST_LIMIT);

  if (error) {
    // Mirror getReadyOperationsForStation: surface the failure instead of
    // swallowing it into an empty list (the jobs page shows it in an Alert).
    throw new Error(`Failed to load completed operations: ${error.message}`);
  }

  type Row = {
    id: string;
    job_id: string;
    job_part_id: string;
    operation_name: string;
    status: string;
    completed_at: string | null;
    work_center_id: string | null;
    job_parts:
      | {
          quantity: number;
          part_id: string;
          parts: { part_name: string; description: string | null } | { part_name: string; description: string | null }[] | null;
          jobs: { job_number: string; is_hot: boolean } | { job_number: string; is_hot: boolean }[] | null;
        }
      | {
          quantity: number;
          part_id: string;
          parts: { part_name: string; description: string | null } | { part_name: string; description: string | null }[] | null;
          jobs: { job_number: string; is_hot: boolean } | { job_number: string; is_hot: boolean }[] | null;
        }[]
      | null;
  };

  return ((data ?? []) as Row[]).map((r) => {
    const partJoin = Array.isArray(r.job_parts) ? r.job_parts[0] : r.job_parts;
    const partsJoin = partJoin
      ? Array.isArray(partJoin.parts) ? partJoin.parts[0] : partJoin.parts
      : null;
    const jobJoin = partJoin
      ? Array.isArray(partJoin.jobs) ? partJoin.jobs[0] : partJoin.jobs
      : null;
    return {
      ready: {
        job_id: r.job_id,
        job_part_id: r.job_part_id,
        job_operation_id: r.id,
        operation_name: r.operation_name,
        op_status: r.status,
        job_number: jobJoin?.job_number ?? '',
        part_id: partJoin?.part_id ?? '',
        part_name: partsJoin?.part_name ?? '',
        part_description: partsJoin?.description ?? null,
        part_quantity: partJoin?.quantity ?? 0,
        is_hot: jobJoin?.is_hot ?? false,
      },
      work_center_id: r.work_center_id,
      completed_at: r.completed_at,
    };
  });
}

/**
 * Recently completed work at ONE station — backs the jobs list's "Completed"
 * filter under the My Station scope. One card per job_part (its most recent
 * completed operation at the station), most-recent first, so an operator can
 * reopen a step they finished by mistake and undo it. Mirrors getOperatorJobs
 * (the ready list) but keyed on completed operations instead of the readiness RPC.
 */
export async function getCompletedOperatorJobs(
  companyId: string,
  workCenterId?: string,
): Promise<OperatorJob[]> {
  if (!workCenterId) return [];
  const rows = await getCompletedOperationRows(companyId, [workCenterId]);

  // Dedupe by job_part (rows are completed_at-desc, so the first seen per part is
  // its most recent completion) → one card per part, like the ready list.
  const seen = new Set<string>();
  const unique = rows.filter((r) => {
    if (seen.has(r.ready.job_part_id)) return false;
    seen.add(r.ready.job_part_id);
    return true;
  });

  const jobs = await buildOperatorJobs(unique.map((r) => r.ready));
  // buildOperatorJobs preserves input order (1:1 over readyRows), so index-align
  // the completed_at timestamps back onto the enriched rows.
  return jobs.map((job, i) => ({ ...job, completed_at: unique[i].completed_at }));
}

/**
 * Whole-plant ("All Stations") "Completed" list: recently completed work across
 * every station, grouped by station in the UI. One card per (job_part, station),
 * since a part can have completed work at more than one station.
 */
export async function getAllStationsCompletedOperatorJobs(
  companyId: string,
  stations: Station[],
): Promise<OperatorPlantJob[]> {
  const stationIds = stations.map((s) => s.id);
  if (stationIds.length === 0) return [];
  const rows = await getCompletedOperationRows(companyId, stationIds);

  const nameById = new Map(stations.map((s) => [s.id, s.name] as const));
  const seen = new Set<string>();
  const unique = rows.filter((r) => {
    const key = `${r.ready.job_part_id}:${r.work_center_id ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const jobs = await buildOperatorJobs(unique.map((r) => r.ready));
  return jobs.map((job, i) => {
    const wcId = unique[i].work_center_id;
    return {
      ...job,
      completed_at: unique[i].completed_at,
      work_center_id: wcId,
      work_center_name: wcId ? nameById.get(wcId) ?? null : null,
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
  part_id: string;
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
  work_center_kind: 'internal' | 'external' | null;
  vendor_name: string | null;
  sent_at: string | null;
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
      id, job_id, part_id, production_status, quantity,
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
    part_id: string;
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
    part_id: p.part_id,
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
    part_id: header.part_id,
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
    operation_work_center_kind: currentOp?.work_center_kind ?? null,
    operation_vendor_name: currentOp?.vendor_name ?? null,
    operation_sent_at: currentOp?.sent_at ?? null,
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
    .select('id, job_part_id, operation_name, status, instructions, sent_at, estimated_setup_minutes, estimated_run_minutes_per_unit, work_center_id, work_center:work_centers(name, kind, vendor:vendors(name))')
    .eq('id', jobOperationId)
    .single();

  if (error || !op) return null;

  const header = await loadPartHeader(op.job_part_id, companyId);
  if (!header) return null; // not this company's job

  type WcJoin = {
    name: string;
    kind: 'internal' | 'external';
    vendor: { name: string } | { name: string }[] | null;
  };
  const wcJoin = (Array.isArray(op.work_center) ? op.work_center[0] : op.work_center) as WcJoin | null;
  const vendorJoin = wcJoin
    ? Array.isArray(wcJoin.vendor) ? wcJoin.vendor[0] : wcJoin.vendor
    : null;
  const currentOp: CurrentOpForDetail = {
    id: op.id,
    operation_name: op.operation_name,
    status: op.status,
    instructions: op.instructions,
    estimated_setup_minutes: op.estimated_setup_minutes,
    estimated_run_minutes_per_unit: op.estimated_run_minutes_per_unit,
    work_center_id: op.work_center_id,
    work_center_name: wcJoin?.name ?? null,
    work_center_kind: wcJoin?.kind ?? null,
    vendor_name: vendorJoin?.name ?? null,
    sent_at: op.sent_at,
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
 * Operation context needed to run the external (outside-vendor) send/receive
 * lifecycle: the job/part it belongs to, its current status, whether its work
 * center is external, and the vendor name (for audit notes). `is_external` is
 * false when the work center was deleted (FK ON DELETE SET NULL) — such an op
 * behaves as a normal internal op.
 */
interface OpOutsideContext {
  id: string;
  job_id: string;
  job_part_id: string;
  company_id: string;
  status: string;
  sent_at: string | null;
  is_external: boolean;
  vendor_name: string | null;
}

async function loadOpOutsideContext(jobOperationId: string): Promise<OpOutsideContext> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('job_operations')
    .select('id, job_id, job_part_id, status, sent_at, jobs!inner(company_id), work_center:work_centers(kind, vendor:vendors(name))')
    .eq('id', jobOperationId)
    .single();
  if (error || !data) throw new Error('Operation not found.');

  type Row = {
    id: string;
    job_id: string;
    job_part_id: string;
    status: string;
    sent_at: string | null;
    jobs: { company_id: string } | { company_id: string }[] | null;
    work_center:
      | { kind: 'internal' | 'external'; vendor: { name: string } | { name: string }[] | null }
      | { kind: 'internal' | 'external'; vendor: { name: string } | { name: string }[] | null }[]
      | null;
  };
  const row = data as unknown as Row;
  const job = Array.isArray(row.jobs) ? row.jobs[0] : row.jobs;
  const wc = Array.isArray(row.work_center) ? row.work_center[0] : row.work_center;
  const vendor = wc ? (Array.isArray(wc.vendor) ? wc.vendor[0] : wc.vendor) : null;

  return {
    id: row.id,
    job_id: row.job_id,
    job_part_id: row.job_part_id,
    company_id: job?.company_id ?? '',
    status: row.status,
    sent_at: row.sent_at,
    is_external: wc?.kind === 'external',
    vendor_name: vendor?.name ?? null,
  };
}

/**
 * Move a job_part to 'in_progress' because work on it has begun. The guard skips
 * parts already in_progress/completed/cancelled, leaving their started_at
 * untouched. Shared by complete, receive, and send (all are "work has begun").
 */
async function movePartToInProgress(jobPartId: string, now: string): Promise<void> {
  const supabase = getSupabase();
  await supabase
    .from('job_parts')
    .update({
      production_status: 'in_progress',
      started_at: now,
      status_changed_at: now,
      updated_at: now,
    })
    .eq('id', jobPartId)
    .not('production_status', 'in', '("in_progress","completed","cancelled")');
}

/**
 * Per-part rollup after an op becomes 'completed': mark the part completed if
 * all its ops are now completed, else move a not-yet-started part to
 * in_progress. Returns whether the part is now fully completed. A 'sent'
 * (at-vendor) op counts as NOT completed, so a part with outstanding outside
 * work correctly stays in_progress.
 */
async function rollupPartAfterCompletion(jobPartId: string, now: string): Promise<boolean> {
  const supabase = getSupabase();
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
  } else {
    await movePartToInProgress(jobPartId, now);
  }
  return partCompleted;
}

/** Read back the (trigger-cascaded) job production_status as a completed flag. */
async function readJobCompleted(jobId: string): Promise<boolean> {
  const supabase = getSupabase();
  const { data: jobRow } = await supabase
    .from('jobs')
    .select('production_status')
    .eq('id', jobId)
    .single();
  return jobRow?.production_status === 'completed';
}

/**
 * Mark an outside (external-vendor) operation as SENT OUT: the parts have left
 * the shop for the vendor. Moves pending → sent, records who/when (sent_by =
 * signed-in auth user), and moves the part to in_progress (work has begun). Only
 * valid for an external op awaiting send (pending). `sent` is an optional
 * waypoint — see markOperationReceived, which also accepts a still-pending op.
 *
 * The send is NOT logged as a job_note. `sent_at`/`sent_by` on the operation are
 * the record; the /activity feed derives a "Sent to {vendor}" operation activity
 * from `sent_at` (see dashboardAccess.fetchOperationActivity). Auto-notes would
 * only clutter the operator notes feed.
 */
export async function markOperationSent(jobOperationId: string): Promise<void> {
  const supabase = getSupabase();
  const op = await loadOpOutsideContext(jobOperationId);
  if (!op.is_external) {
    throw new Error('Only outside (vendor) operations can be sent out.');
  }
  if (op.status !== 'pending') {
    throw new Error('This operation is not awaiting send.');
  }

  const { data: { user } } = await supabase.auth.getUser();
  const now = new Date().toISOString();

  await supabase
    .from('job_operations')
    .update({ status: 'sent', sent_at: now, sent_by: user?.id ?? null })
    .eq('id', jobOperationId);

  await movePartToInProgress(op.job_part_id, now);
}

/**
 * Mark an outside (external-vendor) operation as RECEIVED: the parts are back
 * from the vendor and this step is done. Completes the op (received == completed,
 * reusing completed_at/completed_by) and runs the standard part/job rollup.
 *
 * `sent` is an OPTIONAL waypoint: this also accepts a still-`pending` op (the
 * common after-the-fact case where nobody tapped Mark Sent Out while the parts
 * were away). Received-from-pending back-fills sent_at = completed_at. Not logged
 * as a job_note — `sent_at`/`completed_at` on the op are the record, and the
 * /activity feed derives "Sent to {vendor}" + "Received from {vendor}" operation
 * activities from them. Throws for a non-external op or one already completed.
 */
export async function markOperationReceived(
  jobOperationId: string,
): Promise<JobCompleteResponse> {
  const supabase = getSupabase();
  const op = await loadOpOutsideContext(jobOperationId);
  if (!op.is_external) {
    throw new Error('Only outside (vendor) operations can be received.');
  }
  if (op.status !== 'sent' && op.status !== 'pending') {
    throw new Error('This operation cannot be received.');
  }
  const receivedFromPending = op.status === 'pending';

  const { data: { user } } = await supabase.auth.getUser();
  const now = new Date().toISOString();

  const update: {
    status: 'completed';
    completed_at: string;
    completed_by: string | null;
    sent_at?: string;
    sent_by?: string | null;
  } = { status: 'completed', completed_at: now, completed_by: user?.id ?? null };
  if (receivedFromPending) {
    // Send was skipped — record it alongside receipt so the queue/audit reflect
    // that the parts did go out.
    update.sent_at = now;
    update.sent_by = user?.id ?? null;
  }

  await supabase.from('job_operations').update(update).eq('id', jobOperationId);

  const partCompleted = await rollupPartAfterCompletion(op.job_part_id, now);

  return {
    success: true,
    job_completed: partCompleted ? await readJobCompleted(op.job_id) : false,
  };
}

/**
 * Undo an operation's completion (or, for an outside op, its send) and recompute
 * the part's status. Backs the operator "Undo" action.
 *
 * For a normal internal op: 'completed' → 'pending' (clears completed_at/by).
 *
 * For an outside (external-vendor) op the lifecycle is stepped back one state,
 * never skipped:
 *   - received (completed WITH sent_at) → sent   (parts still out at the vendor)
 *   - completed WITHOUT sent_at → pending        (legacy/backfilled — never sent)
 *   - sent → pending                             (un-send: parts never left)
 *
 * The part can no longer be 'completed' if we un-completed one of its ops: if any
 * other op is still completed the part is 'in_progress', otherwise 'not_started'.
 *
 * An INTERNAL op undoes by voiding every non-void completion event
 * (voidAllOperationCompletions); the recompute trigger derives the op back to
 * pending and cascades the part/job status. Quantities are never deleted.
 */
export async function revertOperationCompletion(
  jobOperationId: string,
): Promise<void> {
  const op = await loadOpOutsideContext(jobOperationId);

  // Outside (external-vendor) ops carry status via direct writes with no
  // completion events, so step the lifecycle back one state and roll the part up
  // manually — voidAllOperationCompletions would be a no-op for them.
  if (op.is_external) {
    const supabase = getSupabase();
    const now = new Date().toISOString();

    if (op.status === 'completed' && op.sent_at) {
      // Received → back to sent (parts are still out); keep sent_at/by.
      await supabase
        .from('job_operations')
        .update({ status: 'sent', completed_at: null, completed_by: null })
        .eq('id', jobOperationId);
    } else if (op.status === 'sent') {
      // Un-send → back to pending; clear the send stamp.
      await supabase
        .from('job_operations')
        .update({ status: 'pending', sent_at: null, sent_by: null })
        .eq('id', jobOperationId);
    } else {
      // Legacy external completed op that never went through send → pending.
      await supabase
        .from('job_operations')
        .update({ status: 'pending', completed_at: null, completed_by: null, sent_at: null, sent_by: null })
        .eq('id', jobOperationId);
    }

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
    return;
  }

  // Internal op: void completion events; the trigger derives op → pending and
  // cascades part/job status.
  await voidAllOperationCompletions(jobOperationId);
}

// ============================================================================
// OUTSIDE (external-vendor) OPERATIONS QUEUE
// ============================================================================

/**
 * Every outside (external-vendor) operation across the company that is not yet
 * received — backs the "Outside work" tab on the Jobs list. The caller groups
 * the result into "Not sent" (status='pending') and "At vendor" (status='sent').
 *
 * Purely informational: NO readiness/predecessor logic (Jigged's completion data
 * is unreliable, so this surface informs the shipping lead rather than gating on
 * it). Excludes archived (deleted_at) and cancelled jobs. Ordered hot-first, then
 * by job due date (nulls last).
 */
export async function getOutsideOpsForCompany(
  companyId: string,
): Promise<OutsideOperation[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('job_operations')
    .select(`
      id, job_id, job_part_id, operation_name, status, sent_at, sent_by,
      work_center:work_centers!inner(kind, vendor:vendors(name)),
      job_part:job_parts!inner(parts(part_name)),
      jobs!inner(job_number, due_date, is_hot, company_id, production_status, deleted_at)
    `)
    .eq('jobs.company_id', companyId)
    .is('jobs.deleted_at', null)
    .neq('jobs.production_status', 'cancelled')
    .eq('work_center.kind', 'external')
    .in('status', ['pending', 'sent']);

  if (error || !data) return [];

  type OneOrMany<T> = T | T[] | null;
  type Row = {
    id: string;
    job_id: string;
    job_part_id: string;
    operation_name: string;
    status: string;
    sent_at: string | null;
    sent_by: string | null;
    work_center: OneOrMany<{ kind: string; vendor: OneOrMany<{ name: string }> }>;
    job_part: OneOrMany<{ parts: OneOrMany<{ part_name: string }> }>;
    jobs: OneOrMany<{ job_number: string; due_date: string | null; is_hot: boolean }>;
  };
  const first = <T>(v: OneOrMany<T>): T | null => (Array.isArray(v) ? v[0] ?? null : v);
  const rows = data as unknown as Row[];

  // Resolve sent_by (auth.users id) → member name, one batched query.
  const senderIds = Array.from(
    new Set(rows.map((r) => r.sent_by).filter((v): v is string => !!v)),
  );
  const nameByUser = new Map<string, string | null>();
  if (senderIds.length > 0) {
    const { data: members } = await supabase
      .from('user_company_access')
      .select('user_id, name')
      .eq('company_id', companyId)
      .in('user_id', senderIds);
    for (const m of (members ?? []) as Array<{ user_id: string; name: string | null }>) {
      nameByUser.set(m.user_id, m.name);
    }
  }

  const ops: OutsideOperation[] = rows.map((r) => {
    const wc = first(r.work_center);
    const vendor = wc ? first(wc.vendor) : null;
    const part = first(first(r.job_part)?.parts ?? null);
    const job = first(r.jobs);
    return {
      id: r.id,
      job_id: r.job_id,
      job_part_id: r.job_part_id,
      job_number: job?.job_number ?? '',
      part_name: part?.part_name ?? null,
      operation_name: r.operation_name,
      vendor_name: vendor?.name ?? null,
      status: r.status === 'sent' ? 'sent' : 'pending',
      sent_at: r.sent_at,
      sent_by_name: r.sent_by ? nameByUser.get(r.sent_by) ?? null : null,
      due_date: job?.due_date ?? null,
      is_hot: job?.is_hot ?? false,
    };
  });

  // Hot first, then earliest due date (nulls last).
  ops.sort((a, b) => {
    if (a.is_hot !== b.is_hot) return a.is_hot ? -1 : 1;
    if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date);
    if (a.due_date) return -1;
    if (b.due_date) return 1;
    return a.job_number.localeCompare(b.job_number);
  });

  return ops;
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
    // Operators only run internal stations; external/vendor work centers are
    // handled through the routing/job workflow, not picked at the station.
    .eq('kind', 'internal')
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
      jobs!inner(id, job_number, created_at, due_date, customer_po_number, company_id, is_hot, customers(name))
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
      is_hot: boolean;
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
    .select('id, sequence, operation_name, instructions, status, estimated_setup_minutes, estimated_run_minutes_per_unit, work_center_id, work_center:work_centers(name, kind, vendor:vendors(name))')
    .eq('job_part_id', jobPartId)
    .order('sequence', { ascending: true });

  type WcJoin = {
    name: string;
    kind: 'internal' | 'external';
    vendor: { name: string } | { name: string }[] | null;
  };
  type OpRow = {
    id: string;
    sequence: number;
    operation_name: string;
    instructions: string | null;
    status: string;
    estimated_setup_minutes: number | null;
    estimated_run_minutes_per_unit: number | null;
    work_center_id: string | null;
    work_center: WcJoin | WcJoin[] | null;
  };
  const opRows = (ops ?? []) as OpRow[];

  const operations: JobTravelerOperation[] = opRows.map((op) => {
    const wcJoin = Array.isArray(op.work_center) ? op.work_center[0] : op.work_center;
    const vendorJoin = wcJoin
      ? Array.isArray(wcJoin.vendor) ? wcJoin.vendor[0] : wcJoin.vendor
      : null;
    return {
      id: op.id,
      sequence: op.sequence,
      operation_name: op.operation_name,
      instructions: op.instructions,
      work_center_id: op.work_center_id,
      work_center_name: wcJoin?.name ?? null,
      // Null kind (deleted work center, FK ON DELETE SET NULL) reads as non-external.
      work_center_kind: wcJoin?.kind ?? null,
      vendor_name: vendorJoin?.name ?? null,
      status: op.status,
      setup_minutes: Number(op.estimated_setup_minutes) || 0,
      cycle_minutes: Number(op.estimated_run_minutes_per_unit) || 0,
    };
  });

  // How many parts the parent job has — drives the traveler's "all parts" link.
  const { count: jobPartCount } = await supabase
    .from('job_parts')
    .select('id', { count: 'exact', head: true })
    .eq('job_id', p.job_id);

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
    is_hot: jobJoin?.is_hot ?? false,
    job_part_count: jobPartCount ?? 1,
    operations,
  };
}

/**
 * Whole-job parts overview for the operator parts hub: the job header plus every
 * child part with its progress. Used to navigate a multi-part job; single-part
 * jobs skip the hub (the page redirects straight to the traveler).
 */
export async function getJobPartsOverview(
  jobId: string,
  companyId: string,
): Promise<JobPartsOverview | null> {
  const supabase = getSupabase();

  const { data: job, error } = await supabase
    .from('jobs')
    .select('id, job_number, due_date, customers(name)')
    .eq('id', jobId)
    .eq('company_id', companyId)
    .single();
  if (error || !job) return null;

  type JobRow = {
    id: string;
    job_number: string;
    due_date: string | null;
    customers: { name: string } | { name: string }[] | null;
  };
  const j = job as JobRow;
  const customer = Array.isArray(j.customers) ? j.customers[0] : j.customers;

  const { data: partRows } = await supabase
    .from('job_parts')
    .select('id, quantity, production_status, parts(part_name)')
    .eq('job_id', jobId);
  type PartRow = {
    id: string;
    quantity: number;
    production_status: string;
    parts: { part_name: string } | { part_name: string }[] | null;
  };
  const parts = (partRows ?? []) as PartRow[];

  // Per-part progress (ops total + completed).
  const jobPartIds = parts.map((p) => p.id);
  const progressByPart = new Map<string, { total: number; done: number }>();
  if (jobPartIds.length > 0) {
    const { data: ops } = await supabase
      .from('job_operations')
      .select('job_part_id, status')
      .in('job_part_id', jobPartIds);
    for (const op of (ops ?? []) as { job_part_id: string; status: string }[]) {
      const acc = progressByPart.get(op.job_part_id) ?? { total: 0, done: 0 };
      acc.total += 1;
      if (op.status === 'completed') acc.done += 1;
      progressByPart.set(op.job_part_id, acc);
    }
  }

  return {
    job_id: j.id,
    job_number: j.job_number,
    customer_name: customer?.name ?? null,
    due_date: j.due_date,
    parts: parts.map((p) => {
      const partJoin = Array.isArray(p.parts) ? p.parts[0] : p.parts;
      const progress = progressByPart.get(p.id) ?? { total: 0, done: 0 };
      return {
        job_part_id: p.id,
        part_name: partJoin?.part_name ?? null,
        quantity: p.quantity,
        production_status: p.production_status,
        operations_total: progress.total,
        operations_completed: progress.done,
      };
    }),
  };
}

// One read shape backs the whole job feed (traveler read-only + operation page).
// Each note carries its optional step tag (job_operations) and its media so the
// feed renders thumbnails without a second round-trip.
const JOB_NOTE_SELECT =
  'id, subject_kind, job_id, job_operation_id, captured_job_id, ' +
  'captured_job_operation_id, part_id, routing_operation_id, ' +
  'viewer_count, usage_count, body, note_type, created_at, ' +
  'author:user_company_access(name), ' +
  'operation:job_operations!notes_job_operation_fk(operation_name, sequence), ' +
  'captured_operation:job_operations!notes_captured_job_operation_fk(operation_name, sequence), ' +
  'media:note_media(id, note_id, storage_path, thumbnail_path, kind, mime_type, width, height)';

type StepRel =
  | { operation_name: string | null; sequence: number | null }
  | { operation_name: string | null; sequence: number | null }[]
  | null;

type JobNoteRow = {
  id: string;
  subject_kind: string;
  job_id: string | null;
  job_operation_id: string | null;
  captured_job_id: string | null;
  captured_job_operation_id: string | null;
  part_id: string | null;
  routing_operation_id: string | null;
  viewer_count: number;
  usage_count: number;
  body: string | null;
  note_type: string | null;
  created_at: string;
  author: { name: string | null } | { name: string | null }[] | null;
  operation: StepRel;
  captured_operation: StepRel;
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

function stepLabel(rel: StepRel): string | null {
  const op = Array.isArray(rel) ? rel[0] : rel;
  if (!op?.operation_name) return null;
  return op.sequence != null ? `Op ${op.sequence} · ${op.operation_name}` : op.operation_name;
}

function mapJobNoteRow(n: JobNoteRow): JobNote {
  const author = Array.isArray(n.author) ? n.author[0] : n.author;
  // A durable part-subject note carries no job_operation_id — its step is the
  // routing step. Its captured_job_operation_id is what names the step the operator
  // was standing at, so the feed row still reads "Op 20 · Deburr" either way.
  const operationLabel = stepLabel(n.operation) ?? stepLabel(n.captured_operation);
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
    // The job this note belongs to FROM THE FEED'S POINT OF VIEW: its own job for a
    // job-subject note, the capturing job for a durable part-subject one.
    job_id: n.job_id ?? n.captured_job_id ?? '',
    job_operation_id: n.job_operation_id ?? n.captured_job_operation_id,
    operation_label: operationLabel,
    body: n.body,
    note_type: n.note_type === 'event' ? 'event' : 'user',
    created_at: n.created_at,
    author_name: author?.name ?? null,
    subject_kind: n.subject_kind === 'part' || n.subject_kind === 'work_center'
      ? n.subject_kind
      : 'job',
    viewer_count: n.viewer_count,
    usage_count: n.usage_count,
    media,
  };
}

/**
 * The job feed (newest first): one append-only stream per job. Two kinds of row
 * appear here, and the union is the point:
 *
 *   - job-subject notes (job_id) — legacy captures, and anything genuinely about
 *     THIS run only;
 *   - durable part-subject notes captured on this job (captured_job_id) — every
 *     new operator capture. Their subject is (part, routing step), so the next
 *     person running the part reads them without ever touching this job.
 *
 * Filtering on job_id alone would silently drop every new capture from the feed.
 * Both columns are indexed, so the `or` is a bitmap OR, not a scan.
 */
export async function getJobNotes(
  jobId: string,
  companyId: string,
): Promise<JobNote[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('notes')
    .select(JOB_NOTE_SELECT)
    .eq('company_id', companyId)
    .or(`job_id.eq.${jobId},captured_job_id.eq.${jobId}`)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);

  return ((data ?? []) as unknown as JobNoteRow[]).map(mapJobNoteRow);
}

/**
 * Resolve the DURABLE anchor for a step the operator is standing at: the part and
 * the routing (template) step, as opposed to this job's instance of it.
 *
 * Returns null when the job operation has no routing link — an ad-hoc step added
 * to one job has nothing durable to anchor to. That is a real subject difference,
 * not a silent fallback for a data-at-rest problem.
 */
async function resolveDurableAnchor(
  jobOperationId: string,
): Promise<{ partId: string; routingOperationId: string } | null> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('job_operations')
    .select('routing_operation_id, job_part:job_parts(part_id)')
    .eq('id', jobOperationId)
    .single();

  if (!data?.routing_operation_id) return null;
  const jobPart = Array.isArray(data.job_part) ? data.job_part[0] : data.job_part;
  if (!jobPart?.part_id) return null;

  return { partId: jobPart.part_id, routingOperationId: data.routing_operation_id };
}

/**
 * Append a note. `authorId` is the author's user_company_access id (from
 * getCurrentMember); RLS requires it to match the caller's access row — there is
 * no path for anyone to author as someone else.
 *
 * SUBJECT CHOICE, which is the whole point of this workstream. The operator is
 * never asked to classify anything:
 *
 *   - step has a routing link  -> subject_kind 'part', anchored to
 *     (part_id, routing_operation_id), with the capturing job recorded as
 *     PROVENANCE. The note outlives the job, so the next person running this part
 *     reads it from one index hit — no prior-run traversal, no toggle.
 *   - otherwise                -> subject_kind 'job', the old behaviour, because
 *     there is no durable step to anchor to.
 *
 * Either way the note appears in this job's feed (getJobNotes unions both), so
 * nothing is lost at the capture surface.
 *
 * `body` may be null/blank for a media-only note — callers must guarantee
 * body-or-media (a fully empty note is useless); the returned note's `media` is
 * empty until media is attached via addJobNoteMedia.
 *
 * `opts.noteType` defaults to 'user'. Pass 'event' for auto-logged feed entries
 * (e.g. the order-quantity-change audit trail); those are always job-subject,
 * since a machine-generated audit line is not durable part knowledge.
 */
export async function addJobNote(
  jobId: string,
  companyId: string,
  authorId: string,
  body: string | null,
  opts?: {
    jobPartId?: string | null;
    jobOperationId?: string | null;
    noteType?: 'user' | 'event';
  },
): Promise<JobNote> {
  const supabase = getSupabase();

  const trimmed = body?.trim() || null;
  const noteType = opts?.noteType ?? 'user';

  const anchor =
    noteType === 'user' && opts?.jobOperationId
      ? await resolveDurableAnchor(opts.jobOperationId)
      : null;

  const row = anchor
    ? {
        company_id: companyId,
        author_id: authorId,
        body: trimmed,
        note_type: noteType,
        subject_kind: 'part',
        part_id: anchor.partId,
        routing_operation_id: anchor.routingOperationId,
        // Provenance, never subject: keeps the note in this job's feed and lets
        // the card name the step, without tying the knowledge to the job.
        captured_job_id: jobId,
        captured_job_operation_id: opts?.jobOperationId ?? null,
      }
    : {
        company_id: companyId,
        author_id: authorId,
        body: trimmed,
        note_type: noteType,
        subject_kind: 'job',
        job_id: jobId,
        job_part_id: opts?.jobPartId ?? null,
        job_operation_id: opts?.jobOperationId ?? null,
      };

  const { data, error } = await supabase
    .from('notes')
    .insert(row)
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

/** Resolve a step's identity for the RPC's legacy step-name fallback. */
async function getStepIdentity(
  jobOperationId: string,
): Promise<{ routing_operation_id: string | null; operation_name: string } | null> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('job_operations')
    .select('routing_operation_id, operation_name')
    .eq('id', jobOperationId)
    .single();
  return (data as { routing_operation_id: string | null; operation_name: string } | null) ?? null;
}

type PlaybookRow = {
  id: string;
  body: string | null;
  created_at: string;
  note_type: string | null;
  subject_kind: string;
  routing_operation_id: string | null;
  corrects_note_id: string | null;
  viewer_count: number;
  usage_count: number;
  author_name: string | null;
  job_number: string | null;
  operation_label: string | null;
  media: JobNoteMedia[] | null;
  reactions: unknown;
};

/**
 * Everything known about running this part, newest first — accumulated setup
 * tips, gotchas and photos, NOT a list of past jobs. Part-centric and never
 * operator-comparative: no time metrics, no per-person counters.
 *
 * ONE round trip, via the part_playbook_notes RPC. This used to issue up to 22
 * (one for the prior runs, then getJobNotes + a step lookup per run, capped at
 * 10) and sort in JS — slow enough on shop wifi that prior knowledge effectively
 * wasn't there, which is a large part of why seeded notes went unread in the last
 * usability session.
 *
 * Most of what the RPC does is now vestigial: a note written after the subject
 * migration is anchored to (part, routing step) directly, so it comes back from a
 * single index hit. The prior-run walk survives only for pre-migration notes.
 *
 * When `jobOperationId` is given, scopes to that step: by routing step for
 * durable notes, falling back to operation_name for legacy ones.
 */
export async function getPartPreviousNotes(
  partId: string,
  companyId: string,
  opts?: { excludeJobId?: string; jobOperationId?: string; maxRuns?: number },
): Promise<PartPreviousNote[]> {
  const supabase = getSupabase();

  const identity = opts?.jobOperationId
    ? await getStepIdentity(opts.jobOperationId)
    : null;

  const { data, error } = await supabase.rpc('part_playbook_notes', {
    p_part_id: partId,
    p_routing_operation_id: identity?.routing_operation_id ?? undefined,
    p_operation_name: identity?.operation_name ?? undefined,
    p_exclude_job_id: opts?.excludeJobId ?? undefined,
    p_max_runs: opts?.maxRuns ?? 10,
  });

  // companyId is intentionally unused as a filter: the RPC is SECURITY INVOKER, so
  // RLS on notes/jobs/job_parts already scopes it to the caller's companies. A
  // second client-side filter would be a redundant source of truth.
  void companyId;

  if (error || !data) return [];

  return (data as unknown as PlaybookRow[]).map((r) => ({
    id: r.id,
    job_id: '',
    job_operation_id: null,
    operation_label: r.operation_label,
    body: r.body,
    note_type: r.note_type === 'event' ? 'event' : 'user',
    created_at: r.created_at,
    author_name: r.author_name,
    subject_kind:
      r.subject_kind === 'part' || r.subject_kind === 'work_center'
        ? r.subject_kind
        : 'job',
    viewer_count: r.viewer_count,
    usage_count: r.usage_count,
    media: r.media ?? [],
    job_number: r.job_number ?? '',
  }));
}
