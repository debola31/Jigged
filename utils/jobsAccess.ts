// Adopt the typed Supabase client so every .from('jobs').select(...) chain
// is validated against types/database.ts at compile time. Aliased to
// getSupabase so the dozens of call sites below don't need renaming —
// this also keeps the diff small for review. See CLAUDE.md "Typed
// Supabase client (incremental adoption)" for the rollout contract.
import { getTypedSupabase as getSupabase } from '@/lib/supabase';
import { friendlyErrorMessage } from '@/lib/supabaseErrors';
import type { Database } from '@/types/database';

// Update payloads for tables this file mutates conditionally. The typed
// `.update(...)` call rejects bare Record<string, unknown> because it
// can't verify the keys against the table schema; using the generated
// Update types preserves the column-name check.
type JobPartUpdate = Database['public']['Tables']['job_parts']['Update'];
type JobMaterialUpdate = Database['public']['Tables']['job_materials']['Update'];
type JobOperationUpdate = Database['public']['Tables']['job_operations']['Update'];
import type {
  Job,
  JobWithRelations,
  JobFilters,
  ProductionStatus,
  JobOperation,
  JobMaterial,
  CompleteOperationData,
  OperationUpdateResult,
  CurrentOperationInfo,
} from '@/types/job';
import { isJobDone } from '@/types/job';

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
      customers!left(id, name),
      quotes!jobs_quote_id_fkey(id, quote_number),
      job_parts(
        *,
        parts(id, part_name, description),
        job_operations(
          *,
          work_center:work_centers!left(id, name, labor_rate, kind)
        ),
        job_materials(
          *,
          material_part:parts!job_materials_material_part_id_fkey(id, part_name, primary_unit, quantity)
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

  const patch: JobMaterialUpdate = {
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
      material_part:parts!job_materials_material_part_id_fkey(id, part_name, primary_unit, quantity)
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
    throw new Error(
      friendlyErrorMessage(error, { entity: 'job', fallback: 'Failed to delete job.' }),
    );
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
      throw new Error(
        friendlyErrorMessage(error, { entity: 'job', fallback: 'Failed to delete jobs.' }),
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
  type OpStatus = { status: string };
  const opRows = (ops ?? []) as OpStatus[];
  if (opRows.length === 0) {
    return { changed: false, newStatus: part.production_status as ProductionStatus };
  }

  const allDone = opRows.every((o) => o.status === 'completed');
  const anyTouched = opRows.some((o) => o.status !== 'pending');

  let newStatus: ProductionStatus;
  if (allDone) newStatus = 'completed';
  else if (anyTouched) newStatus = 'in_progress';
  else newStatus = 'not_started';

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
 * Complete a job_operation with optional time-entry data. Flips the
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
 * Undo a completed job_operation back to pending. Clears timestamps,
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
