/**
 * Operator cycle-time capture (job_operation_intervals).
 *
 * WHY THIS FILE IS MOSTLY `.rpc()` AND NOT `.from()`, which is a deviation from
 * the Supabase-first default worth stating once: starting an interval has to
 * close whatever was open at the same work centre, and that row may belong to a
 * DIFFERENT operator — the shift handoff, where B starts on the machine A forgot
 * to close, is the routine case. RLS cannot express "you may end someone else's
 * row but not otherwise touch it", and doing it as two browser statements is not
 * atomic. That is architecture.md §8.1's "complex multi-step logic", so the write
 * path is two SECURITY DEFINER functions and the browser has no INSERT grant at
 * all. Reads of your OWN intervals are ordinary `.from()` selects.
 *
 * `.rpc()` is deliberately excluded from Sentry's Supabase integration, so every
 * RPC call site here reports by hand — unlike the `.from()` reads below, which
 * report themselves and must NOT be captured again.
 */

import * as Sentry from '@sentry/nextjs';
import { getSupabase } from '@/lib/supabase';
import { toError, toFriendlyError, shouldReportSupabaseError } from '@/lib/supabaseErrors';
import type { Database } from '@/types/database';
import type {
  IntervalAdjustment,
  IntervalCloseReason,
  OpenInterval,
  OperationActuals,
  OperationInterval,
  OperationIntervalWithContext,
  OperatorTimeDetailRow,
  RunningInterval,
} from '@/types/operationInterval';

/**
 * ONE UNBROKEN LITERAL, not a concatenation. `getSupabase()` type-checks the
 * select string against types/database.ts, and it can only do that when the
 * argument is a literal type — a `'a' + 'b'` widens to `string` and every row
 * comes back as `GenericStringError[]`, which is the error you get instead of
 * the shape you wanted.
 */
const INTERVAL_COLUMNS =
  'id, job_operation_id, job_part_id, work_center_id, started_at, ended_at, adjusted_started_at, adjusted_ended_at, adjusted_at, effective_started_at, effective_ended_at, close_reason, capture_source, note' as const;

/**
 * The same interval plus the job/step it belongs to.
 *
 * The strip and the journal both have to NAME the work — "OP 30 · J-0007" — or
 * they are a bare clock with no referent, and the operator cannot tell which of
 * three running machines they are looking at. The join also supplies `job_id`,
 * which the interval row does not carry and the step route needs.
 */
const INTERVAL_WITH_CONTEXT =
  'id, job_operation_id, job_part_id, work_center_id, started_at, ended_at, adjusted_started_at, adjusted_ended_at, adjusted_at, effective_started_at, effective_ended_at, close_reason, capture_source, note, job_operations!inner(job_id, operation_name, sequence, jobs!inner(job_number)), job_parts!inner(parts(part_name))' as const;

/** Flatten the nested join rows into the shape the UI reads. */
function withContext(row: Record<string, unknown>): OperationIntervalWithContext {
  const op = row.job_operations as
    | { job_id: string; operation_name: string; sequence: number; jobs: { job_number: string } }
    | null;
  const part = row.job_parts as { parts: { part_name: string } | null } | null;
  return {
    ...(row as unknown as OperationInterval),
    job_id: op?.job_id ?? '',
    operation_name: op?.operation_name ?? '',
    operation_sequence: op?.sequence ?? 0,
    job_number: op?.jobs?.job_number ?? '',
    part_name: part?.parts?.part_name ?? null,
  };
}

/** Report an RPC failure by hand. See the file header for why this is not automatic. */
function reportRpcError(error: unknown, op: string): void {
  if (shouldReportSupabaseError(error)) {
    Sentry.captureException(toError(error, `Failed to ${op}`), {
      tags: { area: 'operation_intervals', op },
    });
  }
}

/**
 * Open an interval on an operation, closing whatever was open at the same work
 * centre. Returns the new interval plus the clock skew to render it with.
 *
 * The skew is why this returns `server_now` at all: elapsed time is computed from
 * the DIFFERENCE between two server-anchored instants, never from a tick count,
 * because a backgrounded mobile tab stops ticking. A phone with a wrong clock
 * would otherwise render a running timer that is hours out.
 */
export async function startOperationInterval(jobOperationId: string): Promise<RunningInterval> {
  const supabase = getSupabase();

  // Captured before the await so the round trip is not counted as clock drift.
  const sentAt = Date.now();
  const { data, error } = await supabase
    .rpc('start_operation_interval', { p_job_operation_id: jobOperationId })
    .single();

  if (error || !data) {
    reportRpcError(error, 'start interval');
    throw toFriendlyError(error, {
      entity: 'time entry',
      fallback: 'Could not start timing this step.',
    });
  }

  const serverSkewMs = new Date(data.server_now).getTime() - sentAt;
  const interval = await getInterval(data.interval_id);
  if (!interval) {
    // The row was just written and is ours, so this is not reachable through
    // RLS — it means the read failed for another reason and the caller needs to
    // know the timer is running even though we cannot render it in full.
    throw new Error('Timing started, but the running step could not be loaded. Pull to refresh.');
  }
  return { ...interval, serverSkewMs };
}

/**
 * Close an interval, optionally correcting its times and attaching a note.
 *
 * `switched` is not accepted: that reason belongs to the chain and only
 * `start_operation_interval` writes it. Closing an already-closed interval is a
 * no-op rather than an error, so a gloved double-tap and a retry after a dropped
 * cellular response are both harmless.
 */
export async function closeOperationInterval(
  intervalId: string,
  closeReason: Exclude<IntervalCloseReason, 'switched'>,
  adjustment: IntervalAdjustment = {},
): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase.rpc('close_operation_interval', {
    p_interval_id: intervalId,
    p_close_reason: closeReason,
    p_adjusted_started_at: adjustment.adjustedStartedAt ?? undefined,
    p_adjusted_ended_at: adjustment.adjustedEndedAt ?? undefined,
    p_note: adjustment.note ?? undefined,
  });

  if (error) {
    reportRpcError(error, 'close interval');
    throw toFriendlyError(error, {
      entity: 'time entry',
      fallback: 'Could not stop timing this step.',
    });
  }
}

/**
 * Correct the times on an interval that is already closed.
 *
 * A plain `.from().update()` and not an RPC, because this one does NOT cross
 * ownership: the column-scoped grant plus the own-rows policy already say
 * exactly the right thing, and the DB stamps `adjusted_at`/`adjusted_by` itself.
 * The raw `started_at`/`ended_at` are not writable here by construction — that is
 * the point of the pair.
 */
export async function adjustOperationInterval(
  intervalId: string,
  adjustment: IntervalAdjustment,
): Promise<void> {
  const supabase = getSupabase();

  // Typed against the generated Update shape rather than a loose Record, so the
  // column-scoped grant in the migration and this payload cannot drift apart
  // without the compiler noticing.
  const payload: Database['public']['Tables']['job_operation_intervals']['Update'] = {};
  if (adjustment.adjustedStartedAt !== undefined) {
    payload.adjusted_started_at = adjustment.adjustedStartedAt;
  }
  if (adjustment.adjustedEndedAt !== undefined) {
    payload.adjusted_ended_at = adjustment.adjustedEndedAt;
  }
  if (adjustment.note !== undefined) {
    payload.note = adjustment.note?.trim() ? adjustment.note.trim() : null;
  }
  if (Object.keys(payload).length === 0) return;

  // No captureException: this is a `.from()` write, which the Supabase
  // integration already files with its query attached. Reporting here would file
  // the same failure twice.
  const { error } = await supabase
    .from('job_operation_intervals')
    .update(payload)
    .eq('id', intervalId);

  if (error) {
    throw toFriendlyError(error, {
      entity: 'time entry',
      fallback: 'Could not save those times.',
    });
  }
}

/** One interval by id. Own rows only — RLS returns nothing for anyone else's. */
export async function getInterval(intervalId: string): Promise<OperationInterval | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('job_operation_intervals')
    .select(INTERVAL_COLUMNS)
    .eq('id', intervalId)
    .is('voided_at', null)
    .maybeSingle();

  if (error) {
    throw toFriendlyError(error, { entity: 'time entry', fallback: 'Could not load that entry.' });
  }
  return (data as OperationInterval | null) ?? null;
}

/**
 * The caller's own open intervals, oldest first.
 *
 * Plural on purpose. One operator legitimately holds several at once — three
 * spindles is a normal Tuesday — because the chain is per work centre, not per
 * person. A caller that assumes at most one will be wrong on the shop floor.
 */
export async function getMyOpenIntervals(
  companyId: string,
): Promise<OperationIntervalWithContext[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('job_operation_intervals')
    .select(INTERVAL_WITH_CONTEXT)
    .eq('company_id', companyId)
    .is('ended_at', null)
    .is('voided_at', null)
    .order('started_at', { ascending: true });

  if (error) {
    throw toFriendlyError(error, {
      entity: 'time entry',
      fallback: 'Could not load what you are working on.',
    });
  }
  return (data ?? []).map((row) => withContext(row));
}

/**
 * The caller's own intervals on one job, oldest first — the job feed's timeline.
 *
 * OWN ROWS ONLY, and that is a property of the feed rather than a limitation of
 * this query. Notes in that feed are everyone's; time entries are yours. A
 * job-scoped feed showing "Priya started Final Inspection at 11:06 PM" to every
 * operator would be a per-person time view available shop-wide — looser than
 * what admins get, who have to go through an audited function for the same fact.
 * RLS enforces it; this comment exists so the asymmetry reads as deliberate.
 *
 * Filters on the embedded operation's `job_id` because the interval row carries
 * `job_part_id` but not `job_id`; `!inner` makes the embed a join rather than a
 * left join, so the filter actually restricts.
 */
export async function getMyIntervalsForJob(
  companyId: string,
  jobId: string,
): Promise<OperationIntervalWithContext[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('job_operation_intervals')
    .select(INTERVAL_WITH_CONTEXT)
    .eq('company_id', companyId)
    .eq('job_operations.job_id', jobId)
    .is('voided_at', null)
    .order('started_at', { ascending: false });

  if (error) {
    throw toFriendlyError(error, {
      entity: 'time entry',
      fallback: 'Could not load recorded time for this job.',
    });
  }
  return (data ?? []).map((row) => withContext(row));
}

/**
 * The operator's own journal: their recorded intervals, newest first.
 *
 * Paged by DATE RANGE rather than by count, and deliberately returning no total.
 * The journal's safety is that it has no scalar to optimise — a row count or a
 * period sum is the production tally the surveillance guardrail refuses, and
 * rendering one here would reintroduce it through the back door. See
 * docs/modules/operator-view.md#surveillance-guardrail-non-negotiable.
 */
export async function getMyIntervalJournal(
  companyId: string,
  before?: string,
  limit = 20,
): Promise<OperationIntervalWithContext[]> {
  const supabase = getSupabase();

  let query = supabase
    .from('job_operation_intervals')
    .select(INTERVAL_WITH_CONTEXT)
    .eq('company_id', companyId)
    .is('voided_at', null)
    .order('effective_started_at', { ascending: false })
    .limit(limit);

  if (before) query = query.lt('effective_started_at', before);

  const { data, error } = await query;
  if (error) {
    throw toFriendlyError(error, {
      entity: 'time entry',
      fallback: 'Could not load your work journal.',
    });
  }
  return (data ?? []).map((row) => withContext(row));
}

/**
 * Per-operation recorded time for the office. Aggregate, with no operator
 * identity in the result — that is why it is an RPC rather than a select.
 *
 * Returns a Map keyed by operation id, and an operation with no recorded time is
 * ABSENT rather than zero. The caller must render "no time recorded" for a miss
 * instead of a 0, because those are different facts and conflating them is how a
 * fabricated number gets read back as measurement later.
 */
export async function getOperationActuals(
  jobOperationIds: string[],
): Promise<Map<string, OperationActuals>> {
  if (jobOperationIds.length === 0) return new Map();
  const supabase = getSupabase();

  const { data, error } = await supabase.rpc('get_operation_actuals', {
    p_job_operation_ids: jobOperationIds,
  });

  if (error) {
    reportRpcError(error, 'load operation actuals');
    throw toFriendlyError(error, {
      entity: 'time entry',
      fallback: 'Could not load recorded time.',
    });
  }

  return new Map(
    (data ?? []).map((row) => [
      row.job_operation_id,
      { ...row, actual_minutes: Number(row.actual_minutes) } as OperationActuals,
    ]),
  );
}

/**
 * One person's recorded time. **The only path in this file that returns operator
 * identity, and the only one that leaves a record of having been asked.**
 *
 * The function is admin-gated, refuses a blank reason, and writes an
 * `operator_time_access_log` row BEFORE it returns anything — so a failure
 * partway cannot yield an unlogged look. None of that is enforced here; it is
 * enforced in the function, because a client-side check is a suggestion.
 *
 * It exists at all because the alternative is worse. An owner who cannot get
 * this number by any route will ask for a permissive view of the underlying
 * table, and that request is far harder to refuse than to pre-empt. A narrow,
 * logged, reason-coded door is what keeps the wide one shut.
 */
export async function getOperatorTimeDetail(
  companyId: string,
  operatorId: string,
  reason: string,
): Promise<OperatorTimeDetailRow[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase.rpc('get_operator_time_detail', {
    p_company_id: companyId,
    p_operator_id: operatorId,
    p_reason: reason,
  });

  if (error) {
    reportRpcError(error, 'load operator time detail');
    throw toFriendlyError(error, {
      entity: 'time entry',
      fallback: 'Could not load that time record.',
    });
  }
  return (data ?? []) as OperatorTimeDetailRow[];
}

/**
 * Intervals still open, oldest first — the office's forgotten-stop list.
 *
 * Admin-only, enforced inside the function. This is also the ONLY route to an
 * interval whose owner has gone home: `close_operation_interval` refuses a
 * non-owner by design, so without this the row would be unreachable.
 */
export async function getOpenIntervals(companyId: string): Promise<OpenInterval[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase.rpc('get_open_intervals', {
    p_company_id: companyId,
  });

  if (error) {
    reportRpcError(error, 'load open intervals');
    throw toFriendlyError(error, {
      entity: 'time entry',
      fallback: 'Could not load what is still running.',
    });
  }
  return (data ?? []) as OpenInterval[];
}
