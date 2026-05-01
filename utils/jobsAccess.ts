import { getSupabase } from '@/lib/supabase';
import type {
  Job,
  JobWithRelations,
  JobFilters,
  JobStatus,
  JobOperation,
  JobMaterial,
  CompleteOperationData,
  OperationUpdateResult,
  CurrentOperationInfo,
} from '@/types/job';

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

  while (hasMore) {
    let query = supabase
      .from('jobs')
      .select(`
        *,
        customers!left(id, name),
        quotes!jobs_quote_id_fkey(id, quote_number),
        job_parts(
          id, sequence, quantity, status,
          parts(id, part_name, description)
        )
      `)
      .eq('company_id', companyId)
      .order(sortField, { ascending: sortDirection === 'asc' })
      .range(offset, offset + BATCH_SIZE - 1);

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
      customers!left(id, name),
      quotes!jobs_quote_id_fkey(id, quote_number),
      job_parts(
        *,
        parts(id, part_name, description),
        job_operations(
          *,
          operation_types!left(id, name, labor_rate)
        ),
        job_materials(
          *,
          inventory_item:inventory_items(id, name, primary_unit, quantity, cost_per_unit)
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

// ============== Job Materials ==============

/**
 * Update a job material (e.g., record actual quantity, mark consumed).
 * Pass status='consumed' to also stamp consumed_at/consumed_by.
 */
export async function updateJobMaterial(
  materialId: string,
  updates: Partial<Pick<JobMaterial, 'actual_quantity' | 'unit' | 'status' | 'expected_quantity'>>,
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

// ============== Job Lifecycle ==============

/**
 * Delete a job. Cascades remove job_parts, job_operations, and job_materials.
 * (job_attachments was dropped in the pilot cleanup migration; nothing to
 * orphan in storage.)
 */
export async function deleteJob(jobId: string, companyId: string): Promise<void> {
  const supabase = getSupabase();

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
 * Bulk delete jobs.
 */
export async function bulkDeleteJobs(jobIds: string[], companyId: string): Promise<void> {
  if (jobIds.length === 0) return;
  const validIds = jobIds.filter((id) => id && typeof id === 'string');
  if (validIds.length === 0) return;

  const supabase = getSupabase();
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

/**
 * Mark all of a job's parts as cancelled. The status-aggregation trigger on
 * job_parts then flips jobs.status to 'cancelled'.
 */
export async function cancelJob(jobId: string): Promise<Job> {
  const supabase = getSupabase();

  const { error: partsError } = await supabase
    .from('job_parts')
    .update({
      status: 'cancelled',
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
 * Mark all of a job's parts as shipped (only valid when every part is
 * already 'completed'). Trigger flips jobs.status to 'shipped'.
 */
export async function shipJob(jobId: string): Promise<Job> {
  const supabase = getSupabase();

  const { data: parts, error: readErr } = await supabase
    .from('job_parts')
    .select('id, status')
    .eq('job_id', jobId);

  if (readErr) {
    console.error('Error reading job parts to ship:', readErr);
    throw readErr;
  }
  type PartRow = { id: string; status: string };
  const partRows = (parts ?? []) as PartRow[];
  if (partRows.length === 0) {
    throw new Error('Cannot ship: job has no parts.');
  }
  const notReady = partRows.filter((p) => p.status !== 'completed' && p.status !== 'shipped');
  if (notReady.length > 0) {
    throw new Error('Cannot ship: not every part on the job is completed yet.');
  }

  const nowIso = new Date().toISOString();
  const { error: shipErr } = await supabase
    .from('job_parts')
    .update({
      status: 'shipped',
      shipped_at: nowIso,
      status_changed_at: nowIso,
      updated_at: nowIso,
    })
    .eq('job_id', jobId)
    .neq('status', 'shipped');

  if (shipErr) {
    console.error('Error shipping job parts:', shipErr);
    throw shipErr;
  }

  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (error) {
    console.error('Error fetching shipped job:', error);
    throw error;
  }
  return data as Job;
}

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
      operation_types!left(id, name, labor_rate)
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
 * Recompute a job_part's status from its operations and persist the change
 * if it differs from the current value. Returns the resolved status and a
 * flag indicating whether it changed. Skips when the part is already in a
 * terminal user-initiated state (cancelled/shipped).
 */
async function recomputeJobPartStatus(
  jobPartId: string,
): Promise<{ changed: boolean; newStatus: JobStatus }> {
  const supabase = getSupabase();

  const { data: part, error: partErr } = await supabase
    .from('job_parts')
    .select('status, started_at, completed_at')
    .eq('id', jobPartId)
    .single();
  if (partErr || !part) {
    throw partErr || new Error('job_part not found');
  }

  if (part.status === 'cancelled' || part.status === 'shipped') {
    return { changed: false, newStatus: part.status as JobStatus };
  }

  const { data: ops, error: opsErr } = await supabase
    .from('job_operations')
    .select('status')
    .eq('job_part_id', jobPartId);
  if (opsErr) throw opsErr;
  type OpStatus = { status: string };
  const opRows = (ops ?? []) as OpStatus[];
  if (opRows.length === 0) {
    return { changed: false, newStatus: part.status as JobStatus };
  }

  const allDone = opRows.every((o) => o.status === 'completed' || o.status === 'skipped');
  const hasCompleted = opRows.some((o) => o.status === 'completed');
  const anyTouched = opRows.some((o) => o.status !== 'pending');

  let newStatus: JobStatus;
  if (allDone && hasCompleted) newStatus = 'completed';
  else if (anyTouched) newStatus = 'in_progress';
  else newStatus = 'not_started';

  if (newStatus === part.status) {
    return { changed: false, newStatus };
  }

  const nowIso = new Date().toISOString();
  const updates: Record<string, unknown> = {
    status: newStatus,
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
    console.error('Error updating job_part status:', updErr);
    throw updErr;
  }

  return { changed: true, newStatus };
}

/**
 * Snapshot the parent job's status before/after a job_part update so the
 * caller can react when the aggregation trigger flips it (e.g., to celebrate
 * the entire job finishing).
 */
async function detectJobStatusChange(
  jobId: string,
  before: JobStatus,
): Promise<{ changed: boolean; newStatus?: JobStatus }> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('jobs')
    .select('status')
    .eq('id', jobId)
    .single();
  if (error || !data) return { changed: false };
  const newStatus = data.status as JobStatus;
  if (newStatus === before) return { changed: false };
  return { changed: true, newStatus };
}

async function getJobIdForOperation(
  operationId: string,
): Promise<{ jobId: string; jobPartId: string; jobStatus: JobStatus }> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('job_operations')
    .select('job_id, job_part_id, jobs(status)')
    .eq('id', operationId)
    .single();
  if (error || !data) throw error || new Error('operation not found');
  type OpRow = {
    job_id: string;
    job_part_id: string;
    jobs?: { status: string } | { status: string }[] | null;
  };
  const row = data as OpRow;
  const jobsField = row.jobs;
  const jobsRow = Array.isArray(jobsField) ? jobsField[0] : jobsField;
  if (!jobsRow) throw new Error('parent job not found');
  return {
    jobId: row.job_id,
    jobPartId: row.job_part_id,
    jobStatus: jobsRow.status as JobStatus,
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
      operation_types!left(id, name, labor_rate)
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
    newJobPartStatus: partResult.changed ? partResult.newStatus : undefined,
    jobStatusChanged: jobResult.changed,
    newJobStatus: jobResult.newStatus,
  };
}

/**
 * Complete a job_operation with optional time-entry data. Flips the
 * job_part to 'completed' once every op on that part is completed/skipped.
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

  const updateData: Record<string, unknown> = {
    status: 'completed',
    completed_at: new Date().toISOString(),
    completed_by: user?.id || null,
    updated_at: new Date().toISOString(),
  };
  if (data.actual_setup_minutes !== undefined) updateData.actual_setup_minutes = data.actual_setup_minutes;
  if (data.actual_run_minutes !== undefined) updateData.actual_run_minutes = data.actual_run_minutes;
  if (data.notes !== undefined) updateData.notes = data.notes;

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

  const partResult = await recomputeJobPartStatus(ctx.jobPartId);
  const jobResult = await detectJobStatusChange(ctx.jobId, ctx.jobStatus);

  return {
    operation: operation as JobOperation,
    jobPartStatusChanged: partResult.changed,
    newJobPartStatus: partResult.changed ? partResult.newStatus : undefined,
    jobStatusChanged: jobResult.changed,
    newJobStatus: jobResult.newStatus,
  };
}

/**
 * Skip a job_operation with optional reason.
 */
export async function skipJobOperation(
  operationId: string,
  jobId: string,
  reason?: string,
): Promise<OperationUpdateResult> {
  const supabase = getSupabase();
  const ctx = await getJobIdForOperation(operationId);
  void jobId;

  const updateData: Record<string, unknown> = {
    status: 'skipped',
    updated_at: new Date().toISOString(),
  };
  if (reason) updateData.notes = reason;

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

  const partResult = await recomputeJobPartStatus(ctx.jobPartId);
  const jobResult = await detectJobStatusChange(ctx.jobId, ctx.jobStatus);

  return {
    operation: operation as JobOperation,
    jobPartStatusChanged: partResult.changed,
    newJobPartStatus: partResult.changed ? partResult.newStatus : undefined,
    jobStatusChanged: jobResult.changed,
    newJobStatus: jobResult.newStatus,
  };
}

/**
 * Undo a job_operation (completed/skipped → pending). Clears timestamps,
 * actuals, and completed_by. Recomputes the parent job_part status (it may
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
 * Count jobs that are past their due date and not yet completed/shipped/cancelled.
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
  limit: number = 50,
): Promise<JobWithRelations[]> {
  const supabase = getSupabase();
  const today = new Date().toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('jobs')
    .select(`
      *,
      customers!left(id, name),
      job_parts(id, sequence, parts(id, part_name))
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
