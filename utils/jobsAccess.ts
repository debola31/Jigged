// Adopt the typed Supabase client so every .from('jobs').select(...) chain
// is validated against types/database.ts at compile time. Aliased to
// getSupabase so the dozens of call sites below don't need renaming —
// this also keeps the diff small for review. See CLAUDE.md "Typed
// Supabase client (incremental adoption)" for the rollout contract.
import { getSupabase } from '@/lib/supabase';
import { friendlyErrorMessage, toFriendlyError } from '@/lib/supabaseErrors';
import type { Database } from '@/types/database';

// Update payloads for tables this file mutates conditionally. The typed
// `.update(...)` call rejects bare Record<string, unknown> because it
// can't verify the keys against the table schema; using the generated
// Update types preserves the column-name check.
type JobUpdate = Database['public']['Tables']['jobs']['Update'];
type JobInsert = Database['public']['Tables']['jobs']['Insert'];
type JobPartUpdate = Database['public']['Tables']['job_parts']['Update'];
type JobPartInsert = Database['public']['Tables']['job_parts']['Insert'];
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
import { isJobClosed } from '@/types/job';
import type { PricingBasisSnapshot } from '@/types/quote';
import type { FreightTerms } from '@/types/shipment';
import { resolveJobPartUnitPrice, type JobPartPricingBasis } from '@/utils/quotePricingResolver';
import { getJobPartShipmentSummaries } from '@/utils/shipmentsAccess';
import { orIlikeValue } from '@/utils/searchFilter';
import { getJobPartInvoiceSummaries } from '@/utils/quickbooksAccess';
import {
  createOperationCompletion,
  voidAllOperationCompletions,
} from '@/utils/operationCompletionsAccess';

/** PostgREST embeds a to-one relation as either the object or a 1-element array. */
function firstRelation<T>(rel: T | T[]): T {
  return Array.isArray(rel) ? rel[0] : rel;
}

/**
 * Derive a job_part's production_status from its operation statuses (SQL mirror
 * of compute_job_part_production_status): all completed → 'completed', any
 * started → 'in_progress', otherwise 'not_started' (also when there are no ops).
 * Used by the job-reactivate flow, which reopens parts without the cancelled-skip
 * the trigger applies. The routine completion path is DB-trigger-driven.
 */
export function deriveStatusFromOps(opStatuses: string[]): ProductionStatus {
  if (opStatuses.length === 0) return 'not_started';
  if (opStatuses.every((s) => s === 'completed')) return 'completed';
  if (opStatuses.some((s) => s !== 'pending')) return 'in_progress';
  return 'not_started';
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

/**
 * The single server-side definition of "overdue" for a jobs query: due date set
 * and in the past (local date, via todayLocalISODate), production still active
 * (not_started or in_progress), and not fully shipped. Shared by the jobs-list
 * "overdue only" filter (getAllJobs) and the dashboard overdue-count metric so
 * the two SQL queries can't drift — including agreeing on the day boundary
 * (local date, not a UTC timestamp). The client-side mirror, applied per-row for
 * the overdue icon/badge, is isJobOverdue() in types/job.ts.
 *
 * Typed structurally (method syntax) so it accepts both the untyped and typed
 * Supabase filter builders and returns the same builder for further chaining.
 */
export function applyOverdueJobsFilter<
  Q extends {
    not(column: string, operator: string, value: unknown): Q;
    lt(column: string, value: unknown): Q;
    in(column: string, values: readonly unknown[]): Q;
  },
>(query: Q): Q {
  return query
    .not('due_date', 'is', null)
    .lt('due_date', todayLocalISODate())
    .not('fulfillment_status', 'eq', 'fully_shipped')
    .in('production_status', ['not_started', 'in_progress']);
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
      .is('deleted_at', null)
      // Hot jobs float to the top as a primary tier, with the caller's chosen
      // column sort applied within each tier. Chained .order() calls apply in
      // sequence, and the batch loop concatenates in query order, so this holds
      // across the full result set.
      .order('is_hot', { ascending: false })
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
      query = query.or(`job_number.ilike.${orIlikeValue(filters.search.trim())}`);
    }
    if (filters.overdue) {
      // Single source of truth for the overdue predicate — see
      // applyOverdueJobsFilter (mirrors client isJobOverdue + dashboard count).
      query = applyOverdueJobsFilter(query);
    }

    const { data, error } = await query;
    if (error) {
      console.error('Error fetching jobs batch:', error);
      throw error;
    }

    allData = [...allData, ...((data || []) as unknown as JobWithRelations[])];
    hasMore = (data?.length || 0) === BATCH_SIZE;
    offset += BATCH_SIZE;
  }

  // Hide "closed" jobs (done OR cancelled — see isJobClosed) client-side so
  // callers that don't pass explicit status filters still get a clean active
  // list by default. Callers that want closed jobs pass excludeClosed=false
  // (the jobs list sets this from the "Show completed & cancelled" toggle or
  // when a closed lifecycle stage is selected).
  const excludeClosed = filters.excludeClosed ?? true;
  if (excludeClosed) {
    allData = allData.filter((j) => !isJobClosed(j));
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
        customer_contacts(id, name, role, email, phone, is_primary, is_billing_default, deleted_at),
        addresses:customer_addresses(
          id,
          address_line1, address_line2, city, state, postal_code, country,
          default_billing, default_shipping, attention_to
        ),
        carrier_accounts:customer_carrier_accounts(
          id, carrier, bill_to_party, account_number, account_postal_code,
          account_country_code, notes, deleted_at
        )
      ),
      quotes!jobs_quote_id_fkey(id, quote_number),
      job_parts(
        *,
        parts(id, part_name, description),
        job_operations(
          *,
          work_center:work_centers!left(id, name, labor_rate, kind, vendor:vendors(id, name))
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

  // Resolve who completed each operation (job_operations.completed_by → member name)
  // so the page can show attribution, not just the timestamp. One batched query.
  const completerIds = new Set<string>();
  for (const part of job.job_parts ?? []) {
    for (const op of part.job_operations ?? []) {
      if (op.completed_by) completerIds.add(op.completed_by);
    }
  }
  if (completerIds.size > 0) {
    const { data: members } = await supabase
      .from('user_company_access')
      .select('user_id, name')
      .eq('company_id', companyId)
      .in('user_id', Array.from(completerIds));
    const nameByUser = new Map<string, string | null>();
    for (const m of (members ?? []) as Array<{ user_id: string; name: string | null }>) {
      nameByUser.set(m.user_id, m.name);
    }
    for (const part of job.job_parts ?? []) {
      for (const op of part.job_operations ?? []) {
        op.completed_by_name = op.completed_by ? nameByUser.get(op.completed_by) ?? null : null;
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
    // Freight rides along with the address/contact save because it is the same
    // card and the same customer-match trigger guards it: the trigger now also
    // rejects a carrier account belonging to a different customer, which is what
    // stops us billing freight to the wrong company.
    freight_terms?: FreightTerms | null;
    customer_carrier_account_id?: string | null;
    ship_via?: string | null;
    shipping_instructions?: string | null;
  },
): Promise<Job> {
  const supabase = getSupabase();

  const toNull = (v: string | null | undefined): string | null | undefined =>
    v === undefined ? undefined : v === '' ? null : v;

  const patch: JobUpdate = {
    billing_address_id: toNull(fields.billing_address_id),
    shipping_address_id: toNull(fields.shipping_address_id),
    contact_id: toNull(fields.contact_id),
    freight_terms: fields.freight_terms === undefined ? undefined : fields.freight_terms,
    customer_carrier_account_id: toNull(fields.customer_carrier_account_id),
    ship_via: toNull(fields.ship_via),
    shipping_instructions: toNull(fields.shipping_instructions),
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
  fields: { customer_po_number?: string | null; due_date?: string | null; is_hot?: boolean },
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
  // Hot toggle — the office-side "mark/unmark Hot" control writes through here.
  if (fields.is_hot !== undefined) {
    patch.is_hot = fields.is_hot;
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
  /** Mark the new job "Hot" (rush) at creation. Visibility only. Defaults to false. */
  hot?: boolean;
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

  // Pre-flight (the "existing parts only" gate): only MADE parts must already
  // have a routing. Bought parts are purchased, not manufactured — they have no
  // routing and become a job_part with no operations (production-complete on
  // creation), ready to ship + invoice. Fail fast only for a made part missing
  // its routing.
  const partIds = Array.from(partLineCounts.keys());
  const { data: partRows, error: partsErr } = await supabase
    .from('parts')
    .select('id, source')
    .eq('company_id', companyId)
    .in('id', partIds);
  if (partsErr) {
    console.error('Error fetching part sources:', partsErr);
    throw partsErr;
  }
  const sourceByPart = new Map(
    ((partRows ?? []) as Array<{ id: string; source: string }>).map((p) => [p.id, p.source]),
  );
  const isBoughtPart = (partId: string) => sourceByPart.get(partId) === 'bought';
  const madePartIds = partIds.filter((pid) => !isBoughtPart(pid));

  const { data: routings, error: routingsErr } = await supabase
    .from('routings')
    .select('id, part_id')
    .eq('company_id', companyId)
    .in('part_id', madePartIds);
  if (routingsErr) {
    console.error('Error fetching routings:', routingsErr);
    throw routingsErr;
  }
  const routingByPart = new Map<string, string>();
  for (const r of (routings ?? []) as Array<{ id: string; part_id: string }>) {
    routingByPart.set(r.part_id, r.id);
  }
  const missingRoutingPartIds = madePartIds.filter((pid) => !routingByPart.has(pid));
  if (missingRoutingPartIds.length > 0) {
    throw new Error(
      `No routing defined for ${missingRoutingPartIds.length} made part${
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
    is_hot: input.hot ?? false,
    due_date: input.due_date || null,
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
  const jobPartNowIso = new Date().toISOString();
  let sequence = 10;
  for (const line of lines) {
    const isBought = isBoughtPart(line.part_id);
    const routingId = routingByPart.get(line.part_id);
    if (!isBought && !routingId) {
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
      // A bought part is purchased, not manufactured — no operations to run, so
      // its production is complete on creation (ready to ship + invoice).
      production_status: isBought ? 'completed' : 'not_started',
      fulfillment_status: 'unshipped',
      ...(isBought ? { started_at: jobPartNowIso, completed_at: jobPartNowIso } : {}),
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

    // Made parts clone their routing into operations + materials; bought parts
    // have nothing to clone.
    if (!isBought && routingId) {
      const { error: rpcErr } = await supabase.rpc('create_job_part_operations_from_routing', {
        p_job_part_id: jobPart.id,
        p_routing_id: routingId,
      });
      if (rpcErr) {
        console.error('Failed to copy operations from routing:', rpcErr);
        throw new Error('Job created but failed to copy operations from routing.');
      }
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

// JobPartPricingBasis + resolveJobPartUnitPrice moved to quotePricingResolver
// (pure pricing, no DB deps) so UI previews can import them without pulling in
// this DB-access module. Imported above for internal use; re-exported here for
// existing consumers that import them from jobsAccess.
export { resolveJobPartUnitPrice };
export type { JobPartPricingBasis };

// job_parts.total_price is numeric(12,4); round the recompute to 4dp to match
// the convert/PO write paths (calculateTotalPrice rounds to 2dp — too coarse
// here, it would make an edited line inconsistent with its siblings).
const roundTotal4dp = (n: number): number => Math.round(n * 10000) / 10000;

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
 *  - cannot reduce below max(already-shipped, already-invoiced) for the part.
 *    Increases are always allowed even on an invoiced job — that's how a job grows
 *    to bill more (10 -> 15 to invoice the extra 6 on a NEW invoice). The
 *    invoiced-floor only bites when a shipment was voided AFTER invoicing, leaving
 *    invoiced > shipped; reducing below the invoiced qty needs a QuickBooks credit.
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

  // 2. Floor guard: can't drop below what's already committed downstream —
  //    max(shipped, invoiced). Increases are always allowed (invoicing more is done
  //    by raising the order then billing the delta on a new invoice). invoiced can
  //    exceed shipped only when a shipment was voided after invoicing.
  const [shipSummaries, invSummaries] = await Promise.all([
    getJobPartShipmentSummaries(part.job_id),
    getJobPartInvoiceSummaries(part.job_id),
  ]);
  const qtyShipped = shipSummaries.find((s) => s.job_part_id === jobPartId)?.qty_shipped ?? 0;
  const qtyInvoiced = invSummaries.find((s) => s.job_part_id === jobPartId)?.qty_invoiced ?? 0;
  const floor = Math.max(qtyShipped, qtyInvoiced);
  if (newQuantity < floor) {
    throw new Error(
      qtyInvoiced > qtyShipped
        ? `Cannot set quantity to ${newQuantity} — ${qtyInvoiced} have already been invoiced on ` +
          'this part. Credit or void that invoice in QuickBooks first.'
        : `Cannot set quantity to ${newQuantity} — ${qtyShipped} have already shipped on this part. ` +
          'Void a packing slip first to ship fewer.',
    );
  }

  // 3. Re-resolve price (keep agreed by default; cross a tier only on opt-in).
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

  // 4. Single write. fulfillment_status + invoicing_status handled by DB triggers.
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
 *  - blocked once ANY quantity of this part has been invoiced — a per-PART price
 *    lock (each invoice froze its own price snapshot; the order total must stay a
 *    faithful revenue figure). Untouched parts on a partially-invoiced job stay
 *    repriceable. Repricing an invoiced part is a QuickBooks credit/reissue.
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

  // 2. Price-lock gate (per-part): once ANY quantity of this part is invoiced, its
  //    price is frozen. Untouched parts on a partially-invoiced job stay repriceable.
  const invSummaries = await getJobPartInvoiceSummaries(part.job_id);
  const qtyInvoiced = invSummaries.find((s) => s.job_part_id === jobPartId)?.qty_invoiced ?? 0;
  if (qtyInvoiced > 0) {
    throw new Error(
      'This part has been invoiced, so its price is locked. Credit or reissue the invoice in ' +
        'QuickBooks to change what was billed.',
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
 * Archive a job ("Delete" in the UI). Never blocked by references, and never
 * gated by production status: the row and ALL of its history — shipments,
 * QuickBooks invoices, child job_parts / operations / materials, notes, and
 * attachment files — survive untouched. Archiving just stamps deleted_at, which
 * hides the job from the active jobs list (reads filter deleted_at IS NULL)
 * while a direct link to it still resolves and every downstream reference
 * (shipments, invoices, child jobs) keeps resolving. Because nothing is
 * destroyed, there are no records-of-value guards — archiving is always safe.
 */
export async function deleteJob(jobId: string, companyId: string): Promise<void> {
  const supabase = getSupabase();

  // Existence + tenant scope. No shipment/invoice guards: archiving preserves
  // the row and its history, so it can never orphan a record.
  const { data: jobRow, error: loadErr } = await supabase
    .from('jobs')
    .select('id')
    .eq('id', jobId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (loadErr) {
    console.error('Error loading job for archive:', loadErr);
    throw new Error(
      friendlyErrorMessage(loadErr, { entity: 'job', fallback: 'Failed to load job.' }),
    );
  }
  if (!jobRow) {
    throw new Error('Job not found.');
  }

  const { error } = await supabase
    .from('jobs')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('company_id', companyId);

  if (error) {
    console.error('Error archiving job:', error);
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
      work_center:work_centers!left(id, name, labor_rate, kind, vendor:vendors(id, name))
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
 * Complete a job_operation for a quantity of good pieces. Records a
 * job_operation_completions event; a DB trigger derives job_operations.status
 * (pending → in_progress → completed at the ordered qty) and cascades
 * job_parts.production_status → jobs.production_status.
 *
 * `data.quantityGood` records a partial (admin partial-completion). Omitted →
 * completes the whole remaining balance (the one-click "complete" default,
 * mirroring the operator view). `data.notes` is stored both on the event and on
 * job_operations.notes (the admin completion note shown on the op row).
 *
 * Over-completion is allowed (only quantity_good > 0 is enforced in the DB).
 * Returns the resulting op plus whether the part/job status changed, so the UI
 * can celebrate a finished part or job.
 */
export async function completeJobOperation(
  operationId: string,
  jobId: string,
  data: CompleteOperationData = {},
): Promise<OperationUpdateResult> {
  const supabase = getSupabase();
  void jobId;

  // Context: ids + company + ordered qty (target) + before-statuses (to detect
  // the trigger-driven part/job transitions this completion causes) + work-center
  // kind (to reject outside ops).
  const { data: opCtx, error: ctxErr } = await supabase
    .from('job_operations')
    .select(
      'id, job_id, job_part_id, job_parts!inner(company_id, quantity, production_status), jobs!inner(production_status), work_center:work_centers(kind)',
    )
    .eq('id', operationId)
    .single();
  if (ctxErr || !opCtx) throw ctxErr || new Error('operation not found');

  // Outside (external-vendor) ops can NEVER be completed through this internal
  // path — they go through the send/receive lifecycle
  // (operatorAccess.markOperationReceived). See docs/modules/jobs.md.
  const opWc = firstRelation(
    (opCtx as unknown as { work_center: { kind: string } | { kind: string }[] | null }).work_center ?? { kind: 'internal' },
  );
  if (opWc?.kind === 'external') {
    throw new Error(
      'This is an outside (vendor) operation — use Mark Received, not Complete.',
    );
  }
  const part = firstRelation(
    (opCtx as unknown as {
      job_parts:
        | { company_id: string; quantity: number; production_status: string }
        | { company_id: string; quantity: number; production_status: string }[];
    }).job_parts,
  );
  const jobBefore = firstRelation(
    (opCtx as unknown as {
      jobs: { production_status: string } | { production_status: string }[];
    }).jobs,
  );
  const partStatusBefore = part.production_status as ProductionStatus;
  const jobStatusBefore = jobBefore.production_status as ProductionStatus;

  // Good already recorded (non-void) → remaining is the default fill.
  const { data: comps } = await supabase
    .from('job_operation_completions')
    .select('quantity_good')
    .eq('job_operation_id', operationId)
    .is('voided_at', null);
  const good = (comps ?? []).reduce((acc, c) => acc + Number(c.quantity_good), 0);
  const remaining = Math.max(0, Number(part.quantity) - good);
  const qtyGood = data.quantityGood != null ? data.quantityGood : remaining;

  if (qtyGood > 0) {
    await createOperationCompletion({
      companyId: part.company_id,
      jobOperationId: operationId,
      jobPartId: opCtx.job_part_id,
      quantityGood: qtyGood,
      note: data.notes ?? null,
    });
  }
  if (data.notes !== undefined) {
    // Checked: postgrest-js resolves with `{ error }` rather than rejecting, so an
    // un-destructured await threw the note away silently on any write failure.
    const { error: notesError } = await supabase
      .from('job_operations')
      .update({ notes: data.notes, updated_at: new Date().toISOString() })
      .eq('id', operationId);
    if (notesError) {
      throw toFriendlyError(notesError, {
        entity: 'note',
        fallback: 'Failed to save the operation note.',
      });
    }
  }

  // Read back the op + resulting statuses (the trigger already cascaded).
  const { data: operation, error: opErr } = await supabase
    .from('job_operations')
    .select(`
      *,
      work_center:work_centers!left(id, name, labor_rate, kind, vendor:vendors(id, name))
    `)
    .eq('id', operationId)
    .single();
  if (opErr) throw opErr;

  const { data: partAfter } = await supabase
    .from('job_parts')
    .select('production_status')
    .eq('id', opCtx.job_part_id)
    .single();
  const { data: jobAfter } = await supabase
    .from('jobs')
    .select('production_status')
    .eq('id', opCtx.job_id)
    .single();

  const newPart = partAfter?.production_status as ProductionStatus | undefined;
  const newJob = jobAfter?.production_status as ProductionStatus | undefined;
  const partChanged = !!newPart && newPart !== partStatusBefore;
  const jobChanged = !!newJob && newJob !== jobStatusBefore;

  return {
    operation: operation as JobOperation,
    jobPartStatusChanged: partChanged,
    newJobPartProductionStatus: partChanged ? newPart : undefined,
    jobStatusChanged: jobChanged,
    newJobProductionStatus: jobChanged ? newJob : undefined,
  };
}

/**
 * Undo a job_operation's completion entirely — void every non-void completion
 * event on it. The recompute trigger derives the op back to pending and cascades
 * the part/job status. Quantities are never deleted (events stay voided). Returns
 * the resulting op.
 */
export async function undoJobOperation(operationId: string): Promise<JobOperation> {
  const supabase = getSupabase();

  // Outside (external-vendor) ops step back through their own lifecycle
  // (operatorAccess.revertOperationCompletion: received → sent → pending), never
  // this internal completion-void path. The UI routes them there; guard anyway.
  const { data: wcRow } = await supabase
    .from('job_operations')
    .select('work_center:work_centers(kind)')
    .eq('id', operationId)
    .single();
  const undoWc = firstRelation(
    (wcRow as unknown as { work_center: { kind: string } | { kind: string }[] | null } | null)
      ?.work_center ?? { kind: 'internal' },
  );
  if (undoWc?.kind === 'external') {
    throw new Error(
      'This is an outside (vendor) operation — undo it from its send/receive controls.',
    );
  }

  await voidAllOperationCompletions(operationId);

  const { data: operation, error } = await supabase
    .from('job_operations')
    .select(`
      *,
      work_center:work_centers!left(id, name, labor_rate, kind, vendor:vendors(id, name))
    `)
    .eq('id', operationId)
    .single();
  if (error) {
    console.error('Error reading operation after undo:', error);
    throw error;
  }
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
