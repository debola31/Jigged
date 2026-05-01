/**
 * Job status values
 */
export type JobStatus = 'not_started' | 'in_progress' | 'completed' | 'shipped' | 'cancelled';

/**
 * Job attachment record from database. Job attachments are independent of quotes.
 */
export interface JobAttachment {
  id: string;
  job_id: string;
  company_id: string;
  file_name: string;
  file_path: string;
  file_size: number;
  mime_type: string;
  uploaded_by: string | null;
  uploaded_at: string;
}

/**
 * Job operation record from database
 */
export interface JobOperation {
  id: string;
  job_id: string;
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
  instructions: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  // Joined operation type data
  operation_type?: {
    id: string;
    name: string;
    labor_rate: number | null;
  } | null;
}

/**
 * Job record from database
 */
export interface Job {
  id: string;
  company_id: string;
  job_number: string;
  quote_id: string | null;
  customer_id: string;
  part_id: string | null;
  status: JobStatus;
  status_changed_at: string | null;
  current_operation_sequence: number | null;
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
 * Current operation info for the jobs list "Current Op" column
 */
export interface CurrentOperationInfo {
  operationName: string;
  readyCount: number;
}

/**
 * Material expected/consumed for a job. Snapshot from routing_materials at job
 * creation time.
 */
export type JobMaterialStatus = 'pending' | 'consumed' | 'skipped';

export interface JobMaterial {
  id: string;
  job_id: string;
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
  // Joined inventory item data
  inventory_item?: {
    id: string;
    name: string;
    primary_unit: string;
    quantity: number;
    cost_per_unit: number | null;
  } | null;
}

/**
 * Job with joined relation data
 */
export interface JobWithRelations extends Job {
  // Joined customer data
  customers?: {
    id: string;
    name: string;
  } | null;
  // Joined part data
  parts?: {
    id: string;
    part_name: string;
    description: string | null;
  } | null;
  // Joined quote data (if created from quote)
  quotes?: {
    id: string;
    quote_number: string;
    total_price: number | null;
  } | null;
  // Joined operations
  job_operations?: JobOperation[];
  // Joined materials (from job_materials, snapshot of routing_materials)
  job_materials?: JobMaterial[];
  // Joined attachments
  job_attachments?: JobAttachment[];
  // Current operation info (populated by batch query on list page)
  currentOperation?: CurrentOperationInfo | null;
}

/**
 * Form data for creating/editing jobs
 */
export interface JobFormData {
  customer_id: string;
  part_id: string;
  due_date: string; // ISO date (YYYY-MM-DD), '' when not set
  lead_time_days: string;
}

/**
 * Filters for jobs list
 */
export interface JobFilters {
  status?: JobStatus | 'all';
  customerId?: string;
  search?: string;
  overdue?: boolean;
}

/**
 * Empty form defaults for NEW jobs
 */
export const EMPTY_JOB_FORM: JobFormData = {
  customer_id: '',
  part_id: '',
  due_date: '',
  lead_time_days: '',
};

/**
 * Convert Job to JobFormData for edit forms
 */
export function jobToFormData(job: Job): JobFormData {
  return {
    customer_id: job.customer_id,
    part_id: job.part_id || '',
    due_date: job.due_date || '',
    lead_time_days: job.lead_time_days !== null ? String(job.lead_time_days) : '',
  };
}

/**
 * Status display configuration
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
 * Operation status values
 */
export type OperationStatus = 'pending' | 'in_progress' | 'completed' | 'skipped';

/**
 * Operation status display configuration
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
 * Data for completing an operation
 */
export interface CompleteOperationData {
  actual_setup_minutes?: number;
  actual_run_minutes?: number;
  notes?: string;
}

/**
 * Result of an operation update with job status change info
 */
export interface OperationUpdateResult {
  operation: JobOperation;
  jobStatusChanged: boolean;
  newJobStatus?: JobStatus;
}
