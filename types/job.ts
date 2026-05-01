/**
 * Job status values. Applied at the job (project header) level — derived from
 * the aggregate of its job_parts via a Postgres trigger — and at the
 * job_part level — owned by the operator workflow.
 */
export type JobStatus = 'not_started' | 'in_progress' | 'completed' | 'shipped' | 'cancelled';

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
  operation_type_id: string | null;
  routing_node_id: string | null;
  estimated_setup_minutes: number;
  estimated_run_minutes_per_unit: number;
  actual_setup_minutes: number | null;
  actual_run_minutes: number | null;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  started_at: string | null;
  completed_at: string | null;
  assigned_to: string | null;
  completed_by: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  operation_type?: {
    id: string;
    name: string;
    labor_rate: number | null;
  } | null;
}

/**
 * Job (project header). Owns the customer, due date, source quote, and an
 * aggregate status mirrored from job_parts. The actual part-level routing,
 * status, and timestamps live on JobPart.
 */
export interface Job {
  id: string;
  company_id: string;
  job_number: string;
  quote_id: string | null;
  customer_id: string;
  status: JobStatus;
  status_changed_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  shipped_at: string | null;
  due_date: string | null;
  lead_time_days: number | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * One physical part / workpiece-group inside a job. Each job_part has its own
 * routing-derived operations + materials, status, and timestamps.
 */
export interface JobPart {
  id: string;
  job_id: string;
  company_id: string;
  part_id: string;
  source_quote_line_item_id: string | null;
  sequence: number;
  quantity: number;
  status: JobStatus;
  status_changed_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  shipped_at: string | null;
  current_operation_sequence: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * True when a job's due date has passed and it isn't done yet.
 * Cancelled/completed/shipped jobs are never "overdue" — the clock stops.
 */
export function isJobOverdue(job: Pick<Job, 'due_date' | 'status'>): boolean {
  if (!job.due_date) return false;
  if (job.status === 'completed' || job.status === 'shipped' || job.status === 'cancelled') {
    return false;
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(job.due_date) < today;
}

/**
 * Current operation info for the jobs list "Current Op" column.
 */
export interface CurrentOperationInfo {
  operationName: string;
  readyCount: number;
}

/**
 * Material expected/consumed for a (job, part). Snapshot from routing_materials
 * at job-part creation time.
 */
export type JobMaterialStatus = 'pending' | 'consumed' | 'skipped';

export interface JobMaterial {
  id: string;
  job_id: string;
  job_part_id: string;
  routing_material_id: string | null;
  inventory_item_id: string;
  expected_quantity: number;
  actual_quantity: number | null;
  unit: string;
  status: JobMaterialStatus;
  consumed_at: string | null;
  consumed_by: string | null;
  created_at: string;
  updated_at: string;
  inventory_item?: {
    id: string;
    name: string;
    primary_unit: string;
    quantity: number;
    cost_per_unit: number | null;
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
  status?: JobStatus | 'all';
  customerId?: string;
  search?: string;
  overdue?: boolean;
}

/**
 * Status display configuration.
 */
export const JOB_STATUS_CONFIG: Record<
  JobStatus,
  { label: string; color: 'default' | 'info' | 'success' | 'error' }
> = {
  not_started: { label: 'Not Started', color: 'default' },
  in_progress: { label: 'In Progress', color: 'info' },
  completed: { label: 'Completed', color: 'success' },
  shipped: { label: 'Shipped', color: 'success' },
  cancelled: { label: 'Cancelled', color: 'error' },
};

// ============== Operation Types ==============

/**
 * Operation status values.
 */
export type OperationStatus = 'pending' | 'in_progress' | 'completed' | 'skipped';

/**
 * Operation status display configuration.
 */
export const OPERATION_STATUS_CONFIG: Record<
  OperationStatus,
  { label: string; color: 'default' | 'info' | 'success' | 'warning' }
> = {
  pending: { label: 'Pending', color: 'default' },
  in_progress: { label: 'In Progress', color: 'info' },
  completed: { label: 'Completed', color: 'success' },
  skipped: { label: 'Skipped', color: 'warning' },
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
  newJobPartStatus?: JobStatus;
  /** True when the parent job's aggregate status changed as a side effect. */
  jobStatusChanged: boolean;
  newJobStatus?: JobStatus;
}
