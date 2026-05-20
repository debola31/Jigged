/**
 * Production-status values. Owned by operator activity — set on job_parts
 * by recomputeJobPartStatus, aggregated to the parent job via the
 * sync_job_production_status_from_parts trigger.
 */
export type ProductionStatus = 'not_started' | 'in_progress' | 'completed' | 'cancelled';

/**
 * Fulfillment-status values. Owned by shipment activity — set on job_parts
 * by compute_job_part_fulfillment_status from shipment_line_items, aggregated
 * to the parent job by the sync trigger family (PR 4). All rows are
 * 'unshipped' until PR 4 wires up the cascade.
 */
export type FulfillmentStatus = 'unshipped' | 'partially_shipped' | 'fully_shipped';

/**
 * Job operation record. Each operation belongs to one job_part — multi-part
 * jobs have several parallel operation lists, one per part.
 */
export interface JobOperation {
  id: string;
  job_id: string;
  job_part_id: string;
  sequence: number;
  operation_name: string;
  work_center_id: string | null;
  routing_operation_id: string | null;
  estimated_setup_minutes: number;
  estimated_run_minutes_per_unit: number;
  actual_setup_minutes: number | null;
  actual_run_minutes: number | null;
  status: 'pending' | 'in_progress' | 'completed';
  started_at: string | null;
  completed_at: string | null;
  assigned_to: string | null;
  completed_by: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  work_center?: {
    id: string;
    name: string;
    labor_rate: number | null;
    kind: 'internal' | 'external';
  } | null;
}

/**
 * Job (project header). Owns the customer, due date, source quote, and
 * dual aggregate statuses mirrored from job_parts. The actual part-level
 * routing, status, and timestamps live on JobPart.
 *
 * `shipped_at` is no longer a stored column — the last ship date for a
 * job is computed by the SQL helper `public.job_last_ship_date(job_id)`,
 * which sums non-voided shipments in PR 4. The TS access layer wraps
 * this as `getJobLastShipDate(jobId)` in utils/jobsAccess.ts.
 */
export interface Job {
  id: string;
  company_id: string;
  job_number: string;
  quote_id: string | null;
  customer_id: string;
  customer_po_number: string | null;
  production_status: ProductionStatus;
  fulfillment_status: FulfillmentStatus;
  status_changed_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  due_date: string | null;
  lead_time_days: number | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * One physical part / workpiece-group inside a job. Each job_part has its
 * own routing-derived operations + materials and its own production +
 * fulfillment statuses. Production is set by operator activity; fulfillment
 * is set by shipment_line_items (PR 4).
 */
export interface JobPart {
  id: string;
  job_id: string;
  company_id: string;
  part_id: string;
  source_quote_line_item_id: string | null;
  sequence: number;
  quantity: number;
  production_status: ProductionStatus;
  fulfillment_status: FulfillmentStatus;
  status_changed_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  current_operation_sequence: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * True when a job's due date has passed and it isn't done yet. A job is
 * "done" only when it's both produced (completed/cancelled) AND fully
 * shipped — the FR-18 predicate. Cancelled-and-fully-shipped jobs stop
 * the clock; cancelled-and-partially-shipped do too (the customer's
 * remaining order never ships).
 *
 * Date comparison: due_date is a YYYY-MM-DD string. JavaScript's
 * `new Date('YYYY-MM-DD')` parses as UTC midnight, which is the previous
 * calendar day in negative-UTC timezones — so `new Date('2026-05-19') <
 * localMidnight(2026-05-19)` is wrongly true in US Pacific, painting a
 * job-due-today as overdue. We parse the YMD parts directly into a
 * LOCAL date so the comparison matches both the user's intuition and
 * the server-side filter (which uses todayLocalISODate in jobsAccess).
 */
export function isJobOverdue(
  job: Pick<Job, 'due_date' | 'production_status' | 'fulfillment_status'>,
): boolean {
  if (!job.due_date) return false;
  if (isJobDone(job)) return false;
  if (job.production_status === 'cancelled') return false;
  const [y, m, d] = job.due_date.split('-').map((n) => parseInt(n, 10));
  if (!y || !m || !d) return false;
  const dueLocal = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return dueLocal < today;
}

/**
 * FR-18 "done" predicate. A job is done when production has ended
 * (completed or cancelled) AND every part is fully shipped. Used by the
 * jobs-list default filter (hide done), the dashboard active-jobs count,
 * and the overdue check above.
 */
export function isJobDone(
  job: Pick<Job, 'production_status' | 'fulfillment_status'>,
): boolean {
  return (
    (job.production_status === 'completed' || job.production_status === 'cancelled') &&
    job.fulfillment_status === 'fully_shipped'
  );
}

/**
 * Current operation info for the jobs list "Current Op" column.
 */
export interface CurrentOperationInfo {
  operationName: string;
  readyCount: number;
}

/**
 * Material expected/consumed for a (job, part). Snapshot from parts_bom at
 * job-part creation time.
 */
export type JobMaterialStatus = 'pending' | 'consumed' | 'skipped';

export interface JobMaterial {
  id: string;
  job_id: string;
  job_part_id: string;
  parts_bom_id: string | null;
  material_part_id: string;
  expected_quantity: number;
  actual_quantity: number | null;
  unit: string;
  status: JobMaterialStatus;
  consumed_at: string | null;
  consumed_by: string | null;
  created_at: string;
  updated_at: string;
  material_part?: {
    id: string;
    part_name: string;
    primary_unit: string | null;
    quantity: number;
  } | null;
}

/**
 * Hydrated JobPart with its part metadata, operations, and materials.
 */
export interface JobPartWithRelations extends JobPart {
  parts?: {
    id: string;
    part_name: string;
    description: string | null;
  } | null;
  job_operations?: JobOperation[];
  job_materials?: JobMaterial[];
}

/**
 * Job with joined relation data — used by the dashboard detail page.
 */
export interface JobWithRelations extends Job {
  customers?: {
    id: string;
    name: string;
  } | null;
  quotes?: {
    id: string;
    quote_number: string;
  } | null;
  /** One row per physical part inside the job. */
  job_parts?: JobPartWithRelations[];
  /** Summary of the most-progressed operation across parts (list view). */
  currentOperation?: CurrentOperationInfo | null;
}

/**
 * Filters for the jobs list.
 */
export interface JobFilters {
  productionStatus?: ProductionStatus[] | 'all';
  fulfillmentStatus?: FulfillmentStatus[] | 'all';
  customerId?: string;
  search?: string;
  overdue?: boolean;
  /** When true (default), hide jobs that satisfy the FR-18 done predicate. */
  excludeDone?: boolean;
}

/**
 * Production-status display configuration.
 */
export const PRODUCTION_STATUS_CONFIG: Record<
  ProductionStatus,
  { label: string; color: 'default' | 'info' | 'success' | 'error' }
> = {
  not_started: { label: 'Not Started', color: 'default' },
  in_progress: { label: 'In Progress', color: 'info' },
  completed: { label: 'Completed', color: 'success' },
  cancelled: { label: 'Cancelled', color: 'error' },
};

/**
 * Fulfillment-status display configuration.
 */
export const FULFILLMENT_STATUS_CONFIG: Record<
  FulfillmentStatus,
  { label: string; color: 'default' | 'info' | 'success' }
> = {
  unshipped: { label: 'Not Shipped', color: 'default' },
  partially_shipped: { label: 'Partially Shipped', color: 'info' },
  fully_shipped: { label: 'Shipped', color: 'success' },
};

// ============== Operation Types ==============

/**
 * Operation status values.
 */
export type OperationStatus = 'pending' | 'in_progress' | 'completed';

/**
 * Operation status display configuration.
 */
export const OPERATION_STATUS_CONFIG: Record<
  OperationStatus,
  { label: string; color: 'default' | 'info' | 'success' }
> = {
  pending: { label: 'Pending', color: 'default' },
  in_progress: { label: 'In Progress', color: 'info' },
  completed: { label: 'Completed', color: 'success' },
};

/**
 * Data for completing an operation.
 */
export interface CompleteOperationData {
  actual_setup_minutes?: number;
  actual_run_minutes?: number;
  notes?: string;
}

/**
 * Result of an operation update with status-change info — emitted by
 * operatorAccess.completeOperation so the UI can display status transitions.
 */
export interface OperationUpdateResult {
  operation: JobOperation;
  /** True when this operation finished the parent job_part (job_part flipped to completed). */
  jobPartStatusChanged: boolean;
  newJobPartProductionStatus?: ProductionStatus;
  /** True when the parent job's aggregate status changed as a side effect. */
  jobStatusChanged: boolean;
  newJobProductionStatus?: ProductionStatus;
}
