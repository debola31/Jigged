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
import { getSupabase } from '@/lib/supabase';
import { friendlyErrorMessage, toFriendlyError } from '@/lib/supabaseErrors';
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
  MyContributionTotals,
  NewHelpful,
  MyNotesPage,
  MyNote,
  NoteViewer,
  NoteReaction,
} from '@/types/operator';

// ============================================================================
// CURRENT USER (the signed-in company member — ANY role)
// ============================================================================

export interface CurrentMember {
  id: string;
  name: string | null;
  user_id: string;
  /**
   * The caller's role in THIS company. Selected here rather than through a second
   * query because every note surface already calls this to resolve `id`, and
   * delete gating needs author-or-admin (#628). `useUserRole` would issue a second
   * round trip for a value that is on the row we are already fetching.
   */
  role: string | null;
  /**
   * Cursor for the "new since you last looked" recognition block — helpful marks at or
   * before this instant have already been surfaced. NULL means never dismissed, which the
   * reader treats as "the recent window", not "everything ever". Selected here rather than
   * in a second query because this row is already being fetched on the surface that needs
   * it. Safe to read stale-by-one-render: the in-flight cache does not outlive a request,
   * so the next call after a dismiss re-reads it.
   */
  reactions_seen_at: string | null;
}

/**
 * IN-FLIGHT lookups only, keyed by company. Entries are dropped the moment they settle.
 *
 * WHY THIS EXISTS. Every call opens with `auth.getSession()`, which `supabase-js`
 * serialises behind a `navigator.locks` acquisition and may refresh the token inside.
 * Mounting the "Me" tab fires three of these in one commit (the identity hook, the totals
 * loader, the first-page loader), so duplicate callers didn't just cost a round trip —
 * they queued against each other on the single lock that gates every other request on the
 * page, which is what the tab's stall actually was. Sharing one flight collapses that to
 * one lock acquisition.
 *
 * WHY IT DOES NOT OUTLIVE THE FLIGHT. A session-length cache of this row is a cross-user
 * data leak waiting to happen, and the app's shape makes it near-certain rather than
 * theoretical: sign-out on the admin surface is `await signOut(); router.replace('/')`
 * (components/layout/Header.tsx) and sign-in is `router.push` — every step a client
 * navigation, so module state survives the whole sign-out/sign-in cycle. A retained entry
 * would hand the next person the previous person's `user_company_access` row on a shared
 * office computer, and this function is what pins `uploaded_by` / `author_id` on writes
 * whose RLS policies require them to match the caller (utils/partAttachmentsAccess.ts,
 * utils/workCenterAttachmentsAccess.ts) and what drives the admin-only delete affordances
 * in FilesTab and JobFeed. Rather than maintain a list of every sign-out path that must
 * remember to invalidate — one forgotten call site is a silent leak — the entry simply
 * never outlives the request it was deduplicating. There is nothing to invalidate.
 *
 * The cost is one lookup per navigation instead of one per session, which is what the
 * code did before the cache existed. The stall was never sequential calls; it was three
 * concurrent ones.
 */
const memberFlights = new Map<string, Promise<CurrentMember | null>>();

/**
 * The signed-in user's user_company_access row for this company — used wherever
 * we need the acting member's account id (job-note author, operation completer,
 * activity attribution). Intentionally NOT role-filtered: operators, users, and
 * admins are all company members, and every one of them can act in the operator
 * view. (There is no separate "operators" table — that legacy table is gone.)
 *
 * Concurrent callers share one request — see `memberFlights`.
 */
export function getCurrentMember(companyId: string): Promise<CurrentMember | null> {
  const inFlight = memberFlights.get(companyId);
  if (inFlight) return inFlight;

  const flight = fetchCurrentMember(companyId).finally(() => {
    memberFlights.delete(companyId);
  });

  memberFlights.set(companyId, flight);
  return flight;
}

async function fetchCurrentMember(companyId: string): Promise<CurrentMember | null> {
  const supabase = getSupabase();

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;

  const { data: member, error } = await supabase
    .from('user_company_access')
    .select('id, name, user_id, role, reactions_seen_at')
    .eq('user_id', session.user.id)
    .eq('company_id', companyId)
    .single();

  // "No row" is a definitive answer: this user is genuinely not a member. ANYTHING ELSE
  // is "couldn't check", and returning null for it tells 29 call sites the opposite of
  // what happened — every operator surface renders as though the person were not on the
  // team. The control flow is unchanged here on purpose (several callers are bare
  // `.then()` with no rejection handler, so throwing would trade a wrong answer for an
  // unhandled rejection); what changes is that the failure stops being SILENT.
  //
  // The case that made this urgent is a schema mismatch, and it is one this repo's own
  // workflow produces: worktree migrations are validated on the PR's Supabase preview
  // branch and deliberately never replayed into the shared local stack, so running this
  // branch against local yields `42703 column user_company_access.reactions_seen_at does
  // not exist` — the whole select 400s and every operator page silently empties.
  if (error && error.code !== 'PGRST116') {
    if (process.env.NODE_ENV !== 'production') {
      console.error(
        `getCurrentMember: the member lookup FAILED (${error.code}: ${error.message}). ` +
          'This is not "not a member" — operator surfaces will render empty. If the code ' +
          'is 42703, the local database is behind the branch: apply the pending migrations ' +
          'or point at the PR preview branch.',
      );
    }
    // No `captureException` here: the Supabase integration (lib/supabase.ts) already reports
    // this select's `{ error }` with the query — including both ids this used to pass as
    // `extra` — and a second capture would just duplicate the issue. See #708.
    return null;
  }

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
  /**
   * A timer is still open on this operation at this station.
   *
   * The THIRD reason a step can be on this list, alongside "sequence-ready" and
   * "has quantity recorded". It is its own flag rather than folded into
   * `op_status` because op status derives from recorded quantity — a step
   * somebody started but has produced nothing on is `pending`, correctly, and
   * before 20260826010648 that plus being out of sequence hid it from every
   * operator surface at once.
   */
  has_open_interval: boolean;
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
 * (job, job_part) pair whose operation at this station is sequence-ready, has
 * quantity recorded against it, or has a timer still open.
 *
 * That third case is not a nicety. Op status derives from recorded quantity, so
 * a step somebody started but has produced nothing on reads `pending`; if it is
 * also out of sequence — which starting permits, deliberately — it used to
 * appear on NO operator surface, while the office Still-running card showed it.
 * And the station list is the only place an abandoned interval can be cleared
 * from: `close_operation_interval` refuses a non-owner, so the recovery is to
 * start on the same work centre and let the chain close it as `switched`.
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
      has_open_interval: row.has_open_interval,
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
        // The completed list does not compute this. A completed step CAN still
        // carry an open interval (an office-side completion closes none), but
        // this list exists to undo a mis-tapped completion, and marking a row
        // "running" in a list headed "Completed" states a contradiction the
        // operator has no control to resolve. The office Still-running card is
        // where that combination is meant to be noticed.
        has_open_interval: false,
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
    .select('id, job_part_id, operation_name, status, instructions, sent_at, estimated_setup_minutes, estimated_run_minutes_per_unit, work_center_id, vendor_service_id, work_center:work_centers(name), vendor_service:vendor_services(name, vendor:vendors(name))')
    .eq('id', jobOperationId)
    .single();

  if (error || !op) return null;

  const header = await loadPartHeader(op.job_part_id, companyId);
  if (!header) return null; // not this company's job

  type WcJoin = { name: string };
  type VsJoin = { name: string; vendor: { name: string } | { name: string }[] | null };
  const wcJoin = (Array.isArray(op.work_center) ? op.work_center[0] : op.work_center) as WcJoin | null;
  const vsJoin = (Array.isArray(op.vendor_service) ? op.vendor_service[0] : op.vendor_service) as VsJoin | null;
  const vendorJoin = vsJoin
    ? Array.isArray(vsJoin.vendor) ? vsJoin.vendor[0] : vsJoin.vendor
    : null;
  const currentOp: CurrentOpForDetail = {
    id: op.id,
    operation_name: op.operation_name,
    status: op.status,
    instructions: op.instructions,
    estimated_setup_minutes: op.estimated_setup_minutes,
    estimated_run_minutes_per_unit: op.estimated_run_minutes_per_unit,
    work_center_id: op.work_center_id,
    // The service's name when this is outside work — so the phone shows
    // "Anodize", not the plater's legal name.
    work_center_name: vsJoin?.name ?? wcJoin?.name ?? null,
    // Kept as the 'external' | 'internal' string the operator pages already
    // branch on, but derived from the column rather than a joinable kind.
    work_center_kind: op.vendor_service_id ? 'external' : 'internal',
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
    .select('id, job_id, job_part_id, status, sent_at, vendor_service_id, jobs!inner(company_id), vendor_service:vendor_services(vendor:vendors(name))')
    .eq('id', jobOperationId)
    .single();
  if (error || !data) throw new Error('Operation not found.');

  type VendorRel = { name: string } | { name: string }[] | null;
  type Row = {
    id: string;
    job_id: string;
    job_part_id: string;
    status: string;
    sent_at: string | null;
    vendor_service_id: string | null;
    jobs: { company_id: string } | { company_id: string }[] | null;
    vendor_service: { vendor: VendorRel } | { vendor: VendorRel }[] | null;
  };
  const row = data as unknown as Row;
  const job = Array.isArray(row.jobs) ? row.jobs[0] : row.jobs;
  const vs = Array.isArray(row.vendor_service) ? row.vendor_service[0] : row.vendor_service;
  const vendor = vs ? (Array.isArray(vs.vendor) ? vs.vendor[0] : vs.vendor) : null;

  return {
    id: row.id,
    job_id: row.job_id,
    job_part_id: row.job_part_id,
    company_id: job?.company_id ?? '',
    status: row.status,
    sent_at: row.sent_at,
    // The column, not a joined kind: an op is outside work iff it targets a
    // service. Unlike the old join this cannot read NULL for a row that is.
    is_external: Boolean(row.vendor_service_id),
    vendor_name: vendor?.name ?? null,
  };
}

/**
 * Throw when a write failed, instead of continuing as though it hadn't.
 *
 * postgrest-js RESOLVES with `{ error }` rather than rejecting, so `await supabase.from(…)
 * .update(…)` with nothing destructured discards every failure. Several operator actions did
 * exactly that and then returned `{ success: true }` — the shop floor was told the work was
 * recorded while the row sat untouched. A lapsed subscription is one way to hit it (RLS blocks
 * the write), but so is any constraint or policy failure.
 *
 * Matching zero rows is NOT a failure here: several of these updates carry a deliberate `.not(…)`
 * guard that legitimately matches nothing. Only a real `error` throws.
 */
function assertWrote(error: unknown, entity: string, fallback: string): void {
  if (error) throw toFriendlyError(error, { entity, fallback });
}

/**
 * Move a job_part to 'in_progress' because work on it has begun. The guard skips
 * parts already in_progress/completed/cancelled, leaving their started_at
 * untouched. Shared by complete, receive, and send (all are "work has begun").
 */
async function movePartToInProgress(jobPartId: string, now: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('job_parts')
    .update({
      production_status: 'in_progress',
      started_at: now,
      status_changed_at: now,
      updated_at: now,
    })
    .eq('id', jobPartId)
    .not('production_status', 'in', '("in_progress","completed","cancelled")');
  assertWrote(error, 'part', 'Failed to update the part status.');
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
    const { error } = await supabase
      .from('job_parts')
      .update({
        production_status: 'completed',
        completed_at: now,
        status_changed_at: now,
        updated_at: now,
      })
      .eq('id', jobPartId)
      .not('production_status', 'in', '("cancelled")');
    assertWrote(error, 'part', 'Failed to update the part status.');
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

  const { error: sendError } = await supabase
    .from('job_operations')
    .update({ status: 'sent', sent_at: now, sent_by: user?.id ?? null })
    .eq('id', jobOperationId);
  assertWrote(sendError, 'operation', 'Failed to mark the operation sent out.');

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

  // Checked, not fire-and-forget. postgrest-js RESOLVES with `{ error }` rather than rejecting,
  // so an un-destructured `await` swallows every failure silently — this reported
  // `{ success: true }` and told the operator the vendor work was back while the row was
  // untouched. A lapsed subscription is one way to hit it; so is any RLS or constraint failure.
  const { error: updateError } = await supabase
    .from('job_operations')
    .update(update)
    .eq('id', jobOperationId);
  if (updateError) {
    throw toFriendlyError(updateError, {
      entity: 'operation',
      fallback: 'Failed to mark the operation received.',
    });
  }

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

    let stepBackError: unknown = null;
    if (op.status === 'completed' && op.sent_at) {
      // Received → back to sent (parts are still out); keep sent_at/by.
      ({ error: stepBackError } = await supabase
        .from('job_operations')
        .update({ status: 'sent', completed_at: null, completed_by: null })
        .eq('id', jobOperationId));
    } else if (op.status === 'sent') {
      // Un-send → back to pending; clear the send stamp.
      ({ error: stepBackError } = await supabase
        .from('job_operations')
        .update({ status: 'pending', sent_at: null, sent_by: null })
        .eq('id', jobOperationId));
    } else {
      // Legacy external completed op that never went through send → pending.
      ({ error: stepBackError } = await supabase
        .from('job_operations')
        .update({ status: 'pending', completed_at: null, completed_by: null, sent_at: null, sent_by: null })
        .eq('id', jobOperationId));
    }
    assertWrote(stepBackError, 'operation', 'Failed to undo the operation.');

    const { data: stillCompleted } = await supabase
      .from('job_operations')
      .select('id')
      .eq('job_part_id', op.job_part_id)
      .eq('status', 'completed');

    const hasCompleted = !!stillCompleted && stillCompleted.length > 0;

    const { error: rollbackError } = await supabase
      .from('job_parts')
      .update({
        production_status: hasCompleted ? 'in_progress' : 'not_started',
        completed_at: null,
        status_changed_at: now,
        updated_at: now,
      })
      .eq('id', op.job_part_id)
      .not('production_status', 'in', '("cancelled")');
    assertWrote(rollbackError, 'part', 'Failed to undo the operation.');
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
      vendor_service:vendor_services!inner(name, vendor:vendors(id, name)),
      job_part:job_parts!inner(parts(part_name)),
      jobs!inner(job_number, due_date, is_hot, company_id, production_status, deleted_at)
    `)
    .eq('jobs.company_id', companyId)
    .is('jobs.deleted_at', null)
    .neq('jobs.production_status', 'cancelled')
    // The !inner join on vendor_services IS the "outside op" filter — only an
    // outside op has one. The .eq('work_center.kind','external') it replaces is
    // gone with the column.
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
    vendor_service: OneOrMany<{ name: string; vendor: OneOrMany<{ id: string; name: string }> }>;
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
    const vs = first(r.vendor_service);
    const vendor = vs ? first(vs.vendor) : null;
    const part = first(first(r.job_part)?.parts ?? null);
    const job = first(r.jobs);
    return {
      id: r.id,
      job_id: r.job_id,
      job_part_id: r.job_part_id,
      job_number: job?.job_number ?? '',
      part_name: part?.part_name ?? null,
      operation_name: r.operation_name,
      vendor_id: vendor?.id ?? null,
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
    // No kind filter any more, and none is possible: every work_centers row is
    // an in-house station now. Outsourced processes are vendor_services, a
    // different table an operator can never be standing at. This also closes an
    // old leak — getStationName never had the kind filter this query did, so a
    // stale external id in localStorage used to resolve to a usable station.
    // Archived machines are gone from the shop's point of view. Without this the
    // picker offers a machine nobody can be standing at, and selecting one is
    // unrecoverable from the floor.
    .is('deleted_at', null)
    .order('name');

  if (error) throw new Error(error.message);

  return (data || []).map((wc: { id: string; name: string }) => ({
    id: wc.id,
    name: wc.name,
  }));
}

/**
 * Resolve a station's display name within a company, or null when that company
 * has no live machine with that id.
 *
 * Filters `deleted_at` even though it is a by-id read, which is the opposite of
 * the usual rule. The distinction is what the read is FOR: a detail page or a
 * document's retained FK is resolving history and must still render, but this
 * call is VALIDATING A PERSISTED SELECTION. A null answer is the signal that the
 * stored station no longer names anywhere an operator can stand, and the caller
 * drops them back to the picker rather than leaving them on a ghost machine.
 *
 * `companyId` is REQUIRED, and RLS is not a substitute for it. One user can hold
 * access to several companies, so a work center from the company they were in a
 * minute ago reads back perfectly well — this filter is the only thing that
 * turns "a machine you may read" into "a machine you are standing at HERE". Not
 * having it is how a station selected in one company survived a company switch:
 * the name resolved, so the stale selection looked healthy, and the first note
 * saved against it died in the `notes_validate_subject()` trigger with
 * "work center … is not in company …".
 *
 * Throws on a query failure so the caller can tell "this machine is not here"
 * (null) apart from "the network is down" (throw) — the first should clear the
 * stored station, the second must never touch it.
 */
export async function getStationName(
  stationId: string,
  companyId: string,
): Promise<string | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('work_centers')
    .select('name')
    .eq('id', stationId)
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) throw new Error(error.message);

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
    .select('id, sequence, operation_name, instructions, status, estimated_setup_minutes, estimated_run_minutes_per_unit, work_center_id, vendor_service_id, work_center:work_centers(name), vendor_service:vendor_services(name, vendor:vendors(name))')
    .eq('job_part_id', jobPartId)
    .order('sequence', { ascending: true });

  type WcJoin = { name: string };
  type VsJoin = { name: string; vendor: { name: string } | { name: string }[] | null };
  type OpRow = {
    id: string;
    sequence: number;
    operation_name: string;
    instructions: string | null;
    status: string;
    estimated_setup_minutes: number | null;
    estimated_run_minutes_per_unit: number | null;
    work_center_id: string | null;
    vendor_service_id: string | null;
    work_center: WcJoin | WcJoin[] | null;
    vendor_service: VsJoin | VsJoin[] | null;
  };
  const opRows = (ops ?? []) as OpRow[];

  const operations: JobTravelerOperation[] = opRows.map((op) => {
    const wcJoin = Array.isArray(op.work_center) ? op.work_center[0] : op.work_center;
    const vsJoin = Array.isArray(op.vendor_service) ? op.vendor_service[0] : op.vendor_service;
    const vendorJoin = vsJoin
      ? Array.isArray(vsJoin.vendor) ? vsJoin.vendor[0] : vsJoin.vendor
      : null;
    return {
      id: op.id,
      sequence: op.sequence,
      operation_name: op.operation_name,
      instructions: op.instructions,
      work_center_id: op.work_center_id,
      // The SERVICE's name for outside steps. This is what the printed
      // traveler puts in the Work Center column, and it is the fix for a
      // traveler that used to read 'PerformCoat of Michigan LLC' where it
      // should say 'Anodize'.
      work_center_name: vsJoin?.name ?? wcJoin?.name ?? null,
      work_center_kind: op.vendor_service_id ? 'external' : 'internal',
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
  'viewer_count, usage_count, body, note_type, created_at, edited_at, ' +
  'author_id, author:user_company_access(name), ' +
  // Reactions embed because they are PUBLIC within the shop — the deliberate
  // opposite of note_views, which has no client read path at any level. Count and
  // names both derive from this one array, so they can never disagree; that is
  // why no denormalized reaction counter exists.
  'reactions:note_reactions(kind, reactor_id, reactor:user_company_access(name)), ' +
  'operation:job_operations!notes_job_operation_fk(operation_name, sequence), ' +
  'captured_operation:job_operations!notes_captured_job_operation_fk(operation_name, sequence), ' +
  'media:note_media(id, note_id, storage_path, thumbnail_path, kind, mime_type, width, height, duration_seconds)';

export type ReactionRel = {
  kind: string;
  reactor_id: string;
  reactor: { name: string | null } | { name: string | null }[] | null;
};

/**
 * Shared decode for every read path that carries reactions — the PostgREST
 * embed, the playbook RPC's jsonb, and the machine log. Exported so the machine
 * surface decodes reactions the same way rather than growing a second copy that
 * could drift on the `confirmed` branch.
 */
export function mapReactions(rows: ReactionRel[] | null | undefined): NoteReaction[] {
  return (rows ?? []).map((r) => {
    const reactor = Array.isArray(r.reactor) ? r.reactor[0] : r.reactor;
    return {
      kind: r.kind === 'confirmed' ? ('confirmed' as const) : ('helpful' as const),
      reactor_id: r.reactor_id,
      name: reactor?.name ?? null,
    };
  });
}

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
  edited_at: string | null;
  author_id: string | null;
  author: { name: string | null } | { name: string | null }[] | null;
  reactions: ReactionRel[] | null;
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
    author_id: n.author_id,
    reactions: mapReactions(n.reactions),
    // The job this note belongs to FROM THE FEED'S POINT OF VIEW: its own job for a
    // job-subject note, the capturing job for a durable part-subject one.
    job_id: n.job_id ?? n.captured_job_id ?? '',
    job_operation_id: n.job_operation_id ?? n.captured_job_operation_id,
    operation_label: operationLabel,
    body: n.body,
    note_type: n.note_type === 'event' ? 'event' : 'user',
    created_at: n.created_at,
    edited_at: n.edited_at,
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

/**
 * Edit the body of a note you wrote (#628).
 *
 * ONE function for every `notes` surface. The job feed, the Playbook sheet, My work
 * and the machine logbook are four READ shapes over one table; a second update
 * function would be a second place for the blank-body rule to drift out of step.
 *
 * WHAT THIS CANNOT DO, and it is structural rather than a convention here: the
 * browser holds `GRANT UPDATE (body)` and nothing else, so `viewer_count`,
 * `usage_count`, `author_id`, `note_type`, `maintenance_kind`, `resolves_note_id`
 * and every subject column are unwritable — not merely "not written by this
 * function". Editing therefore NEVER resets a note's reach. That is deliberate:
 * a resettable counter would hand an author a timed read-oracle on their own notes
 * (see the migration header and docs/modules/operator-view.md). The honesty cost of
 * keeping the count is carried by `edited_at` and the "· edited" marker instead.
 *
 * `edited_at` is likewise absent from the payload — the database stamps it in a
 * BEFORE UPDATE trigger, and only when the body actually changed, so a no-op
 * re-save leaves the note unmarked.
 *
 * `body` may be null for a media-only note (the `notes_body_blank_or_null` CHECK
 * permits NULL but not blank), so blank normalises to null here. Callers must
 * refuse an empty body on a note with no media — an empty note is a delete, and
 * the UI offers that instead.
 *
 * Returns only the two columns that can have changed. Every caller already holds
 * the note it is editing, so patching `{ body, edited_at }` into it is cheaper and
 * less error-prone than re-selecting one of four different embed shapes here.
 */
export async function updateNoteBody(
  noteId: string,
  body: string | null,
): Promise<{ body: string | null; edited_at: string | null }> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('notes')
    .update({ body: body?.trim() || null })
    .eq('id', noteId)
    .select('body, edited_at')
    .single();

  if (error) {
    throw new Error(
      friendlyErrorMessage(error, {
        entity: 'note',
        fallback: 'Could not save that change.',
      }),
    );
  }

  return data as { body: string | null; edited_at: string | null };
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
  edited_at: string | null;
  note_type: string | null;
  subject_kind: string;
  routing_operation_id: string | null;
  corrects_note_id: string | null;
  viewer_count: number;
  usage_count: number;
  author_id: string | null;
  author_name: string | null;
  job_number: string | null;
  operation_label: string | null;
  media: JobNoteMedia[] | null;
  // The RPC aggregates these as jsonb with the same field names the PostgREST
  // embed produces, so mapReactions decodes both paths.
  reactions: ReactionRel[] | null;
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
/**
 * How many previous notes exist for this part — for the count on the operator's
 * "Previous notes" affordance.
 *
 * Deliberately the SAME RPC the sheet reads, counted server-side via
 * `head: true, count: 'exact'`, so no rows cross the wire. Counting a different
 * source (say, part-subject notes only) would be cheaper but would drift from
 * what the sheet actually shows — and a badge that disagrees with the list is
 * worse than no badge, because it teaches operators the number is noise.
 *
 * Unscoped by step on purpose: the affordance opens at "All part" scope, so the
 * count must describe what they will land on.
 *
 * Returns 0 rather than throwing. This is decoration on a hot path — an operator
 * must never lose the op card because a count failed.
 */
export async function countPartPreviousNotes(
  partId: string,
  opts?: { excludeJobId?: string; maxRuns?: number },
): Promise<number> {
  const supabase = getSupabase();

  const { count, error } = await supabase.rpc(
    'part_playbook_notes',
    {
      p_part_id: partId,
      p_exclude_job_id: opts?.excludeJobId ?? undefined,
      p_max_runs: opts?.maxRuns ?? 10,
    },
    { head: true, count: 'exact' },
  );

  if (error) return 0;
  return count ?? 0;
}

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
    edited_at: r.edited_at,
    author_name: r.author_name,
    author_id: r.author_id,
    reactions: mapReactions(r.reactions),
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

// ============================================================================
// MY WORK — the operator's own contribution, and its reception
// ============================================================================

/**
 * How many of the caller's own notes load at a time on the "Me" tab.
 *
 * Ten, where the completed-jobs list above uses fifty, because the two caps are
 * solving different problems. That one is bounding a query; this one is bounding
 * a SCROLL — "Give feedback" sits under this list, and the whole point of paging
 * it is that the end of the page stays about a screen away on a phone. Fifty
 * blurred cards would page the query and still bury the button.
 */
export const MY_NOTES_PAGE_SIZE = 10;

/**
 * The totals on the "Me" tab's summary card.
 *
 * A SEPARATE QUERY FROM THE LIST, deliberately. These used to be reduced from the
 * fetched note rows, which was only honest while the list was unbounded. Once the
 * list pages, deriving them from the loaded rows would mean the operator's note
 * count climbed every time they tapped Show more — a number about the UI wearing
 * the label of a number about their work.
 *
 * Two columns and one embed, against the seven relations the list select needs:
 * this exists to be cheap enough to run alongside the first page. `photoCount`
 * needs the media rows counted per note, and `peopleReached` needs each row's
 * viewer_count summed; neither is expressible as a PostgREST `count`.
 */
export async function getMyContributionTotals(
  companyId: string,
): Promise<MyContributionTotals> {
  const supabase = getSupabase();

  const empty: MyContributionTotals = { noteCount: 0, photoCount: 0, peopleReached: 0 };

  const member = await getCurrentMember(companyId);
  if (!member) return empty;

  const { data, error } = await supabase
    .from('notes')
    .select('viewer_count, media:note_media(id)')
    .eq('company_id', companyId)
    .eq('author_id', member.id)
    // Auto-logged entries are not somebody's contribution.
    .eq('note_type', 'user');

  // THROW, don't return zeroes. A failed count and a genuine zero are different
  // facts, and rendering the first as the second tells an operator their notes are
  // gone. The caller has an error state; give it something to show.
  if (error) {
    throw new Error(
      friendlyErrorMessage(error, {
        entity: 'note',
        fallback: 'Could not load your work.',
      }),
    );
  }
  if (!data) return empty;

  const rows = data as unknown as Array<{
    viewer_count: number;
    media: Array<{ id: string }> | null;
  }>;

  return {
    noteCount: rows.length,
    photoCount: rows.reduce((n, r) => n + (r.media ?? []).length, 0),
    // Summed rather than distinct, and labelled "views" in the UI for exactly
    // that reason: the per-note numbers it adds up are visible right below it.
    // Distinct people across all notes would need the view rows, which are
    // deliberately unreadable by any browser role.
    peopleReached: rows.reduce((n, r) => n + r.viewer_count, 0),
  };
}

/**
 * What the caller has written, and how far it has travelled — one page of it.
 *
 * This is the return half of the loop: an operator writes something down and,
 * without this, nothing ever comes back. The login banner says "3 people used
 * your notes this week" and until now had nowhere to go.
 *
 * WHAT IT DELIBERATELY DOES NOT RETURN. No completion count, no streak, no
 * average, nothing comparable against another person. A contribution screen is
 * exactly where a leaderboard wants to grow, and the shop-floor guardrail is
 * that no operator-facing surface ever reflects their pace or standing back at
 * them. Their own output and its reception, nothing else.
 *
 * viewer_count and usage_count are columns on the row, so a page is one round
 * trip — no per-note count queries.
 *
 * PAGED SINCE #6xx. This used to fetch every note the operator had ever written,
 * with all seven embeds, and render the lot. It was the only operator screen
 * putting a `backdrop-filter` card inside an uncapped `.map()`, so the cost grew
 * without bound in both the query and the compositor. `hasMore` is derived from a
 * full page coming back rather than from a count, matching the activity feed.
 */
export async function getMyNotesPage(
  companyId: string,
  { offset = 0, limit = MY_NOTES_PAGE_SIZE }: { offset?: number; limit?: number } = {},
): Promise<MyNotesPage> {
  const supabase = getSupabase();

  const member = await getCurrentMember(companyId);
  const empty: MyNotesPage = { notes: [], hasMore: false };
  if (!member) return empty;

  const { data, error } = await supabase
    .from('notes')
    .select(
      'id, body, created_at, edited_at, viewer_count, usage_count, maintenance_kind, ' +
        'part:parts(part_name), ' +
        // The machine, for maintenance entries. Those are `notes` rows too
        // (subject_kind='work_center'), so they land in this list like anything else the
        // operator wrote — but they carry no part, no operation and no job, so without
        // this they rendered as a bare sentence with nothing saying what it was about.
        'work_center:work_centers!notes_work_center_fk(name), ' +
        // Read-only here: RLS forbids reacting to your own note, so on My work
        // these are reception rather than an available action.
        'reactions:note_reactions(kind, reactor_id, reactor:user_company_access(name)), ' +
        // Both job FKs: a job-subject note carries job_id, a durable
        // part-subject one carries only captured_job_id. Either way the author
        // gets a way back to where they wrote it.
        'job:jobs!notes_job_fk(id, job_number), ' +
        'captured_job:jobs!notes_captured_job_fk(id, job_number), ' +
        'media:note_media(id)',
    )
    .eq('company_id', companyId)
    .eq('author_id', member.id)
    // Auto-logged entries are not somebody's contribution.
    .eq('note_type', 'user')
    // `id` breaks ties: two notes saved in the same millisecond would otherwise
    // sort unstably between pages, which is how a row goes missing or repeats.
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1);

  // THROW rather than resolving to an empty page. Swallowing this is worse here than
  // anywhere else in the file: an empty page reads as `hasMore: false`, which retires
  // the Show more button, so a single dropped request on a flaky shop connection made
  // every remaining note look deleted — with no error and no way back short of leaving
  // the tab. The caller's catch is what shows the retry, and it can only fire if this
  // rejects.
  if (error) {
    throw new Error(
      friendlyErrorMessage(error, {
        entity: 'note',
        fallback: 'Could not load your notes.',
      }),
    );
  }
  if (!data) return empty;

  type Row = {
    id: string;
    body: string | null;
    created_at: string;
    edited_at: string | null;
    viewer_count: number;
    usage_count: number;
    maintenance_kind: string | null;
    part: { part_name: string | null } | { part_name: string | null }[] | null;
    work_center: { name: string | null } | { name: string | null }[] | null;
    reactions: ReactionRel[] | null;
    job: JobRel;
    captured_job: JobRel;
    media: Array<{ id: string }> | null;
  };

  type JobRel = { id: string; job_number: string } | { id: string; job_number: string }[] | null;
  const oneJob = (rel: JobRel) => (Array.isArray(rel) ? rel[0] : rel) ?? null;

  const notes: MyNote[] = (data as unknown as Row[]).map((r) => {
    const part = Array.isArray(r.part) ? r.part[0] : r.part;
    const workCenter = Array.isArray(r.work_center) ? r.work_center[0] : r.work_center;
    const job = oneJob(r.job) ?? oneJob(r.captured_job);
    return {
      id: r.id,
      body: r.body,
      created_at: r.created_at,
      edited_at: r.edited_at,
      job_id: job?.id ?? null,
      job_number: job?.job_number ?? null,
      part_name: part?.part_name ?? null,
      machine_name: workCenter?.name ?? null,
      maintenance_kind: r.maintenance_kind,
      photo_count: (r.media ?? []).length,
      reactions: mapReactions(r.reactions),
      viewer_count: r.viewer_count,
      usage_count: r.usage_count,
    };
  });

  // A full page means there is probably another one; a short page means there
  // certainly isn't. Same rule the activity feed uses. It can show Show more once
  // on an exact multiple of the page size, which costs one empty fetch and is
  // preferable to paying for an exact count on every page.
  return { notes, hasMore: notes.length === limit };
}

/**
 * Who read one of YOUR notes. Authors only.
 *
 * Enforced in note_viewers() itself, not here: the caller must be the note's
 * author, and note_views has no client read path at all, so this is the single
 * narrow window through which any name is ever exposed. One row per person
 * however many jobs they used it on, ordered by name and carrying no timestamp
 * — an author must not be able to infer who read it first.
 */
export async function getNoteViewers(noteId: string): Promise<NoteViewer[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('note_viewers', { p_note_id: noteId });
  if (error || !data) return [];
  return data as unknown as NoteViewer[];
}


// ============================================================================
// REACTIONS — public, attributable endorsement
// ============================================================================

/**
 * Mark a note helpful, or take it back.
 *
 * The deliberate opposite of view logging. A view is involuntary and private —
 * a record that someone needed to look something up, which is why note_views has
 * no client read path at all. A reaction is a voluntary claim, so it is public
 * inside the shop, attributable by name, and removable only by the person who
 * made it (admins cannot curate the record of what the shop found useful).
 *
 * Everything that could go wrong is refused by RLS rather than trusted here:
 * you cannot forge someone else's reactor_id, and you cannot react to your own
 * note. The UI hides the control on your own notes so the refusal is never
 * reached — see NoteReactions — but the database is the enforcement.
 *
 * Errors are thrown, not swallowed: unlike view logging (fire-and-forget,
 * Sentry-only), a reaction is a deliberate act and the caller rolls back its
 * optimistic state if it fails.
 */
export async function addReaction(
  companyId: string,
  noteId: string,
  kind: NoteReaction['kind'] = 'helpful',
): Promise<void> {
  const supabase = getSupabase();

  const member = await getCurrentMember(companyId);
  if (!member) throw new Error('Not a member of this company.');

  const { error } = await supabase.from('note_reactions').insert({
    company_id: companyId,
    note_id: noteId,
    reactor_id: member.id,
    kind,
  });

  // A duplicate is the unique constraint doing its job — two taps racing, or a
  // second device. The end state is what the caller asked for, so it is not an
  // error to report.
  if (error && error.code !== '23505') {
    throw new Error(
      friendlyErrorMessage(error, { entity: 'reaction', fallback: 'Could not save that.' }),
    );
  }
}

/** Remove your own reaction. The DELETE policy scopes this to the caller. */
export async function removeReaction(
  companyId: string,
  noteId: string,
  kind: NoteReaction['kind'] = 'helpful',
): Promise<void> {
  const supabase = getSupabase();

  const member = await getCurrentMember(companyId);
  if (!member) throw new Error('Not a member of this company.');

  const { error } = await supabase
    .from('note_reactions')
    .delete()
    .eq('note_id', noteId)
    .eq('reactor_id', member.id)
    .eq('kind', kind);

  if (error) {
    throw new Error(
      friendlyErrorMessage(error, { entity: 'reaction', fallback: 'Could not undo that.' }),
    );
  }
}

// ============================================================================
// NEW RECOGNITION — "helpful" marks the author has not been shown yet
// ============================================================================

/**
 * How far back a reaction can be and still count as NEW.
 *
 * Not a display duration — the block stays on screen until the operator dismisses it.
 * This bounds ELIGIBILITY, so somebody back from six months off is not greeted by a
 * wall of history, and so a reaction that aged out while they were away simply lives on
 * its note instead of arriving as stale news.
 *
 * Eight weeks because that is roughly where the measured effect of a first endorsement
 * has decayed (Wachs et al.: 12.9% at first, 7.7% by eight weeks, 6.4% by twelve).
 */
export const NEW_HELPFUL_WINDOW_DAYS = 56;

/** Names shown before the rest collapse to "and N more". */
export const MAX_HELPFUL_NAMES = 3;

/**
 * "Helpful" marks on the caller's own notes that they have not been shown yet.
 *
 * GROUPED BY NOTE, because the note is the unit of recognition and the reactors are its
 * audience. Three people marking one note is one item naming three people, not three
 * items — several individuals re-described as a single coherent audience is what keeps
 * the signal at single-target strength rather than fading (Västfjäll et al. 2014), and
 * it is also the only shape that satisfies the rule that reactions never sum per person.
 *
 * DERIVED FROM LIVE ROWS, never a stored notification. A colleague can take a mark back,
 * and a snapshot taken at delivery time would outlive its own truth — the operator would
 * be thanked for something that no longer exists. Reading through means a retracted
 * reaction simply stops appearing, and it is also why no "still valid?" expiry rule is
 * needed: a nine-month-old reaction is as true as a new one while its row is there.
 *
 * Self-reactions cannot occur — the RLS INSERT policy forbids reacting to your own note —
 * so there is no author filter to write here.
 */
export async function getNewHelpful(companyId: string): Promise<NewHelpful[]> {
  const supabase = getSupabase();

  const member = await getCurrentMember(companyId);
  if (!member) return [];

  const windowStart = new Date(Date.now() - NEW_HELPFUL_WINDOW_DAYS * 86_400_000);
  // NULL cursor means "never dismissed", which is NOT the epoch: it means show the recent
  // window rather than every reaction ever received.
  //
  // THE CURSOR IS FORWARDED AS THE RAW STRING, never re-serialised through a Date. Postgres
  // keeps timestamptz to the microsecond and JS Date only to the millisecond, so
  // `new Date('…:36.836237Z').toISOString()` sends `…:36.836Z` — 237µs early. The cursor is
  // set to the newest reaction ACTUALLY SHOWN, so that reaction's own `created_at` equals
  // the cursor exactly; truncating makes it compare strictly greater and it returns as
  // "new" on every load, for ever. Observed on the preview: one note stuck in the block
  // through a dismissal, a reload and a fresh session.
  //
  // The window comparison below still goes through Date, which is fine — it decides only
  // whether an 8-week-old cursor beats the window, where a millisecond cannot matter.
  const since =
    member.reactions_seen_at && new Date(member.reactions_seen_at) > windowStart
      ? member.reactions_seen_at
      : windowStart.toISOString();

  // The reactor hint is the FK's real name, not PostgREST's `<table>_<col>_fkey` default:
  // this schema names newer constraints `<table>_<col>_fk` and older ones `_fkey`, so the
  // name has to be looked up rather than guessed. A wrong hint is a 400 on every call.
  const { data, error } = await supabase
    .from('note_reactions')
    .select(
      'created_at, kind, ' +
        'reactor:user_company_access!note_reactions_reactor_fk(name), ' +
        'note:notes!inner(id, body, author_id, ' +
        'job:jobs!notes_job_fk(job_number), ' +
        'captured_job:jobs!notes_captured_job_fk(job_number), ' +
        'work_center:work_centers!notes_work_center_fk(name))',
    )
    .eq('company_id', companyId)
    .eq('kind', 'helpful')
    .eq('note.author_id', member.id)
    .gt('created_at', since)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(
      friendlyErrorMessage(error, {
        entity: 'reaction',
        fallback: 'Could not load what came back.',
      }),
    );
  }

  type Row = {
    created_at: string;
    reactor: { name: string | null } | { name: string | null }[] | null;
    note: {
      id: string;
      body: string | null;
      job: { job_number: string } | { job_number: string }[] | null;
      captured_job: { job_number: string } | { job_number: string }[] | null;
      work_center: { name: string | null } | { name: string | null }[] | null;
    };
  };
  const one = <T,>(rel: T | T[] | null): T | null =>
    (Array.isArray(rel) ? rel[0] : rel) ?? null;

  // Rows arrive newest-first, so first-seen order per note is already newest-first and
  // the first row for a note carries its latest_at.
  const byNote = new Map<string, NewHelpful>();
  for (const r of (data ?? []) as unknown as Row[]) {
    const existing = byNote.get(r.note.id);
    const name = one(r.reactor)?.name;
    if (existing) {
      if (name) existing.names.push(name);
      continue;
    }
    byNote.set(r.note.id, {
      note_id: r.note.id,
      body: r.note.body,
      reference:
        one(r.note.work_center)?.name ??
        one(r.note.job)?.job_number ??
        one(r.note.captured_job)?.job_number ??
        null,
      names: name ? [name] : [],
      latest_at: r.created_at,
    });
  }

  return [...byNote.values()];
}

/**
 * Advance the caller's "I have seen these" cursor.
 *
 * Takes the newest reaction actually SHOWN rather than defaulting to now(), so a
 * reaction landing between render and the tap is not marked seen without ever having
 * been on screen. Dismissing moves this cursor and destroys nothing: every reaction
 * remains on its note in the list below, forever. That separation is deliberate — this
 * shop has already lost recognition once to a control where the nag and the reward were
 * the same object.
 */
export async function markHelpfulSeen(companyId: string, seenThrough: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc('mark_reactions_seen', {
    p_company_id: companyId,
    p_seen_through: seenThrough,
  });
  if (error) {
    throw new Error(
      friendlyErrorMessage(error, { entity: 'reaction', fallback: 'Could not save that.' }),
    );
  }
}
