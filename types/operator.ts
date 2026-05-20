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
 * One row in the station-scoped operator job list. Each row represents a
 * specific (job, job_part) pair where the operator can do work at the
 * selected station — so a multi-part job that has the station's operation
 * ready on N parts produces N rows. The `id` is the job_part_id so the
 * row can navigate directly into the per-part work view.
 *
 * `production_status` carries job_parts.production_status (the operator
 * workflow's lifecycle). Fulfillment is intentionally not surfaced —
 * operators don't act on it.
 */
export interface OperatorJob {
  /** job_part_id — primary navigation key on this row. */
  id: string;
  /** Parent job id (for grouping / navigation back to the parts hub). */
  job_id: string;
  job_number: string;
  customer_name: string | null;
  part_name: string | null;
  part_quantity: number;
  /** job_parts.production_status. */
  production_status: string;
  // Current operation for this station on this part
  operation_id: string | null;
  operation_name: string | null;
  operation_status: string | null;
  // Who is currently working on this operation
  current_operator_name: string | null;
  // Per-part progress
  operations_total: number;
  operations_completed: number;
}

/**
 * Per-part operator detail view — the page where Start/Stop/Complete lives.
 */
export interface OperatorJobDetail {
  /** job_part_id (primary key for this view). */
  id: string;
  /** Parent job id (for the back-to-parts-hub navigation). */
  job_id: string;
  job_number: string;
  customer_name: string | null;
  part_name: string | null;
  part_quantity: number;
  /** job_parts.production_status. */
  production_status: string;
  // Operation details (the one current operation on this part)
  operation_id: string | null;
  operation_name: string | null;
  operation_status: string | null;
  estimated_minutes: number | null;
  // Active session info
  active_session_id: string | null;
  session_started_at: string | null;
  current_operator_id: string | null;
  current_operator_name: string | null;
  // Per-part operation progress
  operations_total: number;
  operations_completed: number;
  // Material requirements scoped to this part.
  materials: Array<{ name: string; quantity: number; unit: string }>;
}

/**
 * One card on the operator parts-hub view (operator scans a job QR with >1 parts).
 */
export interface OperatorJobPartSummary {
  /** job_part_id. */
  id: string;
  job_id: string;
  part_name: string;
  part_description: string | null;
  quantity: number;
  /** job_parts.production_status. */
  production_status: string;
  /** Next ready operation on this part, when one exists. */
  next_operation_name: string | null;
  next_operation_id: string | null;
  /** Per-part progress. */
  operations_total: number;
  operations_completed: number;
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
