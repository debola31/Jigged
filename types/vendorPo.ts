/**
 * Purchase orders TO A VENDOR — the shapes `utils/vendorPoAccess.ts` reads and writes (plan §3).
 *
 * "PO" alone already means the customer's PO (`jobs.customer_po_number`), so every name here says
 * vendor. Statuses, progress, amounts and the QuickBooks state are DERIVED once in SQL
 * (`vendor_purchase_order_status`, `vendor_purchase_order_line_status`) and only carried here; the
 * one thing computed in TypeScript is `isLate`, through the pinned mirror of
 * `is_vendor_purchase_order_late` with the caller's local date.
 *
 * Inputs follow the RPCs' PATCH semantics: a key left `undefined` is not sent (the database keeps
 * or defaults it), `null` is sent and clears it.
 */
import type { AddressSnapshot, ContactSnapshot } from '@/types/documentSnapshot';
import type {
  VendorPoLineStatus,
  VendorPoQuickBooksState,
  VendorPoStatus,
  PartVendorStatus,
} from '@/lib/purchasing/vendorPoStatus';
import type {
  CostTier,
  LastPurchaseCandidate,
  PartVendorLineNotice,
  PriceDefault,
  PriceSheet,
  VendorPoPriceSource,
} from '@/lib/purchasing/priceDefault';
import type { PurchaseUnitBasis, UnitConversionRow } from '@/lib/purchasing/purchaseUnits';
import type { ReceiptEntry, ReceiptQuantityUnit } from '@/lib/purchasing/poReceipt';

export type {
  VendorPoLineStatus,
  VendorPoQuickBooksState,
  VendorPoStatus,
  VendorPoPriceSource,
  ReceiptEntry,
  ReceiptQuantityUnit,
};

export type VendorPoLineKind = 'part' | 'outside_service' | 'other';
export type VendorPoShipToKind = 'shop' | 'vendor' | 'customer';

// ------------------------------------------------------------------------------------------------
// The list (vendor_purchase_order_status)
// ------------------------------------------------------------------------------------------------

/** The view columns the list may sort by on the server. Jobs is derived, so it never sorts. */
export const VENDOR_PO_SORT_FIELDS = [
  'po_number',
  'vendor_name',
  'status',
  'ordered_on',
  'next_expected_on',
  'ordered_amount',
  'open_amount',
  'quickbooks_state',
  'created_at',
  'updated_at',
] as const;
export type VendorPoSortField = (typeof VENDOR_PO_SORT_FIELDS)[number];

/** The list's default order: what is due next, first. */
export const VENDOR_PO_DEFAULT_SORT: { field: VendorPoSortField; direction: 'asc' | 'desc' } = {
  field: 'next_expected_on',
  direction: 'asc',
};

/** How many rows one list read returns at most (the list says "Showing the N newest of M"). */
export const VENDOR_PO_LIST_LIMIT = 500;

export interface VendorPoListRow {
  id: string;
  companyId: string;
  poNumber: string;
  vendorId: string;
  /** The frozen copy on the PO, not the live vendor. */
  vendorName: string;
  status: VendorPoStatus;
  orderedOn: string;
  needByOn: string | null;
  /** The earliest expected date over the outstanding lines. */
  nextExpectedOn: string | null;
  /** `is_vendor_purchase_order_late(status, next_expected_on, today)` with the caller's date. */
  isLate: boolean;
  revision: number;
  sentRevision: number | null;
  /** `revision > sent_revision`: "Rev N not sent". */
  hasUnsentChanges: boolean;
  issuedAt: string | null;
  lastSentAt: string | null;
  closedAt: string | null;
  lineCount: number;
  outstandingLineCount: number;
  /** Sum of line amounts (round(qty × price, 2) each). TBC lines contribute nothing. */
  orderedAmount: number;
  /** "Open value (at PO price)": what is still to arrive, at the PO price. */
  openAmount: number;
  hasUnpricedLines: boolean;
  quickbooksState: VendorPoQuickBooksState;
  jobIds: string[];
  jobNumbers: string[];
  vendorRfqId: string | null;
  createdAt: string;
  updatedAt: string;
  isArchived: boolean;
}

export interface VendorPoListFilters {
  /** The caller's local date (`todayLocalISODate()`): drives `isLate` and `overdueOnly`. */
  today: string;
  statuses?: readonly VendorPoStatus[];
  vendorId?: string | null;
  jobId?: string | null;
  /** Late POs only: still owed something, and the next expected date is before `today`. */
  overdueOnly?: boolean;
  /** Matches `search_text`: PO number, vendor, part numbers, vendor part numbers, job numbers. */
  search?: string | null;
  quickbooksStates?: readonly VendorPoQuickBooksState[];
  sort?: { field: VendorPoSortField; direction: 'asc' | 'desc' };
  /** Default VENDOR_PO_LIST_LIMIT. MCP pages at 50. */
  limit?: number;
  offset?: number;
}

export interface VendorPoListResult {
  rows: VendorPoListRow[];
  /** Every PO the filters match, not just this page. */
  total: number;
  /** There are more matches than this page holds. */
  truncated: boolean;
}

// ------------------------------------------------------------------------------------------------
// One PO
// ------------------------------------------------------------------------------------------------

/** The header as stored: the parties are the FROZEN copies, never the live vendor or customer. */
export interface VendorPoHeader {
  id: string;
  companyId: string;
  poNumber: string;
  vendorId: string;
  vendorName: string;
  vendorAddressId: string | null;
  vendorAddress: AddressSnapshot | null;
  vendorContactId: string | null;
  vendorContact: ContactSnapshot | null;
  shipToKind: VendorPoShipToKind;
  shipToVendorId: string | null;
  shipToVendorAddressId: string | null;
  shipToCustomerId: string | null;
  shipToCustomerAddressId: string | null;
  shipToName: string;
  shipToAddress: AddressSnapshot | null;
  orderedOn: string;
  needByOn: string | null;
  paymentTerms: string | null;
  shipVia: string | null;
  notesToVendor: string | null;
  /** Never printed, never pushed, never bumps the revision. */
  internalNotes: string | null;
  termsAndConditions: string | null;
  revision: number;
  sentRevision: number | null;
  issuedAt: string | null;
  lastSentAt: string | null;
  contentVersion: number;
  closedAt: string | null;
  closedReason: string | null;
  vendorRfqId: string | null;
  createdAt: string;
  /**
   * EXACTLY the string PostgREST returned. Send it back unchanged as `expectedUpdatedAt`:
   * `new Date(…).toISOString()` drops the microseconds and every save would read as stale.
   */
  updatedAt: string;
  deletedAt: string | null;
  isArchived: boolean;
}

/** The derived facts about a PO (vendor_purchase_order_status). */
export interface VendorPoSummary {
  status: VendorPoStatus;
  isLate: boolean;
  nextExpectedOn: string | null;
  lineCount: number;
  outstandingLineCount: number;
  orderedAmount: number;
  openAmount: number;
  hasUnpricedLines: boolean;
  hasUnsentChanges: boolean;
  quickbooksState: VendorPoQuickBooksState;
  jobIds: string[];
  jobNumbers: string[];
}

/** One line, with its progress (vendor_purchase_order_line_status). */
export interface VendorPoLine {
  id: string;
  vendorPurchaseOrderId: string;
  lineNumber: number;
  lineKind: VendorPoLineKind;
  partId: string | null;
  partName: string | null;
  description: string;
  vendorPartNumber: string | null;
  /** In the purchase unit. */
  quantity: number;
  unit: string;
  /** Part lines: the frozen stock unit and factor (stock = quantity × factor, exactly). */
  stockUnit: string | null;
  stockFactor: number | null;
  /** Per purchase unit; null = to be confirmed (prints TBC). */
  unitPrice: number | null;
  priceSource: VendorPoPriceSource | null;
  /** round(quantity × price, 2); null while TBC. */
  amount: number | null;
  /** What is still to arrive, at the PO price. */
  openAmount: number | null;
  needByOn: string | null;
  /** Internal: never printed, never bumps the revision. Part and other lines only. */
  promisedOn: string | null;
  /** Part/other: promised, else need-by. Outside: the earliest due-back of slips still out. */
  expectedOn: string | null;
  certRequired: boolean;
  expectsReceipt: boolean;
  jobId: string | null;
  jobNumber: string | null;
  jobPartId: string | null;
  jobOperationId: string | null;
  operationLabel: string | null;
  vendorServiceId: string | null;
  serviceName: string | null;
  workCenterId: string | null;
  workCenterName: string | null;
  closedAt: string | null;
  status: VendorPoLineStatus;
  isLate: boolean;
  /** Part lines, in stock units. */
  orderedStockQuantity: number | null;
  /** Purchase units (pieces for outside lines, from their linked slips). */
  receivedQuantity: number;
  receivedStockQuantity: number | null;
  remainingQuantity: number;
  remainingStockQuantity: number | null;
  /** 0 once received, closed or archived. */
  openQuantity: number;
  openStockQuantity: number | null;
  /** "Received +N". */
  overReceivedQuantity: number;
  /** Outside lines: from linked live slips. */
  sentQuantity: number | null;
  atVendorQuantity: number | null;
  linkedSlipCount: number;
  /** Something live arrived: kind, part, unit and factor are fixed. */
  hasLiveReceipts: boolean;
  /** No receipt ever (voided ones included) and nothing back on a slip: the line may be removed. */
  removable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface VendorPoReceipt {
  id: string;
  vendorPurchaseOrderLineId: string;
  lineNumber: number | null;
  lineKind: 'part' | 'other';
  receiptGroupId: string;
  entryIndex: number;
  /** Exactly as typed, in `unit` (the purchase or the stock unit). */
  quantity: number;
  unit: string;
  stockQuantity: number | null;
  stockUnit: string | null;
  partId: string | null;
  locationId: string | null;
  locationName: string | null;
  lotId: string | null;
  lotCode: string | null;
  heatNumber: string | null;
  startedTracking: boolean;
  inventoryTransactionId: string | null;
  voidTransactionId: string | null;
  vendorPackingSlip: string | null;
  notes: string | null;
  receivedAt: string;
  /** Resolved from user_company_access; never sent to an AI assistant. */
  receivedByName: string | null;
  voidedAt: string | null;
  voidReason: string | null;
}

/** A vendor packing slip (outside_shipments) shipping against one of this PO's outside lines. */
export interface VendorPoOutsideSlip {
  id: string;
  slipNumber: string;
  vendorPurchaseOrderLineId: string;
  jobId: string;
  jobOperationId: string;
  quantity: number;
  shippedAt: string;
  dueBackOn: string | null;
  closedAt: string | null;
  voidedAt: string | null;
  /** Σ live receipts' good pieces. */
  receivedQuantity: number;
  /** Still at the vendor: 0 once closed or voided. */
  outstandingQuantity: number;
}

/** The QuickBooks link, read from Jigged's own table. Never a QuickBooks call. */
export interface VendorPoQuickBooksInfo {
  state: VendorPoQuickBooksState;
  linkId: string | null;
  provider: 'qbo' | 'qbd' | null;
  linkStatus: 'pending' | 'created' | 'error' | 'needs_verification' | null;
  /** "In QuickBooks as 1043" — QuickBooks' own number when custom numbers are off. */
  docNumber: string | null;
  /** Null for QuickBooks Desktop: there is no web page to open. */
  url: string | null;
  closedInQuickBooks: boolean;
  pushedRevision: number | null;
  pushedAt: string | null;
}

export interface VendorPoDetail {
  header: VendorPoHeader;
  summary: VendorPoSummary;
  lines: VendorPoLine[];
  /** Newest first, voided ones included (they show as voided). */
  receipts: VendorPoReceipt[];
  outsideSlips: VendorPoOutsideSlip[];
  /** How many revisions have been marked sent. */
  revisionCount: number;
  quickbooks: VendorPoQuickBooksInfo;
}

// ------------------------------------------------------------------------------------------------
// Writes
// ------------------------------------------------------------------------------------------------

/**
 * Where it ships. `shop` names nothing else. `vendor` needs `vendorId` (drop-ship to the
 * plater); `customer` needs `customerId`. A missing address id takes that party's default.
 */
export interface VendorPoShipToInput {
  kind: VendorPoShipToKind;
  vendorId?: string | null;
  vendorAddressId?: string | null;
  customerId?: string | null;
  customerAddressId?: string | null;
}

/** Header fields a create may set. `undefined` = let the database default it; `null` = none. */
export interface VendorPoHeaderInput {
  /** Default: the vendor's sales contact, else its primary contact. */
  vendorContactId?: string | null;
  /** Default: the vendor's default address. */
  vendorAddressId?: string | null;
  /** Default: our shop. */
  shipTo?: VendorPoShipToInput;
  needByOn?: string | null;
  /** Default: the vendor's standing terms (`vendors.default_payment_terms`). */
  paymentTerms?: string | null;
  shipVia?: string | null;
  notesToVendor?: string | null;
  internalNotes?: string | null;
}

/**
 * A save's header changes. `shipTo` is ONE key for the RPC (`ship_to`), although
 * `lib/purchasing/vendorPoVisibleFields.ts` lists its five columns separately: a form that diffs
 * those columns sends the whole `shipTo` object when any of them moved.
 */
export interface VendorPoHeaderChanges extends VendorPoHeaderInput {
  /** Drafts only, and only with no outside-service lines. */
  vendorId?: string;
  /** Drafts only. */
  orderedOn?: string;
}

/** A new line (no id). Which keys matter depends on the kind; the RPC enforces the rest. */
export interface VendorPoNewLineInput {
  lineKind: VendorPoLineKind;
  /** Part lines: any live part, made or bought. */
  partId?: string | null;
  /** Outside-service lines: the routing step this vendor performs. */
  jobOperationId?: string | null;
  jobId?: string | null;
  jobPartId?: string | null;
  /** Other lines: the machine it is for. */
  workCenterId?: string | null;
  description?: string | null;
  vendorPartNumber?: string | null;
  /** Purchase units. Outside lines default to the job part's quantity. */
  quantity?: number;
  /** Part lines: the stock unit, a unit the part converts, a preset, or a new unit with `unitFactor`. */
  unit?: string | null;
  /** "Another unit…": stock units in one `unit`, stored as the part's conversion first. */
  unitFactor?: number | null;
  /** Per purchase unit. Omitted or null = to be confirmed (TBC). */
  unitPrice?: number | null;
  /** Where the price came from (priceDefault). A price with no source is stored as `manual`. */
  priceSource?: VendorPoPriceSource | null;
  needByOn?: string | null;
  promisedOn?: string | null;
  certRequired?: boolean;
  /** Other lines only: false for freight or a fee. */
  expectsReceipt?: boolean;
}

/**
 * An existing line: its id and ONLY the keys that change. Its kind and routing step are what the
 * line IS and never change (the RPC refuses it, draft or sent): a different kind or step is a new
 * line, with the old one removed or closed.
 */
export interface VendorPoLinePatch extends Partial<Omit<VendorPoNewLineInput, 'lineKind' | 'jobOperationId'>> {
  id: string;
}

export type VendorPoLineWrite = VendorPoNewLineInput | VendorPoLinePatch;

export interface CreateVendorPoInput {
  vendorId: string;
  /** The order date — the caller's local date; editable while a draft. */
  orderedOn: string;
  /** The caller's local date (`todayLocalISODate()`). */
  today: string;
  header?: VendorPoHeaderInput;
  /** At least one. */
  lines: VendorPoNewLineInput[];
}

export interface UpdateVendorPoInput {
  /** The caller's local date. */
  today: string;
  changes?: VendorPoHeaderChanges;
  /** New lines (no id) and patches to existing ones (id + changed keys). */
  lines?: VendorPoLineWrite[];
  removedLineIds?: string[];
  /** `header.updatedAt` exactly as read. Checked only when the vendor's copy would change. */
  expectedUpdatedAt?: string | null;
}

/** What `save_vendor_purchase_order` and `create` report back. */
export interface VendorPoSaveResult {
  id: string;
  poNumber: string;
  status: VendorPoStatus | null;
  /** One per element of the `lines` sent, in order. */
  lineIds: string[];
  /** Slips an inserted outside line picked up. */
  linkedOutsideShipmentIds: string[];
  /** Slips a removed outside line let go. */
  unlinkedOutsideShipmentIds: string[];
  revision: number;
  sentRevision: number | null;
  /** This save opened a new revision: "Rev N — send it again". */
  revisionBumped: boolean;
  contentVersion: number;
  /** A field QuickBooks holds moved: "Out of date in QuickBooks". */
  contentChanged: boolean;
  /** The new staleness token. */
  updatedAt: string;
}

export interface CreateVendorPoResult {
  id: string;
  poNumber: string;
}

export type VendorPoStateAction = 'mark_sent' | 'close' | 'reopen' | 'archive';

export interface VendorPoStateResult {
  id: string;
  poNumber: string;
  action: VendorPoStateAction | 'close_lines' | 'reopen_lines';
  status: VendorPoStatus | null;
  deletedAt: string | null;
  /** Lines touched by a line-level close or reopen. */
  lineIds: string[];
  /** Slips an archive unlinked. */
  unlinkedOutsideShipmentIds: string[];
  revision: number;
  sentRevision: number | null;
  contentVersion: number;
  contentChanged: boolean;
  updatedAt: string;
}

export interface ReceiveVendorPoInput {
  /**
   * One per DELIVERY. Mint it with `newVendorPoReceiptGroupId()` when the receive dialog opens and
   * send the same id on every retry of that delivery: a replay returns the first result and adds
   * no stock. (MCP derives it from the PO, lines, quantities and UTC day instead.)
   */
  receiptGroupId: string;
  /** From `planVendorPoReceipt` (lib/purchasing/poReceipt.ts): quantities exactly as typed. */
  entries: ReceiptEntry[];
  receivedAt?: string | null;
  vendorPackingSlip?: string | null;
  notes?: string | null;
}

export interface VendorPoReceivedEntry {
  receiptId: string;
  entryIndex: number;
  lineId: string;
  lineNumber: number | null;
  lineKind: 'part' | 'other';
  quantity: number;
  unit: string;
  stockQuantity: number | null;
  stockUnit: string | null;
  partId: string | null;
  locationId: string | null;
  locationName: string | null;
  lotId: string | null;
  lotCode: string | null;
  heatNumber: string | null;
  startedTracking: boolean;
  transactionId: string | null;
  voided: boolean;
  /** The place's balance now (part lines). */
  locationBalance: number | null;
  partQuantity: number | null;
  lineStatus: VendorPoLineStatus | null;
  overReceived: boolean;
  overReceivedQuantity: number;
}

export interface VendorPoReceiveResult {
  vendorPurchaseOrderId: string;
  receiptGroupId: string;
  status: VendorPoStatus | null;
  closedLineIds: string[];
  receipts: VendorPoReceivedEntry[];
  /** The lots this delivery landed in: certs upload against these, AFTER the write. */
  landedLots: Array<{ entryIndex: number; lineId: string; lotId: string; lotCode: string | null; heatNumber: string | null }>;
}

export interface VendorPoVoidReceiptResult {
  /** False when it was already voided (the call is idempotent). */
  voided: boolean;
  receiptId: string;
  voidTransactionId: string | null;
  locationBalance: number | null;
  partQuantity: number | null;
  status: VendorPoStatus | null;
}

export interface VendorPoDuplicateResult extends CreateVendorPoResult {
  /** Outside-service lines are never copied: they belong to one job's routing step. */
  droppedOutsideLineCount: number;
  /** Lines whose job link was dropped. */
  droppedJobLinkCount: number;
  /** Lines whose need-by or promised date was dropped (the header's need-by too). */
  droppedDateCount: number;
}

/** The facts behind the archive dialog's impact lines. Archive is never blocked. */
export interface VendorPoArchiveImpact {
  poNumber: string;
  vendorName: string;
  wasSent: boolean;
  issuedAt: string | null;
  /** Live receipts: they stay in the stock ledger. */
  receiptCount: number;
  /** Live slips the archive will unlink from the PO's outside lines. */
  linkedSlipCount: number;
  /** It stays open in QuickBooks: close it there. */
  inQuickBooks: boolean;
  quickbooksDocNumber: string | null;
  closedInQuickBooks: boolean;
  isArchived: boolean;
}

/** A job's vendor PO lines — the job page's "Vendor POs" row and the bought-part buying line. */
export interface VendorPoJobLine {
  lineId: string;
  vendorPurchaseOrderId: string;
  poNumber: string;
  poStatus: VendorPoStatus;
  vendorId: string;
  vendorName: string;
  lineNumber: number;
  lineKind: VendorPoLineKind;
  partId: string | null;
  partName: string | null;
  description: string;
  jobPartId: string | null;
  jobOperationId: string | null;
  operationLabel: string | null;
  quantity: number;
  unit: string;
  receivedQuantity: number;
  openQuantity: number;
  status: VendorPoLineStatus;
  expectedOn: string | null;
  isLate: boolean;
}

/** An outside step this vendor performs that is not finished — the PO form's outside-line picker. */
export interface OpenOutsideOperation {
  jobOperationId: string;
  jobId: string;
  jobNumber: string;
  jobDueDate: string | null;
  jobPartId: string;
  partId: string;
  partName: string;
  /** The part's own unit: outside work is counted in it. */
  stockUnit: string | null;
  sequence: number;
  operationName: string;
  operationStatus: string;
  vendorServiceId: string;
  serviceName: string;
  /** `vendor_services.unit_price` now. */
  vendorServicePrice: number | null;
  /** `job_operations.external_unit_price_snapshot` — what the job was costed at. */
  frozenOperationPrice: number | null;
  /** Price default for a new line (vendor service price, else the frozen one). */
  priceDefault: PriceDefault;
  orderedQuantity: number;
  sentQuantity: number;
  goodQuantity: number;
  atVendorQuantity: number;
  /** ordered − good − at vendor: what a new line defaults to. */
  leftToSendQuantity: number;
  /** The open outside line already paying for this step to this vendor (one at most). */
  openLine: { vendorPurchaseOrderId: string; poNumber: string; lineId: string; lineNumber: number } | null;
  /** "Anodize — 1234-A — Job J-1042, Op 30": what the RPC writes when no description is given. */
  defaultDescription: string;
}

/** What is coming for one part (part_on_order), with the POs behind it. */
export interface PartOnOrder {
  partId: string;
  stockUnit: string | null;
  /** Sent, open, unarchived part lines, in stock units. */
  onOrder: number;
  /** Draft lines, in stock units — netted on the buy list, never "on order". */
  onDraft: number;
  nextExpectedOn: string | null;
  openLineCount: number;
  draftLineCount: number;
  /** Lines whose frozen stock unit no longer matches the part's: in neither total. */
  unitMismatchLineCount: number;
  refs: PartOnOrderRef[];
}

export interface PartOnOrderRef {
  vendorPurchaseOrderId: string;
  poNumber: string;
  vendorId: string;
  lineId: string;
  lineNumber: number;
  /** Still to arrive (or, for a draft, the whole line), in the part's stock unit. */
  stockQuantity: number;
  expectedOn: string | null;
  isDraft: boolean;
  status: VendorPoLineStatus;
}

export interface VendorPoReceiptFilters {
  /** An instant (ISO timestamp): received at or after. */
  receivedFrom?: string | null;
  /** An instant (ISO timestamp): received strictly before. */
  receivedBefore?: string | null;
  vendorId?: string | null;
  vendorPurchaseOrderId?: string | null;
  /** Contains, case-insensitive. */
  packingSlip?: string | null;
  includeVoided?: boolean;
  limit?: number;
}

/** One row of the hub's Receipts tab (the bookkeeper's month end). */
export interface VendorPoReceiptListRow extends VendorPoReceipt {
  vendorPurchaseOrderId: string;
  poNumber: string;
  vendorId: string;
  vendorName: string;
  partName: string | null;
  description: string | null;
}

export interface VendorPoReceiptListResult {
  rows: VendorPoReceiptListRow[];
  total: number;
  truncated: boolean;
}

/** Stock added to a part WITHOUT a PO lately — "was that this delivery?" (a notice only). */
export interface NoPoStockAddition {
  transactionId: string;
  createdAt: string;
  quantity: number;
  unit: string;
  /** In the part's stock unit. */
  convertedQuantity: number | null;
  locationName: string | null;
  heatNumber: string | null;
  notes: string | null;
}

export interface RelinkOutsideShipmentResult {
  outsideShipmentId: string;
  slipNumber: string;
  vendorPurchaseOrderLineId: string | null;
}

/** Everything `lib/purchasing/priceDefault.ts` needs for one (vendor, part). */
export interface VendorPoPriceDefaultInputs {
  partId: string;
  partName: string;
  partSource: string;
  stockUnit: string | null;
  conversions: UnitConversionRow[];
  vendorId: string;
  vendorName: string;
  /** This vendor's live approved-vendor row for the part, or null when it is not on the list. */
  partVendor: {
    id: string;
    status: PartVendorStatus;
    statusNote: string | null;
    vendorPartNumber: string | null;
    purchaseUnit: string;
    leadTimeDays: number | null;
    minimumOrderQuantity: number | null;
    validUntil: string | null;
  } | null;
  /** The sheet as priceDefault reads it; null with no row, no breaks, or a unit with no factor. */
  sheet: PriceSheet | null;
  /** Last PO prices for this part (sent, unarchived POs), every vendor. */
  lastPurchases: LastPurchaseCandidate[];
  /** The unit this part was last ordered in, from any vendor. */
  lastOrderedUnit: string | null;
  costTiers: CostTier[];
}

/** A part line's defaults: its unit, its price with the caption, and the approved-vendor note. */
export interface VendorPoLinePriceResolution {
  unit: string | null;
  basis: PurchaseUnitBasis;
  price: PriceDefault;
  notice: PartVendorLineNotice | null;
  vendorPartNumber: string | null;
}
