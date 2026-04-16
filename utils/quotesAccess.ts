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
  TempAttachment,
  CompanyMember,
} from '@/types/quote';
import {
  calculateTotalPrice,
  calculateUnitPriceFromMarkup,
  isQuoteExpired,
} from '@/types/quote';
import type { JobAttachment } from '@/types/job';
import { calculateRoutingCost } from '@/utils/routingCostCalculation';
import { getCompanyMembers } from '@/utils/companyAccess';
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
    .replace(/\\/g, '\\\\')  // Escape backslashes first
    .replace(/%/g, '\\%')    // Escape percent signs
    .replace(/_/g, '\\_')    // Escape underscores
    .substring(0, 100);      // Limit length
}

/**
 * A quote is editable while it's still active and hasn't been converted.
 * Expired quotes are read-only; converted quotes are read-only.
 */
function isQuoteEditable(row: { status: string; converted_to_job_id: string | null }): boolean {
  return row.status === 'active' && !row.converted_to_job_id;
}

/**
 * Attach the creator's profile to each quote using the company member directory.
 * Done client-side because auth.users isn't reachable via PostgREST joins.
 */
function hydrateCreators<T extends QuoteWithRelations>(
  rows: T[],
  members: CompanyMember[]
): T[] {
  const map = new Map<string, CompanyMember>();
  for (const m of members) map.set(m.user_id, m);
  for (const row of rows) {
    row.created_by_member = row.created_by ? map.get(row.created_by) ?? null : null;
  }
  return rows;
}

// ============== CRUD Operations ==============

/**
 * Get paginated list of quotes for a company
 */
export async function getQuotes(
  companyId: string,
  filters: QuoteFilters = {},
  page: number = 1,
  limit: number = 25,
  sortField: string = 'created_at',
  sortDirection: 'asc' | 'desc' = 'desc'
): Promise<{ data: QuoteWithRelations[]; total: number }> {
  const supabase = getSupabase();
  const offset = (page - 1) * limit;

  let query = supabase
    .from('quotes')
    .select(
      `
      *,
      customers!left(id, name),
      parts!left(id, part_name, description, category_id, part_categories(id, name, default_markup_percent)),
      jobs:converted_to_job_id!left(id, job_number, status)
    `,
      { count: 'exact' }
    )
    .eq('company_id', companyId)
    .order(sortField, { ascending: sortDirection === 'asc' })
    .range(offset, offset + limit - 1);

  if (filters.status && filters.status !== 'all') {
    query = query.eq('status', filters.status);
  }

  if (filters.customerId) {
    query = query.eq('customer_id', filters.customerId);
  }

  if (filters.createdBy) {
    query = query.eq('created_by', filters.createdBy);
  }

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
 * Use this for client-side pagination in AG Grid.
 */
export async function getAllQuotes(
  companyId: string,
  filters: QuoteFilters = {},
  sortField: string = 'created_at',
  sortDirection: 'asc' | 'desc' = 'desc'
): Promise<QuoteWithRelations[]> {
  const supabase = getSupabase();
  const BATCH_SIZE = 1000;
  let allData: QuoteWithRelations[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    let query = supabase
      .from('quotes')
      .select(
        `
        *,
        customers!left(id, name),
        parts!left(id, part_name, description, category_id, part_categories(id, name, default_markup_percent)),
        jobs:converted_to_job_id!left(id, job_number, status)
      `
      )
      .eq('company_id', companyId)
      .order(sortField, { ascending: sortDirection === 'asc' })
      .range(offset, offset + BATCH_SIZE - 1);

    if (filters.status && filters.status !== 'all') {
      query = query.eq('status', filters.status);
    }

    if (filters.customerId) {
      query = query.eq('customer_id', filters.customerId);
    }

    if (filters.createdBy) {
      query = query.eq('created_by', filters.createdBy);
    }

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
  filters: QuoteFilters = {}
): Promise<number> {
  const supabase = getSupabase();

  let query = supabase
    .from('quotes')
    .select('*', { count: 'exact', head: true })
    .eq('company_id', companyId);

  if (filters.status && filters.status !== 'all') {
    query = query.eq('status', filters.status);
  }

  if (filters.customerId) {
    query = query.eq('customer_id', filters.customerId);
  }

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
 * Lazy-expire sweep: flips any active quote whose expiration_date has passed
 * to 'expired'. Runs as a fire-and-forget side-effect on page loads — no cron.
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
    // Don't throw — this is best-effort. Surface to Sentry if available.
    console.warn('sweepExpiredQuotes failed:', error);
    Sentry.captureException(error, { level: 'warning' });
  }
}

/**
 * Get a single quote by ID
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
 * Get a quote with all relations
 */
export async function getQuoteWithRelations(quoteId: string, companyId: string): Promise<QuoteWithRelations | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('quotes')
    .select(
      `
      *,
      customers!left(id, name, website, contact_name, contact_phone, contact_email, address_line1, address_line2, city, state, postal_code, country),
      parts!left(id, part_name, description, category_id, part_categories(id, name, default_markup_percent)),
      jobs:converted_to_job_id!left(id, job_number, status),
      quote_attachments(*)
`
    )
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

  return quote;
}

/**
 * Create a new quote (starts as active).
 * If the quote has a part with a routing, the per-op/per-material cost
 * breakdown is snapshotted into quote_operations + quote_materials.
 */
export async function createQuote(
  companyId: string,
  formData: QuoteFormData,
  tempAttachments?: TempAttachment[]
): Promise<{ quote: Quote; attachmentErrors: string[] }> {
  const supabase = getSupabase();

  const quantity = parseInt(formData.quantity, 10);
  if (isNaN(quantity) || quantity < 1 || quantity > 1000000) {
    throw new Error('Quantity must be between 1 and 1,000,000');
  }

  const unitPrice = formData.unit_price ? parseFloat(formData.unit_price) : null;
  if (unitPrice !== null && (isNaN(unitPrice) || unitPrice < 0 || unitPrice > 999999.99)) {
    throw new Error('Unit price must be between 0 and 999,999.99');
  }

  const leadTimeDays = formData.lead_time_days ? parseInt(formData.lead_time_days, 10) : null;
  if (leadTimeDays !== null && (isNaN(leadTimeDays) || leadTimeDays < 0 || leadTimeDays > 3650)) {
    throw new Error('Lead time must be between 0 and 3,650 days');
  }

  const expirationDate = formData.expiration_date || null;

  const totalPrice = calculateTotalPrice(quantity, unitPrice);

  const baseCost = formData.base_cost ? parseFloat(formData.base_cost) : null;
  const markupPercent = formData.markup_percent ? parseFloat(formData.markup_percent) : null;

  const partId = formData.part_type === 'existing' && formData.part_id ? formData.part_id : null;

  // created_by is the current authenticated user — used to surface "prepared by"
  const { data: { user } } = await supabase.auth.getUser();

  const { data, error } = await supabase
    .from('quotes')
    .insert({
      company_id: companyId,
      customer_id: formData.customer_id,
      part_id: partId,
      quantity,
      base_cost: baseCost !== null && !isNaN(baseCost) ? baseCost : null,
      markup_percent: markupPercent !== null && !isNaN(markupPercent) ? markupPercent : null,
      unit_price: unitPrice,
      total_price: totalPrice,
      lead_time_days: leadTimeDays,
      expiration_date: expirationDate,
      status: 'active',
      created_by: user?.id ?? null,
      // quote_number is auto-generated by database trigger
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating quote:', error);
    throw error;
  }

  // Snapshot cost breakdown from the part's routing (best-effort)
  if (partId) {
    try {
      await writeCostSnapshots(data.id, companyId, partId);
    } catch (snapshotError) {
      console.warn('Failed to write cost snapshot:', snapshotError);
      Sentry.captureException(snapshotError, { level: 'warning' });
      // Don't fail the quote creation — the quote is still valid without the detailed breakdown
    }
  }

  const attachmentErrors: string[] = [];
  if (tempAttachments && tempAttachments.length > 0 && data.id) {
    for (const tempAttachment of tempAttachments) {
      try {
        await moveTempAttachmentToPermanent(tempAttachment, data.id, companyId);
      } catch (attachmentError) {
        console.error('Failed to move temp attachment:', attachmentError);
        attachmentErrors.push(`Failed to save attachment: ${tempAttachment.file_name}`);
      }
    }
  }

  return { quote: data, attachmentErrors };
}

/**
 * Update an existing quote.
 * Editable while status === 'active' && !converted_to_job_id.
 * Re-snapshots the cost breakdown if part_id, base_cost or markup_percent change.
 */
export async function updateQuote(quoteId: string, formData: QuoteFormData): Promise<Quote> {
  const supabase = getSupabase();

  const { data: existing, error: checkError } = await supabase
    .from('quotes')
    .select('status, converted_to_job_id, part_id, base_cost, markup_percent, company_id')
    .eq('id', quoteId)
    .single();

  if (checkError) {
    console.error('Error checking quote:', checkError);
    throw checkError;
  }

  if (!isQuoteEditable(existing)) {
    throw new Error('This quote cannot be edited. Expired or converted quotes are read-only.');
  }

  const quantity = parseInt(formData.quantity, 10);
  if (isNaN(quantity) || quantity < 1 || quantity > 1000000) {
    throw new Error('Quantity must be between 1 and 1,000,000');
  }

  const unitPrice = formData.unit_price ? parseFloat(formData.unit_price) : null;
  if (unitPrice !== null && (isNaN(unitPrice) || unitPrice < 0 || unitPrice > 999999.99)) {
    throw new Error('Unit price must be between 0 and 999,999.99');
  }

  const leadTimeDays = formData.lead_time_days ? parseInt(formData.lead_time_days, 10) : null;
  if (leadTimeDays !== null && (isNaN(leadTimeDays) || leadTimeDays < 0 || leadTimeDays > 3650)) {
    throw new Error('Lead time must be between 0 and 3,650 days');
  }

  const totalPrice = calculateTotalPrice(quantity, unitPrice);

  const baseCost = formData.base_cost ? parseFloat(formData.base_cost) : null;
  const markupPercent = formData.markup_percent ? parseFloat(formData.markup_percent) : null;
  const partId = formData.part_type === 'existing' && formData.part_id ? formData.part_id : null;

  const { data, error } = await supabase
    .from('quotes')
    .update({
      customer_id: formData.customer_id,
      part_id: partId,
      quantity,
      base_cost: baseCost !== null && !isNaN(baseCost) ? baseCost : null,
      markup_percent: markupPercent !== null && !isNaN(markupPercent) ? markupPercent : null,
      unit_price: unitPrice,
      total_price: totalPrice,
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

  // Refresh cost snapshot if the part or cost inputs changed.
  const partChanged = existing.part_id !== partId;
  const baseChanged = (existing.base_cost ?? null) !== (baseCost ?? null);
  const markupChanged = (existing.markup_percent ?? null) !== (markupPercent ?? null);

  if (partId && (partChanged || baseChanged || markupChanged)) {
    try {
      await writeCostSnapshots(quoteId, existing.company_id, partId);
    } catch (snapshotError) {
      console.warn('Failed to refresh cost snapshot:', snapshotError);
      Sentry.captureException(snapshotError, { level: 'warning' });
    }
  } else if (!partId && partChanged) {
    // Part was removed — clear snapshots
    await supabase.from('quote_operations').delete().eq('quote_id', quoteId);
    await supabase.from('quote_materials').delete().eq('quote_id', quoteId);
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
 * Write (or overwrite) per-op + per-material cost snapshots for a quote,
 * reading the live routing via calculateRoutingCost.
 * Safe to re-call: deletes existing rows first.
 */
async function writeCostSnapshots(
  quoteId: string,
  companyId: string,
  partId: string
): Promise<void> {
  const supabase = getSupabase();

  const breakdown = await calculateRoutingCost(partId);
  if (!breakdown) return;

  // Clear any existing snapshot rows (keeps the function idempotent)
  await supabase.from('quote_operations').delete().eq('quote_id', quoteId);
  await supabase.from('quote_materials').delete().eq('quote_id', quoteId);

  if (breakdown.labor_items.length > 0) {
    const opRows = breakdown.labor_items.map((item, index) => ({
      quote_id: quoteId,
      company_id: companyId,
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
 * Read the cost-breakdown for a quote and compute override info.
 * Snapshot tables are the single source of truth — pre-existing quotes
 * are backfilled by migration 20260416_backfill_quote_cost_snapshots.sql,
 * so the read path never falls back to a live recomputation.
 */
export async function getQuoteCostBreakdown(
  quoteId: string,
  companyId: string
): Promise<QuoteCostBreakdown | null> {
  const supabase = getSupabase();

  const { data: quote, error: quoteError } = await supabase
    .from('quotes')
    .select('base_cost, markup_percent, unit_price')
    .eq('id', quoteId)
    .eq('company_id', companyId)
    .single();

  if (quoteError) {
    console.error('Error fetching quote for breakdown:', quoteError);
    throw quoteError;
  }

  const [opsResp, matsResp] = await Promise.all([
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
  ]);

  if (opsResp.error) throw opsResp.error;
  if (matsResp.error) throw matsResp.error;

  const operations = (opsResp.data || []) as QuoteOperationSnapshot[];
  const materials = (matsResp.data || []) as QuoteMaterialSnapshot[];

  const totalRunCost = operations.reduce((sum, o) => sum + (o.run_cost ?? 0), 0);
  const totalSetupCost = operations.reduce((sum, o) => sum + (o.setup_cost ?? 0), 0);
  const totalLaborCost = totalRunCost + totalSetupCost;
  const totalMaterialCost = materials.reduce((sum, m) => sum + (m.line_cost ?? 0), 0);

  const baseCost = quote.base_cost ?? 0;
  const markupPercent = quote.markup_percent;
  const actualUnitPrice = quote.unit_price;
  const computedUnitPrice =
    markupPercent !== null ? calculateUnitPriceFromMarkup(baseCost, markupPercent) : null;

  const overridePerUnit =
    computedUnitPrice !== null && actualUnitPrice !== null
      ? Math.round((actualUnitPrice - computedUnitPrice) * 100) / 100
      : null;

  return {
    operations,
    materials,
    total_run_cost: Math.round(totalRunCost * 100) / 100,
    total_setup_cost: Math.round(totalSetupCost * 100) / 100,
    total_labor_cost: Math.round(totalLaborCost * 100) / 100,
    total_material_cost: Math.round(totalMaterialCost * 100) / 100,
    base_cost: baseCost,
    markup_percent: markupPercent,
    computed_unit_price: computedUnitPrice,
    actual_unit_price: actualUnitPrice,
    override_per_unit: overridePerUnit,
  };
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

export interface ConvertToJobResult {
  quote: Quote;
  job: {
    id: string;
    job_number: string;
  };
}

export interface ConvertToJobOptions {
  leadTimeDays?: number | null;
  notes?: string | null;
}

/**
 * Convert a quote to a job. No approval gate: expiration is informational only.
 * Caller may override the lead time; otherwise we use the quote's lead_time_days.
 */
export async function convertQuoteToJob(
  quoteId: string,
  options: ConvertToJobOptions = {}
): Promise<ConvertToJobResult> {
  const supabase = getSupabase();

  const { data: quote, error: quoteError } = await supabase
    .from('quotes')
    .select(`
      *,
      quote_attachments (*)
    `)
    .eq('id', quoteId)
    .single();

  if (quoteError) {
    console.error('Error fetching quote:', quoteError);
    throw quoteError;
  }

  if (quote.converted_to_job_id) {
    throw new Error('This quote has already been converted to a job');
  }

  let routingId: string | null = null;
  if (quote.part_id) {
    const { data: routing, error: routingError } = await supabase
      .from('routings')
      .select('id')
      .eq('part_id', quote.part_id)
      .maybeSingle();

    if (routingError) {
      console.error('Error fetching routing for part:', routingError);
      throw routingError;
    }

    if (!routing) {
      throw new Error('No routing defined for this part. Create a routing before converting to a job.');
    }

    routingId = routing.id;
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

  const { data: job, error: jobError } = await supabase
    .from('jobs')
    .insert({
      company_id: quote.company_id,
      quote_id: quoteId,
      customer_id: quote.customer_id,
      part_id: quote.part_id,
      description: options.notes ?? null,
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

  if (routingId) {
    const { error: rpcError } = await supabase.rpc('create_job_operations_from_routing', {
      p_job_id: job.id,
      p_routing_id: routingId,
    });
    if (rpcError) {
      console.error('Failed to copy operations from routing:', rpcError);
      throw new Error('Job created but failed to copy operations from routing. Please add operations manually.');
    }
  }

  const quoteAttachment = quote.quote_attachments?.[0];
  if (quoteAttachment) {
    try {
      await copyAttachmentToJob(
        quoteAttachment,
        job.id,
        quote.company_id,
        user.id
      );
    } catch (attachmentError) {
      console.error('Failed to copy attachment to job:', attachmentError);
    }
  }

  const { data: updatedQuote, error: updateError } = await supabase
    .from('quotes')
    .update({
      converted_to_job_id: job.id,
      converted_at: new Date().toISOString(),
      status_changed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', quoteId)
    .select()
    .single();

  if (updateError) {
    console.error('Error updating quote with job reference:', updateError);
    throw updateError;
  }

  return {
    quote: updatedQuote,
    job,
  };
}

// ============== Helper Functions ==============

/**
 * Get a single part with category info for quote form
 */
export async function getPartWithCostInfo(
  partId: string
): Promise<{
  id: string;
  part_name: string;
  description: string | null;
  category_id: string | null;
  part_categories: { id: string; name: string; default_markup_percent: number | null } | null;
} | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('parts')
    .select('id, part_name, description, category_id, part_categories(id, name, default_markup_percent)')
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

export async function getQuoteAttachments(
  quoteId: string
): Promise<QuoteAttachment[]> {
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

/**
 * Upload a PDF attachment. Allowed while the quote is still editable
 * (active and not converted).
 */
export async function uploadQuoteAttachment(
  quoteId: string,
  companyId: string,
  file: File
): Promise<QuoteAttachment> {
  const supabase = getSupabase();

  if (file.type !== 'application/pdf') {
    throw new Error('Only PDF files are allowed');
  }

  if (file.size > MAX_FILE_SIZE) {
    throw new Error('File size must be 50MB or less');
  }

  const { data: quote, error: quoteError } = await supabase
    .from('quotes')
    .select('status, converted_to_job_id')
    .eq('id', quoteId)
    .single();

  if (quoteError || !quote) {
    throw new Error('Quote not found');
  }

  if (!isQuoteEditable(quote)) {
    throw new Error('Attachments can only be added to active quotes that have not been converted.');
  }

  const existingCount = await getQuoteAttachmentCount(quoteId);
  if (existingCount >= MAX_ATTACHMENTS_PER_QUOTE) {
    throw new Error(
      `Maximum ${MAX_ATTACHMENTS_PER_QUOTE} attachment(s) allowed. Delete existing attachment first.`
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
    await deleteFileFromStorage(filePath).catch((err) => { console.error(err); Sentry.captureException(err, { level: 'warning' }); });
    console.error('Error creating attachment record:', insertError);
    throw new Error('Failed to save attachment');
  }

  return attachment;
}

/**
 * Delete attachment. Allowed while the parent quote is still editable.
 */
export async function deleteQuoteAttachment(
  attachmentId: string,
  companyId: string
): Promise<void> {
  const supabase = getSupabase();

  const { data: attachment, error: fetchError } = await supabase
    .from('quote_attachments')
    .select(`
      id,
      file_path,
      quotes!inner (status, converted_to_job_id)
    `)
    .eq('id', attachmentId)
    .eq('company_id', companyId)
    .single();

  if (fetchError || !attachment) {
    throw new Error('Attachment not found');
  }

  const parentQuote = attachment.quotes as { status: string; converted_to_job_id: string | null };
  if (!isQuoteEditable(parentQuote)) {
    throw new Error('Attachments can only be deleted from active quotes that have not been converted.');
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

/**
 * Replace quote attachment (upload new first, then delete old)
 */
export async function replaceQuoteAttachment(
  attachmentId: string,
  companyId: string,
  quoteId: string,
  newFile: File
): Promise<QuoteAttachment> {
  const supabase = getSupabase();

  if (newFile.type !== 'application/pdf') {
    throw new Error('Only PDF files are allowed');
  }

  if (newFile.size > MAX_FILE_SIZE) {
    throw new Error('File size must be 50MB or less');
  }

  const { data: existing, error: fetchError } = await supabase
    .from('quote_attachments')
    .select(`
      file_path,
      quotes!inner (status, converted_to_job_id)
    `)
    .eq('id', attachmentId)
    .eq('company_id', companyId)
    .single();

  if (fetchError || !existing) {
    throw new Error('Attachment not found');
  }

  const parentQuote = existing.quotes as { status: string; converted_to_job_id: string | null };
  if (!isQuoteEditable(parentQuote)) {
    throw new Error('Attachments can only be replaced on active quotes that have not been converted.');
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
    await deleteFileFromStorage(newPath).catch((err) => { console.error(err); Sentry.captureException(err, { level: 'warning' }); });
    throw new Error('Failed to update attachment');
  }

  if (oldFilePath) {
    await deleteFileFromStorage(oldFilePath)
      .catch(err => { console.warn('Failed to delete old file:', err); Sentry.captureException(err, { level: 'warning' }); });
  }

  return updated;
}

export async function getQuoteAttachmentUrl(filePath: string): Promise<string> {
  return getSignedUrl(filePath, 3600);
}

export async function uploadTempQuoteAttachment(
  companyId: string,
  sessionId: string,
  file: File
): Promise<TempAttachment> {
  if (file.type !== 'application/pdf') {
    throw new Error('Only PDF files are allowed');
  }

  if (file.size > MAX_FILE_SIZE) {
    throw new Error('File size must be 50MB or less');
  }

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
  companyId: string
): Promise<void> {
  const supabase = getSupabase();

  const permanentPath = generateStoragePath(
    companyId,
    'quotes',
    quoteId,
    tempAttachment.file_name
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
  userId: string | null
): Promise<JobAttachment> {
  const supabase = getSupabase();

  const fileData = await downloadFileFromStorage(quoteAttachment.file_path);

  const newPath = generateStoragePath(
    companyId,
    'jobs',
    jobId,
    quoteAttachment.file_name
  );

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
    await deleteFileFromStorage(newPath).catch((err) => { console.error(err); Sentry.captureException(err, { level: 'warning' }); });
    throw new Error('Failed to copy attachment to job');
  }

  return jobAttachment;
}

// Re-export the expired-status helper so consumers don't need a separate import.
export { isQuoteExpired };
