import * as Sentry from '@sentry/nextjs';
import { getSupabase } from '@/lib/supabase';
import type {
  Quote,
  QuoteWithRelations,
  QuoteFormData,
  QuoteFilters,
  QuoteAttachment,
  QuoteCostBreakdown,
  QuoteOperationSnapshot,
  QuoteMaterialSnapshot,
  QuotePartCostBreakdown,
  QuoteLineItem,
  TempAttachment,
  CompanyMember,
} from '@/types/quote';
import { isQuoteExpired } from '@/types/quote';
import type { JobAttachment } from '@/types/job';
import { calculateRoutingCost } from '@/utils/routingCostCalculation';
import { getCompanyMembers } from '@/utils/companyAccess';
import { getTier } from '@/utils/partPricingTiersAccess';
import { insertLineItemFromTier, getLineItemsForQuote } from '@/utils/quoteLineItemsAccess';
import {
  generateStoragePath,
  uploadFileToStorage,
  deleteFileFromStorage,
  getSignedUrl,
  downloadFileFromStorage,
  moveFileInStorage,
  generateTempStoragePath,
} from './storageHelpers';

// Maximum attachments per quote
export const MAX_ATTACHMENTS_PER_QUOTE = 5;

// Maximum file size (50MB)
export const MAX_FILE_SIZE = 50 * 1024 * 1024;

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
  jobs!left(id, job_number, status, source_quote_line_item_id)
`;

const QUOTE_DETAIL_SELECT = `
  *,
  customers!left(id, name, website, contact_name, contact_phone, contact_email, address_line1, address_line2, city, state, postal_code, country),
  line_items:quote_line_items!left(${QUOTE_LINE_ITEM_FIELDS}),
  jobs!left(id, job_number, status, source_quote_line_item_id),
  quote_attachments(*)
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
 * Create a new quote with multiple parts, each with one or more pricing tiers
 * snapshotted into quote_line_items. Also writes per-part cost snapshots into
 * quote_operations + quote_materials.
 */
export async function createQuote(
  companyId: string,
  formData: QuoteFormData,
  tempAttachments?: TempAttachment[],
): Promise<{ quote: Quote; attachmentErrors: string[] }> {
  const supabase = getSupabase();

  if (!formData.parts || formData.parts.length === 0) {
    throw new Error('A quote must include at least one part.');
  }
  for (const block of formData.parts) {
    if (!block.part_id) throw new Error('Every part selection must reference a real part.');
    if (!block.tier_ids || block.tier_ids.length === 0) {
      throw new Error('Every part must include at least one pricing tier.');
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

  // Snapshot each selected tier into quote_line_items and write per-part cost snapshots.
  let sequence = 10;
  const seenPartIds = new Set<string>();

  for (const block of formData.parts) {
    for (const tierId of block.tier_ids) {
      const tier = await getTier(tierId);
      if (!tier) {
        throw new Error(`Pricing tier ${tierId} not found — it may have been deleted.`);
      }
      if (tier.part_id !== block.part_id) {
        throw new Error(`Pricing tier ${tierId} does not belong to part ${block.part_id}.`);
      }
      const override = block.overrides?.[tierId];
      await insertLineItemFromTier(quote.id, companyId, tier, sequence, override);
      sequence += 10;
    }

    if (!seenPartIds.has(block.part_id)) {
      seenPartIds.add(block.part_id);
      try {
        await writeCostSnapshotsForPart(quote.id, companyId, block.part_id);
      } catch (snapshotError) {
        console.warn('Failed to write cost snapshot for part:', block.part_id, snapshotError);
        Sentry.captureException(snapshotError, { level: 'warning' });
      }
    }
  }

  const attachmentErrors: string[] = [];
  if (tempAttachments && tempAttachments.length > 0 && quote.id) {
    for (const tempAttachment of tempAttachments) {
      try {
        await moveTempAttachmentToPermanent(tempAttachment, quote.id, companyId);
      } catch (attachmentError) {
        console.error('Failed to move temp attachment:', attachmentError);
        attachmentErrors.push(`Failed to save attachment: ${tempAttachment.file_name}`);
      }
    }
  }

  return { quote, attachmentErrors };
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
 * Delete a quote and its attachments from storage
 */
export async function deleteQuote(quoteId: string, companyId: string): Promise<void> {
  const supabase = getSupabase();

  const { data: attachments } = await supabase
    .from('quote_attachments')
    .select('file_path')
    .eq('quote_id', quoteId)
    .eq('company_id', companyId);

  if (attachments && attachments.length > 0) {
    for (const attachment of attachments) {
      try {
        await deleteFileFromStorage(attachment.file_path);
      } catch (storageError) {
        console.warn('Failed to delete storage file:', attachment.file_path, storageError);
        Sentry.captureException(storageError, { level: 'warning' });
      }
    }
  }

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
 * Bulk delete quotes and their attachments from storage
 */
export async function bulkDeleteQuotes(quoteIds: string[], companyId: string): Promise<void> {
  if (quoteIds.length === 0) return;
  const validIds = quoteIds.filter((id) => id && typeof id === 'string');
  if (validIds.length === 0) return;

  const supabase = getSupabase();

  const { data: attachments } = await supabase
    .from('quote_attachments')
    .select('file_path')
    .in('quote_id', validIds)
    .eq('company_id', companyId);

  if (attachments && attachments.length > 0) {
    for (const attachment of attachments) {
      try {
        await deleteFileFromStorage(attachment.file_path);
      } catch (storageError) {
        console.warn('Failed to delete storage file:', attachment.file_path, storageError);
        Sentry.captureException(storageError, { level: 'warning' });
      }
    }
  }

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

/**
 * User picks one line item per distinct part at conversion time.
 */
export interface ConvertToJobSelection {
  line_item_id: string;
}

export interface ConvertToJobOptions {
  /** One selection per distinct part in the quote. */
  selections: ConvertToJobSelection[];
  /** Override the quote's lead time for the resulting jobs. */
  leadTimeDays?: number | null;
}

export interface ConvertToJobResult {
  quote: Quote;
  jobs: Array<{
    id: string;
    job_number: string;
    line_item_id: string;
    part_id: string;
    quantity: number;
  }>;
}

/**
 * Convert a quote into one or more jobs. The caller picks exactly one line item
 * per distinct part in the quote; each selected line item spawns one job with that
 * line item's quantity.
 */
export async function convertQuoteToJob(
  quoteId: string,
  options: ConvertToJobOptions,
): Promise<ConvertToJobResult> {
  const supabase = getSupabase();

  if (!options.selections || options.selections.length === 0) {
    throw new Error('Pick at least one quantity tier per part before converting.');
  }

  const { data: quote, error: quoteError } = await supabase
    .from('quotes')
    .select(`
      *,
      quote_attachments (*),
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
    throw new Error('This quote has already been converted to jobs.');
  }

  const lineItems = (quote.line_items || []) as QuoteLineItem[];
  if (lineItems.length === 0) {
    throw new Error('This quote has no line items to convert.');
  }

  // Validate selections: exactly one per distinct part, each referencing a real line item.
  const lineItemsById = new Map(lineItems.map((li) => [li.id, li]));
  const seenParts = new Set<string>();
  const resolved: QuoteLineItem[] = [];
  for (const sel of options.selections) {
    const li = lineItemsById.get(sel.line_item_id);
    if (!li) throw new Error(`Line item ${sel.line_item_id} is not on this quote.`);
    if (seenParts.has(li.part_id)) {
      throw new Error(`Part ${li.part_id} has more than one tier selected.`);
    }
    seenParts.add(li.part_id);
    resolved.push(li);
  }

  const distinctPartIds = new Set(lineItems.map((li) => li.part_id));
  for (const partId of distinctPartIds) {
    if (!seenParts.has(partId)) {
      throw new Error(`No tier selected for part ${partId}.`);
    }
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

  const createdJobs: ConvertToJobResult['jobs'] = [];

  for (const li of resolved) {
    const { data: routing, error: routingErr } = await supabase
      .from('routings')
      .select('id')
      .eq('part_id', li.part_id)
      .maybeSingle();
    if (routingErr) {
      console.error('Error fetching routing for part:', routingErr);
      throw routingErr;
    }
    if (!routing) {
      throw new Error(
        'No routing defined for one of the parts on this quote. Create a routing before converting.',
      );
    }

    const { data: job, error: jobError } = await supabase
      .from('jobs')
      .insert({
        company_id: quote.company_id,
        quote_id: quoteId,
        customer_id: quote.customer_id,
        part_id: li.part_id,
        source_quote_line_item_id: li.id,
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

    const { error: rpcError } = await supabase.rpc('create_job_operations_from_routing', {
      p_job_id: job.id,
      p_routing_id: routing.id,
    });
    if (rpcError) {
      console.error('Failed to copy operations from routing:', rpcError);
      throw new Error('Job created but failed to copy operations from routing.');
    }

    const primaryAttachment = quote.quote_attachments?.[0];
    if (primaryAttachment) {
      try {
        await copyAttachmentToJob(primaryAttachment, job.id, quote.company_id, user.id);
      } catch (attachmentError) {
        console.error('Failed to copy attachment to job:', attachmentError);
      }
    }

    createdJobs.push({
      id: job.id,
      job_number: job.job_number,
      line_item_id: li.id,
      part_id: li.part_id,
      quantity: li.quantity,
    });
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

  return { quote: updatedQuote, jobs: createdJobs };
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

// ============== Attachment Operations ==============

export async function getQuoteAttachments(quoteId: string): Promise<QuoteAttachment[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('quote_attachments')
    .select('*')
    .eq('quote_id', quoteId)
    .order('uploaded_at', { ascending: false });
  if (error) {
    console.error('Error fetching quote attachments:', error);
    throw error;
  }
  return data || [];
}

export async function getQuoteAttachmentCount(quoteId: string): Promise<number> {
  const supabase = getSupabase();
  const { count, error } = await supabase
    .from('quote_attachments')
    .select('*', { count: 'exact', head: true })
    .eq('quote_id', quoteId);
  if (error) {
    console.error('Error counting quote attachments:', error);
    throw error;
  }
  return count || 0;
}

export async function uploadQuoteAttachment(
  quoteId: string,
  companyId: string,
  file: File,
): Promise<QuoteAttachment> {
  const supabase = getSupabase();

  if (file.type !== 'application/pdf') throw new Error('Only PDF files are allowed');
  if (file.size > MAX_FILE_SIZE) throw new Error('File size must be 50MB or less');

  const { data: quote, error: quoteError } = await supabase
    .from('quotes')
    .select('status, converted_at')
    .eq('id', quoteId)
    .single();

  if (quoteError || !quote) throw new Error('Quote not found');
  if (!isQuoteEditable(quote)) {
    throw new Error('Attachments can only be added to active quotes that have not been converted.');
  }

  const existingCount = await getQuoteAttachmentCount(quoteId);
  if (existingCount >= MAX_ATTACHMENTS_PER_QUOTE) {
    throw new Error(
      `Maximum ${MAX_ATTACHMENTS_PER_QUOTE} attachment(s) allowed. Delete existing attachment first.`,
    );
  }

  const { data: { user } } = await supabase.auth.getUser();

  const filePath = generateStoragePath(companyId, 'quotes', quoteId, file.name);
  await uploadFileToStorage(filePath, file);

  const { data: attachment, error: insertError } = await supabase
    .from('quote_attachments')
    .insert({
      quote_id: quoteId,
      company_id: companyId,
      file_name: file.name,
      file_path: filePath,
      file_size: file.size,
      mime_type: file.type,
      uploaded_by: user?.id || null,
    })
    .select()
    .single();

  if (insertError) {
    await deleteFileFromStorage(filePath).catch((err) => {
      console.error(err);
      Sentry.captureException(err, { level: 'warning' });
    });
    console.error('Error creating attachment record:', insertError);
    throw new Error('Failed to save attachment');
  }

  return attachment;
}

export async function deleteQuoteAttachment(
  attachmentId: string,
  companyId: string,
): Promise<void> {
  const supabase = getSupabase();

  const { data: attachment, error: fetchError } = await supabase
    .from('quote_attachments')
    .select(`
      id,
      file_path,
      quotes!inner (status, converted_at)
    `)
    .eq('id', attachmentId)
    .eq('company_id', companyId)
    .single();

  if (fetchError || !attachment) throw new Error('Attachment not found');

  const parentQuote = attachment.quotes as { status: string; converted_at: string | null };
  if (!isQuoteEditable(parentQuote)) {
    throw new Error(
      'Attachments can only be deleted from active quotes that have not been converted.',
    );
  }

  await deleteFileFromStorage(attachment.file_path);

  const { error: dbError } = await supabase
    .from('quote_attachments')
    .delete()
    .eq('id', attachmentId)
    .eq('company_id', companyId);

  if (dbError) {
    console.error('Error deleting attachment record:', dbError);
    throw new Error('Failed to delete attachment');
  }
}

export async function replaceQuoteAttachment(
  attachmentId: string,
  companyId: string,
  quoteId: string,
  newFile: File,
): Promise<QuoteAttachment> {
  const supabase = getSupabase();

  if (newFile.type !== 'application/pdf') throw new Error('Only PDF files are allowed');
  if (newFile.size > MAX_FILE_SIZE) throw new Error('File size must be 50MB or less');

  const { data: existing, error: fetchError } = await supabase
    .from('quote_attachments')
    .select(`
      file_path,
      quotes!inner (status, converted_at)
    `)
    .eq('id', attachmentId)
    .eq('company_id', companyId)
    .single();

  if (fetchError || !existing) throw new Error('Attachment not found');

  const parentQuote = existing.quotes as { status: string; converted_at: string | null };
  if (!isQuoteEditable(parentQuote)) {
    throw new Error(
      'Attachments can only be replaced on active quotes that have not been converted.',
    );
  }

  const oldFilePath = existing.file_path;

  const newPath = generateStoragePath(companyId, 'quotes', quoteId, newFile.name);
  await uploadFileToStorage(newPath, newFile);

  const { data: { user } } = await supabase.auth.getUser();

  const { data: updated, error: updateError } = await supabase
    .from('quote_attachments')
    .update({
      file_name: newFile.name,
      file_path: newPath,
      file_size: newFile.size,
      uploaded_by: user?.id || null,
      uploaded_at: new Date().toISOString(),
    })
    .eq('id', attachmentId)
    .select()
    .single();

  if (updateError) {
    await deleteFileFromStorage(newPath).catch((err) => {
      console.error(err);
      Sentry.captureException(err, { level: 'warning' });
    });
    throw new Error('Failed to update attachment');
  }

  if (oldFilePath) {
    await deleteFileFromStorage(oldFilePath).catch((err) => {
      console.warn('Failed to delete old file:', err);
      Sentry.captureException(err, { level: 'warning' });
    });
  }

  return updated;
}

export async function getQuoteAttachmentUrl(filePath: string): Promise<string> {
  return getSignedUrl(filePath, 3600);
}

export async function uploadTempQuoteAttachment(
  companyId: string,
  sessionId: string,
  file: File,
): Promise<TempAttachment> {
  if (file.type !== 'application/pdf') throw new Error('Only PDF files are allowed');
  if (file.size > MAX_FILE_SIZE) throw new Error('File size must be 50MB or less');

  const filePath = generateTempStoragePath(companyId, sessionId, file.name);
  await uploadFileToStorage(filePath, file);

  return {
    file_name: file.name,
    file_path: filePath,
    file_size: file.size,
    mime_type: file.type,
  };
}

export async function deleteTempQuoteAttachment(filePath: string): Promise<void> {
  await deleteFileFromStorage(filePath);
}

async function moveTempAttachmentToPermanent(
  tempAttachment: TempAttachment,
  quoteId: string,
  companyId: string,
): Promise<void> {
  const supabase = getSupabase();

  const permanentPath = generateStoragePath(
    companyId,
    'quotes',
    quoteId,
    tempAttachment.file_name,
  );

  await moveFileInStorage(tempAttachment.file_path, permanentPath);

  const { data: { user } } = await supabase.auth.getUser();

  const { error: insertError } = await supabase
    .from('quote_attachments')
    .insert({
      quote_id: quoteId,
      company_id: companyId,
      file_name: tempAttachment.file_name,
      file_path: permanentPath,
      file_size: tempAttachment.file_size,
      mime_type: tempAttachment.mime_type,
      uploaded_by: user?.id || null,
    });

  if (insertError) {
    console.error('Failed to create attachment record:', insertError);
    throw new Error('Failed to save attachment');
  }
}

async function copyAttachmentToJob(
  quoteAttachment: QuoteAttachment,
  jobId: string,
  companyId: string,
  userId: string | null,
): Promise<JobAttachment> {
  const supabase = getSupabase();

  const fileData = await downloadFileFromStorage(quoteAttachment.file_path);

  const newPath = generateStoragePath(companyId, 'jobs', jobId, quoteAttachment.file_name);

  await uploadFileToStorage(newPath, fileData);

  const { data: jobAttachment, error: insertError } = await supabase
    .from('job_attachments')
    .insert({
      job_id: jobId,
      company_id: companyId,
      file_name: quoteAttachment.file_name,
      file_path: newPath,
      file_size: quoteAttachment.file_size,
      mime_type: quoteAttachment.mime_type,
      source_quote_attachment_id: quoteAttachment.id,
      uploaded_by: userId,
    })
    .select()
    .single();

  if (insertError) {
    console.error('Failed to create job attachment record:', insertError);
    await deleteFileFromStorage(newPath).catch((err) => {
      console.error(err);
      Sentry.captureException(err, { level: 'warning' });
    });
    throw new Error('Failed to copy attachment to job');
  }

  return jobAttachment;
}

// Re-export the expired-status helper so consumers don't need a separate import.
export { isQuoteExpired };
