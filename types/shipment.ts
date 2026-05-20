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
