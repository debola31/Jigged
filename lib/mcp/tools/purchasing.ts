import { z } from 'zod';

import { callBackend } from '@/lib/mcp/backend';
import { defineCompanyTool, registerCompanyTool, type CompanyToolEnv, type ToolTarget } from '@/lib/mcp/defineTool';
import {
  BAD_CURSOR_MESSAGE,
  DEFAULT_PAGE,
  MAX_PAGE,
  addressOf,
  addressOutput,
  companyLink,
  matchesText,
  pageInput,
  pageOutput,
  paginate,
  urlOutput,
} from '@/lib/mcp/tools/shared';
import { findVendor } from '@/lib/mcp/tools/vendors';
import { VENDOR_PO_PRICE_SOURCES } from '@/lib/purchasing/priceDefault';
import {
  PART_VENDOR_STATUSES,
  VENDOR_PO_DEFAULT_LIST_STATUSES,
  VENDOR_PO_LINE_STATUSES,
  VENDOR_PO_QUICKBOOKS_STATES,
  VENDOR_PO_STATUSES,
  VENDOR_RFQ_STATUSES,
} from '@/lib/purchasing/vendorPoStatus';
import { purchasingHubPath, vendorPoPath, vendorRfqPath } from '@/lib/purchasingRoutes';
import { getSupabase } from '@/lib/supabase';
import type { BuyListPricedGroup, BuyListPricedRow } from '@/types/buyList';
import type { PartCostPreview, PartVendorList, PartVendorRow } from '@/types/partVendor';
import {
  VENDOR_PO_DEFAULT_SORT,
  type VendorPoDetail,
  type VendorPoLine,
  type VendorPoListRow,
  type VendorPoOutsideSlip,
  type VendorPoQuickBooksInfo,
  type VendorPoReceipt,
} from '@/types/vendorPo';
import type { VendorRfqDetail, VendorRfqListRow } from '@/types/vendorRfq';
import { getBuyList } from '@/utils/buyListAccess';
import { listPartVendors, previewPartCostFromVendor } from '@/utils/partVendorsAccess';
import { escapeIlikePattern } from '@/utils/searchFilter';
import { getVendorPo, listVendorPos } from '@/utils/vendorPoAccess';
import { getVendorRfq, listVendorRfqs } from '@/utils/vendorRfqAccess';

/**
 * Purchasing, read side: purchase orders TO A VENDOR, the To buy list, a part's approved vendors
 * and price sheets, RFQs to vendors, and what "Use as part cost" or a QuickBooks push would do.
 * "PO" alone means the CUSTOMER's PO in Jigged (`customer_po_number` on a job), so every name and
 * description here says vendor (plan §3.1, §3.12).
 *
 * Each tool calls the access function the Purchasing hub, the PO page or the part's Buying tab
 * calls, with the arguments it passes:
 *
 *   list_vendor_pos                VendorPoList (hub, Orders)     → listVendorPos
 *   get_vendor_po                  the PO page                    → getVendorPo
 *   get_buy_list                   BuyList (hub, To buy)          → getBuyList
 *   get_part_vendors               BuyingTab (part page)          → listPartVendors
 *   list_vendor_rfqs               the hub's RFQs tab             → listVendorRfqs
 *   get_vendor_rfq                 the RFQ page and its compare   → getVendorRfq
 *   preview_part_cost_from_vendor  UseAsPartCostDialog            → previewPartCostFromVendor
 *   preview_vendor_po_push         the QuickBooks dialog's open   → the backend's preflight
 *
 * RULES (plan §3.12):
 *   - The record is found IN THIS COMPANY (`.eq('company_id', …)`) before its id reaches any
 *     access function that takes an id alone. By id (or by its never-reissued number) an archived
 *     record is found and says so; lists leave archived records out.
 *   - Pages hold at most 50; every record carries a url to its page.
 *   - Nobody is named: no `*_by`, no buyer, no "received by" (the access layer resolves a receipt's
 *     receiver for the page; it never leaves here).
 *   - PRICES go to admins and users alike (shared.ts, the money rule). Stock value does not appear
 *     here at all; it stays admin-only in the inventory tools.
 *   - "Today" is Jigged's server clock (UTC); see todayUtc.
 */

// ------------------------------------------------------------------------------------------------
// Dates and links
// ------------------------------------------------------------------------------------------------

/**
 * Today in UTC (YYYY-MM-DD). The access layer wants the caller's local date; a server has no shop
 * time zone, so "overdue" and "expired" are judged on Jigged's clock, which runs a day ahead of the
 * Americas for the last hours of their evening (the overview tools say the same).
 */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export const vendorPoUrl = (env: CompanyToolEnv, poId: string): string | null =>
  env.link(vendorPoPath(env.company.id, poId));
export const vendorRfqUrl = (env: CompanyToolEnv, rfqId: string): string | null =>
  env.link(vendorRfqPath(env.company.id, rfqId));
export const toBuyUrl = (env: CompanyToolEnv): string | null => env.link(purchasingHubPath(env.company.id, 'to-buy'));
export const partUrl = (env: CompanyToolEnv, partId: string): string | null => companyLink(env, `/parts/${partId}`);
export const vendorUrl = (env: CompanyToolEnv, vendorId: string): string | null => companyLink(env, `/vendors/${vendorId}`);
export const jobUrl = (env: CompanyToolEnv, jobId: string): string | null => companyLink(env, `/jobs/${jobId}`);

/** "a, b and c". */
export function andJoin(words: readonly string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** A caption as a sentence: the captions are phrases, the notices already end in a stop. */
export function asSentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/** The offset a cursor stands for, or null when it is not one this server issued. */
export function cursorOffset(cursor: string | undefined): number | null {
  if (cursor === undefined) return 0;
  return /^\d+$/.test(cursor) ? Number(cursor) : null;
}

// ------------------------------------------------------------------------------------------------
// Shared output pieces
// ------------------------------------------------------------------------------------------------

export const warningsOutput = z
  .array(z.string())
  .describe('What the app would point out. None of it stopped the change.');

export const vendorRefOutput = z.object({ vendor_id: z.string(), name: z.string(), url: urlOutput });
export const partRefOutput = z.object({ part_id: z.string(), part_name: z.string().nullable(), url: urlOutput });
export const jobRefOutput = z.object({ job_id: z.string(), job_number: z.string().nullable(), url: urlOutput });
export const contactOutput = z.object({
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
});

export const PO_NUMBER_HELP =
  "The number Jigged gave this purchase order to a vendor, e.g. PO-1042. Not a customer's PO number, " +
  'which is customer_po_number on a job.';

const PO_STATUS_HELP =
  '`draft`: not sent to the vendor yet. `sent`: with the vendor, nothing received. ' +
  '`partially_received`: some of it has arrived, or a line was closed short. `received`: everything ' +
  'expected has arrived. `closed`: closed by hand, or nothing more is expected.';

const LINE_STATUS_HELP =
  '`draft` (the PO is not sent yet), `open`, `partially_received`, `received` (more than ordered is ' +
  'still received), `closed` (closed short), `no_receipt` (freight or a fee: nothing arrives).';

const OVERDUE_HELP =
  "Still owed something, and its expected date has passed. Judged on Jigged's server clock (UTC), " +
  "which can be a day ahead of the shop's own date near midnight.";

const QUICKBOOKS_STATE_HELP =
  '`not_sent`; `in_quickbooks`; `out_of_date` (changed in Jigged since it was last sent to ' +
  'QuickBooks); `pending` (a send is running); `needs_checking` (a QuickBooks Desktop send nobody ' +
  'could confirm); `failed` (the last send failed).';

const PRICE_SOURCE_HELP =
  'Where the price came from: `price_sheet`, `last_po`, `estimate` (the part cost estimate), ' +
  '`vendor_service`, `rfq` or `manual` (typed). Null while the price is to be confirmed.';

const LINE_KINDS = ['part', 'outside_service', 'other'] as const;

export const vendorPoLineOutput = z.object({
  vendor_po_line_id: z.string(),
  line_number: z.number(),
  kind: z
    .enum(LINE_KINDS)
    .describe('`part`: a part or material into stock. `outside_service`: a routing step the vendor does. `other`: anything else (maintenance, tooling, freight).'),
  part: partRefOutput.nullable(),
  description: z.string(),
  vendor_part_number: z.string().nullable(),
  quantity: z.number().describe('Ordered, in `unit`.'),
  unit: z.string().describe('The unit it is bought in.'),
  stock_unit: z.string().nullable().describe("Part lines: the part's own unit, which stock is counted in."),
  units_per_purchase_unit: z.number().nullable().describe('Part lines: stock units in one purchase unit (a bar of 144 in is 144).'),
  unit_price: z.number().nullable().describe('Per `unit`. Null: to be confirmed (prints TBC).'),
  price_source: z.enum(VENDOR_PO_PRICE_SOURCES).nullable().describe(PRICE_SOURCE_HELP),
  amount: z.number().nullable().describe('Quantity × price, to the cent. Null while to be confirmed.'),
  open_value: z.number().nullable().describe('What is still to arrive on this line, at its price.'),
  need_by_on: z.string().nullable(),
  promised_on: z.string().nullable().describe("The vendor's promised date. Internal: never printed."),
  expected_on: z.string().nullable().describe("Promised, else needed-by; outside lines: the earliest due-back of the vendor slips still out."),
  overdue: z.boolean().describe(OVERDUE_HELP),
  cert_required: z.boolean(),
  expects_receipt: z.boolean().describe('False for freight or a fee: nothing arrives to receive.'),
  job: jobRefOutput.nullable(),
  operation: z.string().nullable().describe('Outside lines: the routing step it pays for, e.g. "Op 30 Anodize".'),
  service: z.string().nullable(),
  machine: z.string().nullable().describe('Other lines: the work center it is for.'),
  status: z.enum(VENDOR_PO_LINE_STATUSES).describe(LINE_STATUS_HELP),
  received_quantity: z.number().describe('In `unit`. Outside lines: good pieces back on their vendor slips.'),
  open_quantity: z.number().describe('Still to arrive, in `unit`; 0 once received or closed.'),
  over_received_quantity: z.number(),
  ordered_stock_quantity: z.number().nullable().describe('Part lines, in the stock unit.'),
  received_stock_quantity: z.number().nullable(),
  open_stock_quantity: z.number().nullable(),
  sent_quantity: z.number().nullable().describe('Outside lines: pieces sent on its vendor slips.'),
  at_vendor_quantity: z.number().nullable().describe('Outside lines: pieces still at the vendor.'),
  closed_at: z.string().nullable(),
  removable: z.boolean().describe('Nothing was ever received on it, so update_vendor_po can remove it.'),
});

export const vendorPoReceiptOutput = z.object({
  receipt_id: z.string(),
  line_number: z.number().nullable(),
  received_at: z.string(),
  quantity: z.number().describe('Exactly as received, in `unit`.'),
  unit: z.string(),
  stock_quantity: z.number().nullable(),
  stock_unit: z.string().nullable(),
  location: z.string().nullable(),
  lot_code: z.string().nullable(),
  heat_number: z.string().nullable(),
  started_lot_tracking: z.boolean().describe('This receipt\'s heat turned on lot tracking for the part.'),
  vendor_packing_slip: z.string().nullable(),
  notes: z.string().nullable(),
  voided: z.boolean(),
  voided_at: z.string().nullable(),
  void_reason: z.string().nullable(),
});

const SLIP_STATUSES = ['open', 'received', 'closed', 'voided'] as const;

export const vendorPoSlipOutput = z.object({
  outside_shipment_id: z.string(),
  slip_number: z.string(),
  line_number: z.number().nullable(),
  quantity_sent: z.number(),
  quantity_received: z.number(),
  quantity_outstanding: z.number(),
  sent_at: z.string(),
  expected_back: z.string().nullable(),
  status: z.enum(SLIP_STATUSES),
  url: urlOutput.describe("The job's page, where the slip is."),
});

export const vendorPoQuickBooksOutput = z.object({
  state: z.enum(VENDOR_PO_QUICKBOOKS_STATES).describe(QUICKBOOKS_STATE_HELP),
  quickbooks: z.enum(['online', 'desktop']).nullable(),
  number: z
    .string()
    .nullable()
    .describe("QuickBooks' number for it: Jigged's, unless custom transaction numbers are off in QuickBooks Online."),
  quickbooks_url: z.string().nullable().describe('The PO in QuickBooks Online. Null for QuickBooks Desktop.'),
  closed_in_quickbooks: z.boolean(),
  pushed_revision: z.number().nullable(),
  last_pushed_at: z.string().nullable(),
});

/** get_vendor_po's shape — every PO write returns it too. */
export const vendorPoOutput = {
  vendor_po_id: z.string(),
  po_number: z.string().describe(PO_NUMBER_HELP),
  status: z.enum(VENDOR_PO_STATUSES).describe(PO_STATUS_HELP),
  overdue: z.boolean().describe(OVERDUE_HELP),
  archived: z.boolean().describe('Archived in Jigged: read-only, and out of every list.'),
  revision: z.number().describe('Rev 0 until it changes after a send; each send cycle that changes what the vendor sees adds one.'),
  sent_revision: z.number().nullable().describe('The revision the vendor was last sent. Null for a draft.'),
  unsent_changes: z.boolean().describe('Changed since it was last sent: the vendor has an older revision.'),
  vendor: vendorRefOutput.describe('The vendor as it was when the PO was made.'),
  vendor_contact: contactOutput.nullable(),
  vendor_address: addressOutput.nullable(),
  ship_to: z.object({
    kind: z.enum(['shop', 'vendor', 'customer']).describe('Our shop, another vendor (drop-ship to the plater) or a customer.'),
    name: z.string(),
    address: addressOutput.nullable(),
  }),
  ordered_on: z.string(),
  need_by_on: z.string().nullable(),
  next_expected_on: z.string().nullable().describe('The earliest expected date over the lines still to arrive.'),
  payment_terms: z.string().nullable(),
  ship_via: z.string().nullable(),
  notes_to_vendor: z.string().nullable().describe('Printed on the PO.'),
  internal_notes: z.string().nullable().describe('Never printed or sent.'),
  first_sent_at: z.string().nullable(),
  last_sent_at: z.string().nullable(),
  closed_at: z.string().nullable(),
  closed_reason: z.string().nullable(),
  line_count: z.number(),
  outstanding_line_count: z.number(),
  total: z.number().describe('The sum of the line amounts at the PO prices; lines to be confirmed add nothing.'),
  open_value: z
    .number()
    .describe('Open value (at PO price): what is still to arrive, at the PO prices. Not money owed: bills are entered in QuickBooks.'),
  has_unpriced_lines: z.boolean().describe('A line is to be confirmed (TBC): it cannot go to QuickBooks until priced.'),
  job_numbers: z.array(z.string()),
  vendor_rfq_id: z.string().nullable().describe('The RFQ this PO was awarded from, if any.'),
  lines: z.array(vendorPoLineOutput),
  receipts: z.array(vendorPoReceiptOutput).describe('Newest first, voided ones included.'),
  outside_slips: z.array(vendorPoSlipOutput).describe("The vendor packing slips its outside-service lines ship on."),
  quickbooks: vendorPoQuickBooksOutput,
  url: urlOutput,
};

export type VendorPoOut = z.infer<z.ZodObject<typeof vendorPoOutput>>;

function lineRecord(l: VendorPoLine, env: CompanyToolEnv): z.infer<typeof vendorPoLineOutput> {
  return {
    vendor_po_line_id: l.id,
    line_number: l.lineNumber,
    kind: l.lineKind,
    part: l.partId ? { part_id: l.partId, part_name: l.partName, url: partUrl(env, l.partId) } : null,
    description: l.description,
    vendor_part_number: l.vendorPartNumber,
    quantity: l.quantity,
    unit: l.unit,
    stock_unit: l.stockUnit,
    units_per_purchase_unit: l.stockFactor,
    unit_price: l.unitPrice,
    price_source: l.priceSource,
    amount: l.amount,
    open_value: l.openAmount,
    need_by_on: l.needByOn,
    promised_on: l.promisedOn,
    expected_on: l.expectedOn,
    overdue: l.isLate,
    cert_required: l.certRequired,
    expects_receipt: l.expectsReceipt,
    job: l.jobId ? { job_id: l.jobId, job_number: l.jobNumber, url: jobUrl(env, l.jobId) } : null,
    operation: l.operationLabel,
    service: l.serviceName,
    machine: l.workCenterName,
    status: l.status,
    received_quantity: l.receivedQuantity,
    open_quantity: l.openQuantity,
    over_received_quantity: l.overReceivedQuantity,
    ordered_stock_quantity: l.orderedStockQuantity,
    received_stock_quantity: l.receivedStockQuantity,
    open_stock_quantity: l.openStockQuantity,
    sent_quantity: l.sentQuantity,
    at_vendor_quantity: l.atVendorQuantity,
    closed_at: l.closedAt,
    removable: l.removable,
  };
}

/** Field by field, so the receiver's name the access layer resolves for the page stays here. */
function receiptRecord(r: VendorPoReceipt): z.infer<typeof vendorPoReceiptOutput> {
  return {
    receipt_id: r.id,
    line_number: r.lineNumber,
    received_at: r.receivedAt,
    quantity: r.quantity,
    unit: r.unit,
    stock_quantity: r.stockQuantity,
    stock_unit: r.stockUnit,
    location: r.locationName,
    lot_code: r.lotCode,
    heat_number: r.heatNumber,
    started_lot_tracking: r.startedTracking,
    vendor_packing_slip: r.vendorPackingSlip,
    notes: r.notes,
    voided: r.voidedAt !== null,
    voided_at: r.voidedAt,
    void_reason: r.voidReason,
  };
}

function slipRecord(
  s: VendorPoOutsideSlip,
  lineNumbers: Map<string, number>,
  env: CompanyToolEnv,
): z.infer<typeof vendorPoSlipOutput> {
  const status = s.voidedAt ? 'voided' : s.closedAt ? 'closed' : s.outstandingQuantity > 0 ? 'open' : 'received';
  return {
    outside_shipment_id: s.id,
    slip_number: s.slipNumber,
    line_number: lineNumbers.get(s.vendorPurchaseOrderLineId) ?? null,
    quantity_sent: s.quantity,
    quantity_received: s.receivedQuantity,
    quantity_outstanding: s.outstandingQuantity,
    sent_at: s.shippedAt,
    expected_back: s.dueBackOn,
    status,
    url: jobUrl(env, s.jobId),
  };
}

export function providerLabel(provider: string | null | undefined): 'online' | 'desktop' | null {
  if (provider === 'qbo') return 'online';
  if (provider === 'qbd') return 'desktop';
  return null;
}

function quickbooksRecord(q: VendorPoQuickBooksInfo): z.infer<typeof vendorPoQuickBooksOutput> {
  return {
    state: q.state,
    quickbooks: providerLabel(q.provider),
    number: q.docNumber,
    quickbooks_url: q.url,
    closed_in_quickbooks: q.closedInQuickBooks,
    pushed_revision: q.pushedRevision,
    last_pushed_at: q.pushedAt,
  };
}

export function vendorPoRecord(detail: VendorPoDetail, env: CompanyToolEnv): VendorPoOut {
  const { header: h, summary: s } = detail;
  const lineNumbers = new Map(detail.lines.map((l) => [l.id, l.lineNumber] as const));
  return {
    vendor_po_id: h.id,
    po_number: h.poNumber,
    status: s.status,
    overdue: s.isLate,
    archived: h.isArchived,
    revision: h.revision,
    sent_revision: h.sentRevision,
    unsent_changes: s.hasUnsentChanges,
    vendor: { vendor_id: h.vendorId, name: h.vendorName, url: vendorUrl(env, h.vendorId) },
    vendor_contact: h.vendorContact
      ? { name: h.vendorContact.name, email: h.vendorContact.email, phone: h.vendorContact.phone }
      : null,
    vendor_address: addressOf(h.vendorAddress),
    ship_to: { kind: h.shipToKind, name: h.shipToName, address: addressOf(h.shipToAddress) },
    ordered_on: h.orderedOn,
    need_by_on: h.needByOn,
    next_expected_on: s.nextExpectedOn,
    payment_terms: h.paymentTerms,
    ship_via: h.shipVia,
    notes_to_vendor: h.notesToVendor,
    internal_notes: h.internalNotes,
    first_sent_at: h.issuedAt,
    last_sent_at: h.lastSentAt,
    closed_at: h.closedAt,
    closed_reason: h.closedReason,
    line_count: s.lineCount,
    outstanding_line_count: s.outstandingLineCount,
    total: s.orderedAmount,
    open_value: s.openAmount,
    has_unpriced_lines: s.hasUnpricedLines,
    job_numbers: s.jobNumbers,
    vendor_rfq_id: h.vendorRfqId,
    lines: detail.lines.map((l) => lineRecord(l, env)),
    receipts: detail.receipts.map(receiptRecord),
    outside_slips: detail.outsideSlips.map((slip) => slipRecord(slip, lineNumbers, env)),
    quickbooks: quickbooksRecord(detail.quickbooks),
    url: vendorPoUrl(env, h.id),
  };
}

// ------------------------------------------------------------------------------------------------
// Finding records, always within this company
// ------------------------------------------------------------------------------------------------

export const vendorPoRef = {
  vendor_po_id: z.guid().optional().describe('The purchase order to a vendor, by id.'),
  po_number: z.string().max(40).optional().describe('The purchase order to a vendor, by its number (PO-1042), when you have no id.'),
};

export interface FoundVendorPo {
  id: string;
  po_number: string;
  deleted_at: string | null;
}

/**
 * The PO by id, or by its number. PO numbers are unique per company and never reissued, archived
 * ones included, so the number is as much an identity as the id: an archived PO is found either
 * way, and the caller says so or refuses.
 */
export async function findVendorPo(
  args: { vendor_po_id?: string; po_number?: string },
  env: CompanyToolEnv,
): Promise<{ po: FoundVendorPo } | { message: string }> {
  const number = args.po_number?.trim();
  if (!args.vendor_po_id && !number) return { message: 'Give a vendor_po_id or a po_number.' };
  const lookup = getSupabase()
    .from('vendor_purchase_orders')
    .select('id, po_number, deleted_at')
    .eq('company_id', env.company.id);
  const { data, error } = await (args.vendor_po_id ? lookup.eq('id', args.vendor_po_id) : lookup.eq('po_number', number ?? ''))
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { message: missingPo(args, env) };
  return { po: data };
}

export function missingPo(args: { vendor_po_id?: string; po_number?: string }, env: CompanyToolEnv): string {
  return args.vendor_po_id
    ? `There is no vendor PO with that id in ${env.company.name}.`
    : `There is no vendor PO ${args.po_number?.trim() ?? ''} in ${env.company.name}.`;
}

/** The PO in full, found in this company first; or the sentence saying it is not there. */
export async function loadVendorPo(
  args: { vendor_po_id?: string; po_number?: string },
  env: CompanyToolEnv,
): Promise<{ po: FoundVendorPo; detail: VendorPoDetail } | { message: string }> {
  const found = await findVendorPo(args, env);
  if ('message' in found) return found;
  const detail = await getVendorPo(found.po.id, { today: todayUtc() });
  if (!detail) return { message: `There is no vendor PO with that id in ${env.company.name}.` };
  return { po: found.po, detail };
}

export const vendorRfqRef = {
  vendor_rfq_id: z.guid().optional().describe('The RFQ to vendors, by id.'),
  rfq_number: z.string().max(40).optional().describe('The RFQ, by its number (RFQ-0004), when you have no id.'),
};

export interface FoundVendorRfq {
  id: string;
  rfq_number: string;
  deleted_at: string | null;
}

/** The RFQ by id or by its never-reissued number, archived ones included. */
export async function findVendorRfq(
  args: { vendor_rfq_id?: string; rfq_number?: string },
  env: CompanyToolEnv,
): Promise<{ rfq: FoundVendorRfq } | { message: string }> {
  const number = args.rfq_number?.trim();
  if (!args.vendor_rfq_id && !number) return { message: 'Give a vendor_rfq_id or an rfq_number.' };
  const lookup = getSupabase().from('vendor_rfqs').select('id, rfq_number, deleted_at').eq('company_id', env.company.id);
  const { data, error } = await (args.vendor_rfq_id ? lookup.eq('id', args.vendor_rfq_id) : lookup.eq('rfq_number', number ?? ''))
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    return {
      message: args.vendor_rfq_id
        ? `There is no RFQ with that id in ${env.company.name}.`
        : `There is no RFQ ${number} in ${env.company.name}.`,
    };
  }
  return { rfq: data };
}

export const partRef = {
  part_id: z.guid().optional().describe('The part, by id.'),
  part_name: z.string().optional().describe('The part, by its exact part name (part number), when you have no id.'),
};

export interface FoundPart {
  id: string;
  part_name: string;
  source: string;
  primary_unit: string | null;
  deleted_at: string | null;
}

const PART_COLUMNS = 'id, part_name, source, primary_unit, deleted_at';

/**
 * The part by id, or by name ignoring case — a live part beats an archived namesake, exact case
 * beats a case-only match (get_part's rule). Archived parts are found: the caller decides.
 */
export async function findPurchasingPart(
  args: { part_id?: string; part_name?: string },
  env: CompanyToolEnv,
): Promise<{ part: FoundPart } | { message: string }> {
  if (args.part_id) {
    const { data, error } = await getSupabase()
      .from('parts')
      .select(PART_COLUMNS)
      .eq('company_id', env.company.id)
      .eq('id', args.part_id)
      .maybeSingle();
    if (error) throw error;
    return data ? { part: data } : { message: `There is no part with that id in ${env.company.name}.` };
  }
  const name = args.part_name?.trim();
  if (!name) return { message: 'Give a part_id or a part_name.' };
  const { data, error } = await getSupabase()
    .from('parts')
    .select(PART_COLUMNS)
    .eq('company_id', env.company.id)
    .ilike('part_name', escapeIlikePattern(name))
    .limit(20);
  if (error) throw error;
  const rank = (p: FoundPart) => (p.deleted_at === null ? 0 : 2) + (p.part_name === name ? 0 : 1);
  const best = (data ?? []).slice().sort((a, b) => rank(a) - rank(b))[0];
  return best ? { part: best } : { message: `There is no part named ${name} in ${env.company.name}.` };
}

export const vendorNameRef = {
  vendor_id: z.guid().optional().describe('The vendor, by id.'),
  vendor_name: z.string().optional().describe("The vendor's exact name (case does not matter), when you have no id."),
};

export interface FoundVendor {
  id: string;
  name: string;
  deleted_at: string | null;
}

/** The vendor by id or exact name, archived ones included (get_vendor's lookup). */
export async function findPurchasingVendor(
  args: { vendor_id?: string; vendor_name?: string },
  env: CompanyToolEnv,
): Promise<{ vendor: FoundVendor } | { message: string }> {
  if (!args.vendor_id && !args.vendor_name?.trim()) return { message: 'Give a vendor_id or a vendor_name.' };
  return findVendor({ vendor_id: args.vendor_id, name: args.vendor_name }, env);
}

export interface FoundJob {
  id: string;
  job_number: string;
  deleted_at: string | null;
}

/**
 * The job a filter or a line names, in this company: by id (archived ones included, for the caller
 * to refuse) or by number among live jobs. `job: null` when none was named.
 */
export async function findJobRef(
  args: { job_id?: string; job_number?: string },
  env: CompanyToolEnv,
): Promise<{ job: FoundJob | null } | { message: string }> {
  const number = args.job_number?.trim();
  if (!args.job_id && !number) return { job: null };
  let query = getSupabase().from('jobs').select('id, job_number, deleted_at').eq('company_id', env.company.id);
  query = args.job_id ? query.eq('id', args.job_id) : query.eq('job_number', number ?? '').is('deleted_at', null);
  const { data, error } = await query.limit(1).maybeSingle();
  if (error) throw error;
  if (!data) {
    return {
      message: args.job_id
        ? `There is no job with that id in ${env.company.name}.`
        : `There is no job ${number} in ${env.company.name}.`,
    };
  }
  return { job: data };
}

// ------------------------------------------------------------------------------------------------
// list_vendor_pos
// ------------------------------------------------------------------------------------------------

const vendorPoSummaryOutput = z.object({
  vendor_po_id: z.string(),
  po_number: z.string().describe(PO_NUMBER_HELP),
  status: z.enum(VENDOR_PO_STATUSES).describe(PO_STATUS_HELP),
  overdue: z.boolean().describe(OVERDUE_HELP),
  vendor: vendorRefOutput,
  ordered_on: z.string(),
  need_by_on: z.string().nullable(),
  next_expected_on: z.string().nullable(),
  revision: z.number(),
  unsent_changes: z.boolean(),
  first_sent_at: z.string().nullable(),
  line_count: z.number(),
  outstanding_line_count: z.number(),
  total: z.number().describe('At the PO prices.'),
  open_value: z.number().describe('Open value (at PO price): what is still to arrive. Not money owed.'),
  has_unpriced_lines: z.boolean(),
  job_numbers: z.array(z.string()),
  quickbooks_state: z.enum(VENDOR_PO_QUICKBOOKS_STATES).describe(QUICKBOOKS_STATE_HELP),
  url: urlOutput,
});

export function vendorPoSummaryRecord(r: VendorPoListRow, env: CompanyToolEnv): z.infer<typeof vendorPoSummaryOutput> {
  return {
    vendor_po_id: r.id,
    po_number: r.poNumber,
    status: r.status,
    overdue: r.isLate,
    vendor: { vendor_id: r.vendorId, name: r.vendorName, url: vendorUrl(env, r.vendorId) },
    ordered_on: r.orderedOn,
    need_by_on: r.needByOn,
    next_expected_on: r.nextExpectedOn,
    revision: r.revision,
    unsent_changes: r.hasUnsentChanges,
    first_sent_at: r.issuedAt,
    line_count: r.lineCount,
    outstanding_line_count: r.outstandingLineCount,
    total: r.orderedAmount,
    open_value: r.openAmount,
    has_unpriced_lines: r.hasUnpricedLines,
    job_numbers: r.jobNumbers,
    quickbooks_state: r.quickbooksState,
    url: vendorPoUrl(env, r.id),
  };
}

export { vendorPoSummaryOutput };

export const listVendorPosTool = defineCompanyTool({
  name: 'list_vendor_pos',
  title: 'List purchase orders to vendors',
  description:
    'Lists purchase orders to a vendor (what the shop buys: material, bought parts, outside ' +
    "services, maintenance, tooling, freight). A customer's PO is something else: customer_po_number " +
    'on a job. Without `statuses` it returns the ones still open (draft, sent, partially_received), ' +
    'as the Purchasing page does; archived POs are left out. Filters: status, vendor, job, overdue, ' +
    'QuickBooks state, and search text matching the PO number, vendor, part numbers, vendor part ' +
    'numbers and job numbers. Each PO has its status, dates, totals and open value at the PO prices, ' +
    "and whether it is overdue, judged on Jigged's server clock (UTC). Sorted by next due date unless " +
    '`sort` is `newest`.',
  access: 'read',
  input: {
    statuses: z.array(z.enum(VENDOR_PO_STATUSES)).min(1).optional().describe(`Statuses to include. ${PO_STATUS_HELP}`),
    vendor_id: z.guid().optional().describe("Only this vendor's POs."),
    job_id: z.guid().optional().describe('Only POs with a line for this job.'),
    job_number: z.string().optional().describe('Only POs with a line for this job, by number.'),
    overdue: z.boolean().optional().describe('Only POs still owed something past their expected date.'),
    search: z.string().max(200).optional().describe('PO number, vendor, part number, vendor part number or job number.'),
    quickbooks_states: z.array(z.enum(VENDOR_PO_QUICKBOOKS_STATES)).min(1).optional().describe(QUICKBOOKS_STATE_HELP),
    sort: z.enum(['next_due', 'newest']).optional(),
    ...pageInput,
  },
  output: { vendor_pos: z.array(vendorPoSummaryOutput), ...pageOutput },
  run: async (args, env) => {
    const offset = cursorOffset(args.cursor);
    if (offset === null) return { ok: false, message: BAD_CURSOR_MESSAGE };
    const scoped = await findJobRef(args, env);
    if ('message' in scoped) return { ok: false, message: scoped.message };
    const limit = Math.min(args.limit ?? DEFAULT_PAGE, MAX_PAGE);

    const result = await listVendorPos(env.company.id, {
      today: todayUtc(),
      statuses: args.statuses ?? [...VENDOR_PO_DEFAULT_LIST_STATUSES],
      vendorId: args.vendor_id,
      jobId: scoped.job?.id,
      overdueOnly: Boolean(args.overdue),
      search: args.search?.trim() || undefined,
      quickbooksStates: args.quickbooks_states,
      sort: args.sort === 'newest' ? { field: 'created_at', direction: 'desc' } : VENDOR_PO_DEFAULT_SORT,
      limit,
      offset,
    });
    const next = offset + result.rows.length;
    return {
      ok: true,
      data: {
        vendor_pos: result.rows.map((r) => vendorPoSummaryRecord(r, env)),
        total: result.total,
        next_cursor: result.rows.length > 0 && next < result.total ? String(next) : null,
      },
    };
  },
});

// ------------------------------------------------------------------------------------------------
// get_vendor_po
// ------------------------------------------------------------------------------------------------

export const getVendorPoTool = defineCompanyTool({
  name: 'get_vendor_po',
  title: 'Get a purchase order to a vendor',
  description:
    'Returns one purchase order to a vendor in full: its status, revision and whether the vendor has ' +
    'the latest one, the vendor and contact as they were when it was made, the ship-to, terms and ' +
    'dates; every line (part, outside service or other) with its quantity, unit, price and where the ' +
    'price came from, its job or routing step, and what has arrived and is still open; the receipts, ' +
    'the vendor packing slips its outside lines ship on, and its state in QuickBooks. Prices are for ' +
    "every office user. Find it by id or by its PO number (PO-1042); an archived PO is found and says so.",
  access: 'read',
  input: vendorPoRef,
  output: vendorPoOutput,
  run: async (args, env) => {
    const loaded = await loadVendorPo(args, env);
    if ('message' in loaded) return { ok: false, message: loaded.message };
    return { ok: true, data: vendorPoRecord(loaded.detail, env) };
  },
});

// ------------------------------------------------------------------------------------------------
// get_buy_list
// ------------------------------------------------------------------------------------------------

const BUY_REASONS = ['job_shortage', 'below_reorder_point', 'both', 'below_zero'] as const;

const buyRowOutput = z.object({
  part: partRefOutput,
  stock_unit: z.string().nullable(),
  reason: z
    .enum(BUY_REASONS)
    .describe('`job_shortage`: open jobs need more than is on hand and coming. `below_reorder_point`. `both`. `below_zero`: no reorder point, and jobs would take it below nothing.'),
  need_by: z.string().nullable().describe('The earliest due date among the jobs that need it.'),
  on_hand: z.number().describe('In the stock unit.'),
  on_order: z.number().describe('On sent POs, still to arrive, in the stock unit.'),
  on_draft: z.number().describe('On draft POs not yet sent.'),
  demand: z.number().describe('What open jobs still need, in the stock unit.'),
  position: z.number().describe('On hand + on order + on draft − demand.'),
  reorder_point: z.number().nullable(),
  jobs: z.array(
    z.object({ job_id: z.string(), job_number: z.string(), due_date: z.string().nullable(), need: z.number(), url: urlOutput }),
  ),
  vendor: vendorRefOutput.nullable().describe("Who it would be bought from: the part's preferred vendor, else its only approved one. Null: no vendor chosen."),
  vendor_basis: z.enum(['chosen', 'preferred', 'only_approved']).nullable(),
  suggested_quantity: z.number().describe('Whole purchase units, at least one, and at least the minimum order.'),
  purchase_unit: z.string(),
  suggested_stock_quantity: z.number(),
  minimum_order_quantity: z.number().nullable(),
  unit_price: z.number().nullable().describe('The price a PO line would default to, per purchase unit. Null: no price on file.'),
  price_source: z.enum(VENDOR_PO_PRICE_SOURCES).nullable(),
  price_note: z.string().describe('Where the price comes from, in the words the app shows.'),
  amount: z.number().nullable(),
  draft_vendor_po: z
    .object({ vendor_po_id: z.string(), po_number: z.string(), url: urlOutput })
    .nullable()
    .describe('A draft PO to this vendor already open, which the part could be added to.'),
  vendor_options: z
    .array(
      z.object({
        vendor: vendorRefOutput,
        status: z.enum(PART_VENDOR_STATUSES).nullable(),
        purchase_unit: z.string(),
        suggested_quantity: z.number(),
        unit_price: z.number().nullable(),
        price_source: z.enum(VENDOR_PO_PRICE_SOURCES).nullable(),
        amount: z.number().nullable(),
      }),
    )
    .describe("The part's usable approved vendors, each priced for this need."),
  url: urlOutput.describe('The To buy list in Jigged.'),
});

function buyRowRecord(row: BuyListPricedRow, group: BuyListPricedGroup, env: CompanyToolEnv): z.infer<typeof buyRowOutput> {
  return {
    part: { part_id: row.partId, part_name: row.partName, url: partUrl(env, row.partId) },
    stock_unit: row.stockUnit,
    reason: row.reason,
    need_by: row.needBy,
    on_hand: row.onHand,
    on_order: row.onOrder,
    on_draft: row.onDraft,
    demand: row.demand,
    position: row.position,
    reorder_point: row.reorderPoint,
    jobs: row.jobs.map((j) => ({ job_id: j.jobId, job_number: j.jobNumber, due_date: j.dueDate, need: j.need, url: jobUrl(env, j.jobId) })),
    vendor: row.vendor ? { vendor_id: row.vendor.vendorId, name: row.vendor.vendorName, url: vendorUrl(env, row.vendor.vendorId) } : null,
    vendor_basis: row.vendorBasis,
    suggested_quantity: row.suggestedQuantity,
    purchase_unit: row.purchaseUnit,
    suggested_stock_quantity: row.suggestedStockQuantity,
    minimum_order_quantity: row.minimumOrderQuantity,
    unit_price: row.price.unitPrice,
    price_source: row.price.priceSource,
    price_note: row.price.caption,
    amount: row.amount,
    draft_vendor_po: group.draft
      ? { vendor_po_id: group.draft.vendorPurchaseOrderId, po_number: group.draft.poNumber, url: vendorPoUrl(env, group.draft.vendorPurchaseOrderId) }
      : null,
    vendor_options: row.vendorPrices.map((v) => ({
      vendor: { vendor_id: v.vendorId, name: v.vendorName, url: vendorUrl(env, v.vendorId) },
      status: v.status,
      purchase_unit: v.purchaseUnit,
      suggested_quantity: v.suggestedQuantity,
      unit_price: v.price.unitPrice,
      price_source: v.price.priceSource,
      amount: v.amount,
    })),
    url: toBuyUrl(env),
  };
}

export const getBuyListTool = defineCompanyTool({
  name: 'get_buy_list',
  title: 'Get the To buy list',
  description:
    "Returns what the shop should buy, the Purchasing page's To buy list: each bought part that open " +
    'jobs need more of than is on hand and on order, or that sits at or below its reorder point, in ' +
    'its stock unit, with the jobs behind it, the vendor it would be bought from, a suggested quantity ' +
    'in whole purchase units and the price a PO line would default to, and any draft PO to that ' +
    'vendor it could join. Drafts already count against the need. It only proposes: nothing is ' +
    'ordered until a purchase order to a vendor is made (create_vendor_po). Only top-level ' +
    'materials count, and only POs in Jigged count as on order. Parts whose need cannot be measured ' +
    '(units that do not convert) are listed apart. Filters: vendor and part number.',
  access: 'read',
  input: {
    vendor_id: z.guid().optional().describe('Only what would be bought from this vendor.'),
    search: z.string().max(200).optional().describe('Part number contains.'),
    ...pageInput,
  },
  output: {
    rows: z.array(buyRowOutput),
    ...pageOutput,
    incomparable: z
      .array(z.object({ part: partRefOutput, stock_unit: z.string().nullable(), job_numbers: z.array(z.string()) }))
      .describe("Parts jobs need in a unit that doesn't convert to their stock unit, so no shortage can be worked out."),
    job_row_count: z.number(),
    reorder_row_count: z.number(),
    no_vendor_row_count: z.number(),
    truncated: z.boolean().describe('A read hit its cap, so the list may be incomplete.'),
    url: urlOutput,
  },
  run: async (args, env) => {
    if (cursorOffset(args.cursor) === null) return { ok: false, message: BAD_CURSOR_MESSAGE };
    const list = await getBuyList(env.company.id, { today: todayUtc() });
    const rows = list.groups
      .flatMap((group) => group.rows.map((row) => ({ group, row })))
      .filter(({ group }) => !args.vendor_id || group.vendorId === args.vendor_id)
      .filter(({ row }) => matchesText(args.search, row.partName));
    const page = paginate(rows, args);
    if (!page) return { ok: false, message: BAD_CURSOR_MESSAGE };
    return {
      ok: true,
      data: {
        rows: page.items.map(({ row, group }) => buyRowRecord(row, group, env)),
        total: page.total,
        next_cursor: page.next_cursor,
        incomparable: list.incomparable.map((b) => ({
          part: { part_id: b.partId, part_name: b.partName, url: partUrl(env, b.partId) },
          stock_unit: b.stockUnit,
          job_numbers: b.jobs.map((j) => j.jobNumber),
        })),
        job_row_count: list.jobRowCount,
        reorder_row_count: list.reorderRowCount,
        no_vendor_row_count: list.noVendorRowCount,
        truncated: list.truncated,
        url: toBuyUrl(env),
      },
    };
  },
});

// ------------------------------------------------------------------------------------------------
// get_part_vendors
// ------------------------------------------------------------------------------------------------

const PART_VENDOR_STATUS_HELP = '`approved`, `conditional` (usable, with a caution) or `disapproved` (Do not use: refused on a PO).';

export const partVendorOutput = z.object({
  part_vendor_id: z.string(),
  vendor: vendorRefOutput,
  status: z.enum(PART_VENDOR_STATUSES).describe(PART_VENDOR_STATUS_HELP),
  status_note: z.string().nullable(),
  preferred: z.boolean().describe("The part's preferred vendor."),
  vendor_part_number: z.string().nullable(),
  purchase_unit: z.string().describe('The unit this vendor sells it in.'),
  units_per_purchase_unit: z.number().nullable().describe('Stock units in one purchase unit; null when the unit no longer converts.'),
  unit_note: z.string().nullable().describe('"1 bar = 144 in"; null for the stock unit itself.'),
  lead_time_days: z.number().nullable(),
  minimum_order_quantity: z.number().nullable().describe('In purchase units.'),
  quoted_on: z.string().nullable(),
  valid_until: z.string().nullable(),
  expired: z.boolean().describe('The price sheet is past its valid-until date: shown, never used as a price.'),
  notes: z.string().nullable(),
  price_breaks: z
    .array(z.object({ min_quantity: z.number().describe('In purchase units.'), unit_price: z.number(), from_rfq: z.boolean() }))
    .describe('The price sheet, smallest break first. A price holds from its quantity up to the next.'),
  last_po_price: z
    .object({
      vendor_po_id: z.string(),
      po_number: z.string(),
      ordered_on: z.string().nullable(),
      quantity: z.number(),
      unit: z.string(),
      unit_price: z.number(),
      unit_price_per_stock_unit: z.number().nullable(),
      url: urlOutput,
    })
    .nullable()
    .describe('Last PO price: the newest priced line for this part on a sent purchase order to this vendor.'),
});

export const partVendorsOutput = {
  part: z.object({
    part_id: z.string(),
    part_name: z.string(),
    source: z.string().describe('`made` or `bought`. "Use as part cost" is for bought parts.'),
    stock_unit: z.string().nullable(),
    archived: z.boolean(),
    url: urlOutput,
  }),
  preferred_vendor_missing: z.boolean().describe('The preferred vendor is archived, so it is not among `vendors`.'),
  vendors: z.array(partVendorOutput).describe('Preferred first, then by name. Archived vendors are left out.'),
  url: urlOutput.describe("The part's page in Jigged, where its Buying tab is."),
};

function partVendorRecord(r: PartVendorRow, env: CompanyToolEnv): z.infer<typeof partVendorOutput> {
  return {
    part_vendor_id: r.id,
    vendor: { vendor_id: r.vendorId, name: r.vendorName, url: vendorUrl(env, r.vendorId) },
    status: r.status,
    status_note: r.statusNote,
    preferred: r.isPreferred,
    vendor_part_number: r.vendorPartNumber,
    purchase_unit: r.purchaseUnit,
    units_per_purchase_unit: r.purchaseFactor,
    unit_note: r.factorLabel,
    lead_time_days: r.leadTimeDays,
    minimum_order_quantity: r.minimumOrderQuantity,
    quoted_on: r.quotedOn,
    valid_until: r.validUntil,
    expired: r.isExpired,
    notes: r.notes,
    price_breaks: r.breaks.map((b) => ({ min_quantity: b.minQuantity, unit_price: b.unitPrice, from_rfq: b.source === 'rfq' })),
    last_po_price: r.lastPurchase
      ? {
          vendor_po_id: r.lastPurchase.vendorPurchaseOrderId,
          po_number: r.lastPurchase.poNumber,
          ordered_on: r.lastPurchase.orderedOn,
          quantity: r.lastPurchase.quantity,
          unit: r.lastPurchase.unit,
          unit_price: r.lastPurchase.unitPrice,
          unit_price_per_stock_unit: r.lastPurchase.unitPricePerStockUnit,
          url: vendorPoUrl(env, r.lastPurchase.vendorPurchaseOrderId),
        }
      : null,
  };
}

export function partVendorsRecord(
  list: PartVendorList,
  part: FoundPart,
  env: CompanyToolEnv,
): z.infer<z.ZodObject<typeof partVendorsOutput>> {
  return {
    part: {
      part_id: list.part.id,
      part_name: list.part.partName,
      source: list.part.source,
      stock_unit: list.part.stockUnit,
      archived: part.deleted_at !== null,
      url: partUrl(env, list.part.id),
    },
    preferred_vendor_missing: list.preferredVendorMissing,
    vendors: list.rows.map((r) => partVendorRecord(r, env)),
    url: partUrl(env, list.part.id),
  };
}

export const getPartVendorsTool = defineCompanyTool({
  name: 'get_part_vendors',
  title: "Get a part's approved vendors",
  description:
    "Returns a part's approved vendor list, as its Buying tab shows it: each vendor's status " +
    '(approved, conditional, or do not use), whether it is the preferred vendor, its part number for ' +
    'it, the unit it sells in and how many stock units that is, lead time and minimum order, its price ' +
    'sheet (quantity breaks, the dates it was quoted and is valid until, and whether it has expired), ' +
    'and the Last PO price: the newest price on a sent purchase order to that vendor. Prices are for ' +
    'every office user. Find the part by id or exact part name.',
  access: 'read',
  input: partRef,
  output: partVendorsOutput,
  run: async (args, env) => {
    const found = await findPurchasingPart(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const list = await listPartVendors(found.part.id, { today: todayUtc() });
    if (!list) return { ok: false, message: `There is no part with that id in ${env.company.name}.` };
    return { ok: true, data: partVendorsRecord(list, found.part, env) };
  },
});

// ------------------------------------------------------------------------------------------------
// list_vendor_rfqs / get_vendor_rfq
// ------------------------------------------------------------------------------------------------

const RFQ_STATUS_HELP =
  '`draft`: not sent to any vendor yet. `sent`: sent, no quotes back. `quoted`: at least one vendor ' +
  'answered. `awarded`: every line awarded. `closed`.';

/** listVendorRfqs reads at most this many, newest first. */
const RFQ_READ_CAP = 1000;

const rfqSummaryOutput = z.object({
  vendor_rfq_id: z.string(),
  rfq_number: z.string(),
  title: z.string().nullable(),
  status: z.enum(VENDOR_RFQ_STATUSES).describe(RFQ_STATUS_HELP),
  needed_by_on: z.string().nullable(),
  respond_by_on: z.string().nullable(),
  line_count: z.number(),
  awarded_line_count: z.number(),
  invited_count: z.number(),
  sent_count: z.number(),
  declined_count: z.number(),
  responded_count: z.number().describe('Vendors who answered at least one line.'),
  vendors: z.array(z.string()).describe('The invited vendors, by name.'),
  created_at: z.string(),
  url: urlOutput,
});

function rfqSummaryRecord(r: VendorRfqListRow, env: CompanyToolEnv): z.infer<typeof rfqSummaryOutput> {
  return {
    vendor_rfq_id: r.id,
    rfq_number: r.rfqNumber,
    title: r.title,
    status: r.status,
    needed_by_on: r.neededByOn,
    respond_by_on: r.respondByOn,
    line_count: r.lineCount,
    awarded_line_count: r.awardedLineCount,
    invited_count: r.invitedCount,
    sent_count: r.sentCount,
    declined_count: r.declinedCount,
    responded_count: r.respondedCount,
    vendors: r.vendorNames,
    created_at: r.createdAt,
    url: vendorRfqUrl(env, r.id),
  };
}

export const listVendorRfqsTool = defineCompanyTool({
  name: 'list_vendor_rfqs',
  title: 'List RFQs to vendors',
  description:
    'Lists requests for quotation the shop sent to vendors (not RFQs a customer sent the shop), ' +
    'newest first, archived ones left out: each with its status, dates, how many lines and vendors, ' +
    'and how many vendors were sent it, declined and answered. Filters: status, and search text ' +
    "matching the RFQ number or title. Reads the company's 1,000 newest.",
  access: 'read',
  input: {
    statuses: z.array(z.enum(VENDOR_RFQ_STATUSES)).min(1).optional().describe(RFQ_STATUS_HELP),
    search: z.string().max(200).optional().describe('RFQ number or title contains.'),
    ...pageInput,
  },
  output: { rfqs: z.array(rfqSummaryOutput), ...pageOutput },
  run: async (args, env) => {
    if (cursorOffset(args.cursor) === null) return { ok: false, message: BAD_CURSOR_MESSAGE };
    const result = await listVendorRfqs(env.company.id, {
      statuses: args.statuses,
      search: args.search?.trim() || undefined,
      limit: RFQ_READ_CAP,
    });
    const page = paginate(result.rows, args);
    if (!page) return { ok: false, message: BAD_CURSOR_MESSAGE };
    return {
      ok: true,
      data: { rfqs: page.items.map((r) => rfqSummaryRecord(r, env)), total: page.total, next_cursor: page.next_cursor },
    };
  },
});

const OFFER_STATES = ['priced', 'expired', 'no_bid', 'no_response', 'declined'] as const;

export const vendorRfqOutput = {
  vendor_rfq_id: z.string(),
  rfq_number: z.string(),
  title: z.string().nullable(),
  status: z.enum(VENDOR_RFQ_STATUSES).describe(RFQ_STATUS_HELP),
  archived: z.boolean(),
  needed_by_on: z.string().nullable(),
  respond_by_on: z.string().nullable(),
  notes_to_vendors: z.string().nullable(),
  internal_notes: z.string().nullable(),
  closed_at: z.string().nullable(),
  line_count: z.number(),
  awarded_line_count: z.number(),
  invited_count: z.number(),
  sent_count: z.number(),
  declined_count: z.number(),
  responded_count: z.number(),
  lines: z.array(
    z.object({
      vendor_rfq_line_id: z.string(),
      line_number: z.number(),
      part: partRefOutput.nullable(),
      description: z.string(),
      unit: z.string().describe('Every quote on this line is priced per this unit.'),
      quantities: z.array(z.number()).describe('The quantities vendors are asked to price, one to four.'),
      job: jobRefOutput.nullable(),
      cert_required: z.boolean(),
      notes: z.string().nullable(),
    }),
  ),
  vendors: z.array(
    z.object({
      invitation_id: z.string(),
      vendor: vendorRefOutput,
      contact: contactOutput.nullable().describe("The vendor's contact the RFQ goes to."),
      sent_at: z.string().nullable(),
      declined_at: z.string().nullable(),
      declined_reason: z.string().nullable(),
      vendor_quote_reference: z.string().nullable(),
      quoted_on: z.string().nullable(),
    }),
  ),
  comparison: z
    .array(
      z.object({
        vendor_rfq_line_id: z.string(),
        line_number: z.number(),
        item: z.string(),
        unit: z.string(),
        quantity: z.number(),
        lowest_response_ids: z.array(z.string()).describe('Several only on a full tie.'),
        offers: z.array(
          z.object({
            response_id: z.string().nullable().describe('What award_vendor_rfq takes.'),
            vendor_id: z.string(),
            vendor_name: z.string(),
            state: z
              .enum(OFFER_STATES)
              .describe('`priced`; `expired` (past its valid-until date: never Lowest); `no_bid`; `no_response`; `declined`.'),
            unit_price: z.number().nullable().describe("Per the line's unit."),
            amount: z.number().nullable().describe('Quantity × price, to the cent.'),
            lead_time_days: z.number().nullable(),
            valid_until: z.string().nullable(),
            minimum_order_quantity: z.number().nullable(),
            vendor_part_number: z.string().nullable(),
            lowest: z.boolean().describe('The lowest valid price at this quantity; on a tie, the shorter lead time.'),
            awarded: z.boolean(),
          }),
        ),
      }),
    )
    .describe('One row per line and quantity, one offer per invited vendor.'),
  url: urlOutput,
};

export type VendorRfqOut = z.infer<z.ZodObject<typeof vendorRfqOutput>>;

export function vendorRfqRecord(d: VendorRfqDetail, env: CompanyToolEnv): VendorRfqOut {
  const responses = new Map(d.responses.map((r) => [r.id, r] as const));
  return {
    vendor_rfq_id: d.header.id,
    rfq_number: d.header.rfqNumber,
    title: d.header.title,
    status: d.status,
    archived: d.header.isArchived,
    needed_by_on: d.header.neededByOn,
    respond_by_on: d.header.respondByOn,
    notes_to_vendors: d.header.notesToVendors,
    internal_notes: d.header.internalNotes,
    closed_at: d.header.closedAt,
    line_count: d.lineCount,
    awarded_line_count: d.awardedLineCount,
    invited_count: d.invitedCount,
    sent_count: d.sentCount,
    declined_count: d.declinedCount,
    responded_count: d.respondedCount,
    lines: d.lines.map((l) => ({
      vendor_rfq_line_id: l.id,
      line_number: l.lineNumber,
      part: l.partId ? { part_id: l.partId, part_name: l.partName, url: partUrl(env, l.partId) } : null,
      description: l.description,
      unit: l.unit,
      quantities: l.quantities,
      job: l.jobId ? { job_id: l.jobId, job_number: l.jobNumber, url: jobUrl(env, l.jobId) } : null,
      cert_required: l.certRequired,
      notes: l.notes,
    })),
    vendors: d.invitations.map((i) => ({
      invitation_id: i.id,
      vendor: { vendor_id: i.vendorId, name: i.vendorName, url: vendorUrl(env, i.vendorId) },
      contact: i.vendorContact ? { name: i.vendorContact.name, email: i.vendorContact.email, phone: i.vendorContact.phone } : null,
      sent_at: i.sentAt,
      declined_at: i.declinedAt,
      declined_reason: i.declinedReason,
      vendor_quote_reference: i.vendorQuoteReference,
      quoted_on: i.quotedOn,
    })),
    comparison: d.comparison.rows.map((row) => ({
      vendor_rfq_line_id: row.lineId,
      line_number: row.lineNumber,
      item: row.label,
      unit: row.unit,
      quantity: row.quantity,
      lowest_response_ids: row.lowestResponseIds,
      offers: row.cells.map((cell) => {
        const response = cell.responseId ? responses.get(cell.responseId) : undefined;
        return {
          response_id: cell.responseId,
          vendor_id: cell.vendorId,
          vendor_name: cell.vendorName,
          state: cell.state,
          unit_price: cell.unitPrice,
          amount: cell.amount,
          lead_time_days: cell.leadTimeDays,
          valid_until: cell.validUntil,
          minimum_order_quantity: response?.minimumOrderQuantity ?? null,
          vendor_part_number: response?.vendorPartNumber ?? null,
          lowest: cell.isLowest,
          awarded: Boolean(response?.awardedAt),
        };
      }),
    })),
    url: vendorRfqUrl(env, d.header.id),
  };
}

/** The RFQ in full, found in this company first. */
export async function loadVendorRfq(
  args: { vendor_rfq_id?: string; rfq_number?: string },
  env: CompanyToolEnv,
): Promise<{ rfq: FoundVendorRfq; detail: VendorRfqDetail } | { message: string }> {
  const found = await findVendorRfq(args, env);
  if ('message' in found) return found;
  const detail = await getVendorRfq(found.rfq.id, { today: todayUtc() });
  if (!detail) return { message: `There is no RFQ with that id in ${env.company.name}.` };
  return { rfq: found.rfq, detail };
}

export const getVendorRfqTool = defineCompanyTool({
  name: 'get_vendor_rfq',
  title: 'Get an RFQ to vendors',
  description:
    'Returns one request for quotation the shop sent to vendors: its lines (a part or a description, ' +
    'one unit, up to four quantities each), the invited vendors with their contact and whether each ' +
    'was sent it, declined or quoted, and the comparison — one row per line and quantity with every ' +
    "vendor's offer per the line's unit, marking the lowest valid price (an expired quote is never " +
    'lowest; a tie goes to the shorter lead time) and what was awarded. award_vendor_rfq takes the ' +
    "offers' response ids. Find it by id or RFQ number; an archived RFQ is found and says so.",
  access: 'read',
  input: vendorRfqRef,
  output: vendorRfqOutput,
  run: async (args, env) => {
    const loaded = await loadVendorRfq(args, env);
    if ('message' in loaded) return { ok: false, message: loaded.message };
    return { ok: true, data: vendorRfqRecord(loaded.detail, env) };
  },
});

// ------------------------------------------------------------------------------------------------
// preview_part_cost_from_vendor
// ------------------------------------------------------------------------------------------------

export const partVendorRef = {
  part_vendor_id: z.guid().optional().describe('The vendor on the part\'s list, by its part_vendor_id from get_part_vendors.'),
  ...partRef,
  ...vendorNameRef,
};

export interface FoundPartVendor {
  id: string;
  part_id: string;
  vendor_id: string;
  deleted_at: string | null;
}

/** The approved-vendor row, by its id or by the part and the vendor, in this company. */
export async function findPartVendorRow(
  args: { part_vendor_id?: string; part_id?: string; part_name?: string; vendor_id?: string; vendor_name?: string },
  env: CompanyToolEnv,
): Promise<{ row: FoundPartVendor } | { message: string }> {
  const columns = 'id, part_id, vendor_id, deleted_at';
  if (args.part_vendor_id) {
    const { data, error } = await getSupabase()
      .from('part_vendors')
      .select(columns)
      .eq('company_id', env.company.id)
      .eq('id', args.part_vendor_id)
      .maybeSingle();
    if (error) throw error;
    return data ? { row: data } : { message: `There is no approved-vendor entry with that id in ${env.company.name}.` };
  }
  const hasPart = Boolean(args.part_id || args.part_name?.trim());
  const hasVendor = Boolean(args.vendor_id || args.vendor_name?.trim());
  if (!hasPart || !hasVendor) return { message: 'Give a part_vendor_id, or the part and the vendor.' };
  const part = await findPurchasingPart(args, env);
  if ('message' in part) return part;
  const vendor = await findPurchasingVendor(args, env);
  if ('message' in vendor) return vendor;
  const { data, error } = await getSupabase()
    .from('part_vendors')
    .select(columns)
    .eq('company_id', env.company.id)
    .eq('part_id', part.part.id)
    .eq('vendor_id', vendor.vendor.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    return { message: `${vendor.vendor.name} isn't on ${part.part.part_name}'s vendor list. Add it with save_part_vendor first.` };
  }
  return { row: data };
}

/** The preview's warning codes, in words. */
export function sourcingWarning(code: string, preview: PartCostPreview, applied: boolean): string {
  if (code === 'starter_tiers_inserted') {
    return applied
      ? `${preview.partName} had no pricing tiers, so these were added at 0% markup. Set its markups before quoting it.`
      : `${preview.partName} has no pricing tiers yet, so these would be added at 0% markup. Set its markups before quoting it.`;
  }
  if (code === 'below_vendor_minimum') {
    return (
      `Some of the part's quantity breaks are below ${preview.vendorName}'s smallest price break, so ` +
      "that break's price is used for them."
    );
  }
  return code;
}

export const partCostPreviewOutput = {
  part_vendor_id: z.string(),
  part: partRefOutput,
  vendor: vendorRefOutput,
  purchase_unit: z.string(),
  stock_unit: z.string().nullable(),
  units_per_purchase_unit: z.number(),
  quoted_on: z.string().nullable(),
  valid_until: z.string().nullable(),
  tiers: z
    .array(
      z.object({
        quantity: z.number().describe("The tier's quantity break, in the stock unit."),
        cost_per_unit_now: z.number().nullable(),
        cost_per_unit_new: z.number().describe("The vendor's price per stock unit at this quantity."),
        markup_percent: z.number().nullable().describe('Unchanged.'),
        unit_price_now: z.number().nullable(),
        unit_price_new: z.number().nullable(),
        vendor_break_quantity: z.number().nullable().describe('The price-sheet break used, in purchase units.'),
        vendor_unit_price: z.number().nullable().describe('Per purchase unit.'),
        below_vendor_minimum: z.boolean(),
      }),
    )
    .describe("The part's existing cost tiers, each with its cost now and what it would become."),
  new_tiers: z
    .array(
      z.object({
        quantity: z.number(),
        cost_per_unit: z.number(),
        markup_percent: z.number(),
        vendor_break_quantity: z.number().nullable(),
        vendor_unit_price: z.number().nullable(),
      }),
    )
    .describe('Tiers added because the part has none yet.'),
  open_quotes_affected: z.number().describe('Open quotes with this part that will show "Pricing changed"; their prices stay.'),
  parts_using_it: z.number().describe('Parts that use it as material, and re-cost.'),
  warnings: warningsOutput,
  url: urlOutput.describe("The part's page in Jigged."),
};

export function partCostPreviewRecord(
  p: PartCostPreview,
  env: CompanyToolEnv,
  applied: boolean,
): z.infer<z.ZodObject<typeof partCostPreviewOutput>> {
  return {
    part_vendor_id: p.partVendorId,
    part: { part_id: p.partId, part_name: p.partName, url: partUrl(env, p.partId) },
    vendor: { vendor_id: p.vendorId, name: p.vendorName, url: vendorUrl(env, p.vendorId) },
    purchase_unit: p.purchaseUnit,
    stock_unit: p.stockUnit,
    units_per_purchase_unit: p.stockFactor,
    quoted_on: p.quotedOn,
    valid_until: p.validUntil,
    tiers: p.tiers.map((t) => ({
      quantity: t.quantity,
      cost_per_unit_now: t.currentCost,
      cost_per_unit_new: t.proposedCost,
      markup_percent: t.markupPercent,
      unit_price_now: t.currentPrice,
      unit_price_new: t.proposedPrice,
      vendor_break_quantity: t.vendorMinQuantity,
      vendor_unit_price: t.vendorUnitPrice,
      below_vendor_minimum: t.belowVendorMinimum,
    })),
    new_tiers: p.inserts.map((t) => ({
      quantity: t.quantity,
      cost_per_unit: t.proposedCost,
      markup_percent: t.markupPercent,
      vendor_break_quantity: t.vendorMinQuantity,
      vendor_unit_price: t.vendorUnitPrice,
    })),
    open_quotes_affected: p.openQuoteCount,
    parts_using_it: p.bomParentPartCount,
    warnings: p.warnings.map((code) => sourcingWarning(code, p, applied)),
    url: partUrl(env, p.partId),
  };
}

export const ROW_TAKEN_OFF = "That vendor was taken off this part's vendor list";

export const previewPartCostFromVendorTool = defineCompanyTool({
  name: 'preview_part_cost_from_vendor',
  title: "Preview a vendor's price as part cost",
  description:
    'Shows what "Use as part cost" would do with one vendor\'s price sheet for a bought part, without ' +
    "doing it: each of the part's cost tiers with its cost now and the vendor's price per stock unit " +
    'at that quantity (markups unchanged, so each price moves with its cost), tiers that would be ' +
    'added when the part has none, how many open quotes would show "Pricing changed" (their prices ' +
    'stay), and how many parts that use it as material would re-cost. Existing jobs keep their frozen ' +
    "cost. Refused for a made part, or a sheet that is empty or expired. Find the vendor's entry by " +
    'part_vendor_id, or by the part and the vendor. set_part_cost_from_vendor applies it.',
  access: 'read',
  input: partVendorRef,
  output: partCostPreviewOutput,
  run: async (args, env) => {
    const found = await findPartVendorRow(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    if (found.row.deleted_at) return { ok: false, message: `${ROW_TAKEN_OFF}, so it has no price to preview.` };
    const preview = await previewPartCostFromVendor(found.row.id, todayUtc());
    return { ok: true, data: partCostPreviewRecord(preview, env, false) };
  },
});

// ------------------------------------------------------------------------------------------------
// preview_vendor_po_push
// ------------------------------------------------------------------------------------------------

export const QUICKBOOKS_OPERATIONS = ['create', 'update', 'close', 'reopen', 'none'] as const;
const VENDOR_MATCHES = ['mapped', 'exact_match', 'candidates', 'unmatched'] as const;

/** POST /api/quickbooks/{company}/vendor-pos/{po}/preflight, every shape `preflight_vendor_po` returns. */
export const vendorPoPreflightResponse = z.object({
  connected: z.boolean(),
  provider: z.enum(['qbo', 'qbd']).optional(),
  has_deep_links: z.boolean().optional(),
  operation: z.enum(QUICKBOOKS_OPERATIONS).optional(),
  blocked: z.object({ code: z.string(), link_id: z.string(), message: z.string() }).nullable().optional(),
  refusal: z.object({ code: z.string(), message: z.string() }).nullable().optional(),
  setup_missing: z.array(z.string()).optional(),
  vendor: z
    .object({
      status: z.enum(VENDOR_MATCHES),
      qb_vendor_id: z.string().nullable(),
      candidates: z.array(z.object({ qb_id: z.string(), display_name: z.string().nullable() })),
      jigged_vendor_id: z.string(),
      jigged_name: z.string(),
      name_problem: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  link: z
    .object({
      id: z.string(),
      status: z.string(),
      qb_po_id: z.string().nullable(),
      qb_doc_number: z.string().nullable(),
      qb_url: z.string().nullable(),
      qb_closed: z.boolean(),
      out_of_date: z.boolean(),
    })
    .nullable()
    .optional(),
  warnings: z.array(z.string()).optional(),
});

export type VendorPoPreflight = z.infer<typeof vendorPoPreflightResponse>;
export type PreflightVendor = NonNullable<VendorPoPreflight['vendor']>;

export function runVendorPoPreflight(env: CompanyToolEnv, poId: string): Promise<VendorPoPreflight> {
  return callBackend(env, `/api/quickbooks/${env.company.id}/vendor-pos/${poId}/preflight`, vendorPoPreflightResponse, {
    body: {},
  });
}

export const QUICKBOOKS_NOT_CONNECTED =
  "QuickBooks isn't connected, so nothing can be sent to it. An admin can connect it in Jigged under Settings.";

const SETUP_WORDS: Record<string, string> = {
  'item:part': 'the QuickBooks item for parts and material',
  'item:outside_service': 'the QuickBooks item for outside services',
  'item:other': 'the QuickBooks item for other purchases',
  ap_account: 'the accounts-payable account',
};

const setupWord = (key: string): string => SETUP_WORDS[key] ?? key;

export function vendorChoiceSentence(name: string): string {
  return (
    `QuickBooks has several vendors that could be ${name}; the push needs one chosen ` +
    '(quickbooks_vendor_id) or a new one created (create_quickbooks_vendor).'
  );
}

/** What stops a push now, in the order a person would want to hear it. Empty when nothing does. */
export function pushBlockers(pre: VendorPoPreflight): string[] {
  if (!pre.connected) return [QUICKBOOKS_NOT_CONNECTED];
  const out: string[] = [];
  if (pre.blocked) out.push(pre.blocked.message);
  if (pre.refusal) out.push(pre.refusal.message);
  const missing = pre.setup_missing ?? [];
  if (missing.length > 0) {
    out.push(
      `Finish the QuickBooks purchasing setup first: choose ${andJoin(missing.map(setupWord))} in Settings → ` +
        'QuickBooks → Purchasing. An admin can do it.',
    );
  }
  const vendor = pre.vendor;
  if (vendor?.status === 'candidates') out.push(vendorChoiceSentence(vendor.jigged_name));
  if (vendor?.status === 'unmatched' && vendor.name_problem) {
    out.push(
      `QuickBooks can't take the vendor name "${vendor.jigged_name}" because ${vendor.name_problem}, so it ` +
        "can't be created there. Change the vendor's name in Jigged.",
    );
  }
  return out;
}

const VENDOR_MATCH_HELP =
  '`linked`: Jigged already sends this vendor\'s POs to this QuickBooks vendor. `exact_match`: ' +
  'QuickBooks has a vendor with exactly this name. `candidates`: vendors with similar names. ' +
  '`unmatched`: none.';

const ON_PUSH_HELP =
  'What push_vendor_po_to_quickbooks does for the vendor without being told: `use_linked`, ' +
  '`use_exact_match` (and link it), `choose` (it needs quickbooks_vendor_id or ' +
  'create_quickbooks_vendor), or `create_in_quickbooks`.';

const pushVendorOutput = z.object({
  vendor_id: z.string(),
  name: z.string(),
  match: z.enum(['linked', 'exact_match', 'candidates', 'unmatched']).describe(VENDOR_MATCH_HELP),
  quickbooks_vendor_id: z.string().nullable(),
  candidates: z.array(z.object({ quickbooks_vendor_id: z.string(), name: z.string().nullable() })),
  on_push: z.enum(['use_linked', 'use_exact_match', 'choose', 'create_in_quickbooks']).describe(ON_PUSH_HELP),
  name_problem: z.string().nullable().describe("Why QuickBooks can't take this name for a new vendor, if it can't."),
});

function pushVendorRecord(v: PreflightVendor): z.infer<typeof pushVendorOutput> {
  const onPush = {
    mapped: 'use_linked',
    exact_match: 'use_exact_match',
    candidates: 'choose',
    unmatched: 'create_in_quickbooks',
  } as const;
  return {
    vendor_id: v.jigged_vendor_id,
    name: v.jigged_name,
    match: v.status === 'mapped' ? 'linked' : v.status,
    quickbooks_vendor_id: v.qb_vendor_id,
    candidates: v.candidates.map((c) => ({ quickbooks_vendor_id: c.qb_id, name: c.display_name })),
    on_push: onPush[v.status],
    name_problem: v.name_problem ?? null,
  };
}

export const previewVendorPoPushTool = defineCompanyTool({
  name: 'preview_vendor_po_push',
  title: 'Preview sending a vendor PO to QuickBooks',
  description:
    'Shows what sending one purchase order to a vendor to QuickBooks (Online or Desktop) would do, ' +
    'without sending it: whether QuickBooks is connected, whether the push would create the PO there ' +
    'or update, close or reopen it, how the vendor matches a QuickBooks vendor (linked, an exact ' +
    'match, similar names, or none), what QuickBooks will hold differently from the PDF, and in ' +
    '`missing` what stops a push now (a draft or an unsent revision, a line with no price, the ' +
    'purchasing setup, an earlier send nobody confirmed). Asks QuickBooks for matching vendors when the ' +
    'vendor is not linked yet. Jigged never creates bills or item receipts. Find the PO by id or number.',
  access: 'read',
  openWorld: true,
  input: vendorPoRef,
  output: {
    vendor_po_id: z.string(),
    po_number: z.string().describe(PO_NUMBER_HELP),
    quickbooks_connected: z.boolean(),
    quickbooks: z.enum(['online', 'desktop']).nullable(),
    operation: z.enum(QUICKBOOKS_OPERATIONS).nullable().describe('What a push would do; `none`: QuickBooks already holds exactly this.'),
    blocked_by_unconfirmed_attempt: z.boolean(),
    vendor: pushVendorOutput.nullable(),
    setup_missing: z.array(z.string()).describe('Purchasing setup an admin still has to choose in Settings → QuickBooks.'),
    in_quickbooks: z
      .object({
        number: z.string().nullable(),
        quickbooks_url: z.string().nullable(),
        closed_in_quickbooks: z.boolean(),
        out_of_date: z.boolean().describe('Changed in Jigged since it was sent.'),
      })
      .nullable()
      .describe('Its copy in QuickBooks, once sent.'),
    missing: z.array(z.string()).describe('What stops a push now. Empty when nothing does.'),
    warnings: z.array(z.string()).describe('What QuickBooks will hold differently from the PDF. None of it stops a push.'),
    url: urlOutput,
  },
  run: async (args, env) => {
    const found = await findVendorPo(args, env);
    if ('message' in found) return { ok: false, message: found.message };
    const { po } = found;
    const pre = await runVendorPoPreflight(env, po.id);
    const link = pre.link ?? null;
    return {
      ok: true,
      data: {
        vendor_po_id: po.id,
        po_number: po.po_number,
        quickbooks_connected: pre.connected,
        quickbooks: providerLabel(pre.provider),
        operation: pre.operation ?? null,
        blocked_by_unconfirmed_attempt: Boolean(pre.blocked),
        vendor: pre.vendor ? pushVendorRecord(pre.vendor) : null,
        setup_missing: (pre.setup_missing ?? []).map(setupWord),
        in_quickbooks: link?.qb_po_id
          ? {
              number: link.qb_doc_number,
              quickbooks_url: link.qb_url,
              closed_in_quickbooks: link.qb_closed,
              out_of_date: link.out_of_date,
            }
          : null,
        missing: pushBlockers(pre),
        warnings: pre.warnings ?? [],
        url: vendorPoUrl(env, po.id),
      },
    };
  },
});

// ------------------------------------------------------------------------------------------------
// Registration
// ------------------------------------------------------------------------------------------------

export function registerPurchasingTools(server: ToolTarget): void {
  registerCompanyTool(server, listVendorPosTool);
  registerCompanyTool(server, getVendorPoTool);
  registerCompanyTool(server, getBuyListTool);
  registerCompanyTool(server, getPartVendorsTool);
  registerCompanyTool(server, listVendorRfqsTool);
  registerCompanyTool(server, getVendorRfqTool);
  registerCompanyTool(server, previewPartCostFromVendorTool);
  registerCompanyTool(server, previewVendorPoPushTool);
}

/** Exported for the catalogue test. */
export const PURCHASING_TOOLS = [
  listVendorPosTool,
  getVendorPoTool,
  getBuyListTool,
  getPartVendorsTool,
  listVendorRfqsTool,
  getVendorRfqTool,
  previewPartCostFromVendorTool,
  previewVendorPoPushTool,
];
