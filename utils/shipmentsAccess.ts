/**
 * Shipments access layer.
 *
 * createShipment routes through the create_shipment_with_line_items RPC
 * (migration 20260524) which:
 *   1. takes a sorted per-job advisory lock (deadlock-free under concurrent calls),
 *   2. snapshots pre-cascade fulfillment_status for every affected job,
 *   3. mints the packing-slip number via next_packing_slip_number (row-locked counter),
 *   4. inserts the shipment + line items (triggers cascade fulfillment),
 *   5. writes audit rows for every job that transitioned forward into fully_shipped.
 *
 * Reads use plain PostgREST joins. Voids are scaffolded but throw — Phase 3.
 */

import { getSupabase } from '@/lib/supabase';
import type {
  CreateShipmentPayload,
  JobPartShipmentSummary,
  JobShipmentSummary,
  ResolvedAttention,
  Shipment,
  ShipmentFilters,
  ShipmentWithRelations,
} from '@/types/shipment';

/**
 * Create a shipment and its line items atomically. Returns the new
 * shipment id and minted packing-slip number.
 *
 * Validation: line_items must be non-empty (the RPC will accept an empty
 * array but a zero-line shipment is meaningless — block here so the
 * caller doesn't have to). Quantities are validated server-side
 * (shipment_line_items_quantity_positive); the modal also blocks all-zero
 * submissions.
 */
export async function createShipment(
  companyId: string,
  payload: CreateShipmentPayload,
): Promise<{ shipmentId: string; packingSlipNumber: string }> {
  if (!payload.line_items.length) {
    throw new Error('createShipment: line_items must be non-empty.');
  }

  const supabase = getSupabase();

  const { data: shipmentId, error } = await supabase.rpc(
    'create_shipment_with_line_items',
    {
      p_company_id: companyId,
      p_customer_id: payload.customer_id,
      p_shipping_address_id: payload.shipping_address_id,
      p_one_time_address: payload.one_time_address ?? null,
      p_ship_date: payload.ship_date,
      p_carrier: payload.carrier ?? null,
      p_tracking_number: payload.tracking_number ?? null,
      p_shipping_arrangement: payload.shipping_arrangement ?? null,
      p_shipping_arrangement_other: payload.shipping_arrangement_other ?? null,
      p_weight_lbs: payload.weight_lbs ?? null,
      p_package_count: payload.package_count ?? null,
      p_package_type: payload.package_type ?? null,
      p_notes: payload.notes ?? null,
      p_coc_text: payload.coc_text ?? null,
      p_line_items: payload.line_items,
    },
  );

  if (error || !shipmentId) {
    console.error('createShipment RPC failed:', error);
    throw new Error(
      error?.message
        ? `Failed to create shipment: ${error.message}`
        : 'Failed to create shipment.',
    );
  }

  // Read back the minted packing-slip number so the caller can render it
  // without a second navigation. The RPC returns only the id.
  const { data: row, error: readErr } = await supabase
    .from('shipments')
    .select('packing_slip_number')
    .eq('id', shipmentId as string)
    .single();

  if (readErr || !row) {
    console.error('createShipment: shipment row missing after RPC', readErr);
    throw new Error('Shipment created but packing-slip number could not be read back.');
  }

  return {
    shipmentId: shipmentId as string,
    packingSlipNumber: row.packing_slip_number,
  };
}

/**
 * Hydrated single shipment for the packing-slip PDF and the
 * ShipmentHistoryCard "View" action.
 */
export async function getShipmentById(
  shipmentId: string,
): Promise<ShipmentWithRelations> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('shipments')
    .select(
      `*,
       customer:customers (id, name),
       shipping_address:customer_addresses!shipping_address_id (
         id, customer_id, address_line1, address_line2, city, state,
         postal_code, country, default_billing, default_shipping, attention_to
       ),
       shipment_line_items (
         id, shipment_id, job_part_id, quantity, created_at,
         job_part:job_parts (
           id, job_id, quantity,
           part:parts (id, part_name, description),
           job:jobs (id, job_number, customer_po_number, quote_id)
         )
       )`,
    )
    .eq('id', shipmentId)
    .single();

  if (error || !data) {
    console.error('Error fetching shipment:', error);
    throw new Error(
      error?.message ? `Failed to load shipment: ${error.message}` : 'Failed to load shipment.',
    );
  }

  return data as unknown as ShipmentWithRelations;
}

/**
 * All non-voided shipments for a job, newest first. Used by the
 * ShipmentHistoryCard.
 */
export async function getShipmentsForJob(
  jobId: string,
): Promise<ShipmentWithRelations[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('shipments')
    .select(
      `*,
       customer:customers (id, name),
       shipping_address:customer_addresses!shipping_address_id (
         id, customer_id, address_line1, address_line2, city, state,
         postal_code, country, default_billing, default_shipping, attention_to
       ),
       shipment_line_items!inner (
         id, shipment_id, job_part_id, quantity, created_at,
         job_part:job_parts!inner (
           id, job_id, quantity,
           part:parts (id, part_name, description),
           job:jobs (id, job_number, customer_po_number, quote_id)
         )
       )`,
    )
    .eq('shipment_line_items.job_part.job_id', jobId)
    .order('ship_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching shipments for job:', error);
    throw new Error(`Failed to load shipments: ${error.message}`);
  }

  return (data ?? []) as unknown as ShipmentWithRelations[];
}

/**
 * List shipments for a company with optional filters. Default ordering
 * is most-recent ship_date first.
 */
export async function listShipmentsForCompany(
  companyId: string,
  filters: ShipmentFilters = {},
): Promise<Shipment[]> {
  const supabase = getSupabase();

  let query = supabase
    .from('shipments')
    .select('*')
    .eq('company_id', companyId)
    .order('ship_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (filters.customerId) {
    query = query.eq('customer_id', filters.customerId);
  }
  if (filters.startDate) {
    query = query.gte('ship_date', filters.startDate);
  }
  if (filters.endDate) {
    query = query.lte('ship_date', filters.endDate);
  }
  if (filters.voided === false) {
    query = query.is('voided_at', null);
  } else if (filters.voided === true) {
    query = query.not('voided_at', 'is', null);
  }

  const { data, error } = await query;
  if (error) {
    console.error('Error listing shipments:', error);
    throw new Error(`Failed to list shipments: ${error.message}`);
  }
  return (data ?? []) as Shipment[];
}

/**
 * Per-job_part shipped summary. Used by the CreateShipmentModal to
 * prefill remaining-to-ship and by the job-detail per-part breakdown.
 *
 * Computed in two queries to avoid an N+1 — pull all job_parts for the
 * job, then sum non-voided shipment_line_items in one go and merge.
 */
export async function getJobPartShipmentSummaries(
  jobId: string,
): Promise<JobPartShipmentSummary[]> {
  const supabase = getSupabase();

  const { data: rawParts, error: partsErr } = await supabase
    .from('job_parts')
    .select('id, quantity')
    .eq('job_id', jobId)
    .order('sequence', { ascending: true });

  if (partsErr || !rawParts) {
    console.error('Error fetching job_parts for shipment summary:', partsErr);
    throw new Error('Failed to load job parts.');
  }
  type JobPartRow = { id: string; quantity: number };
  const parts = rawParts as unknown as JobPartRow[];
  if (parts.length === 0) return [];

  const partIds = parts.map((p) => p.id);

  const { data: shipped, error: shippedErr } = await supabase
    .from('shipment_line_items')
    .select(
      'job_part_id, quantity, shipment:shipments!inner (ship_date, voided_at)',
    )
    .in('job_part_id', partIds);

  if (shippedErr) {
    console.error('Error fetching shipment line items:', shippedErr);
    throw new Error('Failed to load shipped quantities.');
  }

  type ShippedRow = {
    job_part_id: string;
    quantity: number;
    shipment: { ship_date: string; voided_at: string | null } | null;
  };

  const byPart = new Map<string, { qty: number; lastDate: string | null }>();
  for (const row of (shipped ?? []) as unknown as ShippedRow[]) {
    if (!row.shipment || row.shipment.voided_at !== null) continue;
    const acc = byPart.get(row.job_part_id) ?? { qty: 0, lastDate: null };
    acc.qty += Number(row.quantity);
    if (
      row.shipment.ship_date &&
      (acc.lastDate === null || row.shipment.ship_date > acc.lastDate)
    ) {
      acc.lastDate = row.shipment.ship_date;
    }
    byPart.set(row.job_part_id, acc);
  }

  return parts.map((p) => {
    const acc = byPart.get(p.id) ?? { qty: 0, lastDate: null };
    const qtyOrdered = Number(p.quantity);
    const qtyShipped = acc.qty;
    return {
      job_part_id: p.id,
      qty_ordered: qtyOrdered,
      qty_shipped: qtyShipped,
      qty_remaining: Math.max(0, qtyOrdered - qtyShipped),
      last_ship_date: acc.lastDate,
    };
  });
}

/**
 * Per-job aggregate used by the jobs-list "Qty Shipped/Remaining"
 * columns. Folds the per-part summaries into one row.
 */
export async function getJobShipmentSummary(
  jobId: string,
): Promise<JobShipmentSummary> {
  const supabase = getSupabase();

  const parts = await getJobPartShipmentSummaries(jobId);
  const qty_ordered = parts.reduce((acc, p) => acc + p.qty_ordered, 0);
  const qty_shipped = parts.reduce((acc, p) => acc + p.qty_shipped, 0);

  // Latest packing slip + count (single round-trip).
  const { data: shipRows, error: shipErr } = await supabase
    .from('shipments')
    .select(
      `id, packing_slip_number, ship_date, voided_at,
       shipment_line_items!inner (job_part:job_parts!inner (job_id))`,
    )
    .eq('shipment_line_items.job_part.job_id', jobId)
    .is('voided_at', null)
    .order('ship_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (shipErr) {
    console.error('Error fetching latest shipment for job:', shipErr);
    throw new Error('Failed to load shipment summary.');
  }

  const rows = (shipRows ?? []) as Array<{
    id: string;
    packing_slip_number: string;
    ship_date: string;
    voided_at: string | null;
  }>;
  // Dedup — the inner join can return the same shipment multiple times
  // if a shipment has multiple line items on the same job.
  const uniqueIds = new Set(rows.map((r) => r.id));
  const latest = rows[0] ?? null;

  return {
    job_id: jobId,
    qty_ordered,
    qty_shipped,
    qty_remaining: Math.max(0, qty_ordered - qty_shipped),
    last_ship_date: latest?.ship_date ?? null,
    latest_packing_slip_number: latest?.packing_slip_number ?? null,
    shipment_count: uniqueIds.size,
  };
}

/**
 * "Where does the ATTN: line on the packing slip come from?" answer.
 * Phase 1 has no shipments.shipping_contact_id, so the only source is
 * the shipping address's attention_to. Shared by the form preview and
 * the PDF so they can't drift.
 */
export function resolveAttentionLine(
  shipment: Pick<ShipmentWithRelations, 'shipping_address'> | null | undefined,
): ResolvedAttention {
  const text = shipment?.shipping_address?.attention_to?.trim() ?? '';
  if (!text) return { source: 'none', text: null };
  return { source: 'address', text };
}

/**
 * Convenience wrapper around the job_last_ship_date(uuid) SQL helper.
 * The helper is in the public schema so PostgREST exposes it as an RPC.
 */
export async function getJobLastShipDate(jobId: string): Promise<Date | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase.rpc('job_last_ship_date', {
    p_job_id: jobId,
  });

  if (error) {
    console.error('Error calling job_last_ship_date:', error);
    throw new Error('Failed to load last ship date.');
  }
  if (!data) return null;
  // SQL date scalar comes back as 'YYYY-MM-DD' string.
  return new Date(`${data as string}T00:00:00`);
}

/**
 * Phase 3 placeholder. Schema and trigger B support voiding, but the
 * UI surface is out-of-scope for Phase 1. Throwing here keeps the API
 * surface stable for Phase 3 wiring.
 */
export async function voidShipment(_shipmentId: string): Promise<void> {
  throw new Error('voidShipment is not implemented in Phase 1.');
}
