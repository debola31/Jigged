/**
 * Outside processing — shipping & receiving.
 *
 * An outside operation sends a QUANTITY of parts to a vendor and gets some back.
 * One `OutsideShipment` is one send of one `job_operations` row, so an operation
 * can have several: send 50 now, 50 next week. Each carries its own
 * `OSP-{jobBase}-{n}` slip, which is the paperwork that travels in the box.
 *
 * The operation's status is DERIVED from these rows by
 * `compute_job_operation_status` — nothing here is a status you assert. See
 * [docs/modules/outside-processing.md].
 */
import type { AddressSnapshot, ContactSnapshot } from './documentSnapshot';

/** One send. Voided, never archived — a slip the vendor is holding is a document. */
export interface OutsideShipment {
  id: string;
  company_id: string;
  job_id: string;
  job_part_id: string;
  job_operation_id: string;

  vendor_id: string;
  vendor_address_id: string | null;
  vendor_contact_id: string | null;

  /** Frozen at send time. The PDF renders these, never the live vendor rows. */
  vendor_name: string;
  service_name: string;
  ship_to_address: AddressSnapshot | null;
  ship_to_contact: ContactSnapshot | null;

  slip_number: string;
  quantity: number;
  /** timestamptz — the slip prints the date half. */
  shipped_at: string;
  /** A promise, not an event, so it is a plain date. Null when nobody committed to one. */
  due_back_on: string | null;
  carrier: string | null;
  notes: string | null;

  created_by: string | null;
  voided_at: string | null;
  voided_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Parts coming back against one shipment. Append-only: a correction is a void
 * plus a new row, never an edit — which is why `authenticated` holds an UPDATE
 * grant on `voided_at`/`voided_by` and no other column.
 */
export interface OutsideShipmentReceipt {
  id: string;
  company_id: string;
  outside_shipment_id: string;
  job_operation_id: string;
  job_part_id: string;
  /** Drives the operation's status against `job_parts.quantity`. */
  quantity_good: number;
  /**
   * What the vendor consumed or ruined. Retires the shipment's outstanding
   * balance — so the op stops reading "at the vendor" — WITHOUT counting toward
   * the good total, so 98 of 100 reads `in_progress`, not `completed`.
   */
  quantity_scrapped: number;
  received_at: string;
  received_by: string | null;
  note: string | null;
  voided_at: string | null;
  voided_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface OutsideShipmentWithRelations extends OutsideShipment {
  receipts?: OutsideShipmentReceipt[];
  /** Resolved from user_company_access at read time, not a column. */
  shipped_by_member?: { id: string; name: string | null } | null;
  job?: { id: string; job_number: string } | null;
  job_operation?: { id: string; operation_name: string; sequence: number } | null;
  job_part?: {
    id: string;
    quantity: number;
    part?: { id: string; part_name: string } | null;
  } | null;
}

/** `p_company_id` is deliberately absent: the RPC derives it from the operation. */
export interface CreateOutsideShipmentPayload {
  jobOperationId: string;
  quantity: number;
  vendorAddressId?: string | null;
  vendorContactId?: string | null;
  shippedAt?: string | null;
  dueBackOn?: string | null;
  carrier?: string | null;
  notes?: string | null;
}

export interface RecordOutsideReceiptPayload {
  quantityGood: number;
  quantityScrapped?: number;
  receivedAt?: string | null;
  note?: string | null;
}

/**
 * The quantity ledger for one operation — everything the card, the dialogs and
 * the operator button need, derived once so no surface recomputes it its own way.
 */
export interface OutsideOperationSummary {
  job_operation_id: string;
  /** `job_parts.quantity` — the denominator the status is measured against. */
  qty_ordered: number;
  qty_sent: number;
  qty_good: number;
  qty_scrapped: number;
  /** sent − (good + scrapped), clamped at 0. What is physically at the vendor. */
  qty_at_vendor: number;
  /** ordered − sent, clamped at 0. What has never left the building. */
  qty_to_send: number;
  /** shipped_at of the oldest slip with anything still out. Null when nothing is out. */
  oldest_open_shipped_at: string | null;
  earliest_due_back_on: string | null;
  open_slip_count: number;
}

export interface OutsideShipmentFilters {
  vendorId?: string;
  startDate?: string;
  endDate?: string;
  /** Omit for live only; true for voided only; 'all' for both. */
  voided?: boolean | 'all';
  /** Only slips with something still at the vendor. */
  openOnly?: boolean;
}

/**
 * Money-free line the slip and the card both print for a receipt.
 * Kept here so the PDF and the UI cannot word the same fact differently.
 */
export function describeOutsideReceipt(r: Pick<OutsideShipmentReceipt, 'quantity_good' | 'quantity_scrapped'>): string {
  if (r.quantity_scrapped > 0) {
    return `${r.quantity_good} back, ${r.quantity_scrapped} scrapped`;
  }
  return `${r.quantity_good} back`;
}
