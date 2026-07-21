/**
 * Types for partial operation completion (job_operation_completions).
 *
 * An operation's progress is the SUM of non-void quantity_good events against
 * the part's ordered quantity (the target). Mirrors the shipment/invoice
 * line-item model. See docs/modules/partial-operation-completion-design.md.
 */

/** One append-only completion event on an operation. */
export interface OperationCompletionEvent {
  id: string;
  job_operation_id: string;
  job_part_id: string;
  quantity_good: number;
  completed_by: string | null;
  /** Resolved member name for completed_by (not a DB column). */
  completed_by_name?: string | null;
  completed_at: string;
  note: string | null;
  voided_at: string | null;
  voided_by: string | null;
}

/** Per-operation good/remaining rollup for a job_part. */
export interface OperationCompletionSummary {
  job_operation_id: string;
  /** The part's ordered quantity — every op must produce this many good pieces. */
  target: number;
  qty_good: number;
  /** max(0, target − qty_good) — clamped, never negative. */
  qty_remaining: number;
}

/** Payload for recording a completion. company_id/completed_by are derived server-side helpers. */
export interface CreateOperationCompletionInput {
  companyId: string;
  jobOperationId: string;
  jobPartId: string;
  quantityGood: number;
  note?: string | null;
}
