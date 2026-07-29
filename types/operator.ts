/**
 * TypeScript types for the Operator View module.
 *
 * Authentication is handled via Supabase Auth (email/password).
 * Operators authenticate the same way as admin users, but access
 * a dedicated operator interface.
 *
 * NOTE: There is no dedicated "operators" table. Shop-floor users are
 * user_company_access rows with role='operator'; admins/users are members too.
 */

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
  /** jobs.is_hot — the rush marker. Drives hot-first ordering + the HOT badge. */
  is_hot: boolean;
  /** job_parts.production_status. */
  production_status: string;
  // Current operation for this station on this part
  operation_id: string | null;
  operation_name: string | null;
  operation_status: string | null;
  // Per-part progress
  operations_total: number;
  operations_completed: number;
  /**
   * Good pieces recorded (non-void) against the CURRENT operation on this part.
   * Drives the "N of order-qty good" partial-progress label on the ready card.
   * 0 when the operation hasn't been started. Defaults to 0 on lists that don't
   * compute it (the completed list).
   */
  current_op_qty_good?: number;
  /**
   * When this row's operation was completed (job_operations.completed_at).
   * Only set on rows from the "Completed" list (getCompletedOperatorJobs /
   * getAllStationsCompletedOperatorJobs); undefined on the ready list.
   */
  completed_at?: string | null;
}

/**
 * A whole-plant ("All Stations") job row — an OperatorJob plus which station
 * (work center) its ready operation runs at, so the list can group by station.
 * Returned by getAllStationsOperatorJobs(); the per-station list uses OperatorJob.
 */
export interface OperatorPlantJob extends OperatorJob {
  work_center_id: string | null;
  work_center_name: string | null;
}

/**
 * Per-part operator detail view — the page where Start/Stop/Complete lives.
 */
export interface OperatorJobDetail {
  /** job_part_id (primary key for this view). */
  id: string;
  /** Parent job id (for the back-to-parts-hub navigation). */
  job_id: string;
  /** The made part this job_part produces (for part-scoped guidance). */
  part_id: string;
  job_number: string;
  customer_name: string | null;
  part_name: string | null;
  part_description: string | null;
  part_quantity: number;
  /** job_parts.production_status. */
  production_status: string;
  // Operation details (the one current operation on this part)
  operation_id: string | null;
  operation_name: string | null;
  operation_status: string | null;
  /** job_operations.instructions for this step (shop-floor instructions). */
  operation_instructions: string | null;
  /** Work center this operation runs at — drives the station-match guard. */
  operation_work_center_id: string | null;
  operation_work_center_name: string | null;
  /** work_centers.kind — 'external' ops use the send/receive action set and
   *  suppress the station-mismatch guard (they have no operator station). Null
   *  when the work center was deleted. */
  operation_work_center_kind: 'internal' | 'external' | null;
  /** Vendor name for an external op (from work_centers.vendor_id). */
  operation_vendor_name: string | null;
  /** job_operations.sent_at — when an external op left for the vendor. */
  operation_sent_at: string | null;
  estimated_minutes: number | null;
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
  /** work_centers.kind — 'external' ops (outside vendor) get distinct treatment
   *  on the traveler (banner row) and the operation page (send/receive actions).
   *  Null when the work center was deleted (FK ON DELETE SET NULL) — treat as
   *  non-external/unknown, never crash. */
  work_center_kind: 'internal' | 'external' | null;
  /** Vendor name for an external op (from work_centers.vendor_id → vendors.name).
   *  Null for internal ops or when unresolved. */
  vendor_name: string | null;
  /** 'pending' | 'in_progress' | 'completed' | 'sent'. */
  status: string;
  /** estimated_setup_minutes (the traveler's "Setup" column). */
  setup_minutes: number;
  /** estimated_run_minutes_per_unit (the traveler's "Cycle" column). */
  cycle_minutes: number;
}

/**
 * One outside (external-vendor) operation across all jobs, for the company-wide
 * "Outside work" queue (a tab on the Jobs list). Purely informational — no
 * readiness/predecessor logic; grouped by status ('pending' = Not sent, 'sent' =
 * At vendor) and ordered by the parent job's due date.
 */
export interface OutsideOperation {
  /** job_operation_id — the action target for Mark Sent Out / Mark Received. */
  id: string;
  job_id: string;
  job_part_id: string;
  job_number: string;
  part_name: string | null;
  operation_name: string;
  vendor_name: string | null;
  /** 'pending' (Not sent) | 'sent' (At vendor). */
  status: 'pending' | 'sent';
  sent_at: string | null;
  /** Resolved name of sent_by (user_company_access.name); null if unset/unresolved. */
  sent_by_name: string | null;
  due_date: string | null;
  is_hot: boolean;
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
  /** The made part this job_part produces (job_parts.part_id). */
  part_id: string;
  job_number: string;
  customer_name: string | null;
  part_name: string | null;
  part_description: string | null;
  quantity: number;
  /** Order date — sourced from jobs.created_at (no dedicated order_date column). */
  order_date: string | null;
  due_date: string | null;
  customer_po_number: string | null;
  production_status: string;
  /** jobs.is_hot — drives the HOT badge on-screen and the grayscale HOT stamp on the PDF. */
  is_hot: boolean;
  /** Number of parts on the parent job — drives the "all parts" hub link. */
  job_part_count: number;
  operations: JobTravelerOperation[];
}

/**
 * A whole-job parts overview for the operator parts hub — the job header plus
 * each part with its progress, used to navigate a multi-part job.
 */
export interface JobPartsOverview {
  job_id: string;
  job_number: string;
  customer_name: string | null;
  due_date: string | null;
  parts: JobPartSummary[];
}

/** One part row in the parts hub. */
export interface JobPartSummary {
  /** job_part_id — navigation key into the part traveler. */
  job_part_id: string;
  part_name: string | null;
  quantity: number;
  production_status: string;
  operations_total: number;
  operations_completed: number;
}

/**
 * A photo (or, later, short video) attached to a job note. Bytes live in the
 * private `attachments` bucket; the feed renders thumbnails via signed URLs.
 */
export interface JobNoteMedia {
  id: string;
  note_id: string;
  /** Object key in the attachments bucket — pass to getJobNoteMediaUrl(). */
  storage_path: string;
  /** Optional poster/thumbnail key (video, or a smaller image variant). */
  thumbnail_path: string | null;
  kind: 'photo' | 'video';
  mime_type: string | null;
  width: number | null;
  height: number | null;
}

/**
 * One note in the job feed. The feed is one append-only stream per job: every
 * note carries `job_id` (the rollup key) and may optionally be tagged to a step
 * via `job_operation_id` — operation-scoped notes (captured on the operation
 * page) roll up into the same feed. A note may carry text, media, or both.
 */
export interface JobNote {
  id: string;
  job_id: string;
  /** Optional step tag — null for job-level notes, set for operation-scoped ones. */
  job_operation_id: string | null;
  /** Human label for the tagged step, e.g. "Op 20 · Mill"; null when untagged. */
  operation_label: string | null;
  /** Free text. Null when the note is media-only. */
  body: string | null;
  /**
   * 'user' = a human-authored note (typed text and/or attached media).
   * 'event' = an auto-logged feed entry (e.g. the order-quantity-change audit
   * trail). Used to distinguish real operator capture from system events — e.g.
   * the post-completion "add a photo?" offer only counts 'user' notes.
   */
  note_type: 'user' | 'event';
  created_at: string;
  /** Author display name (from user_company_access.name); null if unknown. */
  author_name: string | null;
  /**
   * What the note is ABOUT, which is not the same as where it was captured.
   * 'part' is the durable subject — anchored to (part, routing step), so it
   * outlives the job and is what the next person running the part reads.
   * 'job' is either a legacy note or one genuinely about this run only.
   */
  subject_kind: 'job' | 'part' | 'work_center';
  /**
   * Distinct PEOPLE who have read this note, excluding the author and accounts
   * excluded from metrics. Saturates near shop size — that is what it means.
   */
  viewer_count: number;
  /**
   * Distinct JOBS this note was consulted on. Uncapped, and the number that
   * distinguishes a load-bearing note from one read once out of curiosity.
   * Renders as "used on 11 jobs by 4 people".
   */
  usage_count: number;
  /** Attached photos/videos, in insertion order. */
  media: JobNoteMedia[];
}

/**
 * One note from a PRIOR completed run of a part, flattened across runs for the
 * operator's "previous notes for this part" view (accumulated shop wisdom, not a
 * list of past jobs). Extends the job-feed note with the source run's job number
 * so a tip can be traced back to where it came from.
 */
export interface PartPreviousNote extends JobNote {
  /** The prior run's job number (e.g. "J-0002"), a light source reference. */
  job_number: string;
}

// ============================================================================
// REQUEST TYPES
// ============================================================================

/**
 * Response from completing an operation. Operators complete in a single tap with
 * no session/timer, so there are no duration fields — just whether the parent
 * job is now fully complete (for any downstream "job done" handling).
 */
export interface JobCompleteResponse {
  success: boolean;
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

/** One of the caller's own notes, with how far it has travelled. */
export interface MyNote {
  id: string;
  body: string | null;
  created_at: string;
  /** "Op 20 · Mill" when the note carries a step, else null. */
  operation_label: string | null;
  /** Part the note is durably attached to, when it has one. */
  part_name: string | null;
  /**
   * The job this note was written on — job_id for a job-subject note,
   * captured_job_id for a durable part-subject one. Null once that job is
   * deleted (provenance is ON DELETE SET NULL: the knowledge outlives its
   * origin, so losing the link must never lose the note).
   */
  job_id: string | null;
  job_number: string | null;
  photo_count: number;
  /** Distinct PEOPLE who read it. Saturates near shop size — that is its meaning. */
  viewer_count: number;
  /**
   * Distinct JOBS it was viewed on. Uncapped, and the quality signal the Playbook
   * ranks by — but NOT shown on My Work: next to a view count it reads as a
   * puzzle rather than a signal, and both numbers mean "somebody opened this".
   */
  usage_count: number;
}

/**
 * The operator's own contribution and its reception.
 *
 * Deliberately carries no completion count, streak, average or anything
 * comparable against another person — see the surveillance guardrail in
 * docs. This screen is where a leaderboard would want to grow, and it must not.
 */
export interface MyContribution {
  noteCount: number;
  photoCount: number;
  /**
   * Total VIEWS across their notes — the sum of each note's viewer_count, so one
   * colleague who read three of them contributes three. Not a headcount: a
   * distinct-people figure would need the note_views rows, which no browser role
   * can read by design.
   */
  peopleReached: number;
  notes: MyNote[];
}

/** A named reader of one of your own notes. Authors only — see note_viewers(). */
export interface NoteViewer {
  viewer_name: string | null;
  job_number: string | null;
}
