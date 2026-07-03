/**
 * Shipments access layer.
 *
 * createShipment routes through the create_shipment_with_line_items RPC which:
 *   1. derives the single job behind the line items (one slip = one job),
 *   2. takes a per-job advisory lock (collision-free packing-slip sequence),
 *   3. snapshots pre-cascade fulfillment_status for the job,
 *   4. mints the job-derived packing-slip number PS-{jobBase}-{n} (n from 1),
 *   5. inserts the shipment + line items (triggers cascade fulfillment),
 *   6. writes an audit row if the job transitioned forward into fully_shipped.
 *
 * Reads use plain PostgREST joins. voidShipment stamps voided_at/voided_by
 * and lets the trigger family reverse the fulfillment cascade.
 */

// Typed Supabase client (typed-client rollout). Aliased so the 10 call
// sites stay untouched. See CLAUDE.md "Typed Supabase client".
import { getTypedSupabase as getSupabase } from '@/lib/supabase';
import type {
  CreateShipmentPayload,
  JobPartShipmentSummary,
  JobShipmentSummary,
  OpenJobPartFilter,
  OpenJobPartRow,
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

  // The SQL function (create_shipment_with_line_items) derives the single
  // job behind the line items, mints the PS-{jobBase}-{n} number, and
  // accepts NULL for every optional field. The typed RPC signature reflects
  // only the parameter type (e.g. text) without DEFAULT NULL, so the
  // generated client type rejects null arguments; we cast at the call site.
  const rpcArgs = {
    p_company_id: companyId,
    p_customer_id: payload.customer_id,
    p_shipping_address_id: payload.shipping_address_id,
    p_one_time_address: payload.one_time_address ?? null,
    p_ship_date: payload.ship_date,
    p_carrier: payload.carrier ?? null,
    p_shipping_method: payload.shipping_method ?? null,
    p_line_items: payload.line_items,
  };
  const { data: shipmentId, error } = await supabase.rpc(
    'create_shipment_with_line_items',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rpcArgs as any,
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
       customer:customers (
         id, name,
         addresses:customer_addresses (
           id, customer_id, address_line1, address_line2, city, state,
           postal_code, country, default_billing, default_shipping, attention_to
         )
       ),
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

  const shipment = data as unknown as ShipmentWithRelations;
  shipment.created_by_member = await fetchCreatorMember(
    shipment.company_id,
    shipment.created_by,
  );
  return shipment;
}

/**
 * Look up the salesperson/shipper who created the row. Lives in
 * user_company_access (same shape quotePdf uses). Returns null when
 * created_by is unset (legacy migrations) or the member has since
 * been removed from the company.
 */
async function fetchCreatorMember(
  companyId: string,
  userId: string | null,
): Promise<{ user_id: string; name: string | null; email: string | null } | null> {
  if (!userId) return null;
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('user_company_access')
    .select('user_id, name, email')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.warn('fetchCreatorMember failed:', error);
    return null;
  }
  return (data as { user_id: string; name: string | null; email: string | null } | null) ?? null;
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
       customer:customers (
         id, name,
         addresses:customer_addresses (
           id, customer_id, address_line1, address_line2, city, state,
           postal_code, country, default_billing, default_shipping, attention_to
         )
       ),
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

  const rows = (data ?? []) as unknown as ShipmentWithRelations[];
  if (rows.length > 0) {
    // Batch-resolve created_by members in one round trip rather than N+1.
    const userIds = Array.from(
      new Set(rows.map((r) => r.created_by).filter((u): u is string => Boolean(u))),
    );
    const companyId = rows[0].company_id;
    if (userIds.length > 0) {
      const { data: members } = await supabase
        .from('user_company_access')
        .select('user_id, name, email')
        .eq('company_id', companyId)
        .in('user_id', userIds);
      const byUserId = new Map<string, { user_id: string; name: string | null; email: string | null }>();
      for (const m of (members ?? []) as Array<{
        user_id: string;
        name: string | null;
        email: string | null;
      }>) {
        byUserId.set(m.user_id, m);
      }
      for (const r of rows) {
        r.created_by_member = r.created_by ? byUserId.get(r.created_by) ?? null : null;
      }
    } else {
      for (const r of rows) r.created_by_member = null;
    }
  }
  return rows;
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
 * Count ALL shipment rows referencing a job — voided rows included.
 *
 * Used as a hard pre-delete guard in deleteJob: shipments_job_id_fkey has no
 * ON DELETE clause, so any referencing row (even a voided one) would trip a
 * raw FK violation. getJobPartShipmentSummaries deliberately ignores voided
 * shipments, so it can't answer this question — hence a dedicated count that
 * leans on the direct shipments.job_id column.
 */
export async function countShipmentsForJob(jobId: string): Promise<number> {
  const supabase = getSupabase();

  const { count, error } = await supabase
    .from('shipments')
    .select('id', { count: 'exact', head: true })
    .eq('job_id', jobId);

  if (error) {
    console.error('countShipmentsForJob failed:', error);
    throw new Error('Failed to check shipments.');
  }
  return count ?? 0;
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
 * All open job_parts for a customer across every job they have in this
 * company, with shipped/remaining quantities computed and clamped.
 *
 * NOTE: only reached by ShipmentForm's `customer` mode, which is now
 * unwired (the standalone /shipments/new wizard was removed once a slip
 * became one-job). Kept until the customer-mode form path is excised.
 * Pulls the customer's job_parts via a nested PostgREST
 * filter, then sums non-voided shipment_line_items for those parts in
 * one batched query — same two-round-trip shape as
 * getJobPartShipmentSummaries, just joined on customer_id instead of
 * job_id.
 *
 * The filter defaults match the wizard's case: exclude lines whose
 * production is cancelled and lines already fully shipped. Future
 * surfaces (e.g., a "ship anything anywhere" admin tool, or reporting
 * over historical shipments) can override either flag.
 *
 * qty_remaining is clamped to zero. An over-shipment (qty_shipped >
 * qty_ordered) yields qty_remaining = 0, not a negative — the picker
 * disables the checkbox in that case rather than showing nonsense math.
 *
 * Sorted by job_number then part_name for stable grouping in the UI.
 */
export async function getOpenJobPartsForCustomer(
  companyId: string,
  customerId: string,
  filter: OpenJobPartFilter = {},
): Promise<OpenJobPartRow[]> {
  const supabase = getSupabase();
  const excludeFullyShipped = filter.excludeFullyShipped ?? true;
  const excludeCancelled = filter.excludeCancelled ?? true;

  // Inner-join through jobs so we can filter on jobs.customer_id /
  // jobs.company_id while still returning the job_part row shape.
  let query = supabase
    .from('job_parts')
    .select(
      `id, quantity, production_status, fulfillment_status,
       part:parts (id, part_name, description),
       job:jobs!inner (id, job_number, customer_po_number, customer_id, company_id)`,
    )
    .eq('job.customer_id', customerId)
    .eq('job.company_id', companyId);

  if (excludeCancelled) {
    query = query.neq('production_status', 'cancelled');
  }
  if (excludeFullyShipped) {
    query = query.neq('fulfillment_status', 'fully_shipped');
  }

  const { data: rawParts, error: partsErr } = await query;
  if (partsErr) {
    console.error('getOpenJobPartsForCustomer: parts fetch failed:', partsErr);
    throw new Error('Failed to load open lines.');
  }

  type Row = {
    id: string;
    quantity: number;
    production_status: 'not_started' | 'in_progress' | 'completed' | 'cancelled';
    fulfillment_status: 'unshipped' | 'partially_shipped' | 'fully_shipped';
    part: { id: string; part_name: string; description: string | null } | null;
    job: {
      id: string;
      job_number: string;
      customer_po_number: string | null;
      customer_id: string;
      company_id: string;
    } | null;
  };
  const parts = (rawParts ?? []) as unknown as Row[];
  if (parts.length === 0) return [];

  const partIds = parts.map((p) => p.id);
  const { data: shipped, error: shippedErr } = await supabase
    .from('shipment_line_items')
    .select('job_part_id, quantity, shipment:shipments!inner (voided_at)')
    .in('job_part_id', partIds);

  if (shippedErr) {
    console.error('getOpenJobPartsForCustomer: shipped fetch failed:', shippedErr);
    throw new Error('Failed to load shipped quantities.');
  }

  type ShippedRow = {
    job_part_id: string;
    quantity: number;
    shipment: { voided_at: string | null } | null;
  };
  const shippedByPart = new Map<string, number>();
  for (const row of (shipped ?? []) as unknown as ShippedRow[]) {
    if (!row.shipment || row.shipment.voided_at !== null) continue;
    shippedByPart.set(
      row.job_part_id,
      (shippedByPart.get(row.job_part_id) ?? 0) + Number(row.quantity),
    );
  }

  return parts
    .filter((p) => p.part !== null && p.job !== null)
    .map((p) => {
      const qtyOrdered = Number(p.quantity);
      const qtyShipped = shippedByPart.get(p.id) ?? 0;
      return {
        job_part_id: p.id,
        job_id: p.job!.id,
        job_number: p.job!.job_number,
        customer_po_number: p.job!.customer_po_number,
        part_id: p.part!.id,
        part_name: p.part!.part_name,
        description: p.part!.description,
        qty_ordered: qtyOrdered,
        qty_shipped: qtyShipped,
        qty_remaining: Math.max(0, qtyOrdered - qtyShipped),
        production_status: p.production_status,
        fulfillment_status: p.fulfillment_status,
      };
    })
    .sort((a, b) => {
      if (a.job_number !== b.job_number) {
        return a.job_number.localeCompare(b.job_number, undefined, {
          numeric: true,
          sensitivity: 'base',
        });
      }
      return a.part_name.localeCompare(b.part_name, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
    });
}

/**
 * "Where does the ATTN: line on the packing slip come from?" answer.
 * Phase 1 has no shipments.shipping_contact_id, so the only source is
 * the shipping address's attention_to. Shared by the form preview and
 * the PDF so they can't drift.
 */
export function resolveAttentionLine(
  shipment: Pick<ShipmentWithRelations, 'ship_to_address'> | null | undefined,
): ResolvedAttention {
  // Read the frozen ship-to snapshot, not the live address row, so the ATTN line
  // matches what the slip was issued with even after the address changes/deletes.
  const text = shipment?.ship_to_address?.attention_to?.trim() ?? '';
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
 * Void a shipment. Stamps voided_at/voided_by on the row; the
 * trigger_recompute_jp_fulfillment_on_void trigger reverses the
 * fulfillment cascade (job_parts → job recompute from the remaining
 * non-voided line items). No migration or RPC needed: the "Users can
 * update shipments" RLS policy permits the in-company UPDATE, and the
 * reverse transition is recorded on voided_at/voided_by by design (no
 * separate audit row — see job_fulfillment_audit comment).
 *
 * Idempotent: the `.is('voided_at', null)` guard makes re-voiding a
 * no-op rather than re-stamping a new timestamp. Quantities are never
 * deleted, so the packing-slip number stays on record as VOIDED.
 */
export async function voidShipment(shipmentId: string): Promise<void> {
  const supabase = getSupabase();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    throw new Error('You must be signed in to void a shipment.');
  }

  const { error } = await supabase
    .from('shipments')
    .update({ voided_at: new Date().toISOString(), voided_by: user.id })
    .eq('id', shipmentId)
    .is('voided_at', null);

  if (error) {
    console.error('voidShipment failed:', error);
    throw new Error(`Failed to void shipment: ${error.message}`);
  }
}
