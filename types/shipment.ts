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

/**
 * Who pays the freight. A different axis from `shipping_method` (how the goods
 * left) — conflating the two is the classic error in this domain, so they never
 * share a control.
 *
 * The third axis, FOB point (WHERE title and risk transfer), used to live on the
 * quote and was removed in August 2026 after 96 real quotes left it blank. If it
 * ever comes back it belongs in shop settings as a printed default, not beside
 * this field.
 *
 * `prepaid_and_add` is deliberately absent: it promises adding freight to the
 * invoice, and there is no freight amount anywhere to add (weight_lbs was
 * dropped in June 2026). An option naming something the system cannot do is how
 * the previous version of this enum died of non-use.
 */
export type FreightTerms = 'prepaid' | 'collect' | 'third_party' | 'customer_arranged';

/** Shop vocabulary, not API vocabulary — this is what a shipper says out loud. */
export const FREIGHT_TERMS_LABELS: Record<FreightTerms, string> = {
  prepaid: 'We pay (prepaid)',
  collect: 'Freight collect (their account)',
  third_party: 'Bill third party',
  customer_arranged: 'They collect it',
};

/** Freight terms only mean something when goods actually ship on a carrier. */
export const FREIGHT_TERMS_METHODS: ReadonlyArray<ShippingMethod> = ['shipment', 'dropship'];

/**
 * The redacted freight block frozen onto a shipment at ship time.
 *
 * Never carries the full account number: the packing slip renders from this and
 * rides in the box past carriers, docks and whoever opens the carton.
 * `account_last4` is null when the account is 4 characters or fewer — showing 3
 * of 4 is not redaction — so `has_account` is what tells a document whether to
 * say "billed to their account" or "billed on the bill of lading".
 */
export interface FreightAccountSnapshot {
  carrier: string;
  bill_to_party: string;
  has_account: boolean;
  account_last4: string | null;
}

/**
 * One heat number the packing slip prints, frozen onto the shipment at creation.
 *
 * `material_name` is the depletion row's `item_name` — itself a snapshot — so a
 * slip can say "4471 — 1.25 4140 BAR" without ever reading a live part row.
 */
export interface HeatNumberSnapshotEntry {
  heat_number: string;
  material_name: string;
}

export function toFreightTerms(value: string | null | undefined): FreightTerms | null {
  return value === 'prepaid' || value === 'collect' || value === 'third_party' ||
    value === 'customer_arranged'
    ? value
    : null;
}

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
  freight_terms: FreightTerms | null;
  /** Navigation only — the document renders freight_account_snapshot. */
  customer_carrier_account_id: string | null;
  freight_account_snapshot: FreightAccountSnapshot | null;
  /**
   * The job's material heat numbers as they stood when this slip was created: the
   * DISTINCT (heat, material) pairs on the depletion rows tagged to the job, ordered
   * by material then heat. `[]` — never null — when none was recorded, which is the
   * normal state for a shop that does not track heats, and the slip then prints no
   * heat line at all. Frozen (Document Snapshot Standard): correcting a typo on the
   * ledger afterwards never rewrites a slip a customer already holds.
   */
  heat_numbers_snapshot: HeatNumberSnapshotEntry[];
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
  freight_terms?: FreightTerms | null;
  customer_carrier_account_id?: string | null;
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

/**
 * One printable line describing how a shipment's freight is billed, built from
 * the FROZEN snapshot rather than the live carrier account.
 *
 * Everything here is safe to print: the snapshot never carries the full account
 * number. When `has_account` is true but `account_last4` is null the account was
 * too short to reveal anything, so we say an account is on file without naming
 * it — which is still the information a receiving dock needs.
 *
 * Returns null when there is no freight instruction at all, so the caller omits
 * the row rather than printing "Freight: —".
 */
export function describeShipmentFreight(shipment: {
  freight_terms: FreightTerms | null;
  freight_account_snapshot: FreightAccountSnapshot | null;
}): string | null {
  const terms = shipment.freight_terms ? FREIGHT_TERMS_LABELS[shipment.freight_terms] : null;
  const snap = shipment.freight_account_snapshot;
  if (!terms && !snap) return null;

  const parts: string[] = [];
  if (terms) parts.push(terms);
  if (snap) {
    if (snap.account_last4) {
      parts.push(`${snap.carrier} ••••${snap.account_last4}`);
    } else if (snap.has_account) {
      parts.push(`${snap.carrier} (account on file)`);
    } else {
      parts.push(snap.carrier);
    }
  }
  return parts.join(' — ');
}

/**
 * The entries of a heat-number snapshot, read through the `Json` boundary.
 *
 * The column is `jsonb` and the database only guarantees it is an array; the shape
 * of each element is the RPC's promise, not the type system's. An element that is
 * not `{heat_number, material_name}` is dropped rather than printed — a packing slip
 * must never carry garbage where a heat number goes — and `[]` is what a slip with
 * nothing to say gets.
 */
export function parseHeatNumbersSnapshot(value: unknown): HeatNumberSnapshotEntry[] {
  if (!Array.isArray(value)) return [];
  const out: HeatNumberSnapshotEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const { heat_number, material_name } = item as Record<string, unknown>;
    if (typeof heat_number !== 'string' || typeof material_name !== 'string') continue;
    if (heat_number.trim() === '') continue;
    out.push({ heat_number, material_name });
  }
  return out;
}

/**
 * One printable line of the material heat numbers on a shipment, from the FROZEN
 * snapshot — `4471 — 1.25 4140 BAR; 8823 — 6061 PLATE`.
 *
 * Returns null when nothing was recorded, so the caller omits the row rather than
 * printing "Material heat no(s).: —". A blank is the normal state for most shops and
 * must not read as a missing value on a receiving dock.
 */
export function describeHeatNumbers(shipment: { heat_numbers_snapshot: unknown }): string | null {
  const entries = parseHeatNumbersSnapshot(shipment.heat_numbers_snapshot);
  if (entries.length === 0) return null;
  return entries.map((e) => `${e.heat_number} — ${e.material_name}`).join('; ');
}
