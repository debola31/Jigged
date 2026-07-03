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
import type { AddressSnapshot } from '@/types/documentSnapshot';

export type ShippingMethod =
  | 'customer_pickup'
  | 'personal_delivery'
  | 'shipment'
  | 'dropship'
  | 'restock';

/** Carriers offered when shipping_method === 'shipment'. The UI adds an
 *  "Other" choice that reveals a free-text field; the typed-in value is
 *  stored directly in shipments.carrier, so the column itself is free text. */
export const CARRIER_OPTIONS = ['UPS', 'FedEx', 'USPS'] as const;

export interface Shipment {
  id: string;
  company_id: string;
  customer_id: string;
  /** The single job this packing slip belongs to (one job per slip). */
  job_id: string;
  shipping_address_id: string | null;
  /** Reserved for Phase 3 ad-hoc shipping. Null when shipping_address_id is set (XOR). */
  one_time_address: Record<string, unknown> | null;
  packing_slip_number: string;
  ship_date: string;
  /** UPS / FedEx / USPS or a free-text "Other" carrier; only set when shipping_method === 'shipment'. */
  carrier: string | null;
  shipping_method: ShippingMethod | null;
  created_by: string | null;
  created_at: string;
  voided_at: string | null;
  voided_by: string | null;
  // Document Snapshot Standard: frozen bill-to/ship-to block + customer name,
  // captured by the snapshot_shipment_party trigger. The packing slip renders
  // these, not the live address rows. See docs/architecture.md.
  customer_name: string | null;
  bill_to_address: AddressSnapshot | null;
  ship_to_address: AddressSnapshot | null;
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
  shipping_method?: ShippingMethod | null;
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
 * Display config for shipping_method values. Single source of truth for the
 * human-readable label — the shipment form, the shipments list, and the
 * packing-slip PDF all read from this map. Adding a method adds it here once.
 */
export const SHIPPING_METHOD_LABELS: Record<ShippingMethod, string> = {
  customer_pickup: 'Customer Pickup',
  personal_delivery: 'Personal Delivery',
  shipment: 'Shipment',
  dropship: 'DropShip',
  restock: 'Restock',
};

export const SHIPPING_METHOD_OPTIONS: Array<{
  value: ShippingMethod;
  label: string;
}> = (Object.keys(SHIPPING_METHOD_LABELS) as ShippingMethod[]).map((value) => ({
  value,
  label: SHIPPING_METHOD_LABELS[value],
}));
