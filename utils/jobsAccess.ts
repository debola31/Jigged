import * as Sentry from '@sentry/nextjs';
import { getSupabase } from '@/lib/supabase';
import type {
  Job,
  JobWithRelations,
  JobFormData,
  JobFilters,
  JobStatus,
  JobOperation,
  JobAttachment,
  JobMaterial,
  CompleteOperationData,
  OperationUpdateResult,
  CurrentOperationInfo,
} from '@/types/job';
import {
  deleteFileFromStorage,
  getSignedUrl,
} from './storageHelpers';

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

// ============== CRUD Operations ==============

/**
 * Get all jobs for a company (batch fetch for AG Grid).
 * Fetches in batches of 1000 to bypass Supabase's default row limit.
 */
export async function getAllJobs(
  companyId: string,
  filters: JobFilters = {},
  sortField: string = 'created_at',
  sortDirection: 'asc' | 'desc' = 'desc'
): Promise<JobWithRelations[]> {
  const supabase = getSupabase();
  const BATCH_SIZE = 1000;
  let allData: JobWithRelations[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    let query = supabase
      .from('jobs')
      .select(
        `
        *,
        customers!left(id, name),
        parts!left(id, part_name, description),
        quotes!jobs_quote_id_fkey(id, quote_number, total_price)
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
      const sanitized = sanitizeSearchString(filters.search.trim());
      query = query.or(`job_number.ilike.%${sanitized}%`);
    }

    if (filters.overdue) {
      const today = new Date().toISOString().slice(0, 10);
      query = query
        .not('due_date', 'is', null)
        .lt('due_date', today)
        .not('status', 'in', '(completed,shipped,cancelled)');
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

  return allData;
}

/**
 * Get a single job with all relations
 */
export async function getJobWithRelations(
  jobId: string,
  companyId: string
): Promise<JobWithRelations | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('jobs')
    .select(
      `
      *,
      customers!left(id, name),
      parts!left(id, part_name, description),
      quotes!jobs_quote_id_fkey(id, quote_number, total_price),
      job_operations(
        *,
        operation_types!left(id, name, labor_rate)
      ),
      job_materials(
        *,
        inventory_item:inventory_items(id, name, primary_unit, quantity, cost_per_unit)
      ),
      job_attachments(*)
    `
    )
    .eq('id', jobId)
    .eq('company_id', companyId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching job with relations:', error);
    throw error;
  }

  // Sort operations by sequence
  if (data?.job_operations) {
    data.job_operations.sort((a: JobOperation, b: JobOperation) => a.sequence - b.sequence);
  }

  return data as JobWithRelations | null;
}

// ============== Job Materials ==============

/**
 * Fetch the materials for a single job (joined with inventory item info).
 */
export async function getJobMaterials(jobId: string): Promise<JobMaterial[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('job_materials')
    .select(`
      *,
      inventory_item:inventory_items(id, name, primary_unit, quantity, cost_per_unit)
    `)
    .eq('job_id', jobId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Error fetching job materials:', error);
    throw error;
  }

  return (data as JobMaterial[]) || [];
}

/**
 * Update a job material (e.g., record actual quantity, mark consumed).
 * Pass status='consumed' to also stamp consumed_at/consumed_by.
 */
export async function updateJobMaterial(
  materialId: string,
  updates: Partial<Pick<JobMaterial, 'actual_quantity' | 'unit' | 'status' | 'expected_quantity'>>
): Promise<JobMaterial> {
  const supabase = getSupabase();

  const patch: Record<string, unknown> = {
    ...updates,
    updated_at: new Date().toISOString(),
  };

  if (updates.status === 'consumed') {
    patch.consumed_at = new Date().toISOString();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) patch.consumed_by = user.id;
  }

  const { data, error } = await supabase
    .from('job_materials')
    .update(patch)
    .eq('id', materialId)
    .select(`
      *,
      inventory_item:inventory_items(id, name, primary_unit, quantity, cost_per_unit)
    `)
    .single();

  if (error) {
    console.error('Error updating job material:', error);
    throw error;
  }

  return data as JobMaterial;
}

/**
 * Create a new job directly (not from quote)
 */
export async function createJob(
  companyId: string,
  formData: JobFormData
): Promise<Job> {
  const supabase = getSupabase();

  if (!formData.customer_id) {
    throw new Error('Customer is required');
  }

  if (!formData.part_id) {
    throw new Error('Part is required');
  }

  // Auto-resolve routing from part (1:1 relationship)
  const { data: routing, error: routingError } = await supabase
    .from('routings')
    .select('id')
    .eq('part_id', formData.part_id)
    .maybeSingle();

  if (routingError) {
    console.error('Error fetching routing for part:', routingError);
    throw routingError;
  }

  if (!routing) {
    throw new Error('No routing defined for this part. Create a routing before creating a job.');
  }

  // Get current user
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    throw new Error('Authentication required. Please log in and try again.');
  }

  const leadTimeDays = formData.lead_time_days ? parseInt(formData.lead_time_days, 10) : null;
  if (leadTimeDays !== null && (isNaN(leadTimeDays) || leadTimeDays < 0 || leadTimeDays > 3650)) {
    throw new Error('Lead time must be between 0 and 3,650 days');
  }

  const { data, error } = await supabase
    .from('jobs')
    .insert({
      company_id: companyId,
      customer_id: formData.customer_id,
      part_id: formData.part_id,
      status: 'not_started',
      due_date: formData.due_date || null,
      lead_time_days: leadTimeDays,
      created_by: user.id,
      // job_number is auto-generated by database trigger
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating job:', error);
    throw error;
  }

  // Copy operations from routing to job
  try {
    await createJobOperationsFromRouting(data.id, routing.id);
  } catch (opsError) {
    console.error('Failed to copy operations from routing:', opsError);
  }

  return data;
}

/**
 * Update an existing job
 */
export async function updateJob(jobId: string, formData: JobFormData): Promise<Job> {
  const supabase = getSupabase();

  // First check if job can be edited (only not_started jobs are editable)
  const { data: existing, error: checkError } = await supabase
    .from('jobs')
    .select('status')
    .eq('id', jobId)
    .single();

  if (checkError) {
    console.error('Error checking job status:', checkError);
    throw checkError;
  }

  // Allow editing of due_date and lead_time_days on jobs in any status except
  // cancelled/shipped. For not_started jobs, all fields remain editable.
  const canEditAllFields = existing.status === 'not_started';
  const canEditScheduling = existing.status !== 'cancelled' && existing.status !== 'shipped';

  if (!canEditScheduling) {
    throw new Error('Shipped or cancelled jobs cannot be edited');
  }

  const leadTimeDays = formData.lead_time_days ? parseInt(formData.lead_time_days, 10) : null;
  if (leadTimeDays !== null && (isNaN(leadTimeDays) || leadTimeDays < 0 || leadTimeDays > 3650)) {
    throw new Error('Lead time must be between 0 and 3,650 days');
  }

  const updatePatch: Record<string, unknown> = {
    due_date: formData.due_date || null,
    lead_time_days: leadTimeDays,
    updated_at: new Date().toISOString(),
  };

  if (canEditAllFields) {
    updatePatch.customer_id = formData.customer_id;
    updatePatch.part_id = formData.part_id || null;
  }

  const { data, error } = await supabase
    .from('jobs')
    .update(updatePatch)
    .eq('id', jobId)
    .select()
    .single();

  if (error) {
    console.error('Error updating job:', error);
    throw error;
  }

  return data;
}

/**
 * Delete a job and its attachments from storage
 */
export async function deleteJob(jobId: string, companyId: string): Promise<void> {
  const supabase = getSupabase();

  // 1. Get job's attachments for storage cleanup
  const { data: attachments } = await supabase
    .from('job_attachments')
    .select('file_path')
    .eq('job_id', jobId)
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

  // 3. Delete the job record (cascade will delete operations and attachments from DB)
  const { error } = await supabase
    .from('jobs')
    .delete()
    .eq('id', jobId)
    .eq('company_id', companyId);

  if (error) {
    console.error('Error deleting job:', error);
    throw error;
  }
}

/**
 * Bulk delete jobs and their attachments
 */
export async function bulkDeleteJobs(jobIds: string[], companyId: string): Promise<void> {
  if (jobIds.length === 0) return;

  const validIds = jobIds.filter((id) => id && typeof id === 'string');
  if (validIds.length === 0) return;

  const supabase = getSupabase();

  // 1. Get all attachments for these jobs
  const { data: attachments } = await supabase
    .from('job_attachments')
    .select('file_path')
    .in('job_id', validIds)
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

  // 3. Delete jobs in batches
  const BATCH_SIZE = 100;
  for (let i = 0; i < validIds.length; i += BATCH_SIZE) {
    const batch = validIds.slice(i, i + BATCH_SIZE);

    const { error } = await supabase
      .from('jobs')
      .delete()
      .in('id', batch)
      .eq('company_id', companyId);

    if (error) {
      console.error('Error bulk deleting jobs:', error);
      throw new Error(error.message || 'Failed to delete jobs');
    }
  }
}

// ============== Status Transitions ==============

/**
 * Helper to update job status with validation
 */
async function updateJobStatus(
  jobId: string,
  expectedCurrentStatus: JobStatus | JobStatus[],
  newStatus: JobStatus,
  additionalUpdates: Record<string, unknown> = {}
): Promise<Job> {
  const supabase = getSupabase();

  const { data: existing, error: checkError } = await supabase
    .from('jobs')
    .select('status')
    .eq('id', jobId)
    .single();

  if (checkError) {
    console.error('Error checking job status:', checkError);
    throw checkError;
  }

  const allowedStatuses = Array.isArray(expectedCurrentStatus)
    ? expectedCurrentStatus
    : [expectedCurrentStatus];

  if (!allowedStatuses.includes(existing.status as JobStatus)) {
    throw new Error(`Cannot change status from ${existing.status} to ${newStatus}`);
  }

  const { data, error } = await supabase
    .from('jobs')
    .update({
      status: newStatus,
      ...additionalUpdates,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId)
    .select()
    .single();

  if (error) {
    console.error('Error updating job status:', error);
    throw error;
  }

  return data;
}

/**
 * Start a job (NOT_STARTED → IN_PROGRESS)
 */
export async function startJob(jobId: string): Promise<Job> {
  return updateJobStatus(jobId, 'not_started', 'in_progress', {
    started_at: new Date().toISOString(),
  });
}

/**
 * Complete a job (IN_PROGRESS → COMPLETED)
 */
export async function completeJob(jobId: string): Promise<Job> {
  return updateJobStatus(jobId, 'in_progress', 'completed', {
    completed_at: new Date().toISOString(),
  });
}

/**
 * Ship a job (COMPLETED → SHIPPED)
 */
export async function shipJob(jobId: string): Promise<Job> {
  return updateJobStatus(jobId, 'completed', 'shipped', {
    shipped_at: new Date().toISOString(),
  });
}

/**
 * Cancel a job (any status → CANCELLED)
 */
export async function cancelJob(jobId: string): Promise<Job> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('jobs')
    .update({
      status: 'cancelled',
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId)
    .select()
    .single();

  if (error) {
    console.error('Error cancelling job:', error);
    throw error;
  }

  return data;
}

// ============== Operations ==============

/**
 * Get operations for a job
 */
export async function getJobOperations(jobId: string): Promise<JobOperation[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('job_operations')
    .select(`
      *,
      operation_types!left(id, name, labor_rate)
    `)
    .eq('job_id', jobId)
    .order('sequence', { ascending: true });

  if (error) {
    console.error('Error fetching job operations:', error);
    throw error;
  }

  return (data || []) as JobOperation[];
}

/**
 * Create job operations from a routing
 */
export async function createJobOperationsFromRouting(
  jobId: string,
  routingId: string
): Promise<number> {
  const supabase = getSupabase();

  // Use the database function to create operations
  const { data, error } = await supabase.rpc('create_job_operations_from_routing', {
    p_job_id: jobId,
    p_routing_id: routingId,
  });

  if (error) {
    console.error('Error creating job operations from routing:', error);
    throw error;
  }

  return data as number;
}

/**
 * Update a job operation
 */
export async function updateJobOperation(
  operationId: string,
  updates: {
    status?: JobOperation['status'];
    actual_setup_minutes?: number;
    actual_run_minutes?: number;
    notes?: string;
  }
): Promise<JobOperation> {
  const supabase = getSupabase();

  // Get current user for completed_by
  const { data: { user } } = await supabase.auth.getUser();

  const updateData: Record<string, unknown> = {
    ...updates,
    updated_at: new Date().toISOString(),
  };

  // Set timestamps based on status changes
  if (updates.status === 'in_progress') {
    updateData.started_at = new Date().toISOString();
  } else if (updates.status === 'completed') {
    updateData.completed_at = new Date().toISOString();
    updateData.completed_by = user?.id || null;
  }

  const { data, error } = await supabase
    .from('job_operations')
    .update(updateData)
    .eq('id', operationId)
    .select(`
      *,
      operation_types!left(id, name, labor_rate)
    `)
    .single();

  if (error) {
    console.error('Error updating job operation:', error);
    throw error;
  }

  return data as JobOperation;
}

// ============== Operation Step-Through Functions ==============

/**
 * Check if all operations are done (completed or skipped)
 * and at least one is completed (not all skipped)
 */
async function checkAllOperationsDone(jobId: string): Promise<{
  allDone: boolean;
  hasAtLeastOneCompleted: boolean;
}> {
  const supabase = getSupabase();

  const { data: operations, error } = await supabase
    .from('job_operations')
    .select('status')
    .eq('job_id', jobId);

  if (error) {
    console.error('Error checking operations status:', error);
    throw error;
  }

  if (!operations || operations.length === 0) {
    return { allDone: false, hasAtLeastOneCompleted: false };
  }

  const allDone = operations.every(
    (op: { status: string }) => op.status === 'completed' || op.status === 'skipped'
  );
  const hasAtLeastOneCompleted = operations.some(
    (op: { status: string }) => op.status === 'completed'
  );

  return { allDone, hasAtLeastOneCompleted };
}

/**
 * Start a job operation (pending → in_progress)
 * Auto-starts the job if this is the first operation and job is pending
 * Only one operation can be in_progress at a time
 */
export async function startJobOperation(
  operationId: string,
  jobId: string
): Promise<OperationUpdateResult> {
  const supabase = getSupabase();

  // Check if there's already an in_progress operation
  const { data: inProgressOps, error: checkError } = await supabase
    .from('job_operations')
    .select('id')
    .eq('job_id', jobId)
    .eq('status', 'in_progress');

  if (checkError) {
    console.error('Error checking in-progress operations:', checkError);
    throw checkError;
  }

  if (inProgressOps && inProgressOps.length > 0) {
    throw new Error('Another operation is already in progress. Complete it first.');
  }

  // Update the operation to in_progress
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
      operation_types!left(id, name, labor_rate)
    `)
    .single();

  if (updateError) {
    console.error('Error starting operation:', updateError);
    throw updateError;
  }

  // Check if job needs to be auto-started
  const { data: job, error: jobError } = await supabase
    .from('jobs')
    .select('status')
    .eq('id', jobId)
    .single();

  if (jobError) {
    console.error('Error fetching job status:', jobError);
    throw jobError;
  }

  let jobStatusChanged = false;
  let newJobStatus: JobStatus | undefined;

  if (job.status === 'not_started') {
    // Auto-start the job
    const { error: startError } = await supabase
      .from('jobs')
      .update({
        status: 'in_progress',
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    if (startError) {
      console.error('Error auto-starting job:', startError);
      // Don't throw, operation was already started
    } else {
      jobStatusChanged = true;
      newJobStatus = 'in_progress';
    }
  }

  return {
    operation: operation as JobOperation,
    jobStatusChanged,
    newJobStatus,
  };
}

/**
 * Complete a job operation with optional time entry
 * Auto-completes the job if all operations are done
 */
export async function completeJobOperation(
  operationId: string,
  jobId: string,
  data: CompleteOperationData = {}
): Promise<OperationUpdateResult> {
  const supabase = getSupabase();

  // Get current user for completed_by
  const { data: { user } } = await supabase.auth.getUser();

  const updateData: Record<string, unknown> = {
    status: 'completed',
    completed_at: new Date().toISOString(),
    completed_by: user?.id || null,
    updated_at: new Date().toISOString(),
  };

  if (data.actual_setup_minutes !== undefined) {
    updateData.actual_setup_minutes = data.actual_setup_minutes;
  }
  if (data.actual_run_minutes !== undefined) {
    updateData.actual_run_minutes = data.actual_run_minutes;
  }
  if (data.notes !== undefined) {
    updateData.notes = data.notes;
  }

  const { data: operation, error: updateError } = await supabase
    .from('job_operations')
    .update(updateData)
    .eq('id', operationId)
    .eq('status', 'in_progress')
    .select(`
      *,
      operation_types!left(id, name, labor_rate)
    `)
    .single();

  if (updateError) {
    console.error('Error completing operation:', updateError);
    throw updateError;
  }

  // Check if job should be auto-completed
  const { allDone, hasAtLeastOneCompleted } = await checkAllOperationsDone(jobId);

  let jobStatusChanged = false;
  let newJobStatus: JobStatus | undefined;

  if (allDone && hasAtLeastOneCompleted) {
    // Check current job status
    const { data: job, error: jobError } = await supabase
      .from('jobs')
      .select('status')
      .eq('id', jobId)
      .single();

    if (!jobError && job.status === 'in_progress') {
      // Auto-complete the job
      const { error: completeError } = await supabase
        .from('jobs')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId);

      if (!completeError) {
        jobStatusChanged = true;
        newJobStatus = 'completed';
      }
    }
  }

  return {
    operation: operation as JobOperation,
    jobStatusChanged,
    newJobStatus,
  };
}

/**
 * Skip a job operation with optional reason
 * Auto-completes the job if all operations are done (requires at least 1 completed)
 */
export async function skipJobOperation(
  operationId: string,
  jobId: string,
  reason?: string
): Promise<OperationUpdateResult> {
  const supabase = getSupabase();

  const updateData: Record<string, unknown> = {
    status: 'skipped',
    updated_at: new Date().toISOString(),
  };

  if (reason) {
    updateData.notes = reason;
  }

  const { data: operation, error: updateError } = await supabase
    .from('job_operations')
    .update(updateData)
    .eq('id', operationId)
    .eq('status', 'pending')
    .select(`
      *,
      operation_types!left(id, name, labor_rate)
    `)
    .single();

  if (updateError) {
    console.error('Error skipping operation:', updateError);
    throw updateError;
  }

  // Check if job should be auto-completed
  const { allDone, hasAtLeastOneCompleted } = await checkAllOperationsDone(jobId);

  let jobStatusChanged = false;
  let newJobStatus: JobStatus | undefined;

  if (allDone && hasAtLeastOneCompleted) {
    // Check current job status
    const { data: job, error: jobError } = await supabase
      .from('jobs')
      .select('status')
      .eq('id', jobId)
      .single();

    if (!jobError && job.status === 'in_progress') {
      // Auto-complete the job
      const { error: completeError } = await supabase
        .from('jobs')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId);

      if (!completeError) {
        jobStatusChanged = true;
        newJobStatus = 'completed';
      }
    }
  }

  return {
    operation: operation as JobOperation,
    jobStatusChanged,
    newJobStatus,
  };
}

/**
 * Undo a job operation (completed/skipped → pending)
 * Clears timestamps, hours, and completed_by
 * Does NOT revert job status
 */
export async function undoJobOperation(operationId: string): Promise<JobOperation> {
  const supabase = getSupabase();

  const { data: operation, error } = await supabase
    .from('job_operations')
    .update({
      status: 'pending',
      started_at: null,
      completed_at: null,
      completed_by: null,
      actual_setup_minutes: null,
      actual_run_minutes: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', operationId)
    .in('status', ['completed', 'skipped'])
    .select(`
      *,
      operation_types!left(id, name, labor_rate)
    `)
    .single();

  if (error) {
    console.error('Error undoing operation:', error);
    throw error;
  }

  return operation as JobOperation;
}

// ============== Attachments ==============

/**
 * Get attachments for a job
 */
export async function getJobAttachments(jobId: string): Promise<JobAttachment[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('job_attachments')
    .select('*')
    .eq('job_id', jobId)
    .order('uploaded_at', { ascending: false });

  if (error) {
    console.error('Error fetching job attachments:', error);
    throw error;
  }

  return data || [];
}

/**
 * Get signed URL for job attachment download
 */
export async function getJobAttachmentUrl(filePath: string): Promise<string> {
  return getSignedUrl(filePath, 3600);
}

// ============== Helper Functions ==============

/**
 * Get customers for dropdown (simple list)
 */
export async function getCustomersForSelect(
  companyId: string
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
 * Count jobs that are past their due date and not yet completed/shipped/cancelled.
 * Used by the dashboard "Overdue jobs" tile. "Overdue" is derived, never stored.
 */
export async function getOverdueJobsCount(companyId: string): Promise<number> {
  const supabase = getSupabase();
  const today = new Date().toISOString().slice(0, 10);

  const { count, error } = await supabase
    .from('jobs')
    .select('*', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .not('due_date', 'is', null)
    .lt('due_date', today)
    .not('status', 'in', '(completed,shipped,cancelled)');

  if (error) {
    console.error('Error fetching overdue jobs count:', error);
    throw error;
  }

  return count || 0;
}

/**
 * Fetch overdue jobs for dashboard/list use.
 */
export async function getOverdueJobs(
  companyId: string,
  limit: number = 50
): Promise<JobWithRelations[]> {
  const supabase = getSupabase();
  const today = new Date().toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('jobs')
    .select(`
      *,
      customers!left(id, name),
      parts!left(id, part_name, description)
    `)
    .eq('company_id', companyId)
    .not('due_date', 'is', null)
    .lt('due_date', today)
    .not('status', 'in', '(completed,shipped,cancelled)')
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
 * Get ready/current operations for a batch of jobs.
 * Calls the get_ready_operations_batch DB function which returns
 * in-progress or DAG-aware ready operations per job.
 */
export async function getReadyOperationsForJobs(
  jobIds: string[]
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
