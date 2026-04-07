/**
 * Job status values
 */
export type JobStatus = 'not_started' | 'in_progress' | 'completed' | 'shipped' | 'cancelled';

/**
 * Job attachment record from database
 */
export interface JobAttachment {
  id: string;
  job_id: string;
  company_id: string;
  file_name: string;
  file_path: string;
  file_size: number;
  mime_type: string;
  source_quote_attachment_id: string | null;
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
  description: string | null;
  status: JobStatus;
  status_changed_at: string | null;
  current_operation_sequence: number | null;
  started_at: string | null;
  completed_at: string | null;
  shipped_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Current operation info for the jobs list "Current Op" column
 */
export interface CurrentOperationInfo {
  operationName: string;
  readyCount: number;
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
    part_number: string;
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
  description: string;
}

/**
 * Filters for jobs list
 */
export interface JobFilters {
  status?: JobStatus | 'all';
  customerId?: string;
  search?: string;
}

/**
 * Empty form defaults for NEW jobs
 */
export const EMPTY_JOB_FORM: JobFormData = {
  customer_id: '',
  part_id: '',
  description: '',
};

/**
 * Convert Job to JobFormData for edit forms
 */
export function jobToFormData(job: Job): JobFormData {
  return {
    customer_id: job.customer_id,
    part_id: job.part_id || '',
    description: job.description || '',
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
