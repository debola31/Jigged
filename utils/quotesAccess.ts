import * as Sentry from '@sentry/nextjs';
import { getSupabase } from '@/lib/supabase';
import type {
  Quote,
  QuoteWithRelations,
  QuoteFormData,
  QuoteFilters,
  QuoteStatus,
  QuoteAttachment,
  TempAttachment,
} from '@/types/quote';
import { calculateTotalPrice } from '@/types/quote';
import type { JobAttachment } from '@/types/job';
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

  // Apply filters
  if (filters.status && filters.status !== 'all') {
    query = query.eq('status', filters.status);
  }

  if (filters.customerId) {
    query = query.eq('customer_id', filters.customerId);
  }

  if (filters.search?.trim()) {
    const sanitized = sanitizeSearchString(filters.search.trim());
    query = query.or(
      `quote_number.ilike.%${sanitized}%,description.ilike.%${sanitized}%`
    );
  }

  const { data, error, count } = await query;

  if (error) {
    console.error('Error fetching quotes:', error);
    throw error;
  }

  return { data: (data || []) as QuoteWithRelations[], total: count || 0 };
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

    // Apply filters
    if (filters.status && filters.status !== 'all') {
      query = query.eq('status', filters.status);
    }

    if (filters.customerId) {
      query = query.eq('customer_id', filters.customerId);
    }

    if (filters.search?.trim()) {
      query = query.or(
        `quote_number.ilike.%${filters.search}%,description.ilike.%${filters.search}%`
      );
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

  return allData;
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
    query = query.or(
      `quote_number.ilike.%${sanitized}%,description.ilike.%${sanitized}%`
    );
  }

  const { count, error } = await query;

  if (error) {
    console.error('Error fetching quotes count:', error);
    throw error;
  }

  return count || 0;
}

/**
 * Get a single quote by ID
 * @param quoteId - The quote ID
 * @param companyId - The company ID for security validation
 * @returns Quote if found, null if not found (PGRST116)
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
 * @param quoteId - The quote ID
 * @param companyId - The company ID for security validation
 * @returns Quote with relations if found, null if not found (PGRST116)
 */
export async function getQuoteWithRelations(quoteId: string, companyId: string): Promise<QuoteWithRelations | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('quotes')
    .select(
      `
      *,
      customers!left(id, name),
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

  return data as QuoteWithRelations | null;
}

/**
 * Create a new quote (starts as pending_approval)
 */
export async function createQuote(
  companyId: string,
  formData: QuoteFormData,
  tempAttachments?: TempAttachment[]
): Promise<{ quote: Quote; attachmentErrors: string[] }> {
  const supabase = getSupabase();

  // Input validation
  const quantity = parseInt(formData.quantity, 10);
  if (isNaN(quantity) || quantity < 1 || quantity > 1000000) {
    throw new Error('Quantity must be between 1 and 1,000,000');
  }

  const unitPrice = formData.unit_price ? parseFloat(formData.unit_price) : null;
  if (unitPrice !== null && (isNaN(unitPrice) || unitPrice < 0 || unitPrice > 999999.99)) {
    throw new Error('Unit price must be between 0 and 999,999.99');
  }

  if (formData.description && formData.description.length > 5000) {
    throw new Error('Description cannot exceed 5000 characters');
  }

  const totalPrice = calculateTotalPrice(quantity, unitPrice);

  const baseCost = formData.base_cost ? parseFloat(formData.base_cost) : null;
  const markupPercent = formData.markup_percent ? parseFloat(formData.markup_percent) : null;

  const { data, error } = await supabase
    .from('quotes')
    .insert({
      company_id: companyId,
      customer_id: formData.customer_id,
      part_id: formData.part_type === 'existing' && formData.part_id ? formData.part_id : null,
      description: formData.description.trim() || null,
      quantity,
      base_cost: baseCost !== null && !isNaN(baseCost) ? baseCost : null,
      markup_percent: markupPercent !== null && !isNaN(markupPercent) ? markupPercent : null,
      unit_price: unitPrice,
      total_price: totalPrice,
      status: 'pending_approval',
      // quote_number is auto-generated by database trigger
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating quote:', error);
    throw error;
  }

  // If there are temp attachments, move them to permanent location
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
 * Update an existing quote (pending_approval or rejected only)
 */
export async function updateQuote(quoteId: string, formData: QuoteFormData): Promise<Quote> {
  const supabase = getSupabase();

  // First check if quote is in an editable status
  const { data: existing, error: checkError } = await supabase
    .from('quotes')
    .select('status')
    .eq('id', quoteId)
    .single();

  if (checkError) {
    console.error('Error checking quote status:', checkError);
    throw checkError;
  }

  if (existing.status !== 'pending_approval' && existing.status !== 'rejected') {
    throw new Error('Only pending approval or rejected quotes can be edited');
  }

  // Input validation
  const quantity = parseInt(formData.quantity, 10);
  if (isNaN(quantity) || quantity < 1 || quantity > 1000000) {
    throw new Error('Quantity must be between 1 and 1,000,000');
  }

  const unitPrice = formData.unit_price ? parseFloat(formData.unit_price) : null;
  if (unitPrice !== null && (isNaN(unitPrice) || unitPrice < 0 || unitPrice > 999999.99)) {
    throw new Error('Unit price must be between 0 and 999,999.99');
  }

  if (formData.description && formData.description.length > 5000) {
    throw new Error('Description cannot exceed 5000 characters');
  }

  const totalPrice = calculateTotalPrice(quantity, unitPrice);

  const baseCost = formData.base_cost ? parseFloat(formData.base_cost) : null;
  const markupPercent = formData.markup_percent ? parseFloat(formData.markup_percent) : null;

  const { data, error } = await supabase
    .from('quotes')
    .update({
      customer_id: formData.customer_id,
      part_id: formData.part_type === 'existing' && formData.part_id ? formData.part_id : null,
      description: formData.description.trim() || null,
      quantity,
      base_cost: baseCost !== null && !isNaN(baseCost) ? baseCost : null,
      markup_percent: markupPercent !== null && !isNaN(markupPercent) ? markupPercent : null,
      unit_price: unitPrice,
      total_price: totalPrice,
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

  // 1. Get quote's attachments for storage cleanup
  const { data: attachments } = await supabase
    .from('quote_attachments')
    .select('file_path')
    .eq('quote_id', quoteId)
    .eq('company_id', companyId);

  // 2. Delete storage files (best effort - don't fail if cleanup fails)
  if (attachments && attachments.length > 0) {
    for (const attachment of attachments) {
      try {
        await deleteFileFromStorage(attachment.file_path);
      } catch (storageError) {
        console.warn('Failed to delete storage file:', attachment.file_path, storageError);
        Sentry.captureException(storageError, { level: 'warning' });
        // Continue with deletion even if storage cleanup fails
      }
    }
  }

  // 3. Delete the quote record (cascade will delete attachments from DB)
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

  // 1. Get all attachments for these quotes
  const { data: attachments } = await supabase
    .from('quote_attachments')
    .select('file_path')
    .in('quote_id', validIds)
    .eq('company_id', companyId);

  // 2. Delete storage files (best effort)
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

  // 3. Delete quotes in batches
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

// ============== Status Transitions ==============

/**
 * Helper to update quote status with validation
 */
async function updateQuoteStatus(
  quoteId: string,
  expectedCurrentStatus: QuoteStatus | QuoteStatus[],
  newStatus: QuoteStatus
): Promise<Quote> {
  const supabase = getSupabase();

  const { data: existing, error: checkError } = await supabase
    .from('quotes')
    .select('status')
    .eq('id', quoteId)
    .single();

  if (checkError) {
    console.error('Error checking quote status:', checkError);
    throw checkError;
  }

  const allowedStatuses = Array.isArray(expectedCurrentStatus)
    ? expectedCurrentStatus
    : [expectedCurrentStatus];

  if (!allowedStatuses.includes(existing.status as QuoteStatus)) {
    throw new Error(`Cannot change status from ${existing.status} to ${newStatus}`);
  }

  const { data, error } = await supabase
    .from('quotes')
    .update({
      status: newStatus,
      status_changed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', quoteId)
    .select()
    .single();

  if (error) {
    console.error('Error updating quote status:', error);
    throw error;
  }

  return data;
}

/**
 * Mark quote as pending approval (rejected → pending_approval)
 */
export async function markQuoteAsPendingApproval(quoteId: string): Promise<Quote> {
  return updateQuoteStatus(quoteId, 'rejected', 'pending_approval');
}

/**
 * Mark quote as approved (pending_approval → approved)
 */
export async function markQuoteAsApproved(quoteId: string): Promise<Quote> {
  return updateQuoteStatus(quoteId, 'pending_approval', 'approved');
}

/**
 * Mark quote as rejected (pending_approval → rejected)
 */
export async function markQuoteAsRejected(quoteId: string): Promise<Quote> {
  return updateQuoteStatus(quoteId, 'pending_approval', 'rejected');
}

// ============== Convert to Job ==============

export interface ConvertToJobResult {
  quote: Quote;
  job: {
    id: string;
    job_number: string;
  };
}

/**
 * Convert an approved quote to a job.
 * Routing is auto-resolved from the part (1:1 relationship).
 */
export async function convertQuoteToJob(
  quoteId: string
): Promise<ConvertToJobResult> {
  const supabase = getSupabase();

  // 1. Get quote with full details and attachments
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

  // 2. Validate quote status
  if (quote.status !== 'approved') {
    throw new Error('Only approved quotes can be converted to jobs');
  }

  if (quote.converted_to_job_id) {
    throw new Error('This quote has already been converted to a job');
  }

  // 3. Auto-resolve routing from part (1:1 relationship)
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

  // 4. Get current user
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    throw new Error('Authentication required. Please log in and try again.');
  }

  // 5. Create job
  const { data: job, error: jobError } = await supabase
    .from('jobs')
    .insert({
      company_id: quote.company_id,
      quote_id: quoteId,
      customer_id: quote.customer_id,
      part_id: quote.part_id,
      description: quote.description,
      status: 'pending',
      created_by: user.id,
    })
    .select('id, job_number')
    .single();

  if (jobError) {
    console.error('Error creating job:', jobError);
    throw jobError;
  }

  // 6. Copy operations from routing
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

  // 7. Copy attachment if exists (non-critical — log but don't block)
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

  // 8. Update quote with job reference
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

/**
 * Get attachments for a quote
 */
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

/**
 * Get count of attachments for a quote (for UI limit enforcement)
 */
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
 * Upload a PDF attachment for a quote (pending_approval or rejected only)
 */
export async function uploadQuoteAttachment(
  quoteId: string,
  companyId: string,
  file: File
): Promise<QuoteAttachment> {
  const supabase = getSupabase();

  // 1. Validate file type
  if (file.type !== 'application/pdf') {
    throw new Error('Only PDF files are allowed');
  }

  // 2. Validate file size (50MB)
  if (file.size > MAX_FILE_SIZE) {
    throw new Error('File size must be 50MB or less');
  }

  // 3. Check quote status (must be pending_approval or rejected)
  const { data: quote, error: quoteError } = await supabase
    .from('quotes')
    .select('status')
    .eq('id', quoteId)
    .single();

  if (quoteError || !quote) {
    throw new Error('Quote not found');
  }

  if (quote.status !== 'pending_approval' && quote.status !== 'rejected') {
    throw new Error('Attachments can only be added to pending approval or rejected quotes');
  }

  // 4. Check attachment limit
  const existingCount = await getQuoteAttachmentCount(quoteId);
  if (existingCount >= MAX_ATTACHMENTS_PER_QUOTE) {
    throw new Error(
      `Maximum ${MAX_ATTACHMENTS_PER_QUOTE} attachment(s) allowed. Delete existing attachment first.`
    );
  }

  // 5. Get current user
  const { data: { user } } = await supabase.auth.getUser();

  // 6. Generate storage path
  const filePath = generateStoragePath(companyId, 'quotes', quoteId, file.name);

  // 7. Upload to storage
  await uploadFileToStorage(filePath, file);

  // 8. Create database record
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
    // Cleanup: try to delete uploaded file
    await deleteFileFromStorage(filePath).catch((err) => { console.error(err); Sentry.captureException(err, { level: 'warning' }); });
    console.error('Error creating attachment record:', insertError);
    throw new Error('Failed to save attachment');
  }

  return attachment;
}

/**
 * Delete attachment for a quote (pending_approval or rejected only)
 * @param attachmentId - The attachment ID
 * @param companyId - The company ID for security validation
 */
export async function deleteQuoteAttachment(
  attachmentId: string,
  companyId: string
): Promise<void> {
  const supabase = getSupabase();

  // 1. Get attachment with quote status, validating company ownership
  const { data: attachment, error: fetchError } = await supabase
    .from('quote_attachments')
    .select(`
      id,
      file_path,
      quotes!inner (status)
    `)
    .eq('id', attachmentId)
    .eq('company_id', companyId)
    .single();

  if (fetchError || !attachment) {
    throw new Error('Attachment not found');
  }

  // 2. Verify quote is in an editable status
  const quoteStatus = (attachment.quotes as { status: string }).status;
  if (quoteStatus !== 'pending_approval' && quoteStatus !== 'rejected') {
    throw new Error('Attachments can only be deleted from pending approval or rejected quotes');
  }

  // 3. Delete from storage
  await deleteFileFromStorage(attachment.file_path);

  // 4. Delete database record
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

  // 1. Validate file type and size
  if (newFile.type !== 'application/pdf') {
    throw new Error('Only PDF files are allowed');
  }

  if (newFile.size > MAX_FILE_SIZE) {
    throw new Error('File size must be 50MB or less');
  }

  // 2. Get existing attachment info with quote status, validating company ownership
  const { data: existing, error: fetchError } = await supabase
    .from('quote_attachments')
    .select(`
      file_path,
      quotes!inner (status)
    `)
    .eq('id', attachmentId)
    .eq('company_id', companyId)
    .single();

  if (fetchError || !existing) {
    throw new Error('Attachment not found');
  }

  const quoteStatus = (existing.quotes as { status: string }).status;
  if (quoteStatus !== 'pending_approval' && quoteStatus !== 'rejected') {
    throw new Error('Attachments can only be replaced in pending approval or rejected quotes');
  }

  const oldFilePath = existing.file_path;

  // 3. Upload NEW file first (if this fails, old file is still intact)
  const newPath = generateStoragePath(companyId, 'quotes', quoteId, newFile.name);
  await uploadFileToStorage(newPath, newFile);

  // 4. Get current user
  const { data: { user } } = await supabase.auth.getUser();

  // 5. Update database record
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
    // Cleanup: delete newly uploaded file
    await deleteFileFromStorage(newPath).catch((err) => { console.error(err); Sentry.captureException(err, { level: 'warning' }); });
    throw new Error('Failed to update attachment');
  }

  // 6. Delete old file from storage (best effort - orphaned files can be cleaned up later)
  if (oldFilePath) {
    await deleteFileFromStorage(oldFilePath)
      .catch(err => { console.warn('Failed to delete old file:', err); Sentry.captureException(err, { level: 'warning' }); });
  }

  return updated;
}

/**
 * Get signed URL for attachment download (fetch fresh each time)
 */
export async function getQuoteAttachmentUrl(filePath: string): Promise<string> {
  return getSignedUrl(filePath, 3600);
}

/**
 * Upload a PDF attachment to temporary storage (before quote is created)
 */
export async function uploadTempQuoteAttachment(
  companyId: string,
  sessionId: string,
  file: File
): Promise<TempAttachment> {
  // 1. Validate file type
  if (file.type !== 'application/pdf') {
    throw new Error('Only PDF files are allowed');
  }

  // 2. Validate file size (50MB)
  if (file.size > MAX_FILE_SIZE) {
    throw new Error('File size must be 50MB or less');
  }

  // 3. Generate temp storage path
  const filePath = generateTempStoragePath(companyId, sessionId, file.name);

  // 4. Upload to storage
  await uploadFileToStorage(filePath, file);

  return {
    file_name: file.name,
    file_path: filePath,
    file_size: file.size,
    mime_type: file.type,
  };
}

/**
 * Delete temporary attachment
 */
export async function deleteTempQuoteAttachment(filePath: string): Promise<void> {
  await deleteFileFromStorage(filePath);
}

/**
 * Move temporary attachment to permanent location (internal helper for createQuote)
 */
async function moveTempAttachmentToPermanent(
  tempAttachment: TempAttachment,
  quoteId: string,
  companyId: string
): Promise<void> {
  const supabase = getSupabase();

  // 1. Generate permanent path
  const permanentPath = generateStoragePath(
    companyId,
    'quotes',
    quoteId,
    tempAttachment.file_name
  );

  // 2. Move file in storage
  await moveFileInStorage(tempAttachment.file_path, permanentPath);

  // 3. Get current user
  const { data: { user } } = await supabase.auth.getUser();

  // 4. Create database record
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

/**
 * Copy attachment from quote to job (internal helper)
 */
async function copyAttachmentToJob(
  quoteAttachment: QuoteAttachment,
  jobId: string,
  companyId: string,
  userId: string | null
): Promise<JobAttachment> {
  const supabase = getSupabase();

  // 1. Download file from quote attachment
  const fileData = await downloadFileFromStorage(quoteAttachment.file_path);

  // 2. Generate new path for job
  const newPath = generateStoragePath(
    companyId,
    'jobs',
    jobId,
    quoteAttachment.file_name
  );

  // 3. Upload to job attachments bucket
  await uploadFileToStorage(newPath, fileData);

  // 4. Create job_attachments record
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
    // Cleanup: delete uploaded file
    await deleteFileFromStorage(newPath).catch((err) => { console.error(err); Sentry.captureException(err, { level: 'warning' }); });
    throw new Error('Failed to copy attachment to job');
  }

  return jobAttachment;
}
