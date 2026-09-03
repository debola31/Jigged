/**
 * Outside processing — shipping & receiving access layer.
 *
 * SHIPPING IS THE SEND. There is no "mark sent out" write any more: a send is a
 * row in `outside_shipments`, minted by the `create_outside_shipment` RPC, and
 * `job_operations.status` / `sent_at` / `sent_by` are DERIVED from these tables
 * by a trigger. A hand-written status is refused by the database. That is why
 * `markOperationSent` is gone rather than wrapped.
 *
 * The split of responsibilities mirrors the rest of the repo:
 *
 *   - SEND goes through an RPC, because minting `OSP-{jobBase}-{n}` under a
 *     per-job advisory lock and freezing the vendor address block is not
 *     something a PostgREST insert can do. `outside_shipments` grants the
 *     browser SELECT and nothing else.
 *   - VOID goes through an RPC, because its two statements must be atomic AND
 *     ordered (receipts first, or the job rollup is silently suppressed at
 *     trigger depth 3).
 *   - RECEIVE is a plain insert. It is simple CRUD, so it goes straight through
 *     the Supabase client per the Supabase-first rule — the same call shape
 *     `createOperationCompletion` uses.
 *
 * `.rpc()` is deliberately excluded from the Sentry Supabase integration
 * (lib/supabase.ts), so the two RPC paths report by hand. The `.from()` reads
 * and writes below do NOT — the integration already files those with the query
 * attached, and a second capture files one failure as two issues.
 */
import * as Sentry from '@sentry/nextjs';
import { getSupabase } from '@/lib/supabase';
import { toError, toFriendlyError, shouldReportSupabaseError } from '@/lib/supabaseErrors';
import { isOutsideOperation } from '@/types/job';
import type {
  CreateOutsideShipmentPayload,
  OutsideOperationSummary,
  OutsideShipment,
  OutsideShipmentFilters,
  OutsideShipmentReceipt,
  OutsideShipmentWithRelations,
  RecordOutsideReceiptPayload,
} from '@/types/outsideShipment';

/** numeric(12,2)-ish money-free rounding. See `roundQty` usage notes below. */
function roundQty(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Report an RPC failure by hand. See the file header for why this is not automatic. */
function reportRpcError(error: unknown, op: string): void {
  if (shouldReportSupabaseError(error)) {
    Sentry.captureException(toError(error, `Failed to ${op}`), {
      tags: { area: 'outside_shipments', op },
    });
  }
}

const SHIPMENT_COLUMNS =
  'id, company_id, job_id, job_part_id, job_operation_id, vendor_id, vendor_address_id, ' +
  'vendor_contact_id, vendor_name, service_name, ship_to_address, ship_to_contact, ' +
  'slip_number, quantity, shipped_at, due_back_on, carrier, notes, created_by, ' +
  'voided_at, voided_by, created_at, updated_at';

const RECEIPT_COLUMNS =
  'id, company_id, outside_shipment_id, job_operation_id, job_part_id, quantity_good, ' +
  'quantity_scrapped, received_at, received_by, note, voided_at, voided_by, created_at, updated_at';

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * THE SEND. Mints the slip and stamps the operation, in one transaction.
 *
 * `companyId` is not a parameter because the RPC derives it from the operation —
 * a caller cannot name a tenant it does not own, so that whole class of
 * cross-tenant bug does not exist here.
 */
export async function createOutsideShipment(
  payload: CreateOutsideShipmentPayload,
): Promise<{ shipmentId: string; slipNumber: string }> {
  // Blocked here rather than left to the CHECK constraint so the caller gets a
  // sentence instead of a 23514, and so a zero never costs a round trip.
  if (!(payload.quantity > 0)) {
    throw new Error('Enter how many pieces are going out.');
  }

  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('create_outside_shipment', {
    p_job_operation_id: payload.jobOperationId,
    p_quantity: payload.quantity,
    p_vendor_address_id: payload.vendorAddressId ?? undefined,
    p_vendor_contact_id: payload.vendorContactId ?? undefined,
    p_shipped_at: payload.shippedAt ?? undefined,
    p_due_back_on: payload.dueBackOn ?? undefined,
    p_carrier: payload.carrier ?? undefined,
    p_notes: payload.notes ?? undefined,
  });

  if (error) {
    reportRpcError(error, 'create outside shipment');
    throw toFriendlyError(error, { entity: 'shipment' });
  }

  // RETURNS TABLE, so PostgREST hands back an array even for one row.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.shipment_id) {
    const err = new Error('The shipment was created but its slip number could not be read back.');
    Sentry.captureException(err, { tags: { area: 'outside_shipments', op: 'create' } });
    throw err;
  }

  return { shipmentId: row.shipment_id, slipNumber: row.slip_number };
}

/**
 * Record what came back against ONE slip. A plain insert: the trigger derives
 * the operation status, the part's and the job's.
 *
 * `receivedBy` is written explicitly rather than defaulted to `auth.uid()` in
 * SQL, matching `job_operation_completions.completed_by` — two receipt-shaped
 * tables disagreeing about who owns attribution is how one of them ends up NULL.
 */
export async function receiveOutsideShipment(
  shipmentId: string,
  payload: RecordOutsideReceiptPayload,
): Promise<{ receiptId: string }> {
  const good = payload.quantityGood ?? 0;
  const scrapped = payload.quantityScrapped ?? 0;
  if (!(good + scrapped > 0)) {
    throw new Error('Record how many came back, or how many the vendor scrapped.');
  }

  const supabase = getSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: ship, error: shipErr } = await supabase
    .from('outside_shipments')
    .select('company_id, id, job_operation_id, job_part_id, voided_at')
    .eq('id', shipmentId)
    .single();
  if (shipErr || !ship) {
    throw toFriendlyError(shipErr, { entity: 'shipment' });
  }
  if (ship.voided_at) {
    throw new Error('That slip was voided — nothing can be received against it.');
  }

  const { data, error } = await supabase
    .from('outside_shipment_receipts')
    .insert({
      company_id: ship.company_id,
      outside_shipment_id: ship.id,
      job_operation_id: ship.job_operation_id,
      job_part_id: ship.job_part_id,
      quantity_good: good,
      quantity_scrapped: scrapped,
      received_at: payload.receivedAt ?? undefined,
      received_by: user?.id ?? null,
      note: payload.note?.trim() || null,
    })
    .select('id')
    .single();

  if (error || !data) throw toFriendlyError(error, { entity: 'receipt' });
  return { receiptId: data.id };
}

/**
 * Receive against an operation rather than a named slip.
 *
 * This is what `markOperationReceived` becomes, and it keeps the case its
 * docblock called "the common after-the-fact case": nobody made a slip, the
 * parts came back anyway. With no open shipment it creates a BACKFILL shipment
 * (never printed) and receipts it, reporting `wasBackfilled` so the UI can say
 * so out loud rather than doing it silently the way the old `sent_at =
 * completed_at` write did.
 *
 * Keeping every receipt attached to a shipment is what lets `outside_shipment_id`
 * stay NOT NULL — the alternative, a nullable parent, would force two shapes
 * through every summing query.
 */
export async function receiveOutsideOperation(
  jobOperationId: string,
  payload: RecordOutsideReceiptPayload,
): Promise<{ shipmentId: string; receiptId: string; wasBackfilled: boolean }> {
  const good = payload.quantityGood ?? 0;
  const scrapped = payload.quantityScrapped ?? 0;

  const open = await getOpenOutsideShipments(jobOperationId);
  if (open.length > 0) {
    // Oldest first: the vendor returns the first batch first, and it is the one
    // whose due-back has aged.
    const target = open[0];
    const { receiptId } = await receiveOutsideShipment(target.id, payload);
    return { shipmentId: target.id, receiptId, wasBackfilled: false };
  }

  const { shipmentId } = await createOutsideShipment({
    jobOperationId,
    quantity: good + scrapped,
    notes: 'Recorded when the parts came back — no slip was made for the send.',
  });
  const { receiptId } = await receiveOutsideShipment(shipmentId, payload);
  return { shipmentId, receiptId, wasBackfilled: true };
}

/**
 * Step back exactly one movement — the quantity-world translation of the old
 * "Undo steps back one state" rule. Voids the newest live receipt if there is
 * one, otherwise the newest live shipment. Never both, never skipped.
 */
export async function undoLastOutsideMovement(
  jobOperationId: string,
): Promise<{ undid: 'receipt' | 'shipment' | 'nothing' }> {
  const supabase = getSupabase();

  const { data: receipts, error: rErr } = await supabase
    .from('outside_shipment_receipts')
    .select('id')
    .eq('job_operation_id', jobOperationId)
    .is('voided_at', null)
    .order('received_at', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1);
  if (rErr) throw toFriendlyError(rErr, { entity: 'receipt' });

  if (receipts?.length) {
    await voidOutsideReceipt(receipts[0].id);
    return { undid: 'receipt' };
  }

  const { data: shipments, error: sErr } = await supabase
    .from('outside_shipments')
    .select('id')
    .eq('job_operation_id', jobOperationId)
    .is('voided_at', null)
    .order('shipped_at', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1);
  if (sErr) throw toFriendlyError(sErr, { entity: 'shipment' });

  if (shipments?.length) {
    await voidOutsideShipment(shipments[0].id);
    return { undid: 'shipment' };
  }

  return { undid: 'nothing' };
}

/**
 * Void a slip and everything received against it, in that order.
 *
 * Through the RPC, not a direct update: the browser has no UPDATE grant on
 * `outside_shipments`, and the ordering is what keeps the job rollup inside the
 * `pg_trigger_depth() > 2` bail. Idempotent — a slip already voided returns 0.
 */
export async function voidOutsideShipment(shipmentId: string): Promise<{ receiptsVoided: number }> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('void_outside_shipment', {
    p_shipment_id: shipmentId,
  });
  if (error) {
    reportRpcError(error, 'void outside shipment');
    throw toFriendlyError(error, { entity: 'shipment' });
  }
  return { receiptsVoided: Number(data ?? 0) };
}

/** Void one receipt. The column-scoped UPDATE grant, mirroring voidOperationCompletion. */
export async function voidOutsideReceipt(receiptId: string): Promise<void> {
  const supabase = getSupabase();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    throw new Error('You must be signed in to undo a receipt.');
  }

  const { error } = await supabase
    .from('outside_shipment_receipts')
    .update({ voided_at: new Date().toISOString(), voided_by: user.id })
    .eq('id', receiptId)
    .is('voided_at', null);
  if (error) throw toFriendlyError(error, { entity: 'receipt' });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Hydrated single shipment for the slip PDF and its preview.
 *
 * A BY-ID read, so it deliberately carries no `deleted_at` filter — a slip on an
 * archived job must keep resolving. See architecture.md §16.
 */
export async function getOutsideShipmentById(
  shipmentId: string,
): Promise<OutsideShipmentWithRelations> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('outside_shipments')
    .select(
      `${SHIPMENT_COLUMNS},
       job:jobs(id, job_number),
       job_operation:job_operations(id, operation_name, sequence),
       job_part:job_parts(id, quantity, part:parts(id, part_name)),
       receipts:outside_shipment_receipts(${RECEIPT_COLUMNS})`,
    )
    .eq('id', shipmentId)
    .single();

  if (error || !data) throw toFriendlyError(error, { entity: 'shipment' });

  const row = data as unknown as OutsideShipmentWithRelations;
  return {
    ...row,
    shipped_by_member: await fetchShipperMember(row.company_id, row.created_by),
  };
}

/** Resolved at read time from user_company_access — `created_by` is an auth id, not a name. */
async function fetchShipperMember(
  companyId: string,
  userId: string | null,
): Promise<{ id: string; name: string | null } | null> {
  if (!userId) return null;
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('user_company_access')
    .select('user_id, name')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.warn('fetchShipperMember failed:', error);
    return null;
  }
  return data ? { id: data.user_id, name: data.name } : null;
}

/** Every slip for one operation, newest first. Voided ones included — they print VOIDED. */
export async function getOutsideShipmentsForOperation(
  jobOperationId: string,
): Promise<OutsideShipmentWithRelations[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('outside_shipments')
    .select(`${SHIPMENT_COLUMNS}, receipts:outside_shipment_receipts(${RECEIPT_COLUMNS})`)
    .eq('job_operation_id', jobOperationId)
    .order('shipped_at', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw toFriendlyError(error, { entity: 'shipment' });
  return (data ?? []) as unknown as OutsideShipmentWithRelations[];
}

/** Slips with something still at the vendor, OLDEST FIRST (FIFO — chase order). */
export async function getOpenOutsideShipments(
  jobOperationId: string,
): Promise<(OutsideShipment & { outstanding: number })[]> {
  const all = await getOutsideShipmentsForOperation(jobOperationId);
  return all
    .filter((s) => !s.voided_at)
    .map((s) => {
      const back = (s.receipts ?? [])
        .filter((r) => !r.voided_at)
        .reduce((n, r) => n + Number(r.quantity_good) + Number(r.quantity_scrapped), 0);
      return { ...s, outstanding: roundQty(Math.max(0, Number(s.quantity) - back)) };
    })
    .filter((s) => s.outstanding > 0)
    .sort((a, b) => compareOutsideShipmentOrder(a, b));
}

/** Every slip on one job, newest first — the job toolbar menu. */
export async function getOutsideShipmentsForJob(
  jobId: string,
): Promise<OutsideShipmentWithRelations[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('outside_shipments')
    .select(
      `${SHIPMENT_COLUMNS},
       job_operation:job_operations(id, operation_name, sequence),
       job_part:job_parts(id, quantity, part:parts(id, part_name)),
       receipts:outside_shipment_receipts(${RECEIPT_COLUMNS})`,
    )
    .eq('job_id', jobId)
    .order('shipped_at', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw toFriendlyError(error, { entity: 'shipment' });
  return (data ?? []) as unknown as OutsideShipmentWithRelations[];
}

/**
 * THE QUANTITY LEDGER, for every operation on one job_part in one pass.
 *
 * Keyed on the PART, not one operation, so `OperationsPanel` loads a whole part
 * without an N+1 — exactly parallel to `getOperationCompletionSummaries`.
 *
 * Totals are re-rounded after each accumulation: a chain of binary float adds
 * otherwise leaves 29.999999999999996, which prints as "30" while still testing
 * `> 0` and lighting up a "still at the vendor" caption for a slip that is closed.
 */
export async function getOutsideSummariesForPart(
  jobPartId: string,
): Promise<OutsideOperationSummary[]> {
  const supabase = getSupabase();

  const { data: ops, error: opErr } = await supabase
    .from('job_operations')
    .select('id, vendor_service_id, job_part:job_parts(quantity)')
    .eq('job_part_id', jobPartId);
  if (opErr) throw toFriendlyError(opErr, { entity: 'operation' });

  const outsideOps = (ops ?? []).filter((o) =>
    isOutsideOperation(o as { vendor_service_id?: string | null }),
  );
  if (!outsideOps.length) return [];

  const opIds = outsideOps.map((o) => o.id);

  const [{ data: ships, error: sErr }, { data: receipts, error: rErr }] = await Promise.all([
    supabase
      .from('outside_shipments')
      .select('job_operation_id, quantity, shipped_at, due_back_on, id')
      .in('job_operation_id', opIds)
      .is('voided_at', null),
    supabase
      .from('outside_shipment_receipts')
      .select('job_operation_id, outside_shipment_id, quantity_good, quantity_scrapped')
      .in('job_operation_id', opIds)
      .is('voided_at', null),
  ]);
  if (sErr) throw toFriendlyError(sErr, { entity: 'shipment' });
  if (rErr) throw toFriendlyError(rErr, { entity: 'receipt' });

  const backBySlip = new Map<string, number>();
  for (const r of receipts ?? []) {
    const n = (backBySlip.get(r.outside_shipment_id) ?? 0) +
      Number(r.quantity_good) + Number(r.quantity_scrapped);
    backBySlip.set(r.outside_shipment_id, roundQty(n));
  }

  return outsideOps.map((op) => {
    const ordered = Number(
      (op as { job_part?: { quantity: number } | null }).job_part?.quantity ?? 0,
    );
    const mySlips = (ships ?? []).filter((s) => s.job_operation_id === op.id);
    const myReceipts = (receipts ?? []).filter((r) => r.job_operation_id === op.id);

    let sent = 0;
    for (const s of mySlips) sent = roundQty(sent + Number(s.quantity));
    let good = 0;
    let scrapped = 0;
    for (const r of myReceipts) {
      good = roundQty(good + Number(r.quantity_good));
      scrapped = roundQty(scrapped + Number(r.quantity_scrapped));
    }

    const openSlips = mySlips.filter(
      (s) => Number(s.quantity) - (backBySlip.get(s.id) ?? 0) > 0,
    );
    const openDates = openSlips.map((s) => s.shipped_at).sort();
    const dueDates = openSlips
      .map((s) => s.due_back_on)
      .filter((d): d is string => Boolean(d))
      .sort();

    return {
      job_operation_id: op.id,
      qty_ordered: ordered,
      qty_sent: sent,
      qty_good: good,
      qty_scrapped: scrapped,
      qty_at_vendor: roundQty(Math.max(0, sent - good - scrapped)),
      qty_to_send: roundQty(Math.max(0, ordered - sent)),
      oldest_open_shipped_at: openDates[0] ?? null,
      earliest_due_back_on: dueDates[0] ?? null,
      open_slip_count: openSlips.length,
    };
  });
}

/**
 * Total order over one operation's slips: ship date, then created_at as an
 * INSTANT, then id.
 *
 * `created_at` is parsed rather than string-compared because PostgREST renders a
 * variable number of fractional digits — `…:56.7+00:00` sorts after
 * `…:56.68+00:00` as text and before it as a time.
 */
export function compareOutsideShipmentOrder(
  a: Pick<OutsideShipment, 'id' | 'shipped_at' | 'created_at'>,
  b: Pick<OutsideShipment, 'id' | 'shipped_at' | 'created_at'>,
): number {
  const byShip = Date.parse(a.shipped_at) - Date.parse(b.shipped_at);
  if (byShip !== 0) return byShip;
  const byCreated = Date.parse(a.created_at) - Date.parse(b.created_at);
  if (byCreated !== 0) return byCreated;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * How much went out on the slips issued BEFORE this one — the slip's own
 * point-in-time backlog.
 *
 * Deliberately separate from `getOutsideSummariesForPart`, which sums every slip
 * including later ones and so structurally cannot answer this. Opening slip 1
 * after slip 2 exists must still read what was open when slip 1 was written.
 */
export async function getSentBeforeShipment(
  shipment: Pick<OutsideShipment, 'id' | 'job_operation_id' | 'shipped_at' | 'created_at'>,
): Promise<number> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('outside_shipments')
    .select('id, quantity, shipped_at, created_at')
    .eq('job_operation_id', shipment.job_operation_id)
    .is('voided_at', null);

  // A failed read is not "zero prior". Reporting 0 here would print a slip
  // claiming nothing had gone out yet.
  if (error) throw toFriendlyError(error, { entity: 'shipment' });

  let total = 0;
  for (const s of data ?? []) {
    if (s.id === shipment.id) continue;
    if (compareOutsideShipmentOrder(s, shipment) < 0) total = roundQty(total + Number(s.quantity));
  }
  return total;
}

/**
 * The cross-job register. A LIST read, so it filters archived and cancelled jobs
 * out through the joined parent — `outside_shipments` has no `deleted_at` of its
 * own, exactly as `getOutsideOpsForCompany` does it.
 */
export async function listOutsideShipmentsForCompany(
  companyId: string,
  filters: OutsideShipmentFilters = {},
): Promise<OutsideShipmentWithRelations[]> {
  const supabase = getSupabase();
  let q = supabase
    .from('outside_shipments')
    .select(
      `${SHIPMENT_COLUMNS},
       job:jobs!inner(id, job_number, deleted_at, production_status),
       job_operation:job_operations(id, operation_name, sequence),
       job_part:job_parts(id, quantity, part:parts(id, part_name)),
       receipts:outside_shipment_receipts(${RECEIPT_COLUMNS})`,
    )
    .eq('company_id', companyId)
    .is('job.deleted_at', null)
    .neq('job.production_status', 'cancelled');

  if (filters.vendorId) q = q.eq('vendor_id', filters.vendorId);
  if (filters.startDate) q = q.gte('shipped_at', filters.startDate);
  if (filters.endDate) q = q.lte('shipped_at', filters.endDate);
  if (filters.voided === true) q = q.not('voided_at', 'is', null);
  else if (filters.voided !== 'all') q = q.is('voided_at', null);

  const { data, error } = await q
    .order('shipped_at', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw toFriendlyError(error, { entity: 'shipment' });

  let rows = (data ?? []) as unknown as OutsideShipmentWithRelations[];
  if (filters.openOnly) rows = rows.filter((s) => outstandingOn(s) > 0);
  return rows;
}

/** What is still at the vendor on one slip. Shared so the grid and the card agree. */
export function outstandingOn(
  s: Pick<OutsideShipmentWithRelations, 'quantity' | 'voided_at' | 'receipts'>,
): number {
  if (s.voided_at) return 0;
  const back = (s.receipts ?? [])
    .filter((r) => !r.voided_at)
    .reduce((n, r) => n + Number(r.quantity_good) + Number(r.quantity_scrapped), 0);
  return roundQty(Math.max(0, Number(s.quantity) - back));
}

/**
 * Where a vendor's parts go.
 *
 * REFUSES TO GUESS when a vendor has more than one address, the same stance
 * `pickCarrierAccount` takes. This is load-bearing rather than fussy: a vendor's
 * second address is as likely to be an accounts-receivable desk as a second
 * plant, and auto-picking one would send a pallet of parts to a mailroom.
 */
export async function resolveVendorShipTo(vendorId: string): Promise<{
  address: { id: string; label: string } | null;
  choices: { id: string; label: string }[];
  requiresChoice: boolean;
}> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('vendor_addresses')
    .select('id, address_line1, address_line2, city, state, postal_code, is_default')
    .eq('vendor_id', vendorId)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: true });
  if (error) throw toFriendlyError(error, { entity: 'address' });

  const choices = (data ?? []).map((a) => ({
    id: a.id,
    label: [a.address_line1, a.city, a.state].filter(Boolean).join(', ') || 'Address',
  }));
  const def = (data ?? []).find((a) => a.is_default);

  if (def) return { address: choices.find((c) => c.id === def.id) ?? null, choices, requiresChoice: false };
  if (choices.length === 1) return { address: choices[0], choices, requiresChoice: false };
  if (choices.length > 1) return { address: null, choices, requiresChoice: true };
  return { address: null, choices: [], requiresChoice: false };
}

export type { OutsideShipmentReceipt };
