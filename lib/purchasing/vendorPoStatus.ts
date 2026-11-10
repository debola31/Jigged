/**
 * Status words and colours for purchasing documents.
 *
 * These MAP statuses the database derives — `vendor_purchase_order_status.status`,
 * `vendor_purchase_order_line_status.status`, `vendor_rfq_status.status` — to the label and the
 * StatusChip / StatusDot palette key. They never derive one: a status is computed once, in SQL, and
 * read by the UI, MCP and the insights chat alike (plan §3.4; the `is_quote_open` lesson).
 *
 * The colour keys are the semantic palette (`default` renders hollow / outlined), so a PO's dot in
 * the list and its chip on the detail page can never disagree. Overdue is deliberately NOT a
 * status: it is a flag shown beside one, amber because a late PO is behind, not broken
 * (design-system.md "Red means broken; amber means behind").
 */

/** The palette keys `StatusChip` and `StatusDot` take. */
export type PurchasingStatusColor = 'default' | 'primary' | 'secondary' | 'error' | 'info' | 'success' | 'warning';

export interface PurchasingStatusDisplay {
  label: string;
  color: PurchasingStatusColor;
}

// ------------------------------------------------------------------------------------------------
// Purchase orders
// ------------------------------------------------------------------------------------------------

/** `vendor_purchase_order_status.status`, in lifecycle order. */
export const VENDOR_PO_STATUSES = ['draft', 'sent', 'partially_received', 'received', 'closed'] as const;
export type VendorPoStatus = (typeof VENDOR_PO_STATUSES)[number];

export const VENDOR_PO_STATUS_CONFIG: Record<VendorPoStatus, PurchasingStatusDisplay> = {
  // Hollow: not live yet — the vendor has not seen it.
  draft: { label: 'Draft', color: 'default' },
  sent: { label: 'Sent', color: 'info' },
  // Same slot the jobs list gives "Partially Shipped", so "part of it is here" reads alike.
  partially_received: { label: 'Partly received', color: 'secondary' },
  received: { label: 'Received', color: 'success' },
  // Hollow again: nothing more is expected, whatever arrived.
  closed: { label: 'Closed', color: 'default' },
};

/** The PO list's default status filter: everything still open. */
export const VENDOR_PO_DEFAULT_LIST_STATUSES: readonly VendorPoStatus[] = ['draft', 'sent', 'partially_received'];

/** Overdue — the flag beside Next due, never a status of its own. */
export const VENDOR_PO_OVERDUE: PurchasingStatusDisplay = { label: 'Overdue', color: 'warning' };

export function isVendorPoStatus(value: string): value is VendorPoStatus {
  return (VENDOR_PO_STATUSES as readonly string[]).includes(value);
}

/** A PO status as words and colour. An unknown value shows as itself rather than vanishing. */
export function vendorPoStatusDisplay(status: string): PurchasingStatusDisplay {
  return isVendorPoStatus(status) ? VENDOR_PO_STATUS_CONFIG[status] : { label: status, color: 'default' };
}

// ------------------------------------------------------------------------------------------------
// Lines
// ------------------------------------------------------------------------------------------------

/** `vendor_purchase_order_line_status.status`. */
export const VENDOR_PO_LINE_STATUSES = ['draft', 'open', 'partially_received', 'received', 'closed', 'no_receipt'] as const;
export type VendorPoLineStatus = (typeof VENDOR_PO_LINE_STATUSES)[number];

export const VENDOR_PO_LINE_STATUS_CONFIG: Record<VendorPoLineStatus, PurchasingStatusDisplay> = {
  draft: { label: 'Draft', color: 'default' },
  open: { label: 'Open', color: 'info' },
  partially_received: { label: 'Partly received', color: 'secondary' },
  received: { label: 'Received', color: 'success' },
  // `closed` only ever means closed SHORT: a fully received line reads `received` first.
  closed: { label: 'Closed short', color: 'default' },
  // Freight, fees: a line that never expects a delivery.
  no_receipt: { label: 'No receipt needed', color: 'default' },
};

export function isVendorPoLineStatus(value: string): value is VendorPoLineStatus {
  return (VENDOR_PO_LINE_STATUSES as readonly string[]).includes(value);
}

const OVER_TOLERANCE = 1e-9;

function formatOver(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

/**
 * A line state as words and colour. A received line that took more than was ordered reads
 * "Received +N" — pass ordered and received in the same unit.
 */
export function vendorPoLineStateDisplay(
  status: string,
  quantities?: { orderedQuantity: number; receivedQuantity: number },
): PurchasingStatusDisplay {
  if (!isVendorPoLineStatus(status)) return { label: status, color: 'default' };
  const base = VENDOR_PO_LINE_STATUS_CONFIG[status];
  if (status !== 'received' || !quantities) return base;
  const over = quantities.receivedQuantity - quantities.orderedQuantity;
  const tolerance = OVER_TOLERANCE * Math.max(1, Math.abs(quantities.orderedQuantity));
  if (!Number.isFinite(over) || over <= tolerance) return base;
  return { label: `Received +${formatOver(over)}`, color: base.color };
}

// ------------------------------------------------------------------------------------------------
// QuickBooks, RFQs and approved vendors
// ------------------------------------------------------------------------------------------------

/** `vendor_purchase_order_status.quickbooks_state`. */
export const VENDOR_PO_QUICKBOOKS_STATES = [
  'not_sent',
  'in_quickbooks',
  'out_of_date',
  'pending',
  'needs_checking',
  'failed',
] as const;
export type VendorPoQuickBooksState = (typeof VENDOR_PO_QUICKBOOKS_STATES)[number];

export const VENDOR_PO_QUICKBOOKS_STATE_CONFIG: Record<VendorPoQuickBooksState, PurchasingStatusDisplay> = {
  not_sent: { label: 'Not sent', color: 'default' },
  in_quickbooks: { label: 'In QuickBooks', color: 'success' },
  // Jigged changed since the last push — computed without calling QuickBooks.
  out_of_date: { label: 'Out of date', color: 'warning' },
  pending: { label: 'Sending', color: 'info' },
  needs_checking: { label: 'Needs checking', color: 'warning' },
  failed: { label: 'Failed', color: 'error' },
};

/** `vendor_rfq_status.status`. */
export const VENDOR_RFQ_STATUSES = ['draft', 'sent', 'quoted', 'awarded', 'closed'] as const;
export type VendorRfqStatus = (typeof VENDOR_RFQ_STATUSES)[number];

export const VENDOR_RFQ_STATUS_CONFIG: Record<VendorRfqStatus, PurchasingStatusDisplay> = {
  draft: { label: 'Draft', color: 'default' },
  sent: { label: 'Sent', color: 'info' },
  quoted: { label: 'Quoted', color: 'secondary' },
  awarded: { label: 'Awarded', color: 'success' },
  closed: { label: 'Closed', color: 'default' },
};

/** `part_vendors.status` — the approved vendor list. */
export const PART_VENDOR_STATUSES = ['approved', 'conditional', 'disapproved'] as const;
export type PartVendorStatus = (typeof PART_VENDOR_STATUSES)[number];

export const PART_VENDOR_STATUS_CONFIG: Record<PartVendorStatus, PurchasingStatusDisplay> = {
  approved: { label: 'Approved', color: 'success' },
  conditional: { label: 'Conditional', color: 'warning' },
  // Blocked on new lines in the RPC and the UI — the one reason to record it.
  disapproved: { label: 'Do not use', color: 'error' },
};
