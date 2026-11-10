/**
 * Requests for quotation TO VENDORS — the browser access layer (plan §3.9, §5.3 "Access layer").
 *
 * Every write is an RPC (`create_vendor_rfq`, `save_vendor_rfq`, `set_vendor_rfq_state`,
 * `set_vendor_rfq_invitation_state`, `save_vendor_rfq_responses`, `award_vendor_rfq`); the
 * browser can only read these tables. Reads take the status from `vendor_rfq_status`. Lists filter
 * archived RFQs out; a by-id read finds an archived one. The comparison is the pure
 * `lib/purchasing/rfqCompare.ts`, fed here with the caller's date.
 */
import { z } from 'zod';

import { getSupabase } from '@/lib/supabase';
import type { Json } from '@/types/database';
import { compareVendorRfq as buildComparison, type RfqComparison } from '@/lib/purchasing/rfqCompare';
import { VENDOR_RFQ_STATUSES, type VendorRfqStatus } from '@/lib/purchasing/vendorPoStatus';
import { orIlikeValue } from '@/utils/searchFilter';
import {
  chunkIds,
  parseAddressSnapshot,
  parseContactSnapshot,
  parsePurchasingResult,
  preparePurchaseUnits,
  present,
  purchasingReadFailure,
  purchasingRpcFailure,
  textOrNull,
  type PurchaseUnitRequest,
} from '@/utils/purchasingShared';
import {
  VENDOR_RFQ_MAX_QUANTITIES,
  type AwardVendorRfqResult,
  type CreateVendorRfqInput,
  type CreateVendorRfqResult,
  type SaveVendorRfqInput,
  type SaveVendorRfqResponsesResult,
  type SaveVendorRfqResult,
  type VendorRfqAction,
  type VendorRfqChanges,
  type VendorRfqDetail,
  type VendorRfqInvitationAction,
  type VendorRfqInvitationStateResult,
  type VendorRfqLineWrite,
  type VendorRfqListFilters,
  type VendorRfqListResult,
  type VendorRfqListRow,
  type VendorRfqResponseInput,
  type VendorRfqStateResult,
} from '@/types/vendorRfq';

const ENTITY = 'RFQ';

type JsonObject = { [key: string]: Json };

function rfqStatus(value: string | null | undefined, what: string): VendorRfqStatus {
  const s = present(value, what);
  return (VENDOR_RFQ_STATUSES as readonly string[]).includes(s)
    ? (s as VendorRfqStatus)
    : present<VendorRfqStatus>(null, `${what} (unknown status "${s}")`);
}

const num = (v: number | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

// ------------------------------------------------------------------------------------------------
// Reads
// ------------------------------------------------------------------------------------------------

const LIST_COLUMNS =
  'id, rfq_number, title, status, needed_by_on, respond_by_on, closed_at, line_count, awarded_line_count, invited_count, sent_count, declined_count, responded_count, created_at, updated_at';

/** The RFQ list (the hub's RFQs tab): live RFQs, newest first, with who was asked. */
export async function listVendorRfqs(companyId: string, filters: VendorRfqListFilters = {}): Promise<VendorRfqListResult> {
  const limit = Math.max(1, Math.min(filters.limit ?? 200, 1000));
  const op = 'load the RFQs';
  let q = getSupabase()
    .from('vendor_rfq_status')
    .select(LIST_COLUMNS, { count: 'exact' })
    .eq('company_id', companyId)
    .is('deleted_at', null);
  if (filters.statuses?.length) q = q.in('status', [...filters.statuses]);
  const search = textOrNull(filters.search);
  if (search) q = q.or(`rfq_number.ilike.${orIlikeValue(search)},title.ilike.${orIlikeValue(search)}`);

  const { data, error, count } = await q
    .order('created_at', { ascending: false })
    .order('id', { ascending: true })
    .limit(limit);
  if (error) throw purchasingReadFailure(error, op, ENTITY);
  const rows = data ?? [];

  const names = new Map<string, string[]>();
  const rfqIds = rows.map((r) => present(r.id, 'an RFQ'));
  for (const chunk of chunkIds(rfqIds)) {
    const res = await getSupabase()
      .from('vendor_rfq_invitations')
      .select('vendor_rfq_id, vendor_name')
      .in('vendor_rfq_id', chunk)
      .order('vendor_name', { ascending: true });
    if (res.error) throw purchasingReadFailure(res.error, op, ENTITY);
    for (const inv of res.data ?? []) {
      names.set(inv.vendor_rfq_id, [...(names.get(inv.vendor_rfq_id) ?? []), inv.vendor_name]);
    }
  }

  const out: VendorRfqListRow[] = rows.map((r) => {
    const id = present(r.id, 'an RFQ');
    return {
      id,
      rfqNumber: present(r.rfq_number, 'an RFQ'),
      title: r.title,
      status: rfqStatus(r.status, 'an RFQ'),
      neededByOn: r.needed_by_on,
      respondByOn: r.respond_by_on,
      closedAt: r.closed_at,
      lineCount: num(r.line_count),
      awardedLineCount: num(r.awarded_line_count),
      invitedCount: num(r.invited_count),
      sentCount: num(r.sent_count),
      declinedCount: num(r.declined_count),
      respondedCount: num(r.responded_count),
      vendorNames: names.get(id) ?? [],
      createdAt: present(r.created_at, 'an RFQ'),
      updatedAt: present(r.updated_at, 'an RFQ'),
    };
  });
  const total = count ?? out.length;
  return { rows: out, total, truncated: total > out.length };
}

/**
 * One RFQ with its lines, invitations, responses and the comparison. BY ID: an archived RFQ still
 * resolves. `null` when the caller cannot see it.
 */
export async function getVendorRfq(rfqId: string, options: { today: string }): Promise<VendorRfqDetail | null> {
  const supabase = getSupabase();
  const op = 'load the RFQ';
  const headerRes = await supabase
    .from('vendor_rfqs')
    .select(
      'id, company_id, rfq_number, title, needed_by_on, respond_by_on, notes_to_vendors, internal_notes, terms_and_conditions, ship_to_name, ship_to_address, closed_at, closed_reason, created_at, updated_at, deleted_at',
    )
    .eq('id', rfqId)
    .maybeSingle();
  if (headerRes.error) throw purchasingReadFailure(headerRes.error, op, ENTITY);
  const h = headerRes.data;
  if (!h) return null;

  const [statusRes, linesRes, invitationsRes, responsesRes] = await Promise.all([
    supabase
      .from('vendor_rfq_status')
      .select('status, line_count, awarded_line_count, invited_count, sent_count, declined_count, responded_count')
      .eq('id', rfqId)
      .maybeSingle(),
    supabase
      .from('vendor_rfq_lines')
      .select('id, line_number, part_id, part_name, description, unit, quantities, job_id, job_number, cert_required, notes')
      .eq('vendor_rfq_id', rfqId)
      .order('line_number', { ascending: true }),
    supabase
      .from('vendor_rfq_invitations')
      .select(
        'id, vendor_id, vendor_name, vendor_contact_id, vendor_contact, sent_at, declined_at, declined_reason, vendor_quote_reference, quoted_on',
      )
      .eq('vendor_rfq_id', rfqId)
      .order('vendor_name', { ascending: true }),
    supabase
      .from('vendor_rfq_responses')
      .select(
        'id, vendor_rfq_invitation_id, vendor_rfq_line_id, quantity, unit_price, no_bid, lead_time_days, minimum_order_quantity, valid_until, vendor_part_number, notes, awarded_at, vendor_purchase_order_line_id',
      )
      .eq('vendor_rfq_id', rfqId),
  ]);
  if (statusRes.error) throw purchasingReadFailure(statusRes.error, op, ENTITY);
  if (linesRes.error) throw purchasingReadFailure(linesRes.error, op, ENTITY);
  if (invitationsRes.error) throw purchasingReadFailure(invitationsRes.error, op, ENTITY);
  if (responsesRes.error) throw purchasingReadFailure(responsesRes.error, op, ENTITY);
  const s = present(statusRes.data, 'the RFQ status');

  const lines = (linesRes.data ?? []).map((l) => ({
    id: l.id,
    lineNumber: l.line_number,
    partId: l.part_id,
    partName: l.part_name,
    description: l.description,
    unit: l.unit,
    quantities: (l.quantities ?? []).map(Number),
    jobId: l.job_id,
    jobNumber: l.job_number,
    certRequired: l.cert_required,
    notes: l.notes,
  }));
  const invitations = (invitationsRes.data ?? []).map((i) => ({
    id: i.id,
    vendorId: i.vendor_id,
    vendorName: i.vendor_name,
    vendorContactId: i.vendor_contact_id,
    vendorContact: parseContactSnapshot(i.vendor_contact, `${i.vendor_name}'s contact on ${h.rfq_number}`),
    sentAt: i.sent_at,
    declinedAt: i.declined_at,
    declinedReason: i.declined_reason,
    vendorQuoteReference: i.vendor_quote_reference,
    quotedOn: i.quoted_on,
  }));
  const responses = (responsesRes.data ?? []).map((r) => ({
    id: r.id,
    invitationId: r.vendor_rfq_invitation_id,
    lineId: r.vendor_rfq_line_id,
    quantity: Number(r.quantity),
    unitPrice: numOrNull(r.unit_price),
    noBid: r.no_bid,
    leadTimeDays: r.lead_time_days,
    minimumOrderQuantity: numOrNull(r.minimum_order_quantity),
    validUntil: r.valid_until,
    vendorPartNumber: r.vendor_part_number,
    notes: r.notes,
    awardedAt: r.awarded_at,
    vendorPurchaseOrderLineId: r.vendor_purchase_order_line_id,
  }));

  const detail: Omit<VendorRfqDetail, 'comparison'> = {
    header: {
      id: h.id,
      companyId: h.company_id,
      rfqNumber: h.rfq_number,
      title: h.title,
      neededByOn: h.needed_by_on,
      respondByOn: h.respond_by_on,
      notesToVendors: h.notes_to_vendors,
      internalNotes: h.internal_notes,
      termsAndConditions: h.terms_and_conditions,
      shipToName: h.ship_to_name,
      shipToAddress: parseAddressSnapshot(h.ship_to_address, `${h.rfq_number}'s ship-to address`),
      closedAt: h.closed_at,
      closedReason: h.closed_reason,
      createdAt: h.created_at,
      updatedAt: h.updated_at,
      deletedAt: h.deleted_at,
      isArchived: h.deleted_at !== null,
    },
    status: rfqStatus(s.status, 'the RFQ status'),
    lineCount: num(s.line_count),
    awardedLineCount: num(s.awarded_line_count),
    invitedCount: num(s.invited_count),
    sentCount: num(s.sent_count),
    declinedCount: num(s.declined_count),
    respondedCount: num(s.responded_count),
    lines,
    invitations,
    responses,
  };
  return { ...detail, comparison: compareVendorRfq(detail, options.today) };
}

/**
 * The comparison matrix for a loaded RFQ (pure): rows are line × quantity, columns the invited
 * vendors; "Lowest" is a word on the cell, an expired quote is never Lowest, a tie goes to the
 * shorter lead time. `today` is the caller's local date.
 */
export function compareVendorRfq(
  rfq: Pick<VendorRfqDetail, 'lines' | 'invitations' | 'responses'>,
  today: string,
): RfqComparison {
  return buildComparison({
    lines: rfq.lines.map((l) => ({
      lineId: l.id,
      lineNumber: l.lineNumber,
      label: l.partName ?? l.description,
      unit: l.unit,
      quantities: l.quantities,
    })),
    vendors: rfq.invitations.map((i) => ({
      invitationId: i.id,
      vendorId: i.vendorId,
      vendorName: i.vendorName,
      declined: i.declinedAt !== null,
    })),
    responses: rfq.responses.map((r) => ({
      responseId: r.id,
      invitationId: r.invitationId,
      lineId: r.lineId,
      quantity: r.quantity,
      unitPrice: r.unitPrice,
      noBid: r.noBid,
      leadTimeDays: r.leadTimeDays,
      validUntil: r.validUntil,
      awarded: r.awardedAt !== null,
    })),
    today,
  });
}

// ------------------------------------------------------------------------------------------------
// Payloads
// ------------------------------------------------------------------------------------------------

function changesJson(changes: VendorRfqChanges | undefined): JsonObject {
  const out: JsonObject = {};
  if (!changes) return out;
  if (changes.title !== undefined) out.title = changes.title;
  if (changes.neededByOn !== undefined) out.needed_by_on = changes.neededByOn;
  if (changes.respondByOn !== undefined) out.respond_by_on = changes.respondByOn;
  if (changes.notesToVendors !== undefined) out.notes_to_vendors = changes.notesToVendors;
  if (changes.internalNotes !== undefined) out.internal_notes = changes.internalNotes;
  if (changes.termsAndConditions !== undefined) out.terms_and_conditions = changes.termsAndConditions;
  return out;
}

function isPatch(line: VendorRfqLineWrite): line is Extract<VendorRfqLineWrite, { id: string }> {
  return typeof (line as { id?: unknown }).id === 'string';
}

function lineJson(line: VendorRfqLineWrite, unit: string | undefined): JsonObject {
  const out: JsonObject = {};
  if (isPatch(line)) out.id = line.id;
  if (line.partId !== undefined) out.part_id = line.partId;
  if (line.description !== undefined) out.description = line.description;
  if (unit !== undefined) out.unit = unit;
  else if (line.unit !== undefined) out.unit = line.unit;
  if (line.quantities !== undefined) out.quantities = line.quantities;
  if (line.jobId !== undefined) out.job_id = line.jobId;
  if (line.certRequired !== undefined) out.cert_required = line.certRequired;
  if (line.notes !== undefined) out.notes = line.notes;
  return out;
}

/** The quantity rule, refused with the RPC's own sentences before a round trip. */
function checkQuantities(lines: readonly VendorRfqLineWrite[]): void {
  lines.forEach((line, index) => {
    if (line.quantities === undefined) return;
    const label = isPatch(line) ? 'That line' : `Line ${index + 1}`;
    if (line.quantities.length < 1 || line.quantities.length > VENDOR_RFQ_MAX_QUANTITIES) {
      throw new Error(`${label} needs one to four quantities to price.`);
    }
    if (line.quantities.some((q) => !Number.isFinite(q) || q <= 0)) {
      throw new Error('Quantities must be greater than zero.');
    }
    if (new Set(line.quantities).size !== line.quantities.length) {
      throw new Error('Each quantity can be asked for once on a line.');
    }
  });
}

/** Part lines' units, stored as conversions first (an award turns a line into a PO line). */
async function prepareRfqUnits(rfqId: string | null, lines: readonly VendorRfqLineWrite[]): Promise<Array<string | undefined>> {
  const stored = new Map<string, string | null>();
  const unknownPart = lines.flatMap((l) => (isPatch(l) && l.unit && l.partId === undefined ? [l.id] : []));
  if (rfqId && unknownPart.length > 0) {
    const { data, error } = await getSupabase()
      .from('vendor_rfq_lines')
      .select('id, part_id')
      .eq('vendor_rfq_id', rfqId)
      .in('id', unknownPart);
    if (error) throw purchasingReadFailure(error, 'read the RFQ lines', ENTITY);
    for (const row of data ?? []) stored.set(row.id, row.part_id);
  }
  const requests: PurchaseUnitRequest[] = [];
  lines.forEach((line, index) => {
    if (!line.unit || line.unit.trim() === '') return;
    const partId = line.partId ?? (isPatch(line) ? stored.get(line.id) : null) ?? null;
    if (!partId) return; // an ad-hoc line's unit is free text
    requests.push({ key: String(index), partId, unit: line.unit, unitFactor: line.unitFactor ?? null });
  });
  const resolved = await preparePurchaseUnits(requests);
  return lines.map((_, index) => resolved.get(String(index)));
}

// ------------------------------------------------------------------------------------------------
// Writes
// ------------------------------------------------------------------------------------------------

const statusOrNull = z
  .enum(VENDOR_RFQ_STATUSES)
  .nullish()
  .transform((v) => v ?? null);
const stringList = z
  .array(z.string())
  .nullish()
  .transform((v) => v ?? []);

const createResultSchema = z
  .array(z.object({ id: z.string(), rfq_number: z.string() }))
  .min(1)
  .transform((rows): CreateVendorRfqResult => ({ id: rows[0].id, rfqNumber: rows[0].rfq_number }));

/** A new draft RFQ (`create_vendor_rfq`, the fixed RFQ- series) with its lines and invited vendors. */
export async function createVendorRfq(companyId: string, input: CreateVendorRfqInput): Promise<CreateVendorRfqResult> {
  if (input.lines.length === 0) throw new Error('Add at least one line to the RFQ.');
  checkQuantities(input.lines);
  const units = await prepareRfqUnits(null, input.lines);
  const { data, error } = await getSupabase().rpc('create_vendor_rfq', {
    p_company_id: companyId,
    p_header: changesJson(input.header),
    p_lines: input.lines.map((line, i) => lineJson(line, units[i])),
    p_vendor_ids: [...new Set(input.vendorIds.filter(Boolean))],
  });
  if (error) throw purchasingRpcFailure(error, 'create the RFQ', ENTITY);
  return parsePurchasingResult(createResultSchema, data, 'create the RFQ');
}

const saveResultSchema = z
  .object({
    id: z.string(),
    rfq_number: z.string(),
    status: statusOrNull,
    line_ids: stringList,
    invitation_ids: stringList,
    updated_at: z.string(),
  })
  .transform(
    (r): SaveVendorRfqResult => ({
      id: r.id,
      rfqNumber: r.rfq_number,
      status: r.status,
      lineIds: r.line_ids,
      invitationIds: r.invitation_ids,
      updatedAt: r.updated_at,
    }),
  );

/**
 * Save an RFQ (`save_vendor_rfq`), PATCH semantics: header keys, new lines (no id), patches to
 * existing lines, removed lines and invitations (unquoted only), vendors to invite.
 * `expectedUpdatedAt` is passed through exactly as read.
 */
export async function saveVendorRfq(rfqId: string, input: SaveVendorRfqInput): Promise<SaveVendorRfqResult> {
  const lines = input.lines ?? [];
  checkQuantities(lines);
  const units = await prepareRfqUnits(rfqId, lines);
  const { data, error } = await getSupabase().rpc('save_vendor_rfq', {
    p_id: rfqId,
    p_changes: changesJson(input.changes),
    p_lines: lines.map((line, i) => lineJson(line, units[i])),
    p_removed_line_ids: [...new Set(input.removedLineIds ?? [])],
    p_add_vendor_ids: [...new Set(input.addVendorIds ?? [])],
    p_removed_invitation_ids: [...new Set(input.removedInvitationIds ?? [])],
    p_expected_updated_at: input.expectedUpdatedAt ?? undefined,
  });
  if (error) throw purchasingRpcFailure(error, 'save the RFQ', ENTITY);
  return parsePurchasingResult(saveResultSchema, data, 'save the RFQ');
}

const stateResultSchema = z
  .object({
    id: z.string(),
    rfq_number: z.string(),
    action: z.enum(['close', 'reopen', 'archive']),
    status: statusOrNull,
    deleted_at: z
      .string()
      .nullish()
      .transform((v) => v ?? null),
  })
  .transform(
    (r): VendorRfqStateResult => ({
      id: r.id,
      rfqNumber: r.rfq_number,
      action: r.action,
      status: r.status,
      deletedAt: r.deleted_at,
    }),
  );

/** Close, reopen or archive an RFQ (archive is never blocked). */
export async function setVendorRfqState(
  rfqId: string,
  action: VendorRfqAction,
  reason?: string | null,
): Promise<VendorRfqStateResult> {
  const op = `${action} the RFQ`;
  const { data, error } = await getSupabase().rpc('set_vendor_rfq_state', {
    p_id: rfqId,
    p_action: action,
    p_reason: textOrNull(reason) ?? undefined,
  });
  if (error) throw purchasingRpcFailure(error, op, ENTITY);
  return parsePurchasingResult(stateResultSchema, data, op);
}

const invitationResultSchema = z
  .object({
    id: z.string(),
    vendor_rfq_id: z.string(),
    action: z.enum(['mark_sent', 'decline', 'undo_decline']),
    status: statusOrNull,
  })
  .transform(
    (r): VendorRfqInvitationStateResult => ({
      invitationId: r.id,
      vendorRfqId: r.vendor_rfq_id,
      action: r.action,
      status: r.status,
    }),
  );

/** For one invited vendor: Mark sent (the PDF goes by mailto), Declined, or undo the decline. */
export async function setVendorRfqInvitationState(
  invitationId: string,
  action: VendorRfqInvitationAction,
  reason?: string | null,
): Promise<VendorRfqInvitationStateResult> {
  const op = action === 'mark_sent' ? 'mark the RFQ sent' : action === 'decline' ? 'record the decline' : 'undo the decline';
  const { data, error } = await getSupabase().rpc('set_vendor_rfq_invitation_state', {
    p_id: invitationId,
    p_action: action,
    p_reason: textOrNull(reason) ?? undefined,
  });
  if (error) throw purchasingRpcFailure(error, op, ENTITY);
  return parsePurchasingResult(invitationResultSchema, data, op);
}

const responsesResultSchema = z
  .object({
    invitation_id: z.string(),
    vendor_rfq_id: z.string(),
    response_ids: stringList,
    status: statusOrNull,
  })
  .transform(
    (r): SaveVendorRfqResponsesResult => ({
      invitationId: r.invitation_id,
      vendorRfqId: r.vendor_rfq_id,
      responseIds: r.response_ids,
      status: r.status,
    }),
  );

/**
 * Record one vendor's quote (`save_vendor_rfq_responses`). Send the vendor's WHOLE quote: answers
 * it no longer contains are removed (awarded ones are frozen and kept). A price is per the RFQ
 * line's unit; a No bid has none. `vendorQuoteReference`: undefined keeps it, null or '' clears it.
 */
export async function saveVendorRfqResponses(
  invitationId: string,
  responses: readonly VendorRfqResponseInput[],
  options: { vendorQuoteReference?: string | null; quotedOn?: string | null } = {},
): Promise<SaveVendorRfqResponsesResult> {
  const payload: JsonObject[] = responses.map((r) => {
    const out: JsonObject = { line_id: r.lineId, quantity: r.quantity, no_bid: Boolean(r.noBid) };
    if (!r.noBid && r.unitPrice !== undefined) out.unit_price = r.unitPrice;
    if (r.leadTimeDays !== undefined) out.lead_time_days = r.leadTimeDays;
    if (r.minimumOrderQuantity !== undefined) out.minimum_order_quantity = r.minimumOrderQuantity;
    if (r.validUntil !== undefined) out.valid_until = r.validUntil;
    if (r.vendorPartNumber !== undefined) out.vendor_part_number = r.vendorPartNumber;
    if (r.notes !== undefined) out.notes = r.notes;
    return out;
  });
  const { data, error } = await getSupabase().rpc('save_vendor_rfq_responses', {
    p_invitation_id: invitationId,
    p_responses: payload,
    p_vendor_quote_reference:
      options.vendorQuoteReference === undefined ? undefined : (options.vendorQuoteReference ?? ''),
    p_quoted_on: options.quotedOn ?? undefined,
  });
  if (error) throw purchasingRpcFailure(error, 'save the quote', ENTITY);
  return parsePurchasingResult(responsesResultSchema, data, 'save the quote');
}

const awardResultSchema = z
  .object({
    vendor_rfq_id: z.string(),
    purchase_orders: z.array(
      z.object({
        id: z.string(),
        po_number: z.string(),
        vendor_id: z.string(),
        vendor_name: z.string(),
        line_ids: stringList,
      }),
    ),
    awarded_response_ids: stringList,
    saved_part_vendor_ids: stringList,
    status: statusOrNull,
  })
  .transform(
    (r): AwardVendorRfqResult => ({
      vendorRfqId: r.vendor_rfq_id,
      purchaseOrders: r.purchase_orders.map((p) => ({
        id: p.id,
        poNumber: p.po_number,
        vendorId: p.vendor_id,
        vendorName: p.vendor_name,
        lineIds: p.line_ids,
      })),
      awardedResponseIds: r.awarded_response_ids,
      savedPartVendorIds: r.saved_part_vendor_ids,
      status: r.status,
    }),
  );

/**
 * Award quotes BY RESPONSE ID (one per line), atomically: one draft PO per vendor, ad-hoc lines as
 * Other lines, priced per the line unit with price_source `rfq`. `saveToPriceSheets` (off unless
 * asked) also writes those quotes as the vendor's price sheet for each awarded part.
 */
export async function awardVendorRfq(
  rfqId: string,
  responseIds: readonly string[],
  options: { saveToPriceSheets: boolean; today: string },
): Promise<AwardVendorRfqResult> {
  const unique = [...new Set(responseIds.filter(Boolean))];
  if (unique.length === 0) throw new Error('Choose a quote for at least one line.');
  const { data, error } = await getSupabase().rpc('award_vendor_rfq', {
    p_rfq_id: rfqId,
    p_response_ids: unique,
    p_save_to_price_sheets: options.saveToPriceSheets,
    p_today: options.today,
  });
  if (error) throw purchasingRpcFailure(error, 'award the RFQ', ENTITY);
  return parsePurchasingResult(awardResultSchema, data, 'award the RFQ');
}

