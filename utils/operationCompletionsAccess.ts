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
import type {
  CreateOperationCompletionInput,
  OperationCompletionEvent,
  OperationCompletionSummary,
} from '@/types/operationCompletion';

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

  // Outside (external-vendor) ops are done off-site and use the send/receive
  // lifecycle (operatorAccess.markOperationReceived), never quantity completions —
  // an external op can never be completed through this internal path.
  const { data: opRow } = await supabase
    .from('job_operations')
    .select('work_center:work_centers(kind)')
    .eq('id', input.jobOperationId)
    .single();
  const wc = Array.isArray(opRow?.work_center) ? opRow?.work_center[0] : opRow?.work_center;
  if (wc?.kind === 'external') {
    throw new Error(
      'This is an outside (vendor) operation — use Mark Received, not a quantity completion.',
    );
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
      note,
    })
    .select('id')
    .single();

  if (error || !data) {
    console.error('createOperationCompletion failed:', error);
    throw new Error(error?.message ?? 'Failed to record completion.');
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
    throw new Error(`Failed to void completion: ${error.message}`);
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
    throw new Error(`Failed to undo completion: ${error.message}`);
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
