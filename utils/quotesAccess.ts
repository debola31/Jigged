import * as Sentry from '@sentry/nextjs';
import { getSupabase } from '@/lib/supabase';
import type {
  Quote,
  QuoteWithRelations,
  QuoteFormData,
  QuoteFilters,
  QuoteCostBreakdown,
  QuoteOperationSnapshot,
  QuoteMaterialSnapshot,
  QuotePartCostBreakdown,
  QuoteLineItem,
  CompanyMember,
} from '@/types/quote';
import { isQuoteExpired } from '@/types/quote';
import { calculateRoutingCost } from '@/utils/routingCostCalculation';
import { getCompanyMembers } from '@/utils/companyAccess';
import { getTiersForPart } from '@/utils/partPricingTiersAccess';
import { insertLineItemForPart, getLineItemsForQuote } from '@/utils/quoteLineItemsAccess';

/**
 * Sanitize search string for use in LIKE/ILIKE queries
 * Escapes SQL wildcards to prevent unintended pattern matching
 */
function sanitizeSearchString(search: string): string {
  return search
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
    .substring(0, 100);
}

/**
 * Metadata on a quote stays editable while the quote is still active
 * and has no jobs spawned from it yet. Line items are immutable once created.
 */
function isQuoteEditable(row: { status: string; converted_at: string | null | undefined }): boolean {
  return row.status === 'active' && (row.converted_at === null || row.converted_at === undefined);
}

/**
 * Attach the creator's profile to each quote using the company member directory.
 */
function hydrateCreators<T extends QuoteWithRelations>(
  rows: T[],
  members: CompanyMember[],
): T[] {
  const map = new Map<string, CompanyMember>();
  for (const m of members) map.set(m.user_id, m);
  for (const row of rows) {
    row.created_by_member = row.created_by ? map.get(row.created_by) ?? null : null;
  }
  return rows;
}

// ============== CRUD Operations ==============

const QUOTE_LINE_ITEM_FIELDS = `
  id, quote_id, company_id, part_id, source_tier_id, sequence,
  quantity, unit_price, total_price, markup_percent, base_cost_per_unit,
  is_quote_override, created_at,
  parts(id, part_name, description)
`;

const QUOTE_LIST_SELECT = `
  *,
  customers!left(id, name),
  line_items:quote_line_items!left(${QUOTE_LINE_ITEM_FIELDS}),
  jobs!left(id, job_number, status)
`;

const QUOTE_DETAIL_SELECT = `
  *,
  customers!left(id, name, website, contact_name, contact_phone, contact_email, address_line1, address_line2, city, state, postal_code, country),
  line_items:quote_line_items!left(${QUOTE_LINE_ITEM_FIELDS}),
  jobs!left(id, job_number, status)
`;

/**
 * Get paginated list of quotes for a company
 */
export async function getQuotes(
  companyId: string,
  filters: QuoteFilters = {},
  page: number = 1,
  limit: number = 25,
  sortField: string = 'created_at',
  sortDirection: 'asc' | 'desc' = 'desc',
): Promise<{ data: QuoteWithRelations[]; total: number }> {
  const supabase = getSupabase();
  const offset = (page - 1) * limit;

  let query = supabase
    .from('quotes')
    .select(QUOTE_LIST_SELECT, { count: 'exact' })
    .eq('company_id', companyId)
    .order(sortField, { ascending: sortDirection === 'asc' })
    .range(offset, offset + limit - 1);

  if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status);
  if (filters.customerId) query = query.eq('customer_id', filters.customerId);
  if (filters.createdBy) query = query.eq('created_by', filters.createdBy);
  if (filters.search?.trim()) {
    const sanitized = sanitizeSearchString(filters.search.trim());
    query = query.ilike('quote_number', `%${sanitized}%`);
  }

  const [{ data, error, count }, members] = await Promise.all([
    query,
    getCompanyMembers(companyId).catch((err) => {
      console.warn('getCompanyMembers failed; creator names will be blank:', err);
      return [] as CompanyMember[];
    }),
  ]);

  if (error) {
    console.error('Error fetching quotes:', error);
    throw error;
  }

  const rows = hydrateCreators((data || []) as QuoteWithRelations[], members);
  return { data: rows, total: count || 0 };
}

/**
 * Get all quotes for a company (no pagination).
 * Fetches in batches of 1000 to bypass Supabase's default row limit.
 */
export async function getAllQuotes(
  companyId: string,
  filters: QuoteFilters = {},
  sortField: string = 'created_at',
  sortDirection: 'asc' | 'desc' = 'desc',
): Promise<QuoteWithRelations[]> {
  const supabase = getSupabase();
  const BATCH_SIZE = 1000;
  let allData: QuoteWithRelations[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    let query = supabase
      .from('quotes')
      .select(QUOTE_LIST_SELECT)
      .eq('company_id', companyId)
      .order(sortField, { ascending: sortDirection === 'asc' })
      .range(offset, offset + BATCH_SIZE - 1);

    if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status);
    if (filters.customerId) query = query.eq('customer_id', filters.customerId);
    if (filters.createdBy) query = query.eq('created_by', filters.createdBy);
    if (filters.search?.trim()) {
      const sanitized = sanitizeSearchString(filters.search.trim());
      query = query.ilike('quote_number', `%${sanitized}%`);
    }

    const { data, error } = await query;
    if (error) {
      console.error('Error fetching quotes batch:', error);
      throw error;
    }

    allData = [...allData, ...((data || []) as QuoteWithRelations[])];
    hasMore = (data?.length || 0) === BATCH_SIZE;
    offset += BATCH_SIZE;
  }

  const members = await getCompanyMembers(companyId).catch((err) => {
    console.warn('getCompanyMembers failed; creator names will be blank:', err);
    return [] as CompanyMember[];
  });
  return hydrateCreators(allData, members);
}

/**
 * Get total count of quotes for a company
 */
export async function getQuotesCount(
  companyId: string,
  filters: QuoteFilters = {},
): Promise<number> {
  const supabase = getSupabase();

  let query = supabase
    .from('quotes')
    .select('*', { count: 'exact', head: true })
    .eq('company_id', companyId);

  if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status);
  if (filters.customerId) query = query.eq('customer_id', filters.customerId);
  if (filters.search?.trim()) {
    const sanitized = sanitizeSearchString(filters.search.trim());
    query = query.ilike('quote_number', `%${sanitized}%`);
  }

  const { count, error } = await query;
  if (error) {
    console.error('Error fetching quotes count:', error);
    throw error;
  }
  return count || 0;
}

/**
 * Lazy-expire sweep: flips any active quote whose expiration_date has passed to 'expired'.
 */
export async function sweepExpiredQuotes(companyId: string): Promise<void> {
  const supabase = getSupabase();
  const today = new Date().toISOString().slice(0, 10);
  const { error } = await supabase
    .from('quotes')
    .update({ status: 'expired', status_changed_at: new Date().toISOString() })
    .eq('company_id', companyId)
    .eq('status', 'active')
    .lt('expiration_date', today);

  if (error) {
    console.warn('sweepExpiredQuotes failed:', error);
    Sentry.captureException(error, { level: 'warning' });
  }
}

/**
 * Get a single quote by ID (header only)
 */
export async function getQuote(quoteId: string, companyId: string): Promise<Quote | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('quotes')
    .select('*')
    .eq('id', quoteId)
    .eq('company_id', companyId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching quote:', error);
    throw error;
  }
  return data;
}

/**
 * Get a quote with all relations (line items, customer, jobs, attachments)
 */
export async function getQuoteWithRelations(
  quoteId: string,
  companyId: string,
): Promise<QuoteWithRelations | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('quotes')
    .select(QUOTE_DETAIL_SELECT)
    .eq('id', quoteId)
    .eq('company_id', companyId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching quote with relations:', error);
    throw error;
  }
  if (!data) return null;

  const quote = data as QuoteWithRelations;
  if (quote.created_by) {
    const { data: member } = await supabase
      .from('user_company_access')
      .select('user_id, name, email')
      .eq('company_id', companyId)
      .eq('user_id', quote.created_by)
      .maybeSingle();
    quote.created_by_member = (member as CompanyMember | null) ?? null;
  } else {
    quote.created_by_member = null;
  }

  // Sort line items by sequence for deterministic rendering
  if (quote.line_items) {
    quote.line_items = [...quote.line_items].sort((a, b) => a.sequence - b.sequence);
  }

  return quote;
}

/**
 * Create a new quote with one line item per part. The unit price is auto-resolved
 * from the part's pricing tiers at the chosen order quantity (or hand-entered via
 * an override). Also writes per-part cost snapshots into quote_operations +
 * quote_materials.
 */
export async function createQuote(
  companyId: string,
  formData: QuoteFormData,
): Promise<{ quote: Quote }> {
  const supabase = getSupabase();

  if (!formData.parts || formData.parts.length === 0) {
    throw new Error('A quote must include at least one part.');
  }
  const seenPartsForValidation = new Set<string>();
  for (const block of formData.parts) {
    if (!block.part_id) throw new Error('Every part selection must reference a real part.');
    if (seenPartsForValidation.has(block.part_id)) {
      throw new Error('A part can only appear once on a quote — adjust the order quantity instead of duplicating it.');
    }
    seenPartsForValidation.add(block.part_id);
    if (!Number.isFinite(block.order_quantity) || block.order_quantity <= 0) {
      throw new Error('Every part needs an order quantity greater than zero.');
    }
  }

  const leadTimeDays = formData.lead_time_days ? parseInt(formData.lead_time_days, 10) : null;
  if (leadTimeDays !== null && (isNaN(leadTimeDays) || leadTimeDays < 0 || leadTimeDays > 3650)) {
    throw new Error('Lead time must be between 0 and 3,650 days');
  }

  const expirationDate = formData.expiration_date || null;

  const { data: { user } } = await supabase.auth.getUser();

  const { data: quote, error } = await supabase
    .from('quotes')
    .insert({
      company_id: companyId,
      customer_id: formData.customer_id,
      lead_time_days: leadTimeDays,
      expiration_date: expirationDate,
      status: 'active',
      created_by: user?.id ?? null,
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating quote:', error);
    throw error;
  }

  // Snapshot one line item per part (auto-resolving the tier from order qty)
  // and write per-part cost snapshots.
  let sequence = 10;

  for (const block of formData.parts) {
    const tiers = await getTiersForPart(block.part_id);
    await insertLineItemForPart(
      quote.id,
      companyId,
      block.part_id,
      block.order_quantity,
      tiers,
      sequence,
      block.override,
    );
    sequence += 10;

    try {
      await writeCostSnapshotsForPart(quote.id, companyId, block.part_id);
    } catch (snapshotError) {
      console.warn('Failed to write cost snapshot for part:', block.part_id, snapshotError);
      Sentry.captureException(snapshotError, { level: 'warning' });
    }
  }

  return { quote };
}

/**
 * Update a quote's metadata (customer, lead time, expiration, notes).
 * Line items are immutable snapshots — to change parts/tiers, create a new quote.
 */
export async function updateQuote(quoteId: string, formData: QuoteFormData): Promise<Quote> {
  const supabase = getSupabase();

  const { data: existing, error: checkError } = await supabase
    .from('quotes')
    .select('status, converted_at, company_id')
    .eq('id', quoteId)
    .single();

  if (checkError) {
    console.error('Error checking quote:', checkError);
    throw checkError;
  }

  if (!isQuoteEditable(existing)) {
    throw new Error('This quote cannot be edited. Expired or converted quotes are read-only.');
  }

  const leadTimeDays = formData.lead_time_days ? parseInt(formData.lead_time_days, 10) : null;
  if (leadTimeDays !== null && (isNaN(leadTimeDays) || leadTimeDays < 0 || leadTimeDays > 3650)) {
    throw new Error('Lead time must be between 0 and 3,650 days');
  }

  const { data, error } = await supabase
    .from('quotes')
    .update({
      customer_id: formData.customer_id,
      lead_time_days: leadTimeDays,
      expiration_date: formData.expiration_date || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', quoteId)
    .select()
    .single();

  if (error) {
    console.error('Error updating quote:', error);
    throw error;
  }

  return data;
}

/**
 * Delete a quote (cascades to its line items and cost snapshots).
 */
export async function deleteQuote(quoteId: string, companyId: string): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase
    .from('quotes')
    .delete()
    .eq('id', quoteId)
    .eq('company_id', companyId);

  if (error) {
    console.error('Error deleting quote:', error);
    throw error;
  }
}

/**
 * Bulk delete quotes.
 */
export async function bulkDeleteQuotes(quoteIds: string[], companyId: string): Promise<void> {
  if (quoteIds.length === 0) return;
  const validIds = quoteIds.filter((id) => id && typeof id === 'string');
  if (validIds.length === 0) return;

  const supabase = getSupabase();

  const BATCH_SIZE = 100;
  for (let i = 0; i < validIds.length; i += BATCH_SIZE) {
    const batch = validIds.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('quotes')
      .delete()
      .in('id', batch)
      .eq('company_id', companyId);

    if (error) {
      if (error.code === '23503') {
        throw new Error('Cannot delete some quotes because they have associated jobs.');
      }
      if (error.code === '42501' || error.message?.includes('policy')) {
        throw new Error('Permission denied. You may not have permission to delete these quotes.');
      }
      console.error('Error bulk deleting quotes:', error);
      throw new Error(error.message || 'Failed to delete quotes');
    }
  }
}

// ============== Cost Breakdown Snapshots ==============

/**
 * Write (or overwrite) per-op + per-material cost snapshots for a single
 * (quote, part) pair using the live routing. Multi-part quotes call this
 * once per distinct part.
 */
async function writeCostSnapshotsForPart(
  quoteId: string,
  companyId: string,
  partId: string,
): Promise<void> {
  const supabase = getSupabase();

  const breakdown = await calculateRoutingCost(partId);
  if (!breakdown) return;

  // Clear existing snapshot rows for this (quote, part) — idempotent.
  await supabase.from('quote_operations').delete().eq('quote_id', quoteId).eq('part_id', partId);
  await supabase.from('quote_materials').delete().eq('quote_id', quoteId).eq('part_id', partId);

  if (breakdown.labor_items.length > 0) {
    const opRows = breakdown.labor_items.map((item, index) => ({
      quote_id: quoteId,
      company_id: companyId,
      part_id: partId,
      sequence: index,
      operation_name: item.operation_name,
      run_time_minutes: item.run_time_minutes,
      setup_time_minutes: item.setup_time_minutes,
      labor_rate: item.labor_rate,
      run_cost: item.cost,
      setup_cost: item.setup_cost,
    }));
    const { error } = await supabase.from('quote_operations').insert(opRows);
    if (error) throw error;
  }

  if (breakdown.material_items.length > 0) {
    const matRows = breakdown.material_items.map((item, index) => ({
      quote_id: quoteId,
      company_id: companyId,
      part_id: partId,
      sequence: index,
      inventory_item_id: null,
      item_name: item.item_name,
      quantity: item.quantity,
      unit: item.unit,
      cost_per_unit: item.cost_per_unit,
      line_cost: item.cost,
    }));
    const { error } = await supabase.from('quote_materials').insert(matRows);
    if (error) throw error;
  }
}

/**
 * Read the full cost breakdown for a quote, one section per distinct part
 * plus the snapshotted line items. Snapshot tables are the single source of truth.
 */
export async function getQuoteCostBreakdown(
  quoteId: string,
  _companyId: string,
): Promise<QuoteCostBreakdown | null> {
  const supabase = getSupabase();

  const [opsResp, matsResp, lineItems] = await Promise.all([
    supabase
      .from('quote_operations')
      .select('*')
      .eq('quote_id', quoteId)
      .order('sequence', { ascending: true }),
    supabase
      .from('quote_materials')
      .select('*')
      .eq('quote_id', quoteId)
      .order('sequence', { ascending: true }),
    getLineItemsForQuote(quoteId),
  ]);

  if (opsResp.error) throw opsResp.error;
  if (matsResp.error) throw matsResp.error;

  const operations = (opsResp.data || []) as QuoteOperationSnapshot[];
  const materials = (matsResp.data || []) as QuoteMaterialSnapshot[];

  const partIds = new Set<string>();
  for (const o of operations) partIds.add(o.part_id);
  for (const m of materials) partIds.add(m.part_id);
  for (const li of lineItems) partIds.add(li.part_id);

  const parts: QuotePartCostBreakdown[] = [];
  for (const partId of partIds) {
    const partOps = operations.filter((o) => o.part_id === partId);
    const partMats = materials.filter((m) => m.part_id === partId);

    const totalRunCost = partOps.reduce((sum, o) => sum + (o.run_cost ?? 0), 0);
    const totalSetupCost = partOps.reduce((sum, o) => sum + (o.setup_cost ?? 0), 0);
    const totalMaterialCost = partMats.reduce((sum, m) => sum + (m.line_cost ?? 0), 0);

    parts.push({
      part_id: partId,
      operations: partOps,
      materials: partMats,
      total_run_cost: Math.round(totalRunCost * 100) / 100,
      total_setup_cost: Math.round(totalSetupCost * 100) / 100,
      total_labor_cost: Math.round((totalRunCost + totalSetupCost) * 100) / 100,
      total_material_cost: Math.round(totalMaterialCost * 100) / 100,
    });
  }

  return { parts, line_items: lineItems };
}

// ============== Manual expire ==============

/**
 * Manually mark an active quote as expired.
 */
export async function expireQuote(quoteId: string, companyId: string): Promise<Quote> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('quotes')
    .update({
      status: 'expired',
      status_changed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', quoteId)
    .eq('company_id', companyId)
    .eq('status', 'active')
    .select()
    .single();

  if (error) {
    console.error('Error expiring quote:', error);
    throw error;
  }
  return data;
}

// ============== Convert to Job ==============

export interface ConvertToJobOptions {
  /** Override the quote's lead time on the resulting job. */
  leadTimeDays?: number | null;
}

export interface ConvertToJobResult {
  quote: Quote;
  job: {
    id: string;
    job_number: string;
    parts: Array<{
      id: string;
      part_id: string;
      quantity: number;
      source_quote_line_item_id: string;
    }>;
  };
}

/**
 * Convert a quote into a single job that owns one job_part per quote_line_item.
 * The job number mirrors the quote number (Q-NNNN → J-NNNN). Each part's routing
 * is cloned into job_operations + job_materials via the
 * `create_job_part_operations_from_routing` RPC.
 *
 * The flow is sequential because Supabase doesn't expose multi-statement
 * transactions to the JS client; on partial failure the partial job stays in
 * place and the caller can retry/clean up. The single insert path makes the
 * "Job not found" race observed pre-refactor impossible.
 */
export async function convertQuoteToJob(
  quoteId: string,
  options: ConvertToJobOptions = {},
): Promise<ConvertToJobResult> {
  const supabase = getSupabase();

  const { data: quote, error: quoteError } = await supabase
    .from('quotes')
    .select(`
      *,
      line_items:quote_line_items (
        id, quote_id, company_id, part_id, source_tier_id, sequence,
        quantity, unit_price, total_price, markup_percent, base_cost_per_unit, created_at
      )
    `)
    .eq('id', quoteId)
    .single();

  if (quoteError) {
    console.error('Error fetching quote:', quoteError);
    throw quoteError;
  }
  if (quote.converted_at) {
    throw new Error('This quote has already been converted to a job.');
  }

  const lineItems = ((quote.line_items || []) as QuoteLineItem[])
    .slice()
    .sort((a, b) => a.sequence - b.sequence);
  if (lineItems.length === 0) {
    throw new Error('This quote has no line items to convert.');
  }

  // Pre-flight: every part must have a routing. Fail fast before writing anything.
  const partIds = Array.from(new Set(lineItems.map((li) => li.part_id)));
  const { data: routings, error: routingsErr } = await supabase
    .from('routings')
    .select('id, part_id')
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
      } on this quote. Create routings before converting.`,
    );
  }

  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    throw new Error('Authentication required. Please log in and try again.');
  }

  // Lead time resolution: explicit override > quote value > null
  const resolvedLeadTime =
    options.leadTimeDays !== undefined && options.leadTimeDays !== null
      ? options.leadTimeDays
      : quote.lead_time_days;

  let dueDate: string | null = null;
  if (resolvedLeadTime !== null && resolvedLeadTime !== undefined) {
    const d = new Date();
    d.setDate(d.getDate() + resolvedLeadTime);
    dueDate = d.toISOString().slice(0, 10);
  }

  // Job number mirrors the quote number (Q-0141 → J-0141). Manual jobs are
  // not supported, so this is unique by construction.
  const jobNumber = quote.quote_number.replace(/^Q-/, 'J-');

  const { data: job, error: jobError } = await supabase
    .from('jobs')
    .insert({
      company_id: quote.company_id,
      quote_id: quoteId,
      customer_id: quote.customer_id,
      job_number: jobNumber,
      status: 'not_started',
      due_date: dueDate,
      lead_time_days: resolvedLeadTime,
      created_by: user.id,
    })
    .select('id, job_number')
    .single();

  if (jobError) {
    console.error('Error creating job:', jobError);
    throw jobError;
  }

  const partsCreated: ConvertToJobResult['job']['parts'] = [];

  let sequence = 10;
  for (const li of lineItems) {
    const routingId = routingByPart.get(li.part_id);
    if (!routingId) {
      // Should be impossible after the pre-flight, but guard anyway.
      throw new Error(`Routing for part ${li.part_id} disappeared mid-conversion.`);
    }

    const { data: jobPart, error: jpErr } = await supabase
      .from('job_parts')
      .insert({
        job_id: job.id,
        company_id: quote.company_id,
        part_id: li.part_id,
        source_quote_line_item_id: li.id,
        sequence,
        quantity: li.quantity,
        status: 'not_started',
      })
      .select('id, part_id')
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

    partsCreated.push({
      id: jobPart.id,
      part_id: jobPart.part_id,
      quantity: li.quantity,
      source_quote_line_item_id: li.id,
    });

    sequence += 10;
  }

  const { data: updatedQuote, error: updateError } = await supabase
    .from('quotes')
    .update({
      converted_at: new Date().toISOString(),
      status_changed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', quoteId)
    .select()
    .single();

  if (updateError) {
    console.error('Error updating quote with conversion timestamp:', updateError);
    throw updateError;
  }

  return {
    quote: updatedQuote,
    job: {
      id: job.id,
      job_number: job.job_number,
      parts: partsCreated,
    },
  };
}

// ============== Helper Functions ==============

/**
 * Get a single part with category info for quote form.
 */
export async function getPartWithCostInfo(partId: string): Promise<{
  id: string;
  part_name: string;
  description: string | null;
  category_id: string | null;
  part_categories: { id: string; name: string; default_markup_percent: number | null } | null;
} | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('parts')
    .select(
      'id, part_name, description, category_id, part_categories(id, name, default_markup_percent)',
    )
    .eq('id', partId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching part:', error);
    return null;
  }

  return data as {
    id: string;
    part_name: string;
    description: string | null;
    category_id: string | null;
    part_categories: { id: string; name: string; default_markup_percent: number | null } | null;
  } | null;
}

// Re-export the expired-status helper so consumers don't need a separate import.
export { isQuoteExpired };
