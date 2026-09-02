/**
 * Operation-completion access layer (partial quantity completion on operations).
 *
 * job_operation_completions is an append-only child table carrying per-event
 * quantity_good — the Jigged-side source of truth for "how much of an operation
 * is done". This mirrors shipmentsAccess.ts (shipment_line_items): create appends
 * an event, corrections VOID (never edit), and job_operations.status +
 * job_parts.production_status are recomputed by DB triggers from the events.
 *
 * These are simple member-scoped CRUD writes (no privileged/multi-step work), so
 * they go straight through the Supabase client per the Supabase-first rule — no
 * FastAPI endpoint. Over-completion is allowed (only quantity_good > 0 is
 * enforced, in the DB); the UI warns via operationMath.
 */

import { getSupabase } from '@/lib/supabase';
import { toFriendlyError } from '@/lib/supabaseErrors';
import type {
  CompletionCaptureSource,
  CreateOperationCompletionInput,
  OperationCompletionEvent,
  OperationCompletionSummary,
} from '@/types/operationCompletion';

/**
 * Somebody else recorded work on this step while this caller was looking at it.
 *
 * A DISTINCT CLASS, not a message, because every surface has to react to it
 * differently from a failed write: the completion did NOT land, nothing is
 * broken, and the right response is to re-read and show the operator what is
 * actually there rather than to offer a retry of a write that would now
 * double-count.
 *
 * FIRST WRITE WINS, decided 2026-08-28. Completions are additive, so two people
 * each recording "the remaining 2" on a 2-piece step silently produces 4 good on
 * an order of 2 — over-completion the UI warns about when you type it, arriving
 * here with nobody having typed it.
 */
export class CompletionConflictError extends Error {
  /** What is actually recorded now, so the caller can say so without re-reading. */
  readonly liveQtyGood: number;

  constructor(liveQtyGood: number) {
    super(
      'Someone else recorded work on this step while this page was open. ' +
        'Nothing was recorded — the step has been refreshed to show where it actually stands.',
    );
    this.name = 'CompletionConflictError';
    this.liveQtyGood = liveQtyGood;
  }
}

/**
 * Record a good-quantity completion event on an operation. The insert fires the
 * recompute trigger, which flips job_operations.status (pending → in_progress →
 * completed) and cascades job_parts.production_status → jobs.production_status.
 * Returns the new completion id.
 */
export async function createOperationCompletion(
  input: CreateOperationCompletionInput,
): Promise<{ id: string }> {
  const supabase = getSupabase();

  // Outside ops are done off-site and use the send/receive lifecycle
  // (operatorAccess.markOperationReceived), never quantity completions — an
  // outside op can never be completed through this internal path. One column,
  // no join: vendor_service_id IS the discriminator.
  const { data: opRow } = await supabase
    .from('job_operations')
    .select('vendor_service_id')
    .eq('id', input.jobOperationId)
    .single();
  if (opRow?.vendor_service_id) {
    throw new Error(
      'This is an outside (vendor) operation — use Mark Received, not a quantity completion.',
    );
  }

  // FIRST-WRITE-WINS CHECK, and it is deliberately a re-read rather than a
  // constraint. Completions are additive by design — partial quantities are the
  // whole point of the table — so the database cannot tell a legitimate second
  // event from a stale duplicate. Only the caller can, by saying what it thought
  // was there.
  //
  // This closes the window that MATTERS, which is minutes long: a Complete dialog
  // left open on the office screen while an operator finishes the step on their
  // phone. It does not close a sub-second double-submit, and making it atomic
  // would mean moving the insert into an RPC — a Supabase-first violation for a
  // race whose realistic frequency is zero and whose damage (an over-completion
  // the office can void) is one click to undo.
  if (input.expectedQtyGood !== undefined) {
    const { data: live, error: liveError } = await supabase
      .from('job_operation_completions')
      .select('quantity_good')
      .eq('job_operation_id', input.jobOperationId)
      .is('voided_at', null);

    // A FAILED CHECK IS NOT A PASSED CHECK. "Couldn't read" must not render as
    // "nothing changed" — the same rule the access-check guidance states, and the
    // consequence here is a double-counted completion rather than a wrong badge.
    if (liveError) {
      throw toFriendlyError(liveError, {
        entity: 'completion',
        fallback: 'Could not check what is already recorded on this step.',
      });
    }

    // GREATER THAN, NOT NOT-EQUAL, and the asymmetry is the correctness of this
    // check rather than a loosening of it.
    //
    //   * live > expected — somebody RECORDED while this caller was looking.
    //     Adding on top double-counts, which is the whole harm. Refuse.
    //   * live < expected — somebody UNDID work. Recording now simply banks
    //     against a smaller base and leaves more outstanding, which is a correct
    //     outcome and not a double-count.
    //
    // Refusing both directions looked symmetric and was wrong: an undo that the
    // caller's own screen has not finished re-reading yet lands in the second
    // case, so `!==` turned a stale-by-a-moment view into a refusal of a write
    // that was never dangerous. The operator step screen reloads the job and the
    // summary together after an undo, and there is a render between the two
    // where `qtyGood` is still the pre-undo figure.
    const liveQtyGood = (live ?? []).reduce((acc, c) => acc + Number(c.quantity_good), 0);
    if (liveQtyGood > input.expectedQtyGood) {
      throw new CompletionConflictError(liveQtyGood);
    }
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const note = input.note?.trim() ? input.note.trim() : null;

  const { data, error } = await supabase
    .from('job_operation_completions')
    .insert({
      company_id: input.companyId,
      job_operation_id: input.jobOperationId,
      job_part_id: input.jobPartId,
      quantity_good: input.quantityGood,
      completed_by: user?.id ?? null,
      capture_source: input.captureSource,
      note,
    })
    .select('id')
    .single();

  if (error || !data) {
    console.error('createOperationCompletion failed:', error);
    throw toFriendlyError(error, {
      entity: 'completion',
      fallback: 'Failed to record completion.',
    });
  }
  return { id: data.id };
}

/**
 * Void a completion event (the correction path — void + re-enter, never edit).
 * Stamps voided_at/voided_by; the trigger recomputes the op + part status from
 * the remaining non-void events. Idempotent via the `.is('voided_at', null)`
 * guard, mirroring voidShipment. Quantities are never deleted — the event stays
 * on record as voided.
 */
export async function voidOperationCompletion(completionId: string): Promise<void> {
  const supabase = getSupabase();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    throw new Error('You must be signed in to void a completion.');
  }

  const { error } = await supabase
    .from('job_operation_completions')
    .update({ voided_at: new Date().toISOString(), voided_by: user.id })
    .eq('id', completionId)
    .is('voided_at', null);

  if (error) {
    console.error('voidOperationCompletion failed:', error);
    throw toFriendlyError(error, {
      entity: 'completion',
      fallback: 'Failed to void that completion.',
    });
  }
}

/**
 * Void EVERY non-void completion on an operation — the "undo this operation"
 * action (backs the operator/admin Undo). Recompute cascades the op back to
 * pending. A no-op when the op has no live completions.
 */
export async function voidAllOperationCompletions(jobOperationId: string): Promise<void> {
  const supabase = getSupabase();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    throw new Error('You must be signed in to undo a completion.');
  }

  const { error } = await supabase
    .from('job_operation_completions')
    .update({ voided_at: new Date().toISOString(), voided_by: user.id })
    .eq('job_operation_id', jobOperationId)
    .is('voided_at', null);

  if (error) {
    console.error('voidAllOperationCompletions failed:', error);
    throw toFriendlyError(error, {
      entity: 'completion',
      fallback: 'Failed to undo that completion.',
    });
  }
}

/**
 * Per-operation good/remaining rollup for a job_part. Two queries to avoid an
 * N+1 (pull the part target + its ops, then sum non-void completions), merged in
 * JS. Mirrors getJobPartShipmentSummaries. qty_remaining is clamped ≥ 0 so an
 * over-completed op shows 0, never negative.
 */
export async function getOperationCompletionSummaries(
  jobPartId: string,
): Promise<OperationCompletionSummary[]> {
  const supabase = getSupabase();

  const { data: part, error: partErr } = await supabase
    .from('job_parts')
    .select('quantity')
    .eq('id', jobPartId)
    .single();
  if (partErr || !part) {
    console.error('Error loading job_part for completion summary:', partErr);
    throw new Error('Failed to load job part.');
  }
  const target = Number(part.quantity);

  const { data: ops, error: opsErr } = await supabase
    .from('job_operations')
    .select('id')
    .eq('job_part_id', jobPartId);
  if (opsErr) {
    console.error('Error loading operations for completion summary:', opsErr);
    throw new Error('Failed to load operations.');
  }
  const opIds = (ops ?? []).map((o) => o.id);
  if (opIds.length === 0) return [];

  const { data: completions, error: compErr } = await supabase
    .from('job_operation_completions')
    .select('job_operation_id, quantity_good')
    .eq('job_part_id', jobPartId)
    .is('voided_at', null);
  if (compErr) {
    console.error('Error loading operation completions:', compErr);
    throw new Error('Failed to load completions.');
  }

  const goodByOp = new Map<string, number>();
  for (const row of completions ?? []) {
    goodByOp.set(
      row.job_operation_id,
      (goodByOp.get(row.job_operation_id) ?? 0) + Number(row.quantity_good),
    );
  }

  return opIds.map((id) => {
    const qtyGood = goodByOp.get(id) ?? 0;
    return {
      job_operation_id: id,
      target,
      qty_good: qtyGood,
      qty_remaining: Math.max(0, target - qtyGood),
    };
  });
}

/**
 * The completion event history for one operation (newest first), including
 * voided events, with completed_by resolved to a member name. Backs the admin
 * "who completed how many, when" audit panel.
 */
export async function getOperationCompletionEvents(
  jobOperationId: string,
  companyId: string,
): Promise<OperationCompletionEvent[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('job_operation_completions')
    .select(
      'id, job_operation_id, job_part_id, quantity_good, completed_by, completed_at, note, voided_at, voided_by',
    )
    .eq('job_operation_id', jobOperationId)
    .order('completed_at', { ascending: false });

  if (error) {
    console.error('Error loading operation completion events:', error);
    throw new Error('Failed to load completion history.');
  }
  const rows = (data ?? []) as OperationCompletionEvent[];
  if (rows.length === 0) return [];

  // Resolve completer names in one batched query (mirrors getJobWithRelations).
  const userIds = new Set<string>();
  for (const r of rows) if (r.completed_by) userIds.add(r.completed_by);
  if (userIds.size > 0) {
    const { data: members } = await supabase
      .from('user_company_access')
      .select('user_id, name')
      .eq('company_id', companyId)
      .in('user_id', Array.from(userIds));
    const nameByUser = new Map<string, string | null>();
    for (const m of (members ?? []) as Array<{ user_id: string; name: string | null }>) {
      nameByUser.set(m.user_id, m.name);
    }
    for (const r of rows) {
      r.completed_by_name = r.completed_by ? nameByUser.get(r.completed_by) ?? null : null;
    }
  }
  return rows;
}

/**
 * ONE UNBROKEN LITERAL. Concatenating a select string widens its type to
 * `string`, at which point the client stops type-checking it against
 * types/database.ts and the row comes back as GenericStringError[].
 */
const FEED_COMPLETION =
  'id, job_operation_id, quantity_good, completed_at, capture_source, job_operations!inner(job_id, operation_name)' as const;

/** A completion as the operator's job feed shows it. Carries no actor — see below. */
export interface JobFeedCompletion {
  id: string;
  job_operation_id: string;
  quantity_good: number;
  completed_at: string;
  operation_name: string;
  /**
   * 'office' rows are in this list because the OFFICE recorded them, not because
   * the reader did. The feed labels them, since "someone in the office marked
   * this done" is a different fact from "you finished this".
   */
  capture_source: CompletionCaptureSource | null;
}

/**
 * The completions this job's feed shows: the caller's OWN, plus every one the
 * OFFICE recorded.
 *
 * THE OWN-ROWS RULE IS ABOUT PEOPLE, AND THE SECOND HALF HAS NO PERSON IN IT.
 * A job-scoped feed listing what each named person finished and when would be a
 * per-person production log available shop-wide — the thing the surveillance
 * guardrail refuses, and the reason operator completions stay own-only with no
 * actor name (docs/modules/operator-view.md#surveillance-guardrail-non-negotiable).
 * An office completion is an act by the shop, not by a machinist: including it
 * exposes nobody's pace, and EXCLUDING it was the bug — the office marked a step
 * done and the floor's own record of that step stayed silent, so the operator
 * standing at the machine had no way to learn their step had been closed out
 * from under them.
 *
 * SPLIT ON THE SURFACE COLUMN, NOT THE ACTOR'S ROLE. An admin at a machine
 * records through the operator surface and their row is operator capture; role
 * would file it as an office action and publish it to the whole shop.
 * NULL — every row written before 20260828124806 — is neither, so it stays
 * own-only and nothing at rest changes meaning.
 *
 * Returns ALL of them, timed and untimed, because this query cannot tell the
 * difference — a completion does not know whether an interval points at it. The
 * feed drops the ones its already-loaded intervals claim, which is also what
 * makes a completion whose interval was voided correctly reappear as untimed.
 */
export async function getFeedCompletionsForJob(
  companyId: string,
  jobId: string,
): Promise<JobFeedCompletion[]> {
  const supabase = getSupabase();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from('job_operation_completions')
    .select(FEED_COMPLETION)
    .eq('company_id', companyId)
    .eq('job_operations.job_id', jobId)
    // ONE ROUND TRIP, not two. `or` on a mounted feed matters on cellular, which
    // is the connection this screen actually runs on. Both sides of it are
    // indexed-column equalities, so PostgREST resolves it as a bitmap OR.
    .or(`completed_by.eq.${user.id},capture_source.eq.office`)
    // Undo is a soft void, so an undone completion must not keep claiming work.
    .is('voided_at', null)
    .order('completed_at', { ascending: false });

  if (error) {
    throw toFriendlyError(error, {
      entity: 'completion',
      fallback: 'Could not load what has been finished on this job.',
    });
  }

  return (data ?? []).map((row) => {
    const op = row.job_operations as { job_id: string; operation_name: string } | null;
    return {
      id: row.id,
      job_operation_id: row.job_operation_id,
      quantity_good: Number(row.quantity_good),
      completed_at: row.completed_at,
      operation_name: op?.operation_name ?? '',
      capture_source: (row.capture_source as CompletionCaptureSource | null) ?? null,
    };
  });
}
