/**
 * TypeScript types for the Operator View module.
 *
 * Authentication is handled via Supabase Auth (email/password).
 * Operators authenticate the same way as admin users, but access
 * a dedicated operator interface.
 *
 * NOTE: Operator records are now stored in user_company_access with role='operator'.
 * The legacy 'operators' table is deprecated.
 */

/**
 * Response from the operator creation API.
 */
export interface OperatorCreateResponse {
  success: boolean;
  message?: string;
  operator_id?: string;
  user_id?: string;
}

// ============================================================================
// SESSION TYPES
// ============================================================================

/**
 * Work session data.
 */
export interface OperatorSession {
  id: string;
  operator_id: string;
  job_id: string;
  job_operation_id: string | null;
  operation_type_id: string;
  started_at: string;
  ended_at: string | null;
  notes: string | null;
  duration_seconds?: number;
  // Enriched fields (joined from related tables)
  job_number?: string | null;
  operation_name?: string | null;
}

/**
 * Active session with additional job details.
 */
export interface ActiveSession {
  id: string;
  operator_id: string;
  job_id: string;
  job_number: string | null;
  job_operation_id: string | null;
  operation_name: string | null;
  operation_type_id: string;
  started_at: string;
  notes: string | null;
}

// ============================================================================
// JOB TYPES
// ============================================================================

/**
 * Job data as seen by operators in the job list.
 */
export interface OperatorJob {
  id: string;
  job_number: string;
  customer_name: string | null;
  part_name: string | null;
  status: string;
  // Current operation for this station
  operation_id: string | null;
  operation_name: string | null;
  operation_status: string | null;
  // Who is currently working on this operation
  current_operator_name: string | null;
  // Job progress
  operations_total: number;
  operations_completed: number;
}

/**
 * Detailed job data for active job view.
 */
export interface OperatorJobDetail {
  id: string;
  job_number: string;
  customer_name: string | null;
  part_name: string | null;
  status: string;
  // Operation details
  operation_id: string | null;
  operation_name: string | null;
  operation_status: string | null;
  instructions: string | null;
  estimated_minutes: number | null;
  // Active session info
  active_session_id: string | null;
  session_started_at: string | null;
  current_operator_id: string | null;
  current_operator_name: string | null;
  // Job progress
  operations_total: number;
  operations_completed: number;
  // Material requirements for the job as a whole (sourced from job_materials,
  // not per-operation — materials are routing/job-level, not operation-level).
  materials: Array<{ name: string; quantity: number; unit: string }>;
}

// ============================================================================
// REQUEST TYPES
// ============================================================================

/**
 * Request body for starting work on a job.
 */
export interface JobStartRequest {
  operation_type_id: string;
}

/**
 * Request body for stopping work on a job.
 */
export interface JobStopRequest {
  notes?: string;
}

/**
 * Material confirmation data for job completion.
 * Pre-filled from routing, operator confirms or adjusts.
 */
export interface MaterialConfirmation {
  inventory_item_id: string;
  item_name: string;
  expected_quantity: number;
  confirmed_quantity: number;
  unit: string;
  current_stock: number;
  primary_unit: string;
}

/**
 * Request body for completing a job operation.
 */
export interface JobCompleteRequest {
  notes?: string;
  materials?: MaterialConfirmation[];
}

/**
 * Response from completing a job.
 */
export interface JobCompleteResponse {
  success: boolean;
  session_id: string;
  duration_seconds: number;
  job_completed: boolean;
}

// ============================================================================
// STATION TYPES
// ============================================================================

/**
 * Station (operation type) for the station selector.
 */
export interface Station {
  id: string;
  name: string;
}

// ============================================================================
// UTILITY TYPES
// ============================================================================

/**
 * Format duration in seconds to HH:MM:SS.
 */
export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  return [
    hours.toString().padStart(2, '0'),
    minutes.toString().padStart(2, '0'),
    secs.toString().padStart(2, '0'),
  ].join(':');
}
