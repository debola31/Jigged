/**
 * Shipment domain types.
 *
 * One Shipment row corresponds to one packing slip. ShipmentLineItem is
 * the (shipment, job_part) quantity. The fulfillment_status column on
 * job_parts + jobs is derived from non-voided ShipmentLineItem.quantity
 * via the trigger family in migration 20260524 — single source of truth
 * for "what physically left the building."
 *
 * voided_at + voided_by are present on the type from day one; Phase 1
 * has no void UI but the schema and triggers support it. The Phase 3
 * voidShipment() flow flips these and the cascade reverses fulfillment.
 */

import type { CustomerAddress } from '@/types/customer';

export type ShippingArrangement =
  | 'prepaid_and_add'
  | 'prepaid'
  | 'collect'
  | 'third_party_account'
  | 'customer_pickup'
  | 'customer_arranged_freight'
  | 'other';

export interface Shipment {
  id: string;
  company_id: string;
  customer_id: string;
  shipping_address_id: string | null;
  /** Reserved for Phase 3 ad-hoc shipping. Null when shipping_address_id is set (XOR). */
  one_time_address: Record<string, unknown> | null;
  packing_slip_number: string;
  ship_date: string;
  carrier: string | null;
  tracking_number: string | null;
  shipping_arrangement: ShippingArrangement | null;
  shipping_arrangement_other: string | null;
  weight_lbs: number | null;
  package_count: number | null;
  package_type: string | null;
  notes: string | null;
  coc_text: string | null;
  created_by: string | null;
  created_at: string;
  voided_at: string | null;
  voided_by: string | null;
}

export interface ShipmentLineItem {
  id: string;
  shipment_id: string;
  job_part_id: string;
  quantity: number;
  created_at: string;
}

/**
 * Hydrated shipment shape returned by getShipmentById — joins customer
 * + address + line-item-with-job-and-part for the PDF + history surfaces.
 */
export interface ShipmentWithRelations extends Shipment {
  customer?: {
    id: string;
    name: string;
    /**
     * All customer_addresses for this customer. The packing slip PDF
     * picks the row with default_billing = true to render the Bill To
     * block. Optional because not every reader needs it; getShipmentById
     * and getShipmentsForJob populate it for the PDF surface.
     */
    addresses?: CustomerAddress[];
  } | null;
  shipping_address?: CustomerAddress | null;
  /** Salesperson / shipper who created the row. Resolved post-fetch in shipmentsAccess. */
  created_by_member?: {
    user_id: string;
    name: string | null;
    email: string | null;
  } | null;
  shipment_line_items?: Array<ShipmentLineItem & {
    job_part?: {
      id: string;
      job_id: string;
      quantity: number;
      part?: {
        id: string;
        part_name: string;
        description: string | null;
      } | null;
      job?: {
        id: string;
        job_number: string;
        customer_po_number: string | null;
        quote_id: string | null;
      } | null;
    } | null;
  }>;
}

/**
 * Per-job_part shipped summary used by ShipmentHistoryCard and the job
 * detail page's per-part breakdown.
 */
export interface JobPartShipmentSummary {
  job_part_id: string;
  qty_ordered: number;
  qty_shipped: number;
  qty_remaining: number;
  last_ship_date: string | null;
}

/**
 * Per-job aggregate used by the jobs-list "Qty Shipped / Qty Remaining"
 * columns and the dashboard.
 */
export interface JobShipmentSummary {
  job_id: string;
  qty_ordered: number;
  qty_shipped: number;
  qty_remaining: number;
  last_ship_date: string | null;
  latest_packing_slip_number: string | null;
  shipment_count: number;
}

/**
 * Payload for createShipment. job_part_id quantities are validated client-side
 * (soft warning when > remaining, hard block when all zero) — the server-side
 * floor is shipment_line_items_quantity_positive (quantity > 0).
 */
export interface CreateShipmentPayload {
  customer_id: string;
  shipping_address_id: string | null;
  one_time_address?: Record<string, unknown> | null;
  ship_date: string;
  carrier?: string | null;
  tracking_number?: string | null;
  shipping_arrangement?: ShippingArrangement | null;
  shipping_arrangement_other?: string | null;
  weight_lbs?: number | null;
  package_count?: number | null;
  package_type?: string | null;
  notes?: string | null;
  coc_text?: string | null;
  line_items: Array<{
    job_part_id: string;
    quantity: number;
  }>;
}

/**
 * Result of resolveAttentionLine — single function shared by the form
 * preview and the packing-slip PDF so they can't drift.
 */
export interface ResolvedAttention {
  source: 'address' | 'none';
  text: string | null;
}

export interface ShipmentFilters {
  customerId?: string;
  jobId?: string;
  startDate?: string;
  endDate?: string;
  voided?: boolean;
}

/**
 * Row shape for the top-level Shipments list page (Phase 1.5 / FR-NEW-4).
 * Adds the distinct list of job numbers covered by the shipment, a
 * line-item count, and the resolved created_by member to the bare
 * Shipment row.
 */
export interface ShipmentListRow extends Shipment {
  customer_name: string | null;
  job_numbers: string[];
  line_item_count: number;
  created_by_member: {
    user_id: string;
    name: string | null;
    email: string | null;
  } | null;
}

export type ProductionStatus =
  | 'not_started'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

export type FulfillmentStatus =
  | 'unshipped'
  | 'partially_shipped'
  | 'fully_shipped';

/**
 * Row shape returned by getOpenJobPartsForCustomer (Phase 1.5 / FR-NEW-5).
 * One row per job_part across all of the customer's jobs that match the
 * filter. qty_remaining is clamped to zero — never negative — so the
 * line picker can do non-negative math even when an over-shipment was
 * confirmed via the FR-4 soft warning.
 */
export interface OpenJobPartRow {
  job_part_id: string;
  job_id: string;
  job_number: string;
  customer_po_number: string | null;
  part_id: string;
  part_name: string;
  description: string | null;
  qty_ordered: number;
  qty_shipped: number;
  qty_remaining: number;
  production_status: ProductionStatus;
  fulfillment_status: FulfillmentStatus;
}

export interface OpenJobPartFilter {
  /** Default true. Drops lines already at fulfillment_status = 'fully_shipped'. */
  excludeFullyShipped?: boolean;
  /** Default true. Drops lines at production_status = 'cancelled'. */
  excludeCancelled?: boolean;
}

/**
 * Display config for shipping_arrangement values. Single source of truth
 * for the human-readable label — both CreateShipmentModal and
 * CustomerShippingDefaultsCard (PR 7) and the packing-slip PDF read from
 * this map. Adding a new arrangement adds it here once.
 */
export const SHIPPING_ARRANGEMENT_LABELS: Record<ShippingArrangement, string> = {
  prepaid_and_add: 'Prepaid & Add',
  prepaid: 'Prepaid',
  collect: 'Collect',
  third_party_account: 'Third Party Account',
  customer_pickup: 'Customer Pickup',
  customer_arranged_freight: 'Customer-arranged Freight',
  other: 'Other',
};

export const SHIPPING_ARRANGEMENT_OPTIONS: Array<{
  value: ShippingArrangement;
  label: string;
}> = (Object.keys(SHIPPING_ARRANGEMENT_LABELS) as ShippingArrangement[]).map((value) => ({
  value,
  label: SHIPPING_ARRANGEMENT_LABELS[value],
}));
