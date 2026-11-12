/**
 * Requests for quotation TO VENDORS — the shapes `utils/vendorRfqAccess.ts` reads and writes
 * (plan §3.2 "RFQs", §3.9).
 *
 * An RFQ asks one or more invited vendors for prices on lines (a part, or ad-hoc text) at up to
 * four quantities each, all in the line's unit. A response is priced per THAT unit, or is a No
 * bid. The status (draft / sent / quoted / awarded / closed) is derived in `vendor_rfq_status`.
 * Award is by response id and creates one draft PO per vendor, atomically.
 */
import type { AddressSnapshot, ContactSnapshot } from '@/types/documentSnapshot';
import type { VendorRfqStatus } from '@/lib/purchasing/vendorPoStatus';
import type { RfqComparison } from '@/lib/purchasing/rfqCompare';

export type { VendorRfqStatus, RfqComparison };

/** At most this many quantities on one line (the CHECK, and the form). */
export const VENDOR_RFQ_MAX_QUANTITIES = 4;

export interface VendorRfqListRow {
  id: string;
  rfqNumber: string;
  title: string | null;
  status: VendorRfqStatus;
  neededByOn: string | null;
  respondByOn: string | null;
  closedAt: string | null;
  lineCount: number;
  awardedLineCount: number;
  invitedCount: number;
  sentCount: number;
  declinedCount: number;
  /** Vendors who answered at least one line — "replies (n of m)". */
  respondedCount: number;
  /** The invited vendors, by name. */
  vendorNames: string[];
  createdAt: string;
  updatedAt: string;
}

export interface VendorRfqListFilters {
  statuses?: readonly VendorRfqStatus[];
  /** RFQ number or title, contains. */
  search?: string | null;
  /** Only the RFQs this vendor was invited on — by id, so a renamed vendor still finds its own. */
  vendorId?: string | null;
  limit?: number;
}

export interface VendorRfqListResult {
  rows: VendorRfqListRow[];
  total: number;
  truncated: boolean;
}

export interface VendorRfqHeader {
  id: string;
  companyId: string;
  rfqNumber: string;
  title: string | null;
  neededByOn: string | null;
  respondByOn: string | null;
  notesToVendors: string | null;
  internalNotes: string | null;
  termsAndConditions: string | null;
  /** Our shop, frozen at create. */
  shipToName: string;
  shipToAddress: AddressSnapshot | null;
  closedAt: string | null;
  closedReason: string | null;
  createdAt: string;
  /** EXACTLY as read: pass back unchanged as `expectedUpdatedAt`. */
  updatedAt: string;
  deletedAt: string | null;
  isArchived: boolean;
}

export interface VendorRfqLine {
  id: string;
  lineNumber: number;
  partId: string | null;
  /** The frozen part number, when the line is a part. */
  partName: string | null;
  description: string;
  unit: string;
  /** One to four, all in `unit`. */
  quantities: number[];
  jobId: string | null;
  jobNumber: string | null;
  certRequired: boolean;
  notes: string | null;
}

export interface VendorRfqInvitation {
  id: string;
  vendorId: string;
  vendorName: string;
  vendorContactId: string | null;
  /** Frozen at invite time: the sales contact, else the primary. */
  vendorContact: ContactSnapshot | null;
  sentAt: string | null;
  declinedAt: string | null;
  declinedReason: string | null;
  vendorQuoteReference: string | null;
  quotedOn: string | null;
}

export interface VendorRfqResponse {
  id: string;
  invitationId: string;
  lineId: string;
  /** One of the line's quantities. */
  quantity: number;
  /** Per the RFQ line's unit; null exactly when it is a No bid. */
  unitPrice: number | null;
  noBid: boolean;
  leadTimeDays: number | null;
  minimumOrderQuantity: number | null;
  validUntil: string | null;
  vendorPartNumber: string | null;
  notes: string | null;
  /** Awarded responses are frozen. */
  awardedAt: string | null;
  vendorPurchaseOrderLineId: string | null;
}

export interface VendorRfqDetail {
  header: VendorRfqHeader;
  status: VendorRfqStatus;
  lineCount: number;
  awardedLineCount: number;
  invitedCount: number;
  sentCount: number;
  declinedCount: number;
  respondedCount: number;
  lines: VendorRfqLine[];
  invitations: VendorRfqInvitation[];
  responses: VendorRfqResponse[];
  /** The comparison matrix by the caller's date ("Lowest" in words; expired never lowest). */
  comparison: RfqComparison;
}

// ------------------------------------------------------------------------------------------------
// Writes
// ------------------------------------------------------------------------------------------------

export interface VendorRfqHeaderInput {
  title?: string | null;
  neededByOn?: string | null;
  respondByOn?: string | null;
  notesToVendors?: string | null;
  internalNotes?: string | null;
}

/** A save may also change the printed terms (an RFQ copies them from the series at create). */
export interface VendorRfqChanges extends VendorRfqHeaderInput {
  termsAndConditions?: string | null;
}

export interface VendorRfqLineInput {
  /** A part, or leave it out and give a `description` (an ad-hoc line, awarded as an Other line). */
  partId?: string | null;
  description?: string | null;
  /** Part lines: a unit the part converts (or a preset / new unit with `unitFactor`). */
  unit?: string | null;
  /** "Another unit…": stock units in one `unit`, stored as the part's conversion first. */
  unitFactor?: number | null;
  /** One to four, all > 0, all different. */
  quantities: number[];
  jobId?: string | null;
  certRequired?: boolean;
  notes?: string | null;
}

/** An existing line: its id and ONLY the keys that change. */
export interface VendorRfqLinePatch extends Partial<VendorRfqLineInput> {
  id: string;
}

export type VendorRfqLineWrite = VendorRfqLineInput | VendorRfqLinePatch;

export interface CreateVendorRfqInput {
  header?: VendorRfqHeaderInput;
  lines: VendorRfqLineInput[];
  /** Vendors to invite (each freezes its sales, else primary, contact). */
  vendorIds: string[];
}

export interface SaveVendorRfqInput {
  changes?: VendorRfqChanges;
  lines?: VendorRfqLineWrite[];
  removedLineIds?: string[];
  addVendorIds?: string[];
  removedInvitationIds?: string[];
  /** `header.updatedAt` exactly as read. */
  expectedUpdatedAt?: string | null;
}

export interface CreateVendorRfqResult {
  id: string;
  rfqNumber: string;
}

export interface SaveVendorRfqResult {
  id: string;
  rfqNumber: string;
  status: VendorRfqStatus | null;
  lineIds: string[];
  invitationIds: string[];
  updatedAt: string;
}

export type VendorRfqAction = 'close' | 'reopen' | 'archive';
export type VendorRfqInvitationAction = 'mark_sent' | 'decline' | 'undo_decline';

export interface VendorRfqStateResult {
  id: string;
  rfqNumber: string;
  action: VendorRfqAction;
  status: VendorRfqStatus | null;
  deletedAt: string | null;
}

export interface VendorRfqInvitationStateResult {
  invitationId: string;
  vendorRfqId: string;
  action: VendorRfqInvitationAction;
  status: VendorRfqStatus | null;
}

/** One cell of a vendor's quote: a line at one of its quantities. */
export interface VendorRfqResponseInput {
  lineId: string;
  quantity: number;
  /** Per the line's unit. Leave it out (or null) with `noBid`. */
  unitPrice?: number | null;
  noBid?: boolean;
  leadTimeDays?: number | null;
  minimumOrderQuantity?: number | null;
  validUntil?: string | null;
  vendorPartNumber?: string | null;
  notes?: string | null;
}

export interface SaveVendorRfqResponsesResult {
  invitationId: string;
  vendorRfqId: string;
  responseIds: string[];
  status: VendorRfqStatus | null;
}

export interface AwardVendorRfqResult {
  vendorRfqId: string;
  /** One draft per vendor. */
  purchaseOrders: Array<{ id: string; poNumber: string; vendorId: string; vendorName: string; lineIds: string[] }>;
  awardedResponseIds: string[];
  /** Approved-vendor rows written when "Save to price sheets" was ticked. */
  savedPartVendorIds: string[];
  status: VendorRfqStatus | null;
}
