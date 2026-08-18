/**
 * Types for operator cycle-time capture (job_operation_intervals).
 *
 * An interval is a span of recorded time on one operation, chained on the WORK
 * CENTRE: at most one is open per machine, and the next start there closes the
 * previous one. See docs/modules/operator-view.md#recording-time.
 *
 * The raw/adjusted/effective triple is the whole point of the shape. `started_at`
 * and `ended_at` are what was recorded and are immutable; `adjusted_*` is the
 * operator's correction; `effective_*` is generated in the DB so every reader has
 * ONE shape and nobody has to remember the COALESCE.
 */

/**
 * Why an interval stopped, and there are only two ways.
 *
 * `completed` is the operator recording what they finished; `switched` is the
 * chain closing this one because the next start took the work centre — written
 * server-side, never by a tap. `done_for_day` and `left_running` were built and
 * removed: they asked the operator to classify a stop, and an interval left open
 * already says that on the office Still-running list.
 */
export type IntervalCloseReason = 'completed' | 'switched';

/** Where the interval came from. Only `operator` is produced today. */
export type IntervalCaptureSource = 'operator' | 'sensor' | 'system';

/** One recorded interval, as the operator's own surfaces read it. */
export interface OperationInterval {
  id: string;
  job_operation_id: string;
  job_part_id: string;
  work_center_id: string | null;
  /** Raw. What was recorded. Never edited. */
  started_at: string;
  /** Raw. Null while running. */
  ended_at: string | null;
  adjusted_started_at: string | null;
  adjusted_ended_at: string | null;
  /** Non-null iff the times were corrected. Stamped by the DB, not the client. */
  adjusted_at: string | null;
  /** What every consumer should read. Generated in the DB. */
  effective_started_at: string;
  effective_ended_at: string | null;
  close_reason: IntervalCloseReason | null;
  capture_source: IntervalCaptureSource;
  note: string | null;
  /**
   * How many good pieces the completion that closed this interval recorded.
   *
   * Null on an interval the chain closed, or one still running — nothing was
   * claimed, so there is nothing to show. Resolved through `completion_id`
   * rather than stored, so it can never disagree with the completion itself.
   */
  quantity_good: number | null;
}

/**
 * An interval plus the job and step it belongs to.
 *
 * The strip and the journal both have to NAME the work, or they are a bare clock
 * with no referent — an operator with three machines running cannot tell which
 * one a lone timer refers to.
 */
export interface OperationIntervalWithContext extends OperationInterval {
  job_id: string;
  job_number: string;
  operation_name: string;
  operation_sequence: number;
  part_name: string | null;
}

/**
 * The running interval plus the clock offset to render it with.
 *
 * `serverSkewMs` is `server_now − Date.now()` at the moment of the call. Elapsed
 * time MUST be computed as `(Date.now() + serverSkewMs) − effective_started_at`
 * rather than by accumulating ticks: a backgrounded mobile tab is throttled to
 * one tick a minute (Chrome, after 5 minutes hidden), clamped to 15 minutes
 * (Firefox Android) or suspended outright (iOS Safari), so a tick count is
 * wrong by however long the phone was in a pocket. Timestamp subtraction is
 * immune to all of it. The offset also protects against a phone whose own clock
 * is simply wrong, which on a shop floor is not rare.
 */
export interface RunningInterval extends OperationInterval {
  serverSkewMs: number;
}

/** Per-operation recorded time for the office. Carries no operator identity. */
export interface OperationActuals {
  job_operation_id: string;
  /** Sum over CLOSED intervals only. Open ones are counted, never estimated. */
  actual_minutes: number;
  interval_count: number;
  /** > 0 means the total is incomplete and the UI must say so. */
  open_count: number;
  adjusted_count: number;
  first_started_at: string | null;
  last_ended_at: string | null;
}

/** An interval that is still running, for the office Still-running list. */
export interface OpenInterval {
  interval_id: string;
  job_operation_id: string;
  job_id: string;
  job_number: string;
  part_name: string | null;
  operation_name: string;
  work_center_name: string | null;
  started_at: string;
  capture_source: IntervalCaptureSource;
}

/**
 * One person's interval, as the admin-gated, audited detail view returns it.
 *
 * Deliberately carries BOTH the raw pair and the effective pair: the audit
 * surface is the one place where "what was recorded" and "what it was corrected
 * to" are both the answer to the question being asked.
 */
export interface OperatorTimeDetailRow {
  interval_id: string;
  job_operation_id: string;
  operation_name: string;
  job_number: string;
  started_at: string;
  ended_at: string | null;
  effective_started_at: string;
  effective_ended_at: string | null;
  adjusted_at: string | null;
  close_reason: IntervalCloseReason | null;
}

/** The adjustment an operator submits. Both ends optional — either can be corrected alone. */
export interface IntervalAdjustment {
  adjustedStartedAt?: string | null;
  adjustedEndedAt?: string | null;
  note?: string | null;
}
