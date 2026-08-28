/**
 * Types for partial operation completion (job_operation_completions).
 *
 * An operation's progress is the SUM of non-void quantity_good events against
 * the part's ordered quantity (the target). Mirrors the shipment/invoice
 * line-item model. See docs/modules/operator-view.md#recording-a-completion.
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
  /**
   * Which surface recorded it — 'operator' (the step screen) or 'office' (the
   * job page's Complete button). NULL on rows written before 20260828124806,
   * where the surface is genuinely unknown rather than assumed.
   */
  capture_source: CompletionCaptureSource | null;
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

/**
 * Which surface recorded a completion.
 *
 * NOT the actor's role. An admin standing at a machine records through the
 * operator surface, and their work is operator capture — the role is an
 * inference about the surface rather than the surface itself. This distinction
 * is what lets the job feed show every 'office' row to everyone while keeping
 * operator rows own-only: the own-rows rule protects PEOPLE, and an office
 * completion has no person in it.
 */
export type CompletionCaptureSource = 'operator' | 'office';

/** Payload for recording a completion. company_id/completed_by are derived server-side helpers. */
export interface CreateOperationCompletionInput {
  companyId: string;
  jobOperationId: string;
  jobPartId: string;
  quantityGood: number;
  note?: string | null;
  /**
   * REQUIRED, deliberately. A default would let a new call site record work
   * without saying where it came from, and the feed's visibility rule reads this
   * column — a wrong value there either hides an office action from the floor or
   * publishes an operator's output to the whole shop.
   */
  captureSource: CompletionCaptureSource;
  /**
   * The qty_good this caller believed was already recorded, for first-write-wins
   * conflict detection. When supplied and the live sum has GROWN since,
   * `createOperationCompletion` throws `CompletionConflictError` INSTEAD of
   * inserting, so two people completing the same step do not double-count.
   *
   * GROWN, not merely changed: a live sum that SHRANK means somebody undid work,
   * and banking against a smaller base is a correct outcome rather than a
   * double-count. See the check itself for why symmetry was the wrong instinct.
   *
   * Optional because a caller with no prior view of the step (a fresh scan) has
   * nothing to be stale about; every surface that renders a quantity passes it.
   */
  expectedQtyGood?: number;
}
