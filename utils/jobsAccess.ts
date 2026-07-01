// Adopt the typed Supabase client so every .from('jobs').select(...) chain
// is validated against types/database.ts at compile time. Aliased to
// getSupabase so the dozens of call sites below don't need renaming —
// this also keeps the diff small for review. See CLAUDE.md "Typed
// Supabase client (incremental adoption)" for the rollout contract.
import { getTypedSupabase as getSupabase } from '@/lib/supabase';
import { friendlyErrorMessage } from '@/lib/supabaseErrors';
import { deleteStoredFilesForJobs } from '@/utils/jobAttachmentsAccess';
import type { Database } from '@/types/database';

// Update payloads for tables this file mutates conditionally. The typed
// `.update(...)` call rejects bare Record<string, unknown> because it
// can't verify the keys against the table schema; using the generated
// Update types preserves the column-name check.
type JobUpdate = Database['public']['Tables']['jobs']['Update'];
type JobInsert = Database['public']['Tables']['jobs']['Insert'];
type JobPartUpdate = Database['public']['Tables']['job_parts']['Update'];
type JobPartInsert = Database['public']['Tables']['job_parts']['Insert'];
type JobOperationUpdate = Database['public']['Tables']['job_operations']['Update'];
import type {
  Job,
  JobPart,
  JobWithRelations,
  JobFilters,
  ProductionStatus,
  JobOperation,
  CompleteOperationData,
  OperationUpdateResult,
  CurrentOperationInfo,
} from '@/types/job';
import { isJobDone } from '@/types/job';
import type { PricingBasisSnapshot } from '@/types/quote';
import { resolveTierFromSnapshot } from '@/utils/quotePricingResolver';
import { getJobPartShipmentSummaries, countShipmentsForJob } from '@/utils/shipmentsAccess';
import { getQuickBooksInvoiceLinkForJob } from '@/utils/quickbooksAccess';

/**
 * Sanitize search string for use in LIKE/ILIKE queries
 */
function sanitizeSearchString(search: string): string {
  return search
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
    .substring(0, 100);
}

/**
 * "Today" formatted as YYYY-MM-DD in the *user's local timezone*. The
 * client-side isJobOverdue predicate uses local midnight, so the
 * server-side overdue filter has to agree on what date "today" is —
 * otherwise a job due 2026-05-19 can show the overdue icon locally
 * (because the user's local clock has rolled past midnight) while the
 * server query, anchored on UTC, still considers "today" to be 2026-05-19
 * and excludes it from the `due_date < today` filter.
 */
function todayLocalISODate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ============== Read Queries ==============

/**
 * Get all jobs for a company (batch fetch for AG Grid). Pulls each job's
 * job_parts list with the linked part name + qty so the dashboard list can
 * show "ADP-001, ADP-002" style summaries without extra round-trips.
 */
export async function getAllJobs(
  companyId: string,
  filters: JobFilters = {},
  sortField: string = 'created_at',
  sortDirection: 'asc' | 'desc' = 'desc',
): Promise<JobWithRelations[]> {
  const supabase = getSupabase();
  const BATCH_SIZE = 1000;
  let allData: JobWithRelations[] = [];
  let offset = 0;
  let hasMore = true;

  // If the caller passed search text, resolve the matching set + per-job
  // match_source up-front via the extended search RPC. The main query
  // restricts to those ids; the result rows get match_source mixed in
  // so the cell renderer can show "matched packing slip" sub-text.
  let matchSourceByJobId: Map<string, string> | null = null;
  if (filters.search?.trim()) {
    const matches = await searchJobsByIdentifier(companyId, filters.search.trim());
    matchSourceByJobId = new Map(matches.map((m) => [m.job_id, m.match_source]));
  }

  while (hasMore) {
    let query = supabase
      .from('jobs')
      .select(`
        *,
        customers!left(id, name),
        quotes!jobs_quote_id_fkey(id, quote_number),
        job_parts(
          id, sequence, quantity, production_status, fulfillment_status,
          parts(id, part_name, description)
        )
      `)
      .eq('company_id', companyId)
      .order(sortField, { ascending: sortDirection === 'asc' })
      .range(offset, offset + BATCH_SIZE - 1);

    if (filters.productionStatus && filters.productionStatus !== 'all') {
      query = query.in('production_status', filters.productionStatus);
    }
    if (filters.fulfillmentStatus && filters.fulfillmentStatus !== 'all') {
      query = query.in('fulfillment_status', filters.fulfillmentStatus);
    }
    if (filters.customerId) {
      query = query.eq('customer_id', filters.customerId);
    }
    if (matchSourceByJobId !== null) {
      // search_jobs_by_identifier has already resolved the matching set
      // (see top of getAllJobs). Restrict the main query to those ids;
      // an empty set short-circuits to no rows.
      const ids = Array.from(matchSourceByJobId.keys());
      if (ids.length === 0) {
        hasMore = false;
        break;
      }
      query = query.in('id', ids);
    } else if (filters.search?.trim()) {
      const sanitized = sanitizeSearchString(filters.search.trim());
      query = query.or(`job_number.ilike.%${sanitized}%`);
    }
    if (filters.overdue) {
      // Overdue: due_date past AND not the FR-18 "done" state. Done is
      // production IN (completed, cancelled) AND fulfillment = fully_shipped.
      // Encode by excluding rows that satisfy both halves; we approximate
      // server-side with the fulfillment half and let isJobOverdue refine
      // client-side. Uses local-date today (see todayLocalISODate) so the
      // server agrees with the client's isJobOverdue check.
      query = query
        .not('due_date', 'is', null)
        .lt('due_date', todayLocalISODate())
        .not('fulfillment_status', 'eq', 'fully_shipped');
    }

    const { data, error } = await query;
    if (error) {
      console.error('Error fetching jobs batch:', error);
      throw error;
    }

    allData = [...allData, ...((data || []) as JobWithRelations[])];
    hasMore = (data?.length || 0) === BATCH_SIZE;
    offset += BATCH_SIZE;
  }

  // FR-19 done-filter is applied client-side here so callers that don't pass
  // explicit production/fulfillment filters still get the "hide done jobs"
  // default. Callers that want to see done jobs pass excludeDone=false.
  const excludeDone = filters.excludeDone ?? true;
  if (excludeDone) {
    allData = allData.filter((j) => !isJobDone(j));
  }

  // Attach per-row match_source for the search-result sub-text.
  if (matchSourceByJobId !== null) {
    allData = allData.map((j) => ({
      ...j,
      match_source: matchSourceByJobId.get(j.id) ?? null,
    }));
  }

  return allData;
}

/**
 * Resolve the matching job-ids + per-row match_source for an extended
 * search query (job_number, customer_po, customer name, part number,
 * packing slip number). Capped server-side at 100 rows by the RPC.
 */
export async function searchJobsByIdentifier(
  companyId: string,
  query: string,
): Promise<Array<{ job_id: string; match_source: string }>> {
  if (!query.trim()) return [];
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('search_jobs_by_identifier', {
    p_company_id: companyId,
    p_query: query.trim(),
  });
  if (error) {
    console.error('search_jobs_by_identifier failed:', error);
    throw new Error(`Search failed: ${error.message}`);
  }
  return (data ?? []) as Array<{ job_id: string; match_source: string }>;
}

/**
 * Get a single job with all relations: job_parts (each with their part,
 * operations, and materials), customer, source quote.
 */
export async function getJobWithRelations(
  jobId: string,
  companyId: string,
): Promise<JobWithRelations | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('jobs')
    .select(`
      *,
      customers!left(
        id, name,
        customer_contacts(id, name, role, email, phone, is_primary),
        addresses:customer_addresses(
          id,
          address_line1, address_line2, city, state, postal_code, country,
          default_billing, default_shipping, attention_to
        )
      ),
      quotes!jobs_quote_id_fkey(id, quote_number),
      job_parts(
        *,
        parts(id, part_name, description),
        job_operations(
          *,
          work_center:work_centers!left(id, name, labor_rate, kind)
        )
      )
    `)
    .eq('id', jobId)
    .eq('company_id', companyId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching job with relations:', error);
    throw error;
  }
  if (!data) return null;

  const job = data as JobWithRelations;

  // Sort parts by sequence; sort each part's operations by sequence.
  if (job.job_parts) {
    job.job_parts.sort((a, b) => a.sequence - b.sequence);
    for (const part of job.job_parts) {
      if (part.job_operations) {
        part.job_operations.sort((a, b) => a.sequence - b.sequence);
      }
    }
  }

  return job;
}

/**
 * Update a job's billing/shipping address + contact. Each value is an
 * address/contact id owned by the job's customer, or '' / null to clear it
 * (translated to NULL). The enforce_job_address_contact_customer trigger
 * rejects ids that don't belong to the job's customer.
 */
export async function updateJobAddressContact(
  jobId: string,
  companyId: string,
  fields: {
    billing_address_id?: string | null;
    shipping_address_id?: string | null;
    contact_id?: string | null;
  },
): Promise<Job> {
  const supabase = getSupabase();

  const toNull = (v: string | null | undefined): string | null | undefined =>
    v === undefined ? undefined : v === '' ? null : v;

  const patch: JobUpdate = {
    billing_address_id: toNull(fields.billing_address_id),
    shipping_address_id: toNull(fields.shipping_address_id),
    contact_id: toNull(fields.contact_id),
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('jobs')
    .update(patch)
    .eq('id', jobId)
    .eq('company_id', companyId)
    .select('*')
    .single();

  if (error) {
    console.error('Error updating job address/contact:', error);
    throw new Error(
      friendlyErrorMessage(error, {
        entity: 'job',
        fallback: 'Failed to update job billing/shipping details.',
      }),
    );
  }

  return data as Job;
}

/**
 * Update a job's header details — customer PO number and due date. Complements
 * updateJobAddressContact so the single job-edit form can save every header
 * field. Only the keys provided are patched; '' clears to NULL.
 */
export async function updateJobDetails(
  jobId: string,
  companyId: string,
  fields: { customer_po_number?: string | null; due_date?: string | null },
): Promise<Job> {
  const supabase = getSupabase();
  const toNull = (v: string | null | undefined): string | null | undefined =>
    v === undefined ? undefined : v === '' ? null : v;

  const patch: JobUpdate = { updated_at: new Date().toISOString() };
  if (fields.customer_po_number !== undefined) {
    patch.customer_po_number = toNull(fields.customer_po_number);
  }
  if (fields.due_date !== undefined) {
    patch.due_date = toNull(fields.due_date);
  }

  const { data, error } = await supabase
    .from('jobs')
    .update(patch)
    .eq('id', jobId)
    .eq('company_id', companyId)
    .select('*')
    .single();

  if (error) {
    console.error('Error updating job details:', error);
    throw new Error(
      friendlyErrorMessage(error, { entity: 'job', fallback: 'Failed to update job details.' }),
    );
  }
  return data as Job;
}

// ============== Job Creation (direct from PO) ==============

/** One line on a PO-direct job: an existing part, a quantity, an agreed price. */
export interface CreateJobFromPoLine {
  part_id: string;
  quantity: number;
  unit_price: number;
}

export interface CreateJobFromPoInput {
  customer_id: string;
  /** The customer's PO number — the work-order authorization. Required. */
  customer_po_number: string;
  /** Promised ship date (YYYY-MM-DD), or null. Entered directly (no lead time). */
  due_date: string | null;
  lines: CreateJobFromPoLine[];
}

export interface CreateJobFromPoResult {
  job_id: string;
  job_number: string;
}

/**
 * Create a job directly from a customer Purchase Order — no source quote.
 *
 * Mirrors convertQuoteToJob (utils/quotesAccess.ts) but the line data comes
 * from the PO form instead of quote line items, and the agreed price is stored
 * straight on each job_part (quote-sourced jobs carry it too — see A4 — so the
 * invoice read path is single-shaped). Existing parts only: every part must
 * already have a routing, which is cloned into job_operations + job_materials
 * by the shared create_job_part_operations_from_routing RPC.
 *
 * Like convertQuoteToJob, the writes are sequential (the JS client has no
 * multi-statement transaction); on partial failure the partial job stays in
 * place and the owner can delete + retry.
 */
export async function createJobFromPurchaseOrder(
  companyId: string,
  input: CreateJobFromPoInput,
): Promise<CreateJobFromPoResult> {
  const supabase = getSupabase();

  // PO# is the authorization — required. Reject empty rather than coercing to
  // NULL (no silent fallbacks), and before any writes.
  const customerPoNumber = input.customer_po_number?.trim();
  if (!customerPoNumber) {
    throw new Error('Customer PO is required to create a job.');
  }
  if (!input.customer_id) {
    throw new Error('Select a customer for this PO.');
  }

  const lines = input.lines ?? [];
  if (lines.length === 0) {
    throw new Error('Add at least one part before creating the job.');
  }
  for (const line of lines) {
    if (!line.part_id) {
      throw new Error('Every line must reference a part.');
    }
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new Error('Each part quantity must be a whole number greater than zero.');
    }
    if (
      typeof line.unit_price !== 'number' ||
      !Number.isFinite(line.unit_price) ||
      line.unit_price < 0
    ) {
      throw new Error('Each part needs a valid unit price (zero or more).');
    }
  }
  // Exactly one line per part — duplicate parts would silently create duplicate
  // job parts (mirrors convertQuoteToJob's guard).
  const partLineCounts = new Map<string, number>();
  for (const line of lines) {
    partLineCounts.set(line.part_id, (partLineCounts.get(line.part_id) ?? 0) + 1);
  }
  if (Array.from(partLineCounts.values()).some((n) => n > 1)) {
    throw new Error('Each part can appear only once — combine duplicates into a single quantity.');
  }

  // Pre-flight: every part must already have a routing in this company. Fail
  // fast before writing anything (this is the "existing parts only" gate).
  const partIds = Array.from(partLineCounts.keys());
  const { data: routings, error: routingsErr } = await supabase
    .from('routings')
    .select('id, part_id')
    .eq('company_id', companyId)
    .in('part_id', partIds);
  if (routingsErr) {
    console.error('Error fetching routings:', routingsErr);
    throw routingsErr;
  }
  const routingByPart = new Map<string, string>();
  for (const r of (routings ?? []) as Array<{ id: string; part_id: string }>) {
    routingByPart.set(r.part_id, r.id);
  }
  const missingRoutingPartIds = partIds.filter((pid) => !routingByPart.has(pid));
  if (missingRoutingPartIds.length > 0) {
    throw new Error(
      `No routing defined for ${missingRoutingPartIds.length} part${
        missingRoutingPartIds.length === 1 ? '' : 's'
      }. Add a routing on the part before creating a job from a PO.`,
    );
  }

  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    throw new Error('Authentication required. Please log in and try again.');
  }

  // Default billing/shipping/contact from the customer's address book so the
  // job has a shippable address of its own; editable afterwards via
  // updateJobAddressContact. (The enforce_job_address_contact_customer trigger
  // is satisfied because these ids belong to this customer.)
  const { data: customer, error: customerErr } = await supabase
    .from('customers')
    .select(`
      id,
      customer_addresses(id, default_billing, default_shipping),
      customer_contacts(id, is_primary)
    `)
    .eq('id', input.customer_id)
    .eq('company_id', companyId)
    .single();
  if (customerErr || !customer) {
    throw new Error('Customer not found for this company.');
  }
  const addresses = (customer.customer_addresses ?? []) as Array<{
    id: string;
    default_billing: boolean;
    default_shipping: boolean;
  }>;
  const contacts = (customer.customer_contacts ?? []) as Array<{
    id: string;
    is_primary: boolean;
  }>;
  const billingAddressId = addresses.find((a) => a.default_billing)?.id ?? null;
  const shippingAddressId = addresses.find((a) => a.default_shipping)?.id ?? null;
  const contactId = contacts.find((c) => c.is_primary)?.id ?? null;

  // Draw a J- number from the shared per-company order counter
  // (generate_direct_job_number -> next_order_number). It's atomic, so two
  // concurrent creates get distinct numbers and the number can never collide
  // with a quote's reserved J-N — no re-mint/retry dance needed.
  const { data: jobNumber, error: numErr } = await supabase.rpc('generate_direct_job_number', {
    company_uuid: companyId,
  });
  if (numErr || !jobNumber) {
    console.error('Error generating job number:', numErr);
    throw numErr || new Error('Could not generate a job number.');
  }

  const insertPayload: JobInsert = {
    company_id: companyId,
    quote_id: null,
    customer_id: input.customer_id,
    job_number: jobNumber as string,
    production_status: 'not_started',
    fulfillment_status: 'unshipped',
    due_date: input.due_date || null,
    lead_time_days: null,
    customer_po_number: customerPoNumber,
    billing_address_id: billingAddressId,
    shipping_address_id: shippingAddressId,
    contact_id: contactId,
    created_by: user.id,
  };

  const { data: job, error: jobError } = await supabase
    .from('jobs')
    .insert(insertPayload)
    .select('id, job_number')
    .single();

  if (jobError || !job) {
    console.error('Error creating job from PO:', jobError);
    throw jobError || new Error('Could not create the job — please try again.');
  }

  // One job_part per line carrying the agreed price; clone each part's routing
  // into job_operations + job_materials via the shared snapshot RPC.
  let sequence = 10;
  for (const line of lines) {
    const routingId = routingByPart.get(line.part_id);
    if (!routingId) {
      throw new Error(`Routing for part ${line.part_id} disappeared mid-create.`);
    }

    const totalPrice = Math.round(line.unit_price * line.quantity * 10000) / 10000;
    const jobPartInsert: JobPartInsert = {
      job_id: job.id,
      company_id: companyId,
      part_id: line.part_id,
      sequence,
      quantity: line.quantity,
      unit_price: line.unit_price,
      total_price: totalPrice,
      production_status: 'not_started',
      fulfillment_status: 'unshipped',
    };

    const { data: jobPart, error: jpErr } = await supabase
      .from('job_parts')
      .insert(jobPartInsert)
      .select('id')
      .single();
    if (jpErr) {
      console.error('Error creating job_part:', jpErr);
      throw jpErr;
    }

    const { error: rpcErr } = await supabase.rpc('create_job_part_operations_from_routing', {
      p_job_part_id: jobPart.id,
      p_routing_id: routingId,
    });
    if (rpcErr) {
      console.error('Failed to copy operations from routing:', rpcErr);
      throw new Error('Job created but failed to copy operations from routing.');
    }

    sequence += 10;
  }

  return { job_id: job.id, job_number: job.job_number };
}

// ============== Job Part Quantity Editing ==============

/** Result of editing a job_part's order quantity. */
export interface UpdateJobPartQuantityResult {
  jobPart: JobPart;
  oldQuantity: number;
  newQuantity: number;
  oldUnitPrice: number | null;
  newUnitPrice: number | null;
  oldTotalPrice: number | null;
  newTotalPrice: number | null;
  /** True when the tier price was re-resolved and actually changed unit_price. */
  priceReresolved: boolean;
}

/**
 * Pricing basis for a job_part's quantity edit, read from its source quote
 * line. Null for PO-sourced jobs (no quote line) — those always keep the
 * agreed unit_price. Override / basis_unknown lines also keep their price.
 */
export interface JobPartPricingBasis {
  isOverride: boolean;
  basisUnknown: boolean;
  snapshot: PricingBasisSnapshot | null;
}

// job_parts.total_price is numeric(12,4); round the recompute to 4dp to match
// the convert/PO write paths (calculateTotalPrice rounds to 2dp — too coarse
// here, it would make an edited line inconsistent with its siblings).
const roundTotal4dp = (n: number): number => Math.round(n * 10000) / 10000;

/**
 * Resolve the kept vs. tier-crossing unit price for a job_part at a new
 * quantity. Pure, so the edit modal previews it and the writer applies it
 * identically. `keepUnitPrice` is always the agreed price; `tierUnitPrice` is
 * the snapshot-resolved price, present only when the line is tier-priced
 * (not an override / basis_unknown / PO-sourced) — otherwise null.
 */
export function resolveJobPartUnitPrice(
  currentUnitPrice: number | null,
  basis: JobPartPricingBasis | null,
  newQuantity: number,
): { keepUnitPrice: number | null; tierUnitPrice: number | null } {
  const keepUnitPrice = currentUnitPrice;
  if (!basis || basis.isOverride || basis.basisUnknown || !basis.snapshot) {
    return { keepUnitPrice, tierUnitPrice: null };
  }
  const resolved = resolveTierFromSnapshot(basis.snapshot, newQuantity);
  return { keepUnitPrice, tierUnitPrice: resolved ? resolved.unit_price : null };
}

/**
 * Fetch the frozen pricing basis for a job_part's edit modal, read through
 * `source_quote_line_item_id`. Returns null for PO-sourced jobs (no quote
 * line) so the modal knows there's no tier curve to offer.
 */
export async function getJobPartPricingBasis(
  jobPartId: string,
): Promise<JobPartPricingBasis | null> {
  const supabase = getSupabase();
  const { data: jp, error } = await supabase
    .from('job_parts')
    .select('source_quote_line_item_id')
    .eq('id', jobPartId)
    .single();
  if (error || !jp?.source_quote_line_item_id) return null;

  const { data: line } = await supabase
    .from('quote_line_items')
    .select('is_quote_override, basis_unknown, pricing_basis_snapshot')
    .eq('id', jp.source_quote_line_item_id)
    .maybeSingle();
  if (!line) return null;
  return {
    isOverride: line.is_quote_override,
    basisUnknown: line.basis_unknown,
    snapshot:
      (line.pricing_basis_snapshot as unknown as PricingBasisSnapshot | null) ?? null,
  };
}

/**
 * Edit the order quantity on a job_part after the job was created. Today
 * job_parts.quantity is immutable; this is the post-conversion edit path
 * (customers commonly change quantity up or down after a quote converts).
 *
 * Pricing mirrors the quote-side `updateLineItemQuantity`: it DEFAULTS to
 * keeping the agreed unit_price (passing a volume break is the shop's call,
 * not automatic) and only re-resolves the tier price from the source line's
 * FROZEN snapshot when `opts.useNewTierPrice` is set. PO-sourced / override /
 * basis_unknown lines always keep their price. total_price recomputes at 4dp.
 *
 * Guardrails (all enforced before the write):
 *  - newQuantity must be finite and > 0 (decimals allowed — fractional units).
 *  - cannot reduce below already-shipped qty for the part.
 *  - blocked while a QuickBooks invoice exists for the job (Phase 1 — invoiced
 *    jobs get the void-and-reissue / memo flow in a later phase).
 *
 * fulfillment_status is NOT written here — the AFTER UPDATE OF quantity DB
 * trigger (trigger_recompute_jp_fulfillment_on_qty) recomputes it from the
 * single-source compute_job_part_fulfillment_status function and rolls it up
 * to the job. The returned row may therefore carry a stale fulfillment_status;
 * callers refetch the job for canonical state.
 */
export async function updateJobPartQuantity(
  jobPartId: string,
  newQuantity: number,
  opts?: { useNewTierPrice?: boolean },
): Promise<UpdateJobPartQuantityResult> {
  const supabase = getSupabase();

  if (!Number.isFinite(newQuantity) || newQuantity <= 0) {
    throw new Error('Order quantity must be a number greater than zero.');
  }

  // 1. Load the job_part.
  const { data: jpRow, error: jpErr } = await supabase
    .from('job_parts')
    .select(
      'id, job_id, company_id, quantity, unit_price, total_price, source_quote_line_item_id, production_status',
    )
    .eq('id', jobPartId)
    .single();
  if (jpErr || !jpRow) {
    console.error('Error loading job_part for quantity edit:', jpErr);
    throw jpErr || new Error('Could not load the job part.');
  }
  const part = jpRow as unknown as {
    id: string;
    job_id: string;
    company_id: string;
    quantity: number;
    unit_price: number | null;
    total_price: number | null;
    source_quote_line_item_id: string | null;
    production_status: ProductionStatus;
  };

  if (part.production_status === 'cancelled') {
    throw new Error('This part is cancelled — its quantity can no longer be edited.');
  }

  // 2. Invoice gate (Phase 1): block when a QuickBooks invoice already exists.
  const invoiceLink = await getQuickBooksInvoiceLinkForJob(part.company_id, part.job_id);
  if (invoiceLink) {
    throw new Error(
      `This job is already invoiced in QuickBooks${
        invoiceLink.docNumber ? ` (${invoiceLink.docNumber})` : ''
      }. Revise or void that invoice in QuickBooks before changing the quantity.`,
    );
  }

  // 3. Shipped-floor guard: can't drop below what already shipped.
  const summaries = await getJobPartShipmentSummaries(part.job_id);
  const qtyShipped = summaries.find((s) => s.job_part_id === jobPartId)?.qty_shipped ?? 0;
  if (newQuantity < qtyShipped) {
    throw new Error(
      `Cannot set quantity to ${newQuantity} — ${qtyShipped} have already shipped on this part. ` +
        'Void a packing slip first to ship fewer.',
    );
  }

  // 4. Re-resolve price (keep agreed by default; cross a tier only on opt-in).
  const basis = await getJobPartPricingBasis(jobPartId);
  const { keepUnitPrice, tierUnitPrice } = resolveJobPartUnitPrice(
    part.unit_price,
    basis,
    newQuantity,
  );
  const newUnitPrice =
    opts?.useNewTierPrice && tierUnitPrice !== null ? tierUnitPrice : keepUnitPrice;
  const priceReresolved = newUnitPrice !== part.unit_price;
  const newTotalPrice = newUnitPrice !== null ? roundTotal4dp(newUnitPrice * newQuantity) : null;

  // 5. Single write. fulfillment_status handled by the DB trigger.
  const updatePayload: JobPartUpdate = {
    quantity: newQuantity,
    unit_price: newUnitPrice,
    total_price: newTotalPrice,
    updated_at: new Date().toISOString(),
  };
  const { data: updated, error: updErr } = await supabase
    .from('job_parts')
    .update(updatePayload)
    .eq('id', jobPartId)
    .select('*')
    .single();
  if (updErr || !updated) {
    console.error('Error updating job_part quantity:', updErr);
    throw new Error(
      friendlyErrorMessage(updErr, { entity: 'job', fallback: 'Failed to update the quantity.' }),
    );
  }

  return {
    jobPart: updated as unknown as JobPart,
    oldQuantity: part.quantity,
    newQuantity,
    oldUnitPrice: part.unit_price,
    newUnitPrice,
    oldTotalPrice: part.total_price,
    newTotalPrice,
    priceReresolved,
  };
}

/** Result of editing a job_part's unit price. */
export interface UpdateJobPartPriceResult {
  jobPart: JobPart;
  oldUnitPrice: number | null;
  newUnitPrice: number;
  oldTotalPrice: number | null;
  newTotalPrice: number;
}

/**
 * Manually set a job_part's unit price after the job was created — a direct
 * override of the resolved/tier price. total_price recomputes from the part's
 * current quantity at 4dp. There is no job-level price; pricing lives per
 * job_part.
 *
 * Unlike a quantity edit, price is orthogonal to fulfillment, so there's no
 * shipped-floor check. Guardrails enforced before the write:
 *  - newUnitPrice must be finite and >= 0 (0 = a no-charge line is allowed).
 *  - blocked while a QuickBooks invoice exists for the job (same gate as the
 *    quantity edit — revise/void the invoice in QuickBooks first).
 *  - a cancelled part can't be repriced.
 *
 * Composition note: job_parts carries no override flag (unlike quote lines'
 * is_quote_override), so the manual price is simply stored as unit_price. A
 * later updateJobPartQuantity keeps it by default (resolveJobPartUnitPrice keeps
 * the current unit_price unless the user opts into the tier price); opting into
 * the tier price on a subsequent quantity edit discards this override — the same
 * behavior a quote line has when the user picks the tier price.
 */
export async function updateJobPartPrice(
  jobPartId: string,
  newUnitPrice: number,
): Promise<UpdateJobPartPriceResult> {
  const supabase = getSupabase();

  if (!Number.isFinite(newUnitPrice) || newUnitPrice < 0) {
    throw new Error('Unit price must be a number of zero or more.');
  }

  // 1. Load the job_part.
  const { data: jpRow, error: jpErr } = await supabase
    .from('job_parts')
    .select('id, job_id, company_id, quantity, unit_price, total_price, production_status')
    .eq('id', jobPartId)
    .single();
  if (jpErr || !jpRow) {
    console.error('Error loading job_part for price edit:', jpErr);
    throw jpErr || new Error('Could not load the job part.');
  }
  const part = jpRow as unknown as {
    id: string;
    job_id: string;
    company_id: string;
    quantity: number;
    unit_price: number | null;
    total_price: number | null;
    production_status: ProductionStatus;
  };

  if (part.production_status === 'cancelled') {
    throw new Error('This part is cancelled — its price can no longer be edited.');
  }

  // 2. Invoice gate: same boundary as the quantity edit.
  const invoiceLink = await getQuickBooksInvoiceLinkForJob(part.company_id, part.job_id);
  if (invoiceLink) {
    throw new Error(
      `This job is already invoiced in QuickBooks${
        invoiceLink.docNumber ? ` (${invoiceLink.docNumber})` : ''
      }. Revise or void that invoice in QuickBooks before changing the price.`,
    );
  }

  // 3. Recompute total at 4dp and write once. fulfillment_status is untouched
  //    (price doesn't affect fulfillment).
  const newTotalPrice = roundTotal4dp(newUnitPrice * part.quantity);
  const updatePayload: JobPartUpdate = {
    unit_price: newUnitPrice,
    total_price: newTotalPrice,
    updated_at: new Date().toISOString(),
  };
  const { data: updated, error: updErr } = await supabase
    .from('job_parts')
    .update(updatePayload)
    .eq('id', jobPartId)
    .eq('company_id', part.company_id)
    .select('*')
    .single();
  if (updErr || !updated) {
    console.error('Error updating job_part price:', updErr);
    throw new Error(
      friendlyErrorMessage(updErr, { entity: 'job', fallback: 'Failed to update the price.' }),
    );
  }

  return {
    jobPart: updated as unknown as JobPart,
    oldUnitPrice: part.unit_price,
    newUnitPrice,
    oldTotalPrice: part.total_price,
    newTotalPrice,
  };
}

/**
 * Current job_part quantities for a (converted) quote, keyed by the source
 * quote line. Lets the read-only quote page reflect "current order qty N
 * (quoted M)" when a job quantity was edited after conversion — without making
 * the quote itself writable. Returns [] for unconverted quotes / PO-sourced
 * parts (no source line).
 */
export interface QuoteLineJobQuantity {
  source_quote_line_item_id: string;
  job_id: string;
  job_number: string;
  quantity: number;
}

export async function getJobQuantitiesForQuote(
  quoteId: string,
): Promise<QuoteLineJobQuantity[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('job_parts')
    .select('source_quote_line_item_id, quantity, jobs!inner(id, job_number, quote_id)')
    .eq('jobs.quote_id', quoteId)
    .not('source_quote_line_item_id', 'is', null);
  if (error) {
    console.error('Error loading job quantities for quote:', error);
    return [];
  }
  type Row = {
    source_quote_line_item_id: string | null;
    quantity: number;
    jobs: { id: string; job_number: string; quote_id: string | null } | null;
  };
  const rows = (data ?? []) as unknown as Row[];
  return rows
    .filter((r): r is Row & { source_quote_line_item_id: string; jobs: NonNullable<Row['jobs']> } =>
      Boolean(r.source_quote_line_item_id && r.jobs),
    )
    .map((r) => ({
      source_quote_line_item_id: r.source_quote_line_item_id,
      job_id: r.jobs.id,
      job_number: r.jobs.job_number,
      quantity: r.quantity,
    }));
}

// ============== Job Materials ==============

// ============== Job Lifecycle ==============

/**
 * Delete a job. Deletion is gated by RECORDS OF VALUE, not production status: a
 * job can be removed in any production state (queued, running, completed, or
 * cancelled) as long as it has no shipment records and no QuickBooks invoice —
 * deleting either would orphan a real record. The discriminator is history, not
 * the status label (matches how shop ERPs gate hard-delete). This guard lives
 * here, not just in the UI, so a bypassed caller still can't remove a
 * shipped/invoiced job.
 *
 * Cascades remove job_parts, job_operations, job_materials, job_notes,
 * job_attachments (rows) and the quickbooks_invoice_links; inventory_transactions
 * keep their rows with job_id set null. Two things are handled explicitly:
 *   - attachment files in storage — cleaned up (best-effort) before the delete.
 *   - shipments — shipments_job_id_fkey has no ON DELETE, so any shipment row
 *     (voided included) blocks deletion rather than tripping the FK / losing
 *     fulfillment history.
 */
export async function deleteJob(jobId: string, companyId: string): Promise<void> {
  const supabase = getSupabase();

  // 1. Existence + tenant scope.
  const { data: jobRow, error: loadErr } = await supabase
    .from('jobs')
    .select('id')
    .eq('id', jobId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (loadErr) {
    console.error('Error loading job for delete:', loadErr);
    throw new Error(
      friendlyErrorMessage(loadErr, { entity: 'job', fallback: 'Failed to load job.' }),
    );
  }
  if (!jobRow) {
    throw new Error('Job not found.');
  }

  // 2. Records-of-value guards (status-agnostic). A shipment or a created invoice
  //    means the job is kept for recordkeeping rather than hard-deleted.
  if ((await countShipmentsForJob(jobId)) > 0) {
    throw new Error(
      "This job has shipment records, so it's kept for recordkeeping and can't be deleted.",
    );
  }
  const invoiceLink = await getQuickBooksInvoiceLinkForJob(companyId, jobId);
  if (invoiceLink) {
    throw new Error(
      "This job has been invoiced in QuickBooks, so it's kept for recordkeeping and can't be deleted.",
    );
  }

  // 3. Clean up storage (best-effort), then delete the job row.
  await deleteStoredFilesForJobs([jobId]);

  const { error } = await supabase
    .from('jobs')
    .delete()
    .eq('id', jobId)
    .eq('company_id', companyId);

  if (error) {
    console.error('Error deleting job:', error);
    throw new Error(
      friendlyErrorMessage(error, { entity: 'job', fallback: 'Failed to delete job.' }),
    );
  }
}

/**
 * Bulk cancel jobs. Marks every part of each job as cancelled; the aggregation
 * trigger on job_parts then flips each job's production_status to 'cancelled'.
 * Like cancelJob, this relies on RLS for tenant isolation (job_parts has no
 * company_id column of its own). Reversible per-job via reopenJob.
 */
export async function bulkCancelJobs(jobIds: string[]): Promise<void> {
  if (jobIds.length === 0) return;
  const validIds = jobIds.filter((id) => id && typeof id === 'string');
  if (validIds.length === 0) return;

  const supabase = getSupabase();
  const BATCH_SIZE = 100;
  const nowIso = new Date().toISOString();

  for (let i = 0; i < validIds.length; i += BATCH_SIZE) {
    const batch = validIds.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('job_parts')
      .update({
        production_status: 'cancelled',
        status_changed_at: nowIso,
        updated_at: nowIso,
      })
      .in('job_id', batch);

    if (error) {
      console.error('Error bulk cancelling jobs:', error);
      throw new Error(
        friendlyErrorMessage(error, { entity: 'job', fallback: 'Failed to cancel jobs.' }),
      );
    }
  }
}

/**
 * Mark all of a job's parts as cancelled. The aggregation trigger on
 * job_parts then flips jobs.production_status to 'cancelled'.
 */
export async function cancelJob(jobId: string): Promise<Job> {
  const supabase = getSupabase();

  const { error: partsError } = await supabase
    .from('job_parts')
    .update({
      production_status: 'cancelled',
      status_changed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('job_id', jobId);

  if (partsError) {
    console.error('Error cancelling job parts:', partsError);
    throw partsError;
  }

  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (error) {
    console.error('Error fetching cancelled job:', error);
    throw error;
  }
  return data as Job;
}

/**
 * Reverse a cancellation. For every part on the job, clear the cancelled state
 * by recomputing its production_status from its operations (none started →
 * not_started, some → in_progress, all done → completed; a part with no
 * operations → not_started). The aggregation trigger on job_parts then flips
 * jobs.production_status back off 'cancelled'.
 */
export async function reopenJob(jobId: string): Promise<Job> {
  const supabase = getSupabase();

  const { data: parts, error: partsErr } = await supabase
    .from('job_parts')
    .select('id, started_at, completed_at')
    .eq('job_id', jobId);
  if (partsErr) {
    console.error('Error loading job parts to reopen:', partsErr);
    throw partsErr;
  }
  const partRows = parts ?? [];

  // Operation statuses across all of the job's parts, grouped per part, so we
  // can derive each part's resolved status without the cancelled-skip that the
  // normal recompute path applies.
  const partIds = partRows.map((p) => p.id);
  const opsByPart = new Map<string, string[]>();
  if (partIds.length > 0) {
    const { data: ops, error: opsErr } = await supabase
      .from('job_operations')
      .select('job_part_id, status')
      .in('job_part_id', partIds);
    if (opsErr) {
      console.error('Error loading operations to reopen:', opsErr);
      throw opsErr;
    }
    for (const op of ops ?? []) {
      const list = opsByPart.get(op.job_part_id) ?? [];
      list.push(op.status);
      opsByPart.set(op.job_part_id, list);
    }
  }

  const nowIso = new Date().toISOString();
  for (const part of partRows) {
    const newStatus = deriveStatusFromOps(opsByPart.get(part.id) ?? []);
    const updates: JobPartUpdate = {
      production_status: newStatus,
      status_changed_at: nowIso,
      updated_at: nowIso,
      started_at: newStatus === 'not_started' ? null : part.started_at ?? nowIso,
      completed_at: newStatus === 'completed' ? part.completed_at ?? nowIso : null,
    };
    const { error: updErr } = await supabase
      .from('job_parts')
      .update(updates)
      .eq('id', part.id);
    if (updErr) {
      console.error('Error reopening job part:', updErr);
      throw updErr;
    }
  }

  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('id', jobId)
    .single();
  if (error) {
    console.error('Error fetching reopened job:', error);
    throw error;
  }
  return data as Job;
}

// shipJob deleted in Shipments v2 PR 3. "Shipping" is no longer a
// production-status transition — it's the side effect of creating a
// shipment record against the job's parts. The Mark Shipped button on
// the job detail page is replaced by a "Create Shipment" CTA that opens
// the shipment-create modal (PR 4).

// ============== Operations ==============

/**
 * Get operations for a single job_part, ordered by sequence.
 */
export async function getJobPartOperations(jobPartId: string): Promise<JobOperation[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('job_operations')
    .select(`
      *,
      work_center:work_centers!left(id, name, labor_rate, kind)
    `)
    .eq('job_part_id', jobPartId)
    .order('sequence', { ascending: true });

  if (error) {
    console.error('Error fetching job part operations:', error);
    throw error;
  }
  return (data || []) as JobOperation[];
}

/**
 * Derive a job_part's production_status from its operation statuses:
 * all completed → 'completed', any started → 'in_progress', otherwise
 * 'not_started' (also the result when the part has no operations).
 */
function deriveStatusFromOps(opStatuses: string[]): ProductionStatus {
  if (opStatuses.length === 0) return 'not_started';
  if (opStatuses.every((s) => s === 'completed')) return 'completed';
  if (opStatuses.some((s) => s !== 'pending')) return 'in_progress';
  return 'not_started';
}

/**
 * Recompute a job_part's production_status from its operations and persist
 * the change if it differs. Returns the resolved status and a flag
 * indicating whether it changed. Skips when the part is already cancelled
 * (terminal user-initiated state). Fulfillment is independent and not
 * touched here — it's driven by shipment_line_items in PR 4.
 */
async function recomputeJobPartStatus(
  jobPartId: string,
): Promise<{ changed: boolean; newStatus: ProductionStatus }> {
  const supabase = getSupabase();

  const { data: part, error: partErr } = await supabase
    .from('job_parts')
    .select('production_status, started_at, completed_at')
    .eq('id', jobPartId)
    .single();
  if (partErr || !part) {
    throw partErr || new Error('job_part not found');
  }

  if (part.production_status === 'cancelled') {
    return { changed: false, newStatus: part.production_status as ProductionStatus };
  }

  const { data: ops, error: opsErr } = await supabase
    .from('job_operations')
    .select('status')
    .eq('job_part_id', jobPartId);
  if (opsErr) throw opsErr;
  const opRows = ops ?? [];
  if (opRows.length === 0) {
    return { changed: false, newStatus: part.production_status as ProductionStatus };
  }

  const newStatus = deriveStatusFromOps(opRows.map((o) => o.status));

  if (newStatus === part.production_status) {
    return { changed: false, newStatus };
  }

  const nowIso = new Date().toISOString();
  const updates: JobPartUpdate = {
    production_status: newStatus,
    status_changed_at: nowIso,
    updated_at: nowIso,
  };
  if (newStatus === 'in_progress' && !part.started_at) {
    updates.started_at = nowIso;
  }
  if (newStatus === 'completed' && !part.completed_at) {
    updates.completed_at = nowIso;
  }

  const { error: updErr } = await supabase
    .from('job_parts')
    .update(updates)
    .eq('id', jobPartId);
  if (updErr) {
    console.error('Error updating job_part production_status:', updErr);
    throw updErr;
  }

  return { changed: true, newStatus };
}

/**
 * Snapshot the parent job's production_status before/after a job_part
 * update so the caller can react when the aggregation trigger flips it
 * (e.g., to celebrate the entire job finishing).
 */
async function detectJobStatusChange(
  jobId: string,
  before: ProductionStatus,
): Promise<{ changed: boolean; newStatus?: ProductionStatus }> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('jobs')
    .select('production_status')
    .eq('id', jobId)
    .single();
  if (error || !data) return { changed: false };
  const newStatus = data.production_status as ProductionStatus;
  if (newStatus === before) return { changed: false };
  return { changed: true, newStatus };
}

async function getJobIdForOperation(
  operationId: string,
): Promise<{ jobId: string; jobPartId: string; jobStatus: ProductionStatus }> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('job_operations')
    .select('job_id, job_part_id, jobs(production_status)')
    .eq('id', operationId)
    .single();
  if (error || !data) throw error || new Error('operation not found');
  type OpRow = {
    job_id: string;
    job_part_id: string;
    jobs?: { production_status: string } | { production_status: string }[] | null;
  };
  const row = data as OpRow;
  const jobsField = row.jobs;
  const jobsRow = Array.isArray(jobsField) ? jobsField[0] : jobsField;
  if (!jobsRow) throw new Error('parent job not found');
  return {
    jobId: row.job_id,
    jobPartId: row.job_part_id,
    jobStatus: jobsRow.production_status as ProductionStatus,
  };
}

/**
 * Start a job_operation (pending → in_progress). At most one operation can
 * be in_progress on a single job_part at a time. Auto-flips the job_part's
 * status to 'in_progress'; the trigger then auto-flips the parent job.
 */
export async function startJobOperation(
  operationId: string,
  jobId: string,
): Promise<OperationUpdateResult> {
  const supabase = getSupabase();
  const ctx = await getJobIdForOperation(operationId);
  void jobId; // Caller passes for backward compat; we trust the lookup.

  // Concurrency guard: no other in-progress op on this part.
  const { data: inProgressOps, error: checkError } = await supabase
    .from('job_operations')
    .select('id')
    .eq('job_part_id', ctx.jobPartId)
    .eq('status', 'in_progress');
  if (checkError) {
    console.error('Error checking in-progress operations:', checkError);
    throw checkError;
  }
  if (inProgressOps && inProgressOps.length > 0) {
    throw new Error('Another operation is already in progress on this part. Complete it first.');
  }

  const { data: operation, error: updateError } = await supabase
    .from('job_operations')
    .update({
      status: 'in_progress',
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', operationId)
    .eq('status', 'pending')
    .select(`
      *,
      work_center:work_centers!left(id, name, labor_rate, kind)
    `)
    .single();
  if (updateError) {
    console.error('Error starting operation:', updateError);
    throw updateError;
  }

  const partResult = await recomputeJobPartStatus(ctx.jobPartId);
  const jobResult = await detectJobStatusChange(ctx.jobId, ctx.jobStatus);

  return {
    operation: operation as JobOperation,
    jobPartStatusChanged: partResult.changed,
    newJobPartProductionStatus: partResult.changed ? partResult.newStatus : undefined,
    jobStatusChanged: jobResult.changed,
    newJobProductionStatus: jobResult.newStatus,
  };
}

/**
 * Complete a job_operation with optional notes. Flips the
 * job_part to 'completed' once every op on that part is completed.
 */
export async function completeJobOperation(
  operationId: string,
  jobId: string,
  data: CompleteOperationData = {},
): Promise<OperationUpdateResult> {
  const supabase = getSupabase();
  const ctx = await getJobIdForOperation(operationId);
  void jobId;

  const { data: { user } } = await supabase.auth.getUser();

  const updateData: JobOperationUpdate = {
    status: 'completed',
    completed_at: new Date().toISOString(),
    completed_by: user?.id || null,
    updated_at: new Date().toISOString(),
  };
  if (data.notes !== undefined) updateData.notes = data.notes;

  const { data: operation, error: updateError } = await supabase
    .from('job_operations')
    .update(updateData)
    .eq('id', operationId)
    .eq('status', 'in_progress')
    .select(`
      *,
      work_center:work_centers!left(id, name, labor_rate, kind)
    `)
    .single();
  if (updateError) {
    console.error('Error completing operation:', updateError);
    throw updateError;
  }

  const partResult = await recomputeJobPartStatus(ctx.jobPartId);
  const jobResult = await detectJobStatusChange(ctx.jobId, ctx.jobStatus);

  return {
    operation: operation as JobOperation,
    jobPartStatusChanged: partResult.changed,
    newJobPartProductionStatus: partResult.changed ? partResult.newStatus : undefined,
    jobStatusChanged: jobResult.changed,
    newJobProductionStatus: jobResult.newStatus,
  };
}

/**
 * Undo a completed job_operation back to pending. Clears timestamps and
 * completed_by. Recomputes the parent job_part status (it may
 * fall back to in_progress or not_started).
 */
export async function undoJobOperation(operationId: string): Promise<JobOperation> {
  const supabase = getSupabase();
  const ctx = await getJobIdForOperation(operationId);

  const { data: operation, error } = await supabase
    .from('job_operations')
    .update({
      status: 'pending',
      started_at: null,
      completed_at: null,
      completed_by: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', operationId)
    .eq('status', 'completed')
    .select(`
      *,
      work_center:work_centers!left(id, name, labor_rate, kind)
    `)
    .single();
  if (error) {
    console.error('Error undoing operation:', error);
    throw error;
  }

  await recomputeJobPartStatus(ctx.jobPartId);
  return operation as JobOperation;
}

// ============== Helper Functions ==============

/**
 * Get customers for dropdown (simple list)
 */
export async function getCustomersForSelect(
  companyId: string,
): Promise<Array<{ id: string; name: string }>> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('customers')
    .select('id, name')
    .eq('company_id', companyId)
    .order('name');

  if (error) {
    console.error('Error fetching customers for select:', error);
    throw error;
  }

  return data || [];
}

// ============== Overdue ==============

/**
 * Count jobs that are past their due date and not yet at the FR-18 done
 * state. Done = production_status IN (completed, cancelled) AND
 * fulfillment_status = fully_shipped. Server-side we approximate by
 * excluding the fulfillment half (fully_shipped) — cancelled jobs whose
 * fulfillment isn't fully_shipped are still "live" from the customer's
 * perspective and remain overdue if past due_date.
 */
export async function getOverdueJobsCount(companyId: string): Promise<number> {
  const supabase = getSupabase();

  const { count, error } = await supabase
    .from('jobs')
    .select('*', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .not('due_date', 'is', null)
    .lt('due_date', todayLocalISODate())
    .not('fulfillment_status', 'eq', 'fully_shipped')
    .not('production_status', 'eq', 'cancelled');

  if (error) {
    console.error('Error fetching overdue jobs count:', error);
    throw error;
  }

  return count || 0;
}

/**
 * Fetch overdue jobs for dashboard/list use. Same server-side
 * approximation as getOverdueJobsCount; callers that need the exact
 * FR-18 predicate refine client-side via isJobOverdue.
 */
export async function getOverdueJobs(
  companyId: string,
  limit: number = 50,
): Promise<JobWithRelations[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('jobs')
    .select(`
      *,
      customers!left(id, name),
      job_parts(id, sequence, parts(id, part_name))
    `)
    .eq('company_id', companyId)
    .not('due_date', 'is', null)
    .lt('due_date', todayLocalISODate())
    .not('fulfillment_status', 'eq', 'fully_shipped')
    .not('production_status', 'eq', 'cancelled')
    .order('due_date', { ascending: true })
    .limit(limit);

  if (error) {
    console.error('Error fetching overdue jobs:', error);
    throw error;
  }

  return (data || []) as JobWithRelations[];
}

// ============== Current Operation Batch Query ==============

/**
 * Get ready/current operations for a batch of jobs. Calls
 * get_ready_operations_batch which now scopes the readiness DAG to
 * job_part_id but still returns one row per job_id.
 */
export async function getReadyOperationsForJobs(
  jobIds: string[],
): Promise<Map<string, CurrentOperationInfo>> {
  if (jobIds.length === 0) return new Map();

  const supabase = getSupabase();

  const { data, error } = await supabase.rpc('get_ready_operations_batch', {
    p_job_ids: jobIds,
  });

  if (error) {
    console.error('Error fetching ready operations batch:', error);
    return new Map();
  }

  const result = new Map<string, CurrentOperationInfo>();
  for (const row of data || []) {
    result.set(row.job_id, {
      operationName: row.operation_name,
      readyCount: row.ready_count,
    });
  }

  return result;
}
