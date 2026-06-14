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
  /**
   * True when this operation has earlier (lower-sequence) steps on the part
   * that are not yet completed. Only the traveler/operation-detail path sets
   * this; it drives a non-blocking "earlier steps incomplete" warning. Starting
   * is still allowed (shops work out of order).
   */
  predecessors_incomplete?: boolean;
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

/**
 * One operation/step row on the job traveler (mirrors a row in the printed
 * job-traveler step table: Step #, Work Center, Description, Setup, Cycle).
 */
export interface JobTravelerOperation {
  /** job_operation_id — navigation key into the action view. */
  id: string;
  /** Step number (job_operations.sequence). */
  sequence: number;
  operation_name: string;
  instructions: string | null;
  /** Work center / station name. */
  work_center_id: string | null;
  work_center_name: string | null;
  /** 'pending' | 'in_progress' | 'completed'. */
  status: string;
  /** estimated_setup_minutes (the traveler's "Setup" column). */
  setup_minutes: number;
  /** estimated_run_minutes_per_unit (the traveler's "Cycle" column). */
  cycle_minutes: number;
  /** Name of the operator with an active session on this op, if any. */
  active_operator_name: string | null;
}

/**
 * The job traveler for a single job_part — header info plus every operation,
 * shown when an operator scans/opens a job. Replicates the printed shop
 * traveler (e.g. Tangle's Work Order PDF).
 */
export interface JobTraveler {
  /** job_part_id. */
  job_part_id: string;
  job_id: string;
  job_number: string;
  customer_name: string | null;
  part_name: string | null;
  part_description: string | null;
  quantity: number;
  due_date: string | null;
  customer_po_number: string | null;
  production_status: string;
  operations: JobTravelerOperation[];
}

/**
 * One job-level note in the traveler's notes feed. Notes are general (not tied
 * to an operation) and append-only — many notes by different people over time.
 */
export interface JobNote {
  id: string;
  job_id: string;
  body: string;
  created_at: string;
  /** Author display name (from user_company_access.name); null if unknown. */
  author_name: string | null;
}

// ============================================================================
// REQUEST TYPES
// ============================================================================

/**
 * Request body for starting work on a job. At least one of the two fields must
 * be supplied:
 * - `operation_type_id` (a work_center_id): the station-QR flow — resolves the
 *   matching pending/in-progress operation on the part by work center.
 * - `job_operation_id`: the traveler flow — pins the exact operation to start
 *   (important when two steps share a work center). The operation's own work
 *   center is used for the session, so `operation_type_id` is optional here.
 */
export interface JobStartRequest {
  operation_type_id?: string;
  job_operation_id?: string;
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
