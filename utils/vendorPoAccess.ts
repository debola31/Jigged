/**
 * Purchase orders TO A VENDOR — the browser access layer (plan §3, §5.3 "Access layer").
 *
 * EVERY WRITE IS AN RPC. The browser holds SELECT only on every purchasing table; the SECURITY
 * DEFINER functions derive the company, refuse operators, check the billing gate, lock the header
 * and scope every id to the document (supabase/migrations/20261110043800). The one table this file
 * writes is `parts_unit_conversions`, and only through `preparePurchaseUnits`: a purchase unit must
 * be stored as the part's conversion before the RPC can freeze its factor (plan §3.5).
 *
 * READS come from the views, so status, progress, amounts and the QuickBooks state are computed
 * once in SQL; this file only adds `isLate`, through the pinned TypeScript mirror of
 * `is_vendor_purchase_order_late` with the CALLER's local date. Lists filter `deleted_at`; by-id
 * reads do not (an archived PO opened by id renders read-only with a banner).
 *
 * The MCP tools call these same functions with the same arguments the UI passes.
 */
import type { QueryData } from '@supabase/supabase-js';
import { z } from 'zod';

import { getSupabase } from '@/lib/supabase';
import type { Json } from '@/types/database';
import { isVendorPoLate, LATE_ELIGIBLE_STATUSES } from '@/lib/purchasing/late';
import { roundUnitPrice } from '@/lib/purchasing/amount';
import {
  defaultOutsideLinePrice,
  defaultPartLinePrice,
  partVendorLineNotice,
  type LastPurchaseCandidate,
  type PriceSheet,
} from '@/lib/purchasing/priceDefault';
import { defaultPurchaseUnit } from '@/lib/purchasing/purchaseUnits';
import {
  PART_VENDOR_STATUSES,
  VENDOR_PO_LINE_STATUSES,
  VENDOR_PO_QUICKBOOKS_STATES,
  VENDOR_PO_STATUSES,
  isVendorPoLineStatus,
  isVendorPoStatus,
  type PartVendorStatus,
  type VendorPoLineStatus,
  type VendorPoQuickBooksState,
  type VendorPoStatus,
} from '@/lib/purchasing/vendorPoStatus';
import { VENDOR_PO_PRICE_SOURCES, type VendorPoPriceSource } from '@/lib/purchasing/priceDefault';
import { escapeIlikePattern } from '@/utils/searchFilter';
import {
  chunkIds,
  firstRow,
  isPurchasingRefusal,
  one,
  parseAddressSnapshot,
  parseContactSnapshot,
  parsePurchasingResult,
  preparePurchaseUnits,
  present,
  purchasingReadFailure,
  purchasingRpcFailure,
  resolvePartUnit,
  textOrNull,
  type PurchaseUnitRequest,
} from '@/utils/purchasingShared';
import {
  VENDOR_PO_DEFAULT_SORT,
  VENDOR_PO_LIST_LIMIT,
  type CreateVendorPoInput,
  type CreateVendorPoResult,
  type NoPoStockAddition,
  type OpenOutsideOperation,
  type PartOnOrder,
  type PartOnOrderRef,
  type ReceiveVendorPoInput,
  type RelinkOutsideShipmentResult,
  type UpdateVendorPoInput,
  type VendorPoArchiveImpact,
  type VendorPoDetail,
  type VendorPoDuplicateResult,
  type VendorPoHeader,
  type VendorPoHeaderChanges,
  type VendorPoHeaderInput,
  type VendorPoJobLine,
  type VendorPoLine,
  type VendorPoLineKind,
  type VendorPoLinePriceResolution,
  type VendorPoLineWrite,
  type VendorPoListFilters,
  type VendorPoListResult,
  type VendorPoListRow,
  type VendorPoNewLineInput,
  type VendorPoOutsideSlip,
  type VendorPoPartLine,
  type VendorPoPartLinesResult,
  type VendorPoPriceDefaultInputs,
  type VendorPoQuickBooksInfo,
  type VendorPoReceipt,
  type VendorPoReceiptFilters,
  type VendorPoReceiptListResult,
  type VendorPoReceiptListRow,
  type VendorPoReceiveResult,
  type VendorPoSaveResult,
  type VendorPoShipToInput,
  type VendorPoShipToKind,
  type VendorPoStateResult,
  type VendorPoSummary,
  type VendorPoUnlinkedSlip,
  type VendorPoVoidReceiptResult,
} from '@/types/vendorPo';

const ENTITY = 'purchase order';

type JsonObject = { [key: string]: Json };

// ------------------------------------------------------------------------------------------------
// Small parsers for the values the views hand back
// ------------------------------------------------------------------------------------------------

function poStatus(value: string | null | undefined, what: string): VendorPoStatus {
  const s = present(value, what);
  if (!isVendorPoStatus(s)) return present<VendorPoStatus>(null, `${what} (unknown status "${s}")`);
  return s;
}

function lineStatus(value: string | null | undefined, what: string): VendorPoLineStatus {
  const s = present(value, what);
  if (!isVendorPoLineStatus(s)) return present<VendorPoLineStatus>(null, `${what} (unknown status "${s}")`);
  return s;
}

function quickBooksState(value: string | null | undefined, what: string): VendorPoQuickBooksState {
  const s = present(value, what);
  const known = (VENDOR_PO_QUICKBOOKS_STATES as readonly string[]).includes(s);
  if (!known) return present<VendorPoQuickBooksState>(null, `${what} (unknown QuickBooks state "${s}")`);
  return s as VendorPoQuickBooksState;
}

function lineKind(value: string | null | undefined, what: string): VendorPoLineKind {
  const s = present(value, what);
  if (s !== 'part' && s !== 'outside_service' && s !== 'other') {
    return present<VendorPoLineKind>(null, `${what} (unknown line kind "${s}")`);
  }
  return s;
}

function priceSource(value: string | null | undefined): VendorPoPriceSource | null {
  if (value === null || value === undefined) return null;
  return (VENDOR_PO_PRICE_SOURCES as readonly string[]).includes(value) ? (value as VendorPoPriceSource) : null;
}

function shipToKind(value: string, what: string): VendorPoShipToKind {
  if (value !== 'shop' && value !== 'vendor' && value !== 'customer') {
    return present<VendorPoShipToKind>(null, `${what} (unknown ship-to "${value}")`);
  }
  return value;
}

function partVendorStatus(value: string): PartVendorStatus {
  return (PART_VENDOR_STATUSES as readonly string[]).includes(value)
    ? (value as PartVendorStatus)
    : present<PartVendorStatus>(null, `an approved-vendor status ("${value}")`);
}

const num = (value: number | null | undefined): number => (value === null || value === undefined ? 0 : Number(value));
const numOrNull = (value: number | null | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);

/** The receipt group id for one delivery. Mint ONCE when the receive dialog opens. */
export function newVendorPoReceiptGroupId(): string {
  return globalThis.crypto.randomUUID();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ------------------------------------------------------------------------------------------------
// The list
// ------------------------------------------------------------------------------------------------

const LIST_COLUMNS =
  'id, company_id, po_number, vendor_id, vendor_name, status, ordered_on, need_by_on, next_expected_on, revision, sent_revision, has_unsent_changes, issued_at, last_sent_at, closed_at, line_count, outstanding_line_count, ordered_amount, open_amount, has_unpriced_lines, quickbooks_state, job_ids, job_numbers, vendor_rfq_id, created_at, updated_at, is_archived';

const listQuery = () =>
  getSupabase().from('vendor_purchase_order_status').select(LIST_COLUMNS, { count: 'exact' });
type ListViewRow = QueryData<ReturnType<typeof listQuery>>[number];

function toListRow(row: ListViewRow, today: string): VendorPoListRow {
  const what = 'a purchase order from the list';
  const status = poStatus(row.status, what);
  return {
    id: present(row.id, what),
    companyId: present(row.company_id, what),
    poNumber: present(row.po_number, what),
    vendorId: present(row.vendor_id, what),
    vendorName: present(row.vendor_name, what),
    status,
    orderedOn: present(row.ordered_on, what),
    needByOn: row.need_by_on,
    nextExpectedOn: row.next_expected_on,
    isLate: isVendorPoLate(status, row.next_expected_on, today),
    revision: num(row.revision),
    sentRevision: numOrNull(row.sent_revision),
    hasUnsentChanges: Boolean(row.has_unsent_changes),
    issuedAt: row.issued_at,
    lastSentAt: row.last_sent_at,
    closedAt: row.closed_at,
    lineCount: num(row.line_count),
    outstandingLineCount: num(row.outstanding_line_count),
    orderedAmount: num(row.ordered_amount),
    openAmount: num(row.open_amount),
    hasUnpricedLines: Boolean(row.has_unpriced_lines),
    quickbooksState: quickBooksState(row.quickbooks_state, what),
    jobIds: row.job_ids ?? [],
    jobNumbers: row.job_numbers ?? [],
    vendorRfqId: row.vendor_rfq_id,
    createdAt: present(row.created_at, what),
    updatedAt: present(row.updated_at, what),
    isArchived: Boolean(row.is_archived),
  };
}

/** The PO statuses that can be late (a PO's, not a line's). */
const LATE_PO_STATUSES = VENDOR_PO_STATUSES.filter((s) => LATE_ELIGIBLE_STATUSES.includes(s));

async function runList(
  scope: { companyId?: string; vendorId?: string | null },
  filters: VendorPoListFilters,
): Promise<VendorPoListResult> {
  let statuses: readonly VendorPoStatus[] | null = filters.statuses?.length ? filters.statuses : null;
  if (filters.overdueOnly) {
    // The late predicate, as a filter: still owed something, and expected before the CALLER's
    // date. The status list is the predicate's own (lib/purchasing/late.ts), not a copy.
    statuses = (statuses ?? VENDOR_PO_STATUSES).filter((s) => LATE_PO_STATUSES.includes(s));
    if (statuses.length === 0) return { rows: [], total: 0, truncated: false };
  }

  const limit = Math.max(1, Math.min(filters.limit ?? VENDOR_PO_LIST_LIMIT, 1000));
  const offset = Math.max(0, filters.offset ?? 0);
  const sort = filters.sort ?? VENDOR_PO_DEFAULT_SORT;

  let q = listQuery().is('deleted_at', null);
  if (scope.companyId) q = q.eq('company_id', scope.companyId);
  const vendorId = scope.vendorId ?? filters.vendorId;
  if (vendorId) q = q.eq('vendor_id', vendorId);
  if (statuses) q = q.in('status', [...statuses]);
  if (filters.overdueOnly) q = q.lt('next_expected_on', filters.today);
  if (filters.jobId) q = q.contains('job_ids', [filters.jobId]);
  const search = textOrNull(filters.search);
  if (search) q = q.ilike('search_text', `%${escapeIlikePattern(search)}%`);
  if (filters.quickbooksStates?.length) q = q.in('quickbooks_state', [...filters.quickbooksStates]);

  const { data, error, count } = await q
    .order(sort.field, { ascending: sort.direction === 'asc', nullsFirst: false })
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw purchasingReadFailure(error, 'load purchase orders', ENTITY);

  const rows = (data ?? []).map((r) => toListRow(r, filters.today));
  const total = count ?? offset + rows.length;
  return { rows, total, truncated: total > offset + rows.length };
}

/**
 * The PO list (the Purchasing hub's Orders tab). Live POs only, sorted on the server by a real
 * view column (default: next due, soonest first), with the total so a capped page can say so.
 */
export async function listVendorPos(companyId: string, filters: VendorPoListFilters): Promise<VendorPoListResult> {
  return runList({ companyId }, filters);
}

/** One vendor's live POs, newest first — the vendor page's Purchase orders card. */
export async function listVendorPosForVendor(
  vendorId: string,
  options: { today: string; limit?: number; statuses?: readonly VendorPoStatus[] },
): Promise<VendorPoListResult> {
  return runList(
    { vendorId },
    {
      today: options.today,
      limit: options.limit,
      statuses: options.statuses,
      sort: { field: 'created_at', direction: 'desc' },
    },
  );
}

// ------------------------------------------------------------------------------------------------
// One PO
// ------------------------------------------------------------------------------------------------

const HEADER_COLUMNS =
  'id, company_id, po_number, vendor_id, vendor_name, vendor_address_id, vendor_address, vendor_contact_id, vendor_contact, ship_to_kind, ship_to_vendor_id, ship_to_vendor_address_id, ship_to_customer_id, ship_to_customer_address_id, ship_to_name, ship_to_address, ordered_on, need_by_on, payment_terms, ship_via, notes_to_vendor, internal_notes, terms_and_conditions, revision, sent_revision, issued_at, last_sent_at, content_version, closed_at, closed_reason, vendor_rfq_id, created_at, updated_at, deleted_at';

const headerQuery = (id: string) =>
  getSupabase().from('vendor_purchase_orders').select(HEADER_COLUMNS).eq('id', id).maybeSingle();
type HeaderRow = QueryData<ReturnType<typeof headerQuery>>;

function toHeader(row: HeaderRow): VendorPoHeader {
  return {
    id: row.id,
    companyId: row.company_id,
    poNumber: row.po_number,
    vendorId: row.vendor_id,
    vendorName: row.vendor_name,
    vendorAddressId: row.vendor_address_id,
    vendorAddress: parseAddressSnapshot(row.vendor_address, `${row.po_number}'s vendor address`),
    vendorContactId: row.vendor_contact_id,
    vendorContact: parseContactSnapshot(row.vendor_contact, `${row.po_number}'s vendor contact`),
    shipToKind: shipToKind(row.ship_to_kind, row.po_number),
    shipToVendorId: row.ship_to_vendor_id,
    shipToVendorAddressId: row.ship_to_vendor_address_id,
    shipToCustomerId: row.ship_to_customer_id,
    shipToCustomerAddressId: row.ship_to_customer_address_id,
    shipToName: row.ship_to_name,
    shipToAddress: parseAddressSnapshot(row.ship_to_address, `${row.po_number}'s ship-to address`),
    orderedOn: row.ordered_on,
    needByOn: row.need_by_on,
    paymentTerms: row.payment_terms,
    shipVia: row.ship_via,
    notesToVendor: row.notes_to_vendor,
    internalNotes: row.internal_notes,
    termsAndConditions: row.terms_and_conditions,
    revision: row.revision,
    sentRevision: row.sent_revision,
    issuedAt: row.issued_at,
    lastSentAt: row.last_sent_at,
    contentVersion: row.content_version,
    closedAt: row.closed_at,
    closedReason: row.closed_reason,
    vendorRfqId: row.vendor_rfq_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    isArchived: row.deleted_at !== null,
  };
}

const SUMMARY_COLUMNS =
  'id, status, next_expected_on, line_count, outstanding_line_count, ordered_amount, open_amount, has_unpriced_lines, has_unsent_changes, quickbooks_state, job_ids, job_numbers';
const summaryQuery = (id: string) =>
  getSupabase().from('vendor_purchase_order_status').select(SUMMARY_COLUMNS).eq('id', id).maybeSingle();
type SummaryRow = QueryData<ReturnType<typeof summaryQuery>>;

function toSummary(row: SummaryRow, today: string): VendorPoSummary {
  const what = 'the purchase order status';
  const status = poStatus(row.status, what);
  return {
    status,
    isLate: isVendorPoLate(status, row.next_expected_on, today),
    nextExpectedOn: row.next_expected_on,
    lineCount: num(row.line_count),
    outstandingLineCount: num(row.outstanding_line_count),
    orderedAmount: num(row.ordered_amount),
    openAmount: num(row.open_amount),
    hasUnpricedLines: Boolean(row.has_unpriced_lines),
    hasUnsentChanges: Boolean(row.has_unsent_changes),
    quickbooksState: quickBooksState(row.quickbooks_state, what),
    jobIds: row.job_ids ?? [],
    jobNumbers: row.job_numbers ?? [],
  };
}

const LINE_COLUMNS =
  'id, vendor_purchase_order_id, po_number, vendor_id, line_number, line_kind, part_id, part_name, description, vendor_part_number, quantity, unit, stock_unit, stock_factor, unit_price, price_source, amount, open_amount, need_by_on, promised_on, expected_on, cert_required, expects_receipt, job_id, job_number, job_part_id, job_operation_id, operation_label, vendor_service_id, service_name, work_center_id, work_center_name, closed_at, status, ordered_stock_quantity, received_quantity, received_stock_quantity, remaining_quantity, remaining_stock_quantity, open_quantity, open_stock_quantity, over_received_quantity, sent_quantity, at_vendor_quantity, linked_slip_count, created_at, updated_at, is_archived';
const linesQuery = () => getSupabase().from('vendor_purchase_order_line_status').select(LINE_COLUMNS);
type LineRow = QueryData<ReturnType<typeof linesQuery>>[number];

function toLine(row: LineRow, today: string, receiptCountByLine: Map<string, number>): VendorPoLine {
  const what = 'a purchase order line';
  const id = present(row.id, what);
  const status = lineStatus(row.status, what);
  const receivedQuantity = num(row.received_quantity);
  return {
    id,
    vendorPurchaseOrderId: present(row.vendor_purchase_order_id, what),
    lineNumber: present(row.line_number, what),
    lineKind: lineKind(row.line_kind, what),
    partId: row.part_id,
    partName: row.part_name,
    description: present(row.description, what),
    vendorPartNumber: row.vendor_part_number,
    quantity: num(present(row.quantity, what)),
    unit: present(row.unit, what),
    stockUnit: row.stock_unit,
    stockFactor: numOrNull(row.stock_factor),
    unitPrice: numOrNull(row.unit_price),
    priceSource: priceSource(row.price_source),
    amount: numOrNull(row.amount),
    openAmount: numOrNull(row.open_amount),
    needByOn: row.need_by_on,
    promisedOn: row.promised_on,
    expectedOn: row.expected_on,
    certRequired: Boolean(row.cert_required),
    expectsReceipt: row.expects_receipt !== false,
    jobId: row.job_id,
    jobNumber: row.job_number,
    jobPartId: row.job_part_id,
    jobOperationId: row.job_operation_id,
    operationLabel: row.operation_label,
    vendorServiceId: row.vendor_service_id,
    serviceName: row.service_name,
    workCenterId: row.work_center_id,
    workCenterName: row.work_center_name,
    closedAt: row.closed_at,
    status,
    isLate: isVendorPoLate(status, row.expected_on, today),
    orderedStockQuantity: numOrNull(row.ordered_stock_quantity),
    receivedQuantity,
    receivedStockQuantity: numOrNull(row.received_stock_quantity),
    remainingQuantity: num(row.remaining_quantity),
    remainingStockQuantity: numOrNull(row.remaining_stock_quantity),
    openQuantity: num(row.open_quantity),
    openStockQuantity: numOrNull(row.open_stock_quantity),
    overReceivedQuantity: num(row.over_received_quantity),
    sentQuantity: numOrNull(row.sent_quantity),
    atVendorQuantity: numOrNull(row.at_vendor_quantity),
    linkedSlipCount: num(row.linked_slip_count),
    hasLiveReceipts: receivedQuantity > 0,
    // The RPC refuses to remove a line with ANY receipt (a voided one too: the ledger points at
    // it) or with good pieces back on a linked slip.
    removable: (receiptCountByLine.get(id) ?? 0) === 0 && receivedQuantity === 0,
    createdAt: present(row.created_at, what),
    updatedAt: present(row.updated_at, what),
  };
}

const RECEIPT_COLUMNS =
  'id, vendor_purchase_order_id, vendor_purchase_order_line_id, line_kind, receipt_group_id, entry_index, quantity, unit, stock_quantity, stock_unit, part_id, location_id, location_name, lot_id, lot_code, heat_number, started_tracking, inventory_transaction_id, void_transaction_id, vendor_packing_slip, notes, received_at, received_by, voided_at, void_reason';
const receiptsQuery = () => getSupabase().from('vendor_purchase_order_receipts').select(RECEIPT_COLUMNS);
type ReceiptRow = QueryData<ReturnType<typeof receiptsQuery>>[number];

function toReceipt(
  row: ReceiptRow,
  lineNumbers: Map<string, number>,
  names: Map<string, string | null>,
): VendorPoReceipt {
  return {
    id: row.id,
    vendorPurchaseOrderLineId: row.vendor_purchase_order_line_id,
    lineNumber: lineNumbers.get(row.vendor_purchase_order_line_id) ?? null,
    lineKind: row.line_kind === 'part' ? 'part' : 'other',
    receiptGroupId: row.receipt_group_id,
    entryIndex: row.entry_index,
    quantity: Number(row.quantity),
    unit: row.unit,
    stockQuantity: numOrNull(row.stock_quantity),
    stockUnit: row.stock_unit,
    partId: row.part_id,
    locationId: row.location_id,
    locationName: row.location_name,
    lotId: row.lot_id,
    lotCode: row.lot_code,
    heatNumber: row.heat_number,
    startedTracking: row.started_tracking,
    inventoryTransactionId: row.inventory_transaction_id,
    voidTransactionId: row.void_transaction_id,
    vendorPackingSlip: row.vendor_packing_slip,
    notes: row.notes,
    receivedAt: row.received_at,
    receivedByName: row.received_by ? (names.get(row.received_by) ?? null) : null,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
  };
}

const SLIP_COLUMNS =
  'id, slip_number, vendor_purchase_order_line_id, job_id, job_operation_id, quantity, shipped_at, due_back_on, closed_at, voided_at, outside_shipment_receipts(quantity_good, voided_at)';
const slipsQuery = () => getSupabase().from('outside_shipments').select(SLIP_COLUMNS);
type SlipRow = QueryData<ReturnType<typeof slipsQuery>>[number];

/** A slip and what came back on it, linked or not. */
function toSlipFigures(row: SlipRow): VendorPoUnlinkedSlip {
  const received = (row.outside_shipment_receipts ?? [])
    .filter((r) => !r.voided_at)
    .reduce((n, r) => n + Number(r.quantity_good), 0);
  const quantity = Number(row.quantity);
  return {
    id: row.id,
    slipNumber: row.slip_number,
    jobId: row.job_id,
    jobOperationId: row.job_operation_id,
    quantity,
    shippedAt: row.shipped_at,
    dueBackOn: row.due_back_on,
    closedAt: row.closed_at,
    voidedAt: row.voided_at,
    receivedQuantity: received,
    outstandingQuantity: row.voided_at || row.closed_at ? 0 : Math.max(0, quantity - received),
  };
}

function toSlip(row: SlipRow): VendorPoOutsideSlip {
  return {
    ...toSlipFigures(row),
    vendorPurchaseOrderLineId: present(row.vendor_purchase_order_line_id, 'a linked slip'),
  };
}

const QB_LINK_COLUMNS = 'id, provider, status, qb_doc_number, qb_url, qb_closed, pushed_revision, pushed_at, updated_at';

const LINK_STATUSES = ['pending', 'created', 'error', 'needs_verification'] as const;

async function readQuickBooksLink(poId: string) {
  const { data, error } = await getSupabase()
    .from('quickbooks_purchase_order_links')
    .select(QB_LINK_COLUMNS)
    .eq('vendor_purchase_order_id', poId)
    .order('updated_at', { ascending: false })
    .limit(1);
  if (error) throw purchasingReadFailure(error, 'load the purchase order', ENTITY);
  return firstRow(data);
}

async function memberNames(companyId: string, userIds: string[]): Promise<Map<string, string | null>> {
  const names = new Map<string, string | null>();
  if (userIds.length === 0) return names;
  const { data, error } = await getSupabase()
    .from('user_company_access')
    .select('user_id, name')
    .eq('company_id', companyId)
    .in('user_id', userIds);
  // A name is decoration on a receipt row: a failed lookup shows no name, never blocks the PO.
  if (error) return names;
  for (const m of data ?? []) names.set(m.user_id, m.name);
  return names;
}

/**
 * One PO with its lines, receipts, linked slips and QuickBooks link. BY ID, so an archived PO still
 * resolves (it renders read-only with a banner). `null` when the caller cannot see it.
 */
export async function getVendorPo(poId: string, options: { today: string }): Promise<VendorPoDetail | null> {
  const op = 'load the purchase order';
  const { data: headerRow, error: headerError } = await headerQuery(poId);
  if (headerError) throw purchasingReadFailure(headerError, op, ENTITY);
  if (!headerRow) return null;

  const supabase = getSupabase();
  const [summaryRes, linesRes, receiptsRes, revisionsRes, link] = await Promise.all([
    summaryQuery(poId),
    linesQuery().eq('vendor_purchase_order_id', poId).order('line_number', { ascending: true }),
    receiptsQuery()
      .eq('vendor_purchase_order_id', poId)
      .order('received_at', { ascending: false })
      .order('entry_index', { ascending: true }),
    supabase
      .from('vendor_purchase_order_revisions')
      .select('id', { count: 'exact', head: true })
      .eq('vendor_purchase_order_id', poId),
    readQuickBooksLink(poId),
  ]);
  if (summaryRes.error) throw purchasingReadFailure(summaryRes.error, op, ENTITY);
  if (linesRes.error) throw purchasingReadFailure(linesRes.error, op, ENTITY);
  if (receiptsRes.error) throw purchasingReadFailure(receiptsRes.error, op, ENTITY);
  if (revisionsRes.error) throw purchasingReadFailure(revisionsRes.error, op, ENTITY);

  const lineRows = linesRes.data ?? [];
  const receiptRows = receiptsRes.data ?? [];
  const outsideLineIds = lineRows
    .filter((l) => l.line_kind === 'outside_service' && l.id)
    .map((l) => present(l.id, 'an outside line'));
  const receiverIds = [...new Set(receiptRows.map((r) => r.received_by).filter((v): v is string => Boolean(v)))];

  const [slipsRes, names] = await Promise.all([
    outsideLineIds.length > 0
      ? slipsQuery().in('vendor_purchase_order_line_id', outsideLineIds).order('shipped_at', { ascending: true })
      : Promise.resolve({ data: [] as SlipRow[], error: null }),
    memberNames(headerRow.company_id, receiverIds),
  ]);
  if (slipsRes.error) throw purchasingReadFailure(slipsRes.error, op, ENTITY);

  const receiptCountByLine = new Map<string, number>();
  for (const r of receiptRows) {
    receiptCountByLine.set(r.vendor_purchase_order_line_id, (receiptCountByLine.get(r.vendor_purchase_order_line_id) ?? 0) + 1);
  }
  const lines = lineRows.map((l) => toLine(l, options.today, receiptCountByLine));
  const lineNumbers = new Map(lines.map((l) => [l.id, l.lineNumber]));
  const summary = toSummary(present(summaryRes.data, 'the purchase order status'), options.today);

  const quickbooks: VendorPoQuickBooksInfo = {
    state: summary.quickbooksState,
    linkId: link?.id ?? null,
    provider: link?.provider === 'qbo' || link?.provider === 'qbd' ? link.provider : null,
    linkStatus: link && (LINK_STATUSES as readonly string[]).includes(link.status)
      ? (link.status as VendorPoQuickBooksInfo['linkStatus'])
      : null,
    docNumber: link?.qb_doc_number ?? null,
    url: link?.qb_url ?? null,
    closedInQuickBooks: Boolean(link?.qb_closed),
    pushedRevision: link?.pushed_revision ?? null,
    pushedAt: link?.pushed_at ?? null,
  };

  return {
    header: toHeader(headerRow),
    summary,
    lines,
    receipts: receiptRows.map((r) => toReceipt(r, lineNumbers, names)),
    outsideSlips: (slipsRes.data ?? []).map(toSlip),
    revisionCount: revisionsRes.count ?? 0,
    quickbooks,
  };
}

// ------------------------------------------------------------------------------------------------
// Payloads for the write RPCs (patch semantics: undefined is left out, null is sent)
// ------------------------------------------------------------------------------------------------

function shipToJson(shipTo: VendorPoShipToInput): JsonObject {
  // Only the side the kind names: a form that toggled from "Another vendor" to "A customer" may
  // still hold the vendor ids, and the RPC refuses ids on the wrong side.
  if (shipTo.kind === 'vendor') {
    const out: JsonObject = { kind: 'vendor', vendor_id: shipTo.vendorId ?? null };
    if (shipTo.vendorAddressId !== undefined) out.vendor_address_id = shipTo.vendorAddressId;
    return out;
  }
  if (shipTo.kind === 'customer') {
    const out: JsonObject = { kind: 'customer', customer_id: shipTo.customerId ?? null };
    if (shipTo.customerAddressId !== undefined) out.customer_address_id = shipTo.customerAddressId;
    return out;
  }
  return { kind: 'shop' };
}

/** A create's header is a save's changes without the two keys only a save may send. */
function headerJson(header: VendorPoHeaderChanges | undefined): JsonObject {
  const out: JsonObject = {};
  if (!header) return out;
  if (header.vendorId !== undefined) out.vendor_id = header.vendorId;
  if (header.orderedOn !== undefined) out.ordered_on = header.orderedOn;
  if (header.vendorContactId !== undefined) out.vendor_contact_id = header.vendorContactId;
  if (header.vendorAddressId !== undefined) out.vendor_address_id = header.vendorAddressId;
  if (header.shipTo !== undefined) out.ship_to = shipToJson(header.shipTo);
  if (header.needByOn !== undefined) out.need_by_on = header.needByOn;
  if (header.paymentTerms !== undefined) out.payment_terms = header.paymentTerms;
  if (header.shipVia !== undefined) out.ship_via = header.shipVia;
  if (header.notesToVendor !== undefined) out.notes_to_vendor = header.notesToVendor;
  if (header.internalNotes !== undefined) out.internal_notes = header.internalNotes;
  return out;
}

function isPatch(line: VendorPoLineWrite): line is Extract<VendorPoLineWrite, { id: string }> {
  return typeof (line as { id?: unknown }).id === 'string';
}

function lineJson(line: VendorPoLineWrite, unit: string | undefined): JsonObject {
  const out: JsonObject = {};
  if (isPatch(line)) {
    out.id = line.id;
  } else {
    // Kind and step are a NEW line's; an existing line keeps the ones it was made with.
    out.line_kind = line.lineKind;
    if (line.jobOperationId !== undefined) out.job_operation_id = line.jobOperationId;
  }
  if (line.partId !== undefined) out.part_id = line.partId;
  if (line.jobId !== undefined) out.job_id = line.jobId;
  if (line.jobPartId !== undefined) out.job_part_id = line.jobPartId;
  if (line.workCenterId !== undefined) out.work_center_id = line.workCenterId;
  if (line.description !== undefined) out.description = line.description;
  if (line.vendorPartNumber !== undefined) out.vendor_part_number = line.vendorPartNumber;
  if (line.quantity !== undefined) out.quantity = line.quantity;
  if (unit !== undefined) out.unit = unit;
  else if (line.unit !== undefined) out.unit = line.unit;
  // At the stored five places, so the amount shown before saving is the amount after it.
  if (line.unitPrice !== undefined) out.unit_price = line.unitPrice === null ? null : roundUnitPrice(line.unitPrice);
  if (line.priceSource !== undefined) out.price_source = line.priceSource;
  if (line.needByOn !== undefined) out.need_by_on = line.needByOn;
  if (line.promisedOn !== undefined) out.promised_on = line.promisedOn;
  if (line.certRequired !== undefined) out.cert_required = line.certRequired;
  if (line.expectsReceipt !== undefined) out.expects_receipt = line.expectsReceipt;
  return out;
}

/** Quantities the RPC would refuse, refused first with the same sentence and no round trip. */
function checkLineQuantities(lines: readonly VendorPoLineWrite[]): void {
  lines.forEach((line, index) => {
    if (line.quantity === undefined) return;
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
      const label = isPatch(line) ? 'That line' : `Line ${index + 1}`;
      throw new Error(`${label} needs a quantity greater than zero.`);
    }
  });
}

/**
 * The units to send for part lines, after every non-stock unit is stored as a conversion. A patch
 * that changes the unit is resolved against the line as stored: its kind (fixed) and, unless the
 * patch names a new one, its part.
 */
async function prepareLineUnits(
  poId: string | null,
  lines: readonly VendorPoLineWrite[],
): Promise<Array<string | undefined>> {
  const ids = lines.flatMap((line) => (isPatch(line) && line.unit ? [line.id] : []));
  const stored = new Map<string, { partId: string | null; lineKind: string }>();
  if (poId && ids.length > 0) {
    const { data, error } = await getSupabase()
      .from('vendor_purchase_order_lines')
      .select('id, part_id, line_kind')
      .eq('vendor_purchase_order_id', poId)
      .in('id', ids);
    if (error) throw purchasingReadFailure(error, 'read the purchase order lines', ENTITY);
    for (const row of data ?? []) stored.set(row.id, { partId: row.part_id, lineKind: row.line_kind });
  }

  const requests: PurchaseUnitRequest[] = [];
  lines.forEach((line, index) => {
    if (line.unit === undefined || line.unit === null || line.unit.trim() === '') return;
    const prior = isPatch(line) ? stored.get(line.id) : undefined;
    const kind = isPatch(line) ? prior?.lineKind : line.lineKind;
    if (kind !== 'part') return; // outside lines use the part's own unit; other lines are free text
    const partId = line.partId ?? prior?.partId ?? null;
    if (!partId) return; // the RPC says "needs a part"
    requests.push({ key: String(index), partId, unit: line.unit, unitFactor: line.unitFactor ?? null });
  });

  const resolved = await preparePurchaseUnits(requests);
  return lines.map((_, index) => resolved.get(String(index)));
}

// ------------------------------------------------------------------------------------------------
// Result parsers (every jsonb result is parsed, never cast)
// ------------------------------------------------------------------------------------------------

const ids = z
  .array(z.string())
  .nullish()
  .transform((v) => v ?? []);
const poStatusOrNull = z
  .enum(VENDOR_PO_STATUSES)
  .nullish()
  .transform((v) => v ?? null);
const lineStatusOrNull = z
  .enum(VENDOR_PO_LINE_STATUSES)
  .nullish()
  .transform((v) => v ?? null);
const numberOrNull = z
  .number()
  .nullish()
  .transform((v) => v ?? null);
const stringOrNull = z
  .string()
  .nullish()
  .transform((v) => v ?? null);

const versionShape = {
  revision: z.number(),
  sent_revision: numberOrNull,
  revision_bumped: z.boolean().optional(),
  content_version: z.number(),
  content_changed: z.boolean(),
  updated_at: z.string(),
};

const createResultSchema = z
  .array(z.object({ id: z.string(), po_number: z.string() }))
  .min(1)
  .transform((rows): CreateVendorPoResult => ({ id: rows[0].id, poNumber: rows[0].po_number }));

const saveResultSchema = z
  .object({
    id: z.string(),
    po_number: z.string(),
    status: poStatusOrNull,
    line_ids: ids,
    linked_outside_shipment_ids: ids,
    unlinked_outside_shipment_ids: ids,
    ...versionShape,
  })
  .transform(
    (r): VendorPoSaveResult => ({
      id: r.id,
      poNumber: r.po_number,
      status: r.status,
      lineIds: r.line_ids,
      linkedOutsideShipmentIds: r.linked_outside_shipment_ids,
      unlinkedOutsideShipmentIds: r.unlinked_outside_shipment_ids,
      revision: r.revision,
      sentRevision: r.sent_revision,
      revisionBumped: Boolean(r.revision_bumped),
      contentVersion: r.content_version,
      contentChanged: r.content_changed,
      updatedAt: r.updated_at,
    }),
  );

const stateResultSchema = z
  .object({
    id: z.string(),
    po_number: z.string(),
    action: z.enum(['mark_sent', 'close', 'reopen', 'archive']),
    status: poStatusOrNull,
    deleted_at: stringOrNull,
    unlinked_outside_shipment_ids: ids,
    ...versionShape,
  })
  .transform(
    (r): VendorPoStateResult => ({
      id: r.id,
      poNumber: r.po_number,
      action: r.action,
      status: r.status,
      deletedAt: r.deleted_at,
      lineIds: [],
      unlinkedOutsideShipmentIds: r.unlinked_outside_shipment_ids,
      revision: r.revision,
      sentRevision: r.sent_revision,
      contentVersion: r.content_version,
      contentChanged: r.content_changed,
      updatedAt: r.updated_at,
    }),
  );

const lineStateResultSchema = z
  .object({
    id: z.string(),
    po_number: z.string(),
    action: z.enum(['close', 'reopen']),
    line_ids: ids,
    status: poStatusOrNull,
    ...versionShape,
  })
  .transform(
    (r): VendorPoStateResult => ({
      id: r.id,
      poNumber: r.po_number,
      action: r.action === 'close' ? 'close_lines' : 'reopen_lines',
      status: r.status,
      deletedAt: null,
      lineIds: r.line_ids,
      unlinkedOutsideShipmentIds: [],
      revision: r.revision,
      sentRevision: r.sent_revision,
      contentVersion: r.content_version,
      contentChanged: r.content_changed,
      updatedAt: r.updated_at,
    }),
  );

const receiveResultSchema = z
  .object({
    vendor_purchase_order_id: z.string(),
    receipt_group_id: z.string(),
    status: poStatusOrNull,
    closed_line_ids: ids,
    receipts: z.array(
      z.object({
        receipt_id: z.string(),
        entry_index: z.number(),
        line_id: z.string(),
        line_number: numberOrNull,
        line_kind: z.enum(['part', 'other']),
        quantity: z.number(),
        unit: z.string(),
        stock_quantity: numberOrNull,
        stock_unit: stringOrNull,
        part_id: stringOrNull,
        location_id: stringOrNull,
        location_name: stringOrNull,
        lot_id: stringOrNull,
        lot_code: stringOrNull,
        heat_number: stringOrNull,
        started_tracking: z.boolean(),
        transaction_id: stringOrNull,
        voided: z.boolean(),
        location_balance: numberOrNull,
        part_quantity: numberOrNull,
        line_status: lineStatusOrNull,
        over_received: z.boolean().nullish().transform((v) => Boolean(v)),
        over_received_quantity: numberOrNull,
      }),
    ),
  })
  .transform((r): VendorPoReceiveResult => {
    const receipts = r.receipts.map((x) => ({
      receiptId: x.receipt_id,
      entryIndex: x.entry_index,
      lineId: x.line_id,
      lineNumber: x.line_number,
      lineKind: x.line_kind,
      quantity: x.quantity,
      unit: x.unit,
      stockQuantity: x.stock_quantity,
      stockUnit: x.stock_unit,
      partId: x.part_id,
      locationId: x.location_id,
      locationName: x.location_name,
      lotId: x.lot_id,
      lotCode: x.lot_code,
      heatNumber: x.heat_number,
      startedTracking: x.started_tracking,
      transactionId: x.transaction_id,
      voided: x.voided,
      locationBalance: x.location_balance,
      partQuantity: x.part_quantity,
      lineStatus: x.line_status,
      overReceived: x.over_received,
      overReceivedQuantity: x.over_received_quantity ?? 0,
    }));
    return {
      vendorPurchaseOrderId: r.vendor_purchase_order_id,
      receiptGroupId: r.receipt_group_id,
      status: r.status,
      closedLineIds: r.closed_line_ids,
      receipts,
      landedLots: receipts.flatMap((x) =>
        x.lotId !== null && !x.voided
          ? [{ entryIndex: x.entryIndex, lineId: x.lineId, lotId: x.lotId, lotCode: x.lotCode, heatNumber: x.heatNumber }]
          : [],
      ),
    };
  });

const voidResultSchema = z
  .object({
    voided: z.boolean(),
    receipt_id: z.string(),
    void_transaction_id: stringOrNull,
    location_balance: numberOrNull,
    part_quantity: numberOrNull,
    status: poStatusOrNull,
  })
  .transform(
    (r): VendorPoVoidReceiptResult => ({
      voided: r.voided,
      receiptId: r.receipt_id,
      voidTransactionId: r.void_transaction_id,
      locationBalance: r.location_balance,
      partQuantity: r.part_quantity,
      status: r.status,
    }),
  );

const relinkResultSchema = z
  .object({
    outside_shipment_id: z.string(),
    slip_number: z.string(),
    vendor_purchase_order_line_id: stringOrNull,
  })
  .transform(
    (r): RelinkOutsideShipmentResult => ({
      outsideShipmentId: r.outside_shipment_id,
      slipNumber: r.slip_number,
      vendorPurchaseOrderLineId: r.vendor_purchase_order_line_id,
    }),
  );

// ------------------------------------------------------------------------------------------------
// Writes
// ------------------------------------------------------------------------------------------------

/**
 * A new DRAFT PO to a vendor (`create_vendor_purchase_order`). The number is minted by the RPC;
 * the vendor, contact, address, ship-to and terms & conditions are frozen there. Every non-stock
 * purchase unit is stored as the part's conversion first, so the RPC can freeze its factor.
 */
export async function createVendorPo(input: CreateVendorPoInput): Promise<CreateVendorPoResult> {
  if (input.lines.length === 0) throw new Error('Add at least one line to the purchase order.');
  checkLineQuantities(input.lines);
  const units = await prepareLineUnits(null, input.lines);

  const { data, error } = await getSupabase().rpc('create_vendor_purchase_order', {
    p_vendor_id: input.vendorId,
    p_ordered_on: input.orderedOn,
    p_today: input.today,
    p_header: headerJson(input.header),
    p_lines: input.lines.map((line, i) => lineJson(line, units[i])),
  });
  if (error) throw purchasingRpcFailure(error, 'create the purchase order', ENTITY);
  return parsePurchasingResult(createResultSchema, data, 'create the purchase order');
}

/**
 * Save changes to a PO (`save_vendor_purchase_order`), PATCH semantics: header keys and line keys
 * that are not given do not change; new lines carry no id; removed lines go in `removedLineIds`.
 *
 * `expectedUpdatedAt` is passed through EXACTLY as read — the database compares it only when the
 * vendor's copy would change. After a send, the first such change opens a new revision; the result
 * says so (`revisionBumped`).
 */
export async function updateVendorPo(poId: string, input: UpdateVendorPoInput): Promise<VendorPoSaveResult> {
  const lines = input.lines ?? [];
  checkLineQuantities(lines);
  const units = await prepareLineUnits(poId, lines);
  const removed = [...new Set((input.removedLineIds ?? []).filter(Boolean))];

  const { data, error } = await getSupabase().rpc('save_vendor_purchase_order', {
    p_id: poId,
    p_changes: headerJson(input.changes),
    p_lines: lines.map((line, i) => lineJson(line, units[i])),
    p_removed_line_ids: removed,
    p_expected_updated_at: input.expectedUpdatedAt ?? undefined,
    p_today: input.today,
  });
  if (error) throw purchasingRpcFailure(error, 'save the purchase order', ENTITY);
  return parsePurchasingResult(saveResultSchema, data, 'save the purchase order');
}

/** Internal notes: auto-saved, never printed, never a revision, allowed on a closed or archived PO. */
export async function setVendorPoInternalNotes(
  poId: string,
  notes: string | null,
  today: string,
): Promise<VendorPoSaveResult> {
  const { data, error } = await getSupabase().rpc('save_vendor_purchase_order', {
    p_id: poId,
    p_changes: { internal_notes: textOrNull(notes) },
    p_lines: [],
    p_removed_line_ids: [],
    p_today: today,
  });
  if (error) throw purchasingRpcFailure(error, 'save the internal notes', ENTITY);
  return parsePurchasingResult(saveResultSchema, data, 'save the internal notes');
}

/** A line's promised date: auto-saved, internal, never a revision, allowed on a closed PO. */
export async function setVendorPoLinePromisedOn(
  poId: string,
  lineId: string,
  promisedOn: string | null,
  today: string,
): Promise<VendorPoSaveResult> {
  const { data, error } = await getSupabase().rpc('save_vendor_purchase_order', {
    p_id: poId,
    p_changes: {},
    p_lines: [{ id: lineId, promised_on: promisedOn }],
    p_removed_line_ids: [],
    p_today: today,
  });
  if (error) throw purchasingRpcFailure(error, 'save the promised date', ENTITY);
  return parsePurchasingResult(saveResultSchema, data, 'save the promised date');
}

async function setState(
  poId: string,
  action: 'mark_sent' | 'close' | 'reopen' | 'archive',
  op: string,
  reason?: string | null,
  today?: string,
): Promise<VendorPoStateResult> {
  const { data, error } = await getSupabase().rpc('set_vendor_purchase_order_state', {
    p_id: poId,
    p_action: action,
    p_reason: textOrNull(reason) ?? undefined,
    p_today: today,
  });
  if (error) throw purchasingRpcFailure(error, op, ENTITY);
  return parsePurchasingResult(stateResultSchema, data, op);
}

/** "Mark as sent": stamps the send and snapshots exactly what the vendor got. Needs a line. */
export function markVendorPoSent(poId: string, today: string): Promise<VendorPoStateResult> {
  return setState(poId, 'mark_sent', 'mark the purchase order sent', null, today);
}

/** Archive ("Delete"): never blocked; unlinks its outside slips. QuickBooks is not touched. */
export function archiveVendorPo(poId: string): Promise<VendorPoStateResult> {
  return setState(poId, 'archive', 'archive the purchase order');
}

async function setLineState(
  poId: string,
  lineIds: string[] | 'all',
  action: 'close' | 'reopen',
  reason: string | null | undefined,
): Promise<VendorPoStateResult> {
  const op = action === 'close' ? 'close the purchase order lines' : 'reopen the purchase order lines';
  if (lineIds === 'all') return setState(poId, action, op.replace(' lines', ''), reason);
  const unique = [...new Set(lineIds.filter(Boolean))];
  if (unique.length === 0) throw new Error(`Choose the lines to ${action}.`);
  const { data, error } = await getSupabase().rpc('set_vendor_purchase_order_line_state', {
    p_id: poId,
    p_line_ids: unique,
    p_action: action,
    p_reason: textOrNull(reason) ?? undefined,
  });
  if (error) throw purchasingRpcFailure(error, op, ENTITY);
  return parsePurchasingResult(lineStateResultSchema, data, op);
}

/** Close lines short (a batch, atomically), or the whole PO with `'all'`. Never a revision. */
export function closeVendorPoLines(
  poId: string,
  lineIds: string[] | 'all',
  reason?: string | null,
): Promise<VendorPoStateResult> {
  return setLineState(poId, lineIds, 'close', reason);
}

/**
 * True when `closeVendorPoLines` was refused because line `lineNumber` has nothing left to receive —
 * it is received in full (`set_vendor_purchase_order_line_state`: "Line 2 has nothing left to
 * receive."). For a caller closing a line AFTER a receipt, that is the line done, not a failure.
 *
 * Told apart by its P0001 SENTENCE, read through the error plumbing: `purchasingRpcFailure` keeps the
 * code (`isPurchasingRefusal`) and the sentence as the message. The code alone is not enough — every
 * refusal these RPCs raise is a P0001 ("PO-1042 is closed. Reopen it first.") — so the whole sentence
 * is matched, for this line's number, never a fragment of it. The wording is the RPC's own
 * (`RAISE EXCEPTION 'Line % has nothing left to receive.'` in 20261110043800); change one and change
 * the other. A sentence that drifts fails safe: the close reads as not done, as it did before.
 */
export function isNothingLeftToReceiveRefusal(error: unknown, lineNumber: number): boolean {
  return isLineCloseRefusal(error, `Line ${lineNumber} has nothing left to receive.`);
}

/**
 * True when `closeVendorPoLines` was refused because line `lineNumber` is already closed
 * (`set_vendor_purchase_order_line_state`: "Line 2 is already closed.") — closed before this close
 * was sent, on the PO page or by another slip's "Also close". For a caller closing a line AFTER a
 * receipt, that is the line done too: nothing more is expected on it, which is what was asked.
 *
 * Told apart exactly as `isNothingLeftToReceiveRefusal` is: the P0001 code, and the whole sentence for
 * this line's number — a fragment would take the PO's own "PO-1042 is already closed." for the line's.
 * The wording is the RPC's (`RAISE EXCEPTION 'Line % is already closed.'` in 20261110043800); change
 * one and change the other. A sentence that drifts fails safe, as a close that did not happen.
 */
export function isAlreadyClosedRefusal(error: unknown, lineNumber: number): boolean {
  return isLineCloseRefusal(error, `Line ${lineNumber} is already closed.`);
}

/**
 * True when `closeVendorPoLines` was refused because the whole PO `poNumber` is closed
 * (`set_vendor_purchase_order_line_state`: "PO-1042 is closed. Reopen it first.") — closed on the PO
 * page before this close was sent, and refused before any line is looked at. For a caller closing a
 * line AFTER a receipt, that is the line done too: nothing more is expected on any line of a closed
 * PO, so "Reopen it first" would undo the very thing that was asked.
 *
 * Told apart exactly as the line refusals are: the P0001 code, and the whole sentence for this PO's
 * number. The wording is the RPC's (`RAISE EXCEPTION '% is closed. Reopen it first.'` in
 * 20261110043800); change one and change the other. A sentence that drifts fails safe, as a close
 * that did not happen.
 */
export function isPoClosedRefusal(error: unknown, poNumber: string): boolean {
  return isLineCloseRefusal(error, `${poNumber} is closed. Reopen it first.`);
}

/** A P0001 refusal from the line-state RPC whose sentence is exactly `sentence`. */
function isLineCloseRefusal(error: unknown, sentence: string): boolean {
  return isPurchasingRefusal(error) && error instanceof Error && error.message === sentence;
}

/** Reopen lines (a batch), or the whole PO with `'all'`. */
export function reopenVendorPoLines(poId: string, lineIds: string[] | 'all'): Promise<VendorPoStateResult> {
  return setLineState(poId, lineIds, 'reopen', null);
}

/**
 * Receive one delivery (`receive_vendor_purchase_order`): atomic and idempotent on
 * `receiptGroupId`. Quantities go EXACTLY as typed, with their `quantity_unit`; the RPC computes
 * the stock quantity with the line's frozen factor. Certificates upload AFTER this resolves,
 * against `landedLots`.
 */
export async function receiveVendorPo(poId: string, input: ReceiveVendorPoInput): Promise<VendorPoReceiveResult> {
  if (!UUID.test(input.receiptGroupId)) {
    throw new Error('Failed to receive: the delivery has no id. Close the dialog and open it again.');
  }
  if (input.entries.length === 0) throw new Error('Enter what arrived on at least one line.');

  const receipts: JsonObject[] = input.entries.map((e) => ({
    line_id: e.line_id,
    quantity: e.quantity,
    quantity_unit: e.quantity_unit,
    location_id: e.location_id,
    heat_number: e.heat_number,
    lot_id: e.lot_id,
    notes: e.notes,
    close_remaining: e.close_remaining,
  }));
  const { data, error } = await getSupabase().rpc('receive_vendor_purchase_order', {
    p_id: poId,
    p_receipt_group_id: input.receiptGroupId,
    p_receipts: receipts,
    p_received_at: input.receivedAt ?? undefined,
    p_vendor_packing_slip: textOrNull(input.vendorPackingSlip) ?? undefined,
    p_notes: textOrNull(input.notes) ?? undefined,
  });
  if (error) throw purchasingRpcFailure(error, 'receive against the purchase order', ENTITY);
  return parsePurchasingResult(receiveResultSchema, data, 'receive against the purchase order');
}

/** Void a receipt: the stock comes back out through the stock engine. Idempotent. */
export async function voidVendorPoReceipt(receiptId: string, reason?: string | null): Promise<VendorPoVoidReceiptResult> {
  const { data, error } = await getSupabase().rpc('void_vendor_purchase_order_receipt', {
    p_receipt_id: receiptId,
    p_reason: textOrNull(reason) ?? undefined,
  });
  if (error) throw purchasingRpcFailure(error, 'void the receipt', 'receipt');
  return parsePurchasingResult(voidResultSchema, data, 'void the receipt');
}

/**
 * Relink a vendor packing slip to an outside line of a PO (same step, same vendor), or unlink it
 * with `null`. The rare correction: slips link themselves when they are sent.
 */
export async function relinkOutsideShipment(
  outsideShipmentId: string,
  vendorPurchaseOrderLineId: string | null,
): Promise<RelinkOutsideShipmentResult> {
  const { data, error } = await getSupabase().rpc('set_outside_shipment_vendor_purchase_order_line', {
    p_outside_shipment_id: outsideShipmentId,
    // Omitted, the argument is NULL: that is the unlink.
    p_vendor_purchase_order_line_id: vendorPurchaseOrderLineId ?? undefined,
  });
  if (error) throw purchasingRpcFailure(error, 'link the slip to the purchase order', 'slip');
  return parsePurchasingResult(relinkResultSchema, data, 'link the slip to the purchase order');
}

/**
 * The slips "Link a slip…" offers an outside line (the PO page): its step's LIVE slips to the PO's
 * vendor that ship against no line — the same set the line's insert links by itself (plan §3.6), for
 * the slip that missed it or was unlinked by hand. A slip on another line is not offered: it is
 * unlinked on its own PO first, where the person can see what leaving costs that line.
 *
 * Company-scoped, and scoped to one step — the line's own — so the job is the line's job. Voided
 * slips are left out (the relink refuses them, and they count for nothing); a short-closed slip is
 * live and offered, since what came back on it is real. Oldest first, as slips are chased.
 */
export async function listUnlinkedOutsideSlips(
  companyId: string,
  jobOperationId: string,
  vendorId: string,
): Promise<VendorPoUnlinkedSlip[]> {
  const { data, error } = await slipsQuery()
    .eq('company_id', companyId)
    .eq('job_operation_id', jobOperationId)
    .eq('vendor_id', vendorId)
    .is('voided_at', null)
    .is('vendor_purchase_order_line_id', null)
    .order('shipped_at', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw purchasingReadFailure(error, 'load the slips to link', 'slip');
  return (data ?? []).map(toSlipFigures);
}

/**
 * Duplicate: a new draft to the same vendor with a new number, dated today. Copies the header and
 * the part and other lines; DROPS job links, dates and outside-service lines (an outside line pays
 * for one job's step) and reports how many, so the page can say so.
 */
export async function duplicateVendorPo(poId: string, today: string): Promise<VendorPoDuplicateResult> {
  const supabase = getSupabase();
  const op = 'duplicate the purchase order';
  const [headerRes, linesRes] = await Promise.all([
    supabase
      .from('vendor_purchase_orders')
      .select(
        'id, po_number, vendor_id, vendor_contact_id, vendor_address_id, ship_to_kind, ship_to_vendor_id, ship_to_vendor_address_id, ship_to_customer_id, ship_to_customer_address_id, need_by_on, payment_terms, ship_via, notes_to_vendor',
      )
      .eq('id', poId)
      .maybeSingle(),
    supabase
      .from('vendor_purchase_order_lines')
      .select(
        'line_number, line_kind, part_id, description, vendor_part_number, quantity, unit, unit_price, price_source, need_by_on, promised_on, cert_required, expects_receipt, job_id, work_center_id',
      )
      .eq('vendor_purchase_order_id', poId)
      .order('line_number', { ascending: true }),
  ]);
  if (headerRes.error) throw purchasingReadFailure(headerRes.error, op, ENTITY);
  if (linesRes.error) throw purchasingReadFailure(linesRes.error, op, ENTITY);
  const source = headerRes.data;
  if (!source) throw new Error('That record is not available.');

  let droppedOutsideLineCount = 0;
  let droppedJobLinkCount = 0;
  let droppedDateCount = source.need_by_on ? 1 : 0;
  const lines: VendorPoNewLineInput[] = [];
  for (const l of linesRes.data ?? []) {
    if (l.line_kind === 'outside_service') {
      droppedOutsideLineCount += 1;
      continue;
    }
    if (l.job_id) droppedJobLinkCount += 1;
    if (l.need_by_on || l.promised_on) droppedDateCount += 1;
    const kind = l.line_kind === 'part' ? 'part' : 'other';
    lines.push({
      lineKind: kind,
      partId: kind === 'part' ? l.part_id : undefined,
      description: l.description,
      vendorPartNumber: l.vendor_part_number,
      quantity: Number(l.quantity),
      unit: l.unit,
      unitPrice: numOrNull(l.unit_price),
      priceSource: priceSource(l.price_source),
      certRequired: l.cert_required,
      ...(kind === 'other' ? { expectsReceipt: l.expects_receipt, workCenterId: l.work_center_id } : {}),
    });
  }
  if (lines.length === 0) {
    throw new Error(
      `${source.po_number} has only outside-service lines, and those are never copied. Start a new PO from the operation instead.`,
    );
  }

  const kind = shipToKind(source.ship_to_kind, source.po_number);
  const header: VendorPoHeaderInput = {
    // A contact or address that no longer exists was cleared by its foreign key; leaving it out
    // lets the vendor's current default fill it, rather than freezing "nobody".
    ...(source.vendor_contact_id ? { vendorContactId: source.vendor_contact_id } : {}),
    ...(source.vendor_address_id ? { vendorAddressId: source.vendor_address_id } : {}),
    shipTo: {
      kind,
      vendorId: source.ship_to_vendor_id,
      vendorAddressId: source.ship_to_vendor_address_id,
      customerId: source.ship_to_customer_id,
      customerAddressId: source.ship_to_customer_address_id,
    },
    // Copied exactly, null included: the copy keeps the original's terms, not the vendor's.
    paymentTerms: source.payment_terms,
    shipVia: source.ship_via,
    notesToVendor: source.notes_to_vendor,
  };

  const created = await createVendorPo({ vendorId: source.vendor_id, orderedOn: today, today, header, lines });
  return { ...created, droppedOutsideLineCount, droppedJobLinkCount, droppedDateCount };
}

// ------------------------------------------------------------------------------------------------
// Reads for other surfaces
// ------------------------------------------------------------------------------------------------

/** The facts behind the archive dialog's impact lines. */
export async function getVendorPoArchiveImpact(poId: string): Promise<VendorPoArchiveImpact> {
  const supabase = getSupabase();
  const op = 'check what archiving the purchase order affects';
  const [headerRes, receiptsRes, outsideRes, link] = await Promise.all([
    supabase.from('vendor_purchase_orders').select('po_number, vendor_name, issued_at, deleted_at').eq('id', poId).maybeSingle(),
    supabase
      .from('vendor_purchase_order_receipts')
      .select('id', { count: 'exact', head: true })
      .eq('vendor_purchase_order_id', poId)
      .is('voided_at', null),
    supabase
      .from('vendor_purchase_order_lines')
      .select('id')
      .eq('vendor_purchase_order_id', poId)
      .eq('line_kind', 'outside_service'),
    readQuickBooksLink(poId),
  ]);
  if (headerRes.error) throw purchasingReadFailure(headerRes.error, op, ENTITY);
  if (receiptsRes.error) throw purchasingReadFailure(receiptsRes.error, op, ENTITY);
  if (outsideRes.error) throw purchasingReadFailure(outsideRes.error, op, ENTITY);
  const header = headerRes.data;
  if (!header) throw new Error('That record is not available.');

  let linkedSlipCount = 0;
  const outsideIds = (outsideRes.data ?? []).map((l) => l.id);
  if (outsideIds.length > 0) {
    const { count, error } = await supabase
      .from('outside_shipments')
      .select('id', { count: 'exact', head: true })
      .in('vendor_purchase_order_line_id', outsideIds)
      .is('voided_at', null);
    if (error) throw purchasingReadFailure(error, op, ENTITY);
    linkedSlipCount = count ?? 0;
  }

  return {
    poNumber: header.po_number,
    vendorName: header.vendor_name,
    wasSent: header.issued_at !== null,
    issuedAt: header.issued_at,
    receiptCount: receiptsRes.count ?? 0,
    linkedSlipCount,
    inQuickBooks: Boolean(link && link.status === 'created'),
    quickbooksDocNumber: link?.qb_doc_number ?? null,
    closedInQuickBooks: Boolean(link?.qb_closed),
    isArchived: header.deleted_at !== null,
  };
}

/**
 * A job's vendor PO lines (live POs only) — the job page's "Vendor POs" row and, filtered by job
 * part, the bought part's buying line ("PO-1042 (Acme) · 40 of 100 received").
 */
export async function listVendorPoLinesForJob(jobId: string, options: { today: string }): Promise<VendorPoJobLine[]> {
  const op = "load the job's purchase orders";
  const { data, error } = await linesQuery()
    .eq('job_id', jobId)
    .eq('is_archived', false)
    .order('po_number', { ascending: true })
    .order('line_number', { ascending: true });
  if (error) throw purchasingReadFailure(error, op, ENTITY);
  const rows = data ?? [];
  if (rows.length === 0) return [];

  const poIds = [...new Set(rows.map((r) => present(r.vendor_purchase_order_id, 'a job PO line')))];
  const pos = new Map<string, { status: VendorPoStatus; vendorName: string }>();
  for (const chunk of chunkIds(poIds)) {
    const res = await getSupabase().from('vendor_purchase_order_status').select('id, status, vendor_name').in('id', chunk);
    if (res.error) throw purchasingReadFailure(res.error, op, ENTITY);
    for (const p of res.data ?? []) {
      pos.set(present(p.id, 'a job PO'), {
        status: poStatus(p.status, 'a job PO'),
        vendorName: present(p.vendor_name, 'a job PO'),
      });
    }
  }

  return rows.map((r) => {
    const line = toLine(r, options.today, new Map());
    const po = present(pos.get(line.vendorPurchaseOrderId), 'the PO of a job line');
    return {
      lineId: line.id,
      vendorPurchaseOrderId: line.vendorPurchaseOrderId,
      poNumber: present(r.po_number, 'a job PO line'),
      poStatus: po.status,
      vendorId: present(r.vendor_id, 'a job PO line'),
      vendorName: po.vendorName,
      lineNumber: line.lineNumber,
      lineKind: line.lineKind,
      partId: line.partId,
      partName: line.partName,
      description: line.description,
      jobPartId: line.jobPartId,
      jobOperationId: line.jobOperationId,
      operationLabel: line.operationLabel,
      quantity: line.quantity,
      unit: line.unit,
      receivedQuantity: line.receivedQuantity,
      openQuantity: line.openQuantity,
      status: line.status,
      needByOn: line.needByOn,
      expectedOn: line.expectedOn,
      isLate: line.isLate,
    };
  });
}

/** How many of a part's PO lines `listVendorPoLinesForPart` returns when not told. */
const PART_LINES_DEFAULT_LIMIT = 25;

/**
 * A part's lines on live (unarchived) vendor POs, in EVERY status — draft, open, partly received,
 * received and closed short — newest first: the part page's purchase history. Part lines only: an
 * outside-service line names the part it processes, but it buys a service, not the part.
 * `statuses` narrows it (the part page asks for received and closed only, because what is still
 * owed is already listed, complete, from `getOnOrderForParts`), so `limit` counts what is shown.
 *
 * The PO's own status, order date and vendor name come from `vendor_purchase_order_status` in a
 * second read (the line view carries neither), one per `.in()` chunk of POs. THROWS on a failed
 * read: an empty history would say "never bought", which a failure must not.
 */
export async function listVendorPoLinesForPart(
  partId: string,
  options: { today: string; limit?: number; statuses?: readonly VendorPoLineStatus[] },
): Promise<VendorPoPartLinesResult> {
  const op = "load the part's purchase orders";
  const limit = Math.max(1, Math.min(options.limit ?? PART_LINES_DEFAULT_LIMIT, 200));
  let q = getSupabase()
    .from('vendor_purchase_order_line_status')
    .select(LINE_COLUMNS, { count: 'exact' })
    .eq('part_id', partId)
    .eq('line_kind', 'part')
    .eq('is_archived', false);
  if (options.statuses?.length) q = q.in('status', [...options.statuses]);
  const { data, error, count } = await q
    .order('created_at', { ascending: false })
    .order('line_number', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit);
  if (error) throw purchasingReadFailure(error, op, ENTITY);
  const rows = data ?? [];
  const total = count ?? rows.length;
  if (rows.length === 0) return { rows: [], total, truncated: false };

  const poIds = [...new Set(rows.map((r) => present(r.vendor_purchase_order_id, 'a part PO line')))];
  const pos = new Map<string, { status: VendorPoStatus; vendorName: string; orderedOn: string }>();
  for (const chunk of chunkIds(poIds)) {
    const res = await getSupabase()
      .from('vendor_purchase_order_status')
      .select('id, status, vendor_name, ordered_on')
      .in('id', chunk);
    if (res.error) throw purchasingReadFailure(res.error, op, ENTITY);
    for (const p of res.data ?? []) {
      pos.set(present(p.id, 'a part PO'), {
        status: poStatus(p.status, 'a part PO'),
        vendorName: present(p.vendor_name, 'a part PO'),
        orderedOn: present(p.ordered_on, 'a part PO'),
      });
    }
  }

  const lines = rows.map((r): VendorPoPartLine => {
    const line = toLine(r, options.today, new Map());
    const po = present(pos.get(line.vendorPurchaseOrderId), 'the PO of a part line');
    return {
      lineId: line.id,
      vendorPurchaseOrderId: line.vendorPurchaseOrderId,
      poNumber: present(r.po_number, 'a part PO line'),
      poStatus: po.status,
      vendorId: present(r.vendor_id, 'a part PO line'),
      vendorName: po.vendorName,
      orderedOn: po.orderedOn,
      lineNumber: line.lineNumber,
      quantity: line.quantity,
      unit: line.unit,
      receivedQuantity: line.receivedQuantity,
      openQuantity: line.openQuantity,
      status: line.status,
      expectedOn: line.expectedOn,
      isLate: line.isLate,
      jobNumber: line.jobNumber,
      createdAt: line.createdAt,
    };
  });
  return { rows: lines, total, truncated: total > lines.length };
}

const OUTSIDE_OP_SELECT = `id, job_id, job_part_id, sequence, operation_name, status, external_unit_price_snapshot,
  vendor_services!inner(id, name, unit_price, vendor_id, vendors(name)),
  jobs!inner(id, job_number, due_date, company_id, production_status, deleted_at),
  job_parts!inner(id, quantity, parts!job_parts_part_id_fkey(id, part_name, primary_unit)),
  outside_shipments(id, quantity, closed_at, voided_at, outside_shipment_receipts(quantity_good, voided_at)),
  vendor_purchase_order_lines(id, line_number, line_kind, closed_at, vendor_purchase_orders(id, po_number, vendor_id, closed_at, deleted_at))`;

/**
 * The outside steps this vendor performs that are not finished, on live jobs — the PO form's
 * outside-line picker ("J-1042 · 1234-A · Anodize · 50 left to send"). THROWS on a failed read:
 * an empty picker would say "nothing to send", which is the one answer a failure must not give.
 */
export async function listOpenOutsideOpsForVendor(companyId: string, vendorId: string): Promise<OpenOutsideOperation[]> {
  const { data, error } = await getSupabase()
    .from('job_operations')
    .select(OUTSIDE_OP_SELECT)
    .eq('vendor_services.vendor_id', vendorId)
    .eq('jobs.company_id', companyId)
    .is('jobs.deleted_at', null)
    .neq('jobs.production_status', 'cancelled')
    .neq('status', 'completed');
  if (error) throw purchasingReadFailure(error, "load the vendor's outside steps", 'operation');

  const ops: OpenOutsideOperation[] = [];
  for (const row of data ?? []) {
    const service = one(row.vendor_services);
    const job = one(row.jobs);
    const jobPart = one(row.job_parts);
    const part = one(jobPart?.parts ?? null);
    if (!service || !job || !jobPart || !part) continue;

    const ordered = Number(jobPart.quantity);
    let sent = 0;
    let good = 0;
    let atVendor = 0;
    for (const slip of row.outside_shipments ?? []) {
      if (slip.voided_at) continue;
      const back = (slip.outside_shipment_receipts ?? [])
        .filter((r) => !r.voided_at)
        .reduce((n, r) => n + Number(r.quantity_good), 0);
      sent += Number(slip.quantity);
      good += back;
      // A short-closed slip owes nothing, however little came back on it.
      if (!slip.closed_at) atVendor += Math.max(0, Number(slip.quantity) - back);
    }
    const round = (n: number) => Math.round(n * 1e6) / 1e6;

    const open = (row.vendor_purchase_order_lines ?? []).find((l) => {
      const po = one(l.vendor_purchase_orders);
      return (
        l.line_kind === 'outside_service' &&
        !l.closed_at &&
        po !== null &&
        po.vendor_id === vendorId &&
        !po.closed_at &&
        !po.deleted_at
      );
    });
    const openPo = open ? one(open.vendor_purchase_orders) : null;
    const vendorName = one(service.vendors)?.name ?? '';

    ops.push({
      jobOperationId: row.id,
      jobId: job.id,
      jobNumber: job.job_number,
      jobDueDate: job.due_date,
      jobPartId: jobPart.id,
      partId: part.id,
      partName: part.part_name,
      stockUnit: part.primary_unit,
      sequence: row.sequence,
      operationName: row.operation_name,
      operationStatus: row.status,
      vendorServiceId: service.id,
      serviceName: service.name,
      vendorServicePrice: numOrNull(service.unit_price),
      frozenOperationPrice: numOrNull(row.external_unit_price_snapshot),
      priceDefault: defaultOutsideLinePrice({
        vendorName,
        serviceName: service.name,
        vendorServicePrice: numOrNull(service.unit_price),
        frozenOperationPrice: numOrNull(row.external_unit_price_snapshot),
      }),
      orderedQuantity: ordered,
      sentQuantity: round(sent),
      goodQuantity: round(good),
      atVendorQuantity: round(atVendor),
      leftToSendQuantity: round(Math.max(0, ordered - good - atVendor)),
      openLine:
        open && openPo
          ? { vendorPurchaseOrderId: openPo.id, poNumber: openPo.po_number, lineId: open.id, lineNumber: open.line_number }
          : null,
      // The same words vendor_purchase_order_upsert_line writes when no description is given.
      defaultDescription: `${service.name} — ${part.part_name} — Job ${job.job_number}, Op ${row.sequence}`,
    });
  }

  return ops.sort((a, b) => {
    if (a.jobDueDate !== b.jobDueDate) {
      if (a.jobDueDate === null) return 1;
      if (b.jobDueDate === null) return -1;
      return a.jobDueDate < b.jobDueDate ? -1 : 1;
    }
    return a.jobNumber.localeCompare(b.jobNumber) || a.sequence - b.sequence;
  });
}

/**
 * What is coming for each part (part_on_order), with the POs behind it: on order (sent, open lines)
 * and on draft kept apart, in stock units. A part with nothing coming has no entry. Lines whose
 * frozen stock unit no longer matches the part's are left out of the refs, as they are of the
 * totals (`unitMismatchLineCount` says how many).
 */
export async function getOnOrderForParts(companyId: string, partIds: readonly string[]): Promise<Map<string, PartOnOrder>> {
  const out = new Map<string, PartOnOrder>();
  const unique = [...new Set(partIds.filter(Boolean))];
  if (unique.length === 0) return out;
  const supabase = getSupabase();
  const op = 'load what is on order';

  const chunks = chunkIds(unique);
  const [totals, lines] = await Promise.all([
    Promise.all(
      chunks.map((chunk) =>
        supabase
          .from('part_on_order')
          .select(
            'part_id, stock_unit, on_order_quantity, on_draft_quantity, next_expected_on, open_line_count, draft_line_count, unit_mismatch_line_count',
          )
          .eq('company_id', companyId)
          .in('part_id', chunk),
      ),
    ),
    Promise.all(
      chunks.map((chunk) =>
        supabase
          .from('vendor_purchase_order_line_status')
          .select(
            'id, vendor_purchase_order_id, po_number, vendor_id, line_number, part_id, status, quantity, stock_unit, stock_factor, open_stock_quantity, expected_on',
          )
          .eq('company_id', companyId)
          .eq('line_kind', 'part')
          .eq('is_archived', false)
          .in('status', ['draft', 'open', 'partially_received'])
          .in('part_id', chunk)
          .order('expected_on', { ascending: true, nullsFirst: false }),
      ),
    ),
  ]);

  for (const res of totals) {
    if (res.error) throw purchasingReadFailure(res.error, op, 'part');
    for (const row of res.data ?? []) {
      const partId = present(row.part_id, 'an on-order row');
      out.set(partId, {
        partId,
        stockUnit: row.stock_unit,
        onOrder: num(row.on_order_quantity),
        onDraft: num(row.on_draft_quantity),
        nextExpectedOn: row.next_expected_on,
        openLineCount: num(row.open_line_count),
        draftLineCount: num(row.draft_line_count),
        unitMismatchLineCount: num(row.unit_mismatch_line_count),
        refs: [],
      });
    }
  }
  for (const res of lines) {
    if (res.error) throw purchasingReadFailure(res.error, op, 'part');
    for (const row of res.data ?? []) {
      const entry = out.get(present(row.part_id, 'an on-order line'));
      if (!entry || row.stock_unit !== entry.stockUnit) continue;
      const status = lineStatus(row.status, 'an on-order line');
      const isDraft = status === 'draft';
      const ref: PartOnOrderRef = {
        vendorPurchaseOrderId: present(row.vendor_purchase_order_id, 'an on-order line'),
        poNumber: present(row.po_number, 'an on-order line'),
        vendorId: present(row.vendor_id, 'an on-order line'),
        lineId: present(row.id, 'an on-order line'),
        lineNumber: present(row.line_number, 'an on-order line'),
        // A draft owes its whole line; a sent line what is still open.
        stockQuantity: isDraft ? num(row.quantity) * num(row.stock_factor) : num(row.open_stock_quantity),
        expectedOn: row.expected_on,
        isDraft,
        status,
      };
      entry.refs.push(ref);
    }
  }
  return out;
}

const RECEIPT_LIST_SELECT = `${RECEIPT_COLUMNS}, vendor_purchase_order_lines!inner(line_number, part_name, description, vendor_purchase_orders!inner(id, po_number, vendor_id, vendor_name, deleted_at))`;

/**
 * The hub's Receipts tab — every receipt on a live PO, newest first, filtered by date range,
 * vendor, PO and packing slip. Voided receipts are left out unless asked for.
 */
export async function listVendorPoReceipts(
  companyId: string,
  filters: VendorPoReceiptFilters = {},
): Promise<VendorPoReceiptListResult> {
  const limit = Math.max(1, Math.min(filters.limit ?? 500, 1000));
  let q = getSupabase()
    .from('vendor_purchase_order_receipts')
    .select(RECEIPT_LIST_SELECT, { count: 'exact' })
    .eq('company_id', companyId)
    .is('vendor_purchase_order_lines.vendor_purchase_orders.deleted_at', null);
  if (!filters.includeVoided) q = q.is('voided_at', null);
  if (filters.receivedFrom) q = q.gte('received_at', filters.receivedFrom);
  if (filters.receivedBefore) q = q.lt('received_at', filters.receivedBefore);
  if (filters.vendorPurchaseOrderId) q = q.eq('vendor_purchase_order_id', filters.vendorPurchaseOrderId);
  if (filters.vendorId) q = q.eq('vendor_purchase_order_lines.vendor_purchase_orders.vendor_id', filters.vendorId);
  const slip = textOrNull(filters.packingSlip);
  if (slip) q = q.ilike('vendor_packing_slip', `%${escapeIlikePattern(slip)}%`);

  const { data, error, count } = await q
    .order('received_at', { ascending: false })
    .order('receipt_group_id', { ascending: true })
    .order('entry_index', { ascending: true })
    .limit(limit);
  if (error) throw purchasingReadFailure(error, 'load the receipts', 'receipt');

  const rows: VendorPoReceiptListRow[] = [];
  for (const row of data ?? []) {
    const line = one(row.vendor_purchase_order_lines);
    const po = one(line?.vendor_purchase_orders ?? null);
    if (!line || !po) continue;
    rows.push({
      ...toReceipt(row, new Map([[row.vendor_purchase_order_line_id, line.line_number]]), new Map()),
      vendorPurchaseOrderId: po.id,
      poNumber: po.po_number,
      vendorId: po.vendor_id,
      vendorName: po.vendor_name,
      partName: line.part_name,
      description: line.description,
    });
  }
  const total = count ?? rows.length;
  return { rows, total, truncated: total > rows.length };
}

/**
 * Stock added to this part WITHOUT a PO in the last `days` days — the receive dialog's "was that
 * this delivery?" notice. Transfers and PO receipts are left out. A notice only: nothing blocks.
 */
export async function getRecentNoPoReceipts(partId: string, days: number = 14): Promise<NoPoStockAddition[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const supabase = getSupabase();
  const op = 'check recent stock additions';
  const [txns, receipts] = await Promise.all([
    supabase
      .from('inventory_transactions')
      .select('id, created_at, quantity, unit, converted_quantity, location_name, heat_number, notes')
      .eq('part_id', partId)
      .eq('type', 'addition')
      .is('transfer_group_id', null)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(50),
    // Every PO receipt's own ledger row, voided or not: it came with a PO either way.
    supabase
      .from('vendor_purchase_order_receipts')
      .select('inventory_transaction_id')
      .eq('part_id', partId)
      .not('inventory_transaction_id', 'is', null)
      .gte('created_at', since),
  ]);
  if (txns.error) throw purchasingReadFailure(txns.error, op, 'stock');
  if (receipts.error) throw purchasingReadFailure(receipts.error, op, 'stock');

  const fromPos = new Set((receipts.data ?? []).map((r) => r.inventory_transaction_id).filter(Boolean));
  return (txns.data ?? [])
    .filter((t) => !fromPos.has(t.id))
    .map((t) => ({
      transactionId: t.id,
      createdAt: present(t.created_at, 'a stock addition'),
      quantity: Number(t.quantity),
      unit: t.unit,
      convertedQuantity: numOrNull(t.converted_quantity),
      locationName: t.location_name,
      heatNumber: t.heat_number,
      notes: t.notes,
    }));
}

// ------------------------------------------------------------------------------------------------
// Price defaults (lib/purchasing/priceDefault.ts is the one implementation; this only feeds it)
// ------------------------------------------------------------------------------------------------

/**
 * Everything the price default needs for one (vendor, part): this vendor's live sheet with its
 * breaks, Last PO prices, the part's cost tiers and units. Used by the PO form and by any caller
 * that omits a price (MCP), so both reach the same number with the same caption.
 */
export async function getPriceDefaultInputs(
  companyId: string,
  vendorId: string,
  partId: string,
): Promise<VendorPoPriceDefaultInputs> {
  const supabase = getSupabase();
  const op = 'load the price default';
  const [partRes, vendorRes, avlRes, lastRes] = await Promise.all([
    supabase
      .from('parts')
      .select(
        'id, company_id, part_name, source, primary_unit, parts_unit_conversions(from_unit, to_primary_factor), part_pricing_tiers(quantity, cost_per_unit)',
      )
      .eq('id', partId)
      .maybeSingle(),
    supabase.from('vendors').select('id, company_id, name').eq('id', vendorId).maybeSingle(),
    supabase
      .from('part_vendors')
      .select(
        'id, status, status_note, vendor_part_number, purchase_unit, lead_time_days, minimum_order_quantity, valid_until, part_vendor_price_breaks(min_quantity, unit_price)',
      )
      .eq('part_id', partId)
      .eq('vendor_id', vendorId)
      .is('deleted_at', null)
      .maybeSingle(),
    supabase
      .from('part_vendor_last_purchase')
      .select('vendor_id, po_number, ordered_on, unit, unit_price, stock_factor')
      .eq('company_id', companyId)
      .eq('part_id', partId)
      .order('ordered_on', { ascending: false }),
  ]);
  if (partRes.error) throw purchasingReadFailure(partRes.error, op, 'part');
  if (vendorRes.error) throw purchasingReadFailure(vendorRes.error, op, 'vendor');
  if (avlRes.error) throw purchasingReadFailure(avlRes.error, op, 'part vendor');
  if (lastRes.error) throw purchasingReadFailure(lastRes.error, op, 'part');
  const part = partRes.data;
  const vendor = vendorRes.data;
  if (!part || !vendor || part.company_id !== companyId || vendor.company_id !== companyId) {
    throw new Error('That record is not available.');
  }

  const conversions = (part.parts_unit_conversions ?? []).map((c) => ({
    from_unit: c.from_unit,
    to_primary_factor: Number(c.to_primary_factor),
  }));
  const avl = avlRes.data;
  let sheet: PriceSheet | null = null;
  if (avl) {
    const basis = resolvePartUnit(avl.purchase_unit, part.primary_unit, conversions);
    const breaks = (avl.part_vendor_price_breaks ?? []).map((b) => ({
      minQuantity: Number(b.min_quantity),
      unitPrice: Number(b.unit_price),
    }));
    if (basis.kind !== 'incomparable' && breaks.length > 0) {
      sheet = {
        vendorName: vendor.name,
        status: partVendorStatus(avl.status),
        purchaseUnit: basis.unit,
        stockFactor: basis.factor,
        validUntil: avl.valid_until,
        breaks,
      };
    }
  }

  const lastPurchases: LastPurchaseCandidate[] = (lastRes.data ?? []).flatMap((r) =>
    r.vendor_id && r.po_number && r.unit && r.stock_factor !== null
      ? [
          {
            vendorId: r.vendor_id,
            poNumber: r.po_number,
            orderedOn: r.ordered_on,
            isSent: true, // the view counts sent, unarchived POs only
            isArchived: false,
            unitPrice: numOrNull(r.unit_price),
            unit: r.unit,
            stockFactor: Number(r.stock_factor),
          },
        ]
      : [],
  );

  return {
    partId: part.id,
    partName: part.part_name,
    partSource: part.source,
    stockUnit: part.primary_unit,
    conversions,
    vendorId: vendor.id,
    vendorName: vendor.name,
    partVendor: avl
      ? {
          id: avl.id,
          status: partVendorStatus(avl.status),
          statusNote: avl.status_note,
          vendorPartNumber: avl.vendor_part_number,
          purchaseUnit: avl.purchase_unit,
          leadTimeDays: avl.lead_time_days,
          minimumOrderQuantity: numOrNull(avl.minimum_order_quantity),
          validUntil: avl.valid_until,
        }
      : null,
    sheet,
    lastPurchases,
    lastOrderedUnit: lastPurchases[0]?.unit ?? null,
    costTiers: (part.part_pricing_tiers ?? []).map((t) => ({
      quantity: Number(t.quantity),
      costPerUnit: numOrNull(t.cost_per_unit),
    })),
  };
}

/**
 * A part line's defaults from those inputs (pure): the purchase unit (the vendor's sheet unit,
 * else the last unit ordered, else the stock unit), the price with its caption, and the
 * approved-vendor note. A unit that cannot be related to the stock unit gets no price.
 */
export function resolveLinePriceDefault(
  inputs: VendorPoPriceDefaultInputs,
  line: { quantity: number; unit?: string | null; today: string; typedPrice?: number | null },
): VendorPoLinePriceResolution {
  const unit =
    textOrNull(line.unit) ??
    defaultPurchaseUnit({
      sheetUnit: inputs.partVendor?.purchaseUnit,
      lastOrderedUnit: inputs.lastOrderedUnit,
      stockUnit: inputs.stockUnit,
      conversions: inputs.conversions,
    });
  const basis = resolvePartUnit(unit, inputs.stockUnit, inputs.conversions);
  const price = defaultPartLinePrice({
    vendorId: inputs.vendorId,
    vendorName: inputs.vendorName,
    quantity: line.quantity,
    unit: basis.unit,
    stockFactor: basis.kind === 'incomparable' ? Number.NaN : basis.factor,
    today: line.today,
    sheet: inputs.sheet,
    lastPurchases: inputs.lastPurchases,
    costTiers: inputs.costTiers,
    ...(line.typedPrice !== undefined ? { typedPrice: line.typedPrice } : {}),
  });
  return {
    unit: basis.kind === 'incomparable' ? unit : basis.unit,
    basis,
    price,
    notice: partVendorLineNotice({
      vendorName: inputs.vendorName,
      status: inputs.partVendor?.status ?? null,
      statusNote: inputs.partVendor?.statusNote ?? null,
    }),
    vendorPartNumber: inputs.partVendor?.vendorPartNumber ?? null,
  };
}
