/**
 * Production-status values. Owned by operator activity — set on job_parts
 * by recomputeJobPartStatus, aggregated to the parent job via the
 * sync_job_production_status_from_parts trigger.
 */
import type { AddressSnapshot, ContactSnapshot } from '@/types/documentSnapshot';

export type ProductionStatus = 'not_started' | 'in_progress' | 'completed' | 'cancelled';

/**
 * Fulfillment-status values. Owned by shipment activity — set on job_parts
 * by compute_job_part_fulfillment_status from shipment_line_items, aggregated
 * to the parent job by the sync trigger family (PR 4). All rows are
 * 'unshipped' until PR 4 wires up the cascade.
 */
export type FulfillmentStatus = 'unshipped' | 'partially_shipped' | 'fully_shipped';

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
  work_center_id: string | null;
  routing_operation_id: string | null;
  estimated_setup_minutes: number;
  estimated_run_minutes_per_unit: number;
  status: OperationStatus;
  completed_at: string | null;
  completed_by: string | null;
  /** Resolved display name of `completed_by` (from user_company_access), attached by
   *  getJobWithRelations — not a DB column. Null if unresolved/unset. */
  completed_by_name?: string | null;
  /** External-op send waypoint (see OperationStatus). received == completed, so
   *  these mirror completed_at/completed_by; set only on external ops. */
  sent_at: string | null;
  sent_by: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  work_center?: {
    id: string;
    name: string;
    labor_rate: number | null;
    kind: 'internal' | 'external';
    /** Present for external work centers (kind='external' requires a vendor). */
    vendor?: { id: string; name: string } | null;
  } | null;
}

/**
 * Job (project header). Owns the customer, due date, source quote, and
 * dual aggregate statuses mirrored from job_parts. The actual part-level
 * routing, status, and timestamps live on JobPart.
 *
 * `shipped_at` is no longer a stored column — the last ship date for a
 * job is computed by the SQL helper `public.job_last_ship_date(job_id)`,
 * which sums non-voided shipments in PR 4. The TS access layer wraps
 * this as `getJobLastShipDate(jobId)` in utils/jobsAccess.ts.
 */
export interface Job {
  id: string;
  company_id: string;
  job_number: string;
  quote_id: string | null;
  customer_id: string;
  customer_po_number: string | null;
  // FKs into the customer's address book, copied from the source quote at
  // conversion and editable on the job. Mirror quotes.{billing,shipping}_address_id
  // + contact_id; a customer-match trigger enforces they belong to customer_id.
  billing_address_id: string | null;
  shipping_address_id: string | null;
  contact_id: string | null;
  production_status: ProductionStatus;
  fulfillment_status: FulfillmentStatus;
  // "Hot" (rush) marker — the digital pink-paper / red-pen "HOT" signal. Pure
  // visibility: no scheduling behavior. Sorts hot jobs first in the admin list
  // and the operator station queue. Set at creation and toggleable by office staff.
  is_hot: boolean;
  status_changed_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  due_date: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // Document Snapshot Standard: frozen customer/address/contact block captured
  // by the snapshot_document_party trigger. See docs/architecture.md.
  customer_name: string | null;
  bill_to_address: AddressSnapshot | null;
  ship_to_address: AddressSnapshot | null;
  contact_snapshot: ContactSnapshot | null;
}

/**
 * One physical part / workpiece-group inside a job. Each job_part has its
 * own routing-derived operations + materials and its own production +
 * fulfillment statuses. Production is set by operator activity; fulfillment
 * is set by shipment_line_items (PR 4).
 */
export interface JobPart {
  id: string;
  job_id: string;
  company_id: string;
  part_id: string;
  source_quote_line_item_id: string | null;
  sequence: number;
  quantity: number;
  /**
   * Agreed price per unit and line total. The single source of price for
   * invoicing (both quote- and PO-sourced jobs carry it). Quote-sourced jobs
   * copy it from the quote line at conversion; PO-sourced jobs take it from the
   * PO form. Nullable only for genuinely pre-snapshot legacy lines.
   */
  unit_price: number | null;
  total_price: number | null;
  production_status: ProductionStatus;
  fulfillment_status: FulfillmentStatus;
  status_changed_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  current_operation_sequence: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * A file attached to a job (e.g. the customer's PO PDF). The bytes live in the
 * private storage bucket at `storage_path`; this is the metadata row. See
 * utils/jobAttachmentsAccess.ts and components/jobs/JobAttachmentsCard.tsx.
 */
export interface JobAttachment {
  id: string;
  job_id: string;
  company_id: string;
  storage_path: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  uploaded_by: string | null;
  created_at: string;
}

/**
 * True when a job's due date has passed and it isn't done yet. A job is
 * "done" only when it's both produced (completed/cancelled) AND fully
 * shipped — the FR-18 predicate. Cancelled-and-fully-shipped jobs stop
 * the clock; cancelled-and-partially-shipped do too (the customer's
 * remaining order never ships).
 *
 * Date comparison: due_date is a YYYY-MM-DD string. JavaScript's
 * `new Date('YYYY-MM-DD')` parses as UTC midnight, which is the previous
 * calendar day in negative-UTC timezones — so `new Date('2026-05-19') <
 * localMidnight(2026-05-19)` is wrongly true in US Pacific, painting a
 * job-due-today as overdue. We parse the YMD parts directly into a
 * LOCAL date so the comparison matches both the user's intuition and
 * the server-side filter (which uses todayLocalISODate in jobsAccess).
 */
export function isJobOverdue(
  job: Pick<Job, 'due_date' | 'production_status' | 'fulfillment_status'>,
): boolean {
  if (!job.due_date) return false;
  // Not overdue once production has ended (completed or cancelled) or the job
  // is fully shipped — a delivered or closed-out job can't be late. Keyed off
  // production_status directly (not isJobDone, which additionally requires full
  // shipment) so a completed-but-unshipped job also clears. Mirrors the
  // server-side overdue filters in jobsAccess/dashboardAccess.
  if (job.production_status === 'completed' || job.production_status === 'cancelled') return false;
  if (job.fulfillment_status === 'fully_shipped') return false;
  const [y, m, d] = job.due_date.split('-').map((n) => parseInt(n, 10));
  if (!y || !m || !d) return false;
  const dueLocal = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return dueLocal < today;
}

/**
 * FR-18 "done" predicate. A job is done when production has ended
 * (completed or cancelled) AND every part is fully shipped. Used by the
 * jobs-list default filter (hide done) and the dashboard active-jobs count.
 */
export function isJobDone(
  job: Pick<Job, 'production_status' | 'fulfillment_status'>,
): boolean {
  return (
    (job.production_status === 'completed' || job.production_status === 'cancelled') &&
    job.fulfillment_status === 'fully_shipped'
  );
}

/**
 * "Closed" = terminal for the jobs-list default view. Built ON TOP of the
 * canonical isJobDone predicate (produced AND fully shipped) plus cancelled,
 * so there is a single definition of "done" — the list hides closed jobs by
 * default and the "Show completed & cancelled" toggle reveals them. A
 * cancelled job counts as closed at any shipment state (its remaining order
 * never ships).
 */
export function isJobClosed(
  job: Pick<Job, 'production_status' | 'fulfillment_status'>,
): boolean {
  return isJobDone(job) || job.production_status === 'cancelled';
}

/**
 * Single combined lifecycle stage for the jobs list — collapses the two
 * independent status axes (production + fulfillment) into one "where is this
 * order?" value used by the combined Status filter and the row chip.
 */
export type JobLifecycleStage =
  | 'not_started'
  | 'in_progress'
  | 'ready_to_ship'
  | 'partially_shipped'
  | 'completed'
  | 'cancelled';

/**
 * Map a job's production + fulfillment statuses to one lifecycle stage.
 * Total over all production×fulfillment combinations; precedence order
 * matters:
 *   1. cancelled  — production cancelled, any shipment state (own terminal bucket)
 *   2. completed  — fully shipped (covers the FR-18 done case AND the rare
 *                   shipped-before-ops-marked-complete edge)
 *   3. partially_shipped — some but not all shipped
 *   4. ready_to_ship     — production complete, nothing shipped yet
 *   5. in_progress       — production underway, nothing shipped
 *   6. not_started       — nothing done yet
 * Keep in lockstep with STAGE_TO_JOB_FILTERS (the inverse, for querying).
 */
export function getJobLifecycleStage(
  job: Pick<Job, 'production_status' | 'fulfillment_status'>,
): JobLifecycleStage {
  if (job.production_status === 'cancelled') return 'cancelled';
  if (job.fulfillment_status === 'fully_shipped') return 'completed';
  if (job.fulfillment_status === 'partially_shipped') return 'partially_shipped';
  // Unshipped from here down — resolve by production.
  if (job.production_status === 'completed') return 'ready_to_ship';
  if (job.production_status === 'in_progress') return 'in_progress';
  return 'not_started';
}

/**
 * Current operation info for the jobs list "Current Op" column.
 */
export interface CurrentOperationInfo {
  operationName: string;
  readyCount: number;
}

/**
 * Hydrated JobPart with its part metadata and operations. Materials are no
 * longer read off the job_materials snapshot in the app — the Job page reads
 * the part BOM live (see JobPartMaterialsCard / getBomForPart).
 */
export interface JobPartWithRelations extends JobPart {
  parts?: {
    id: string;
    part_name: string;
    description: string | null;
  } | null;
  job_operations?: JobOperation[];
}

/**
 * Job with joined relation data — used by the dashboard detail page.
 */
export interface JobWithRelations extends Job {
  // Customer + their full address book / contacts, so the job detail page can
  // both resolve the job's selected billing/shipping/contact for display and
  // offer the customer's other saved addresses/contacts in the edit dropdowns.
  customers?: {
    id: string;
    name: string;
    customer_contacts?: Array<{
      id: string;
      name: string;
      role: string;
      email: string | null;
      phone: string | null;
      is_primary: boolean;
    }>;
    addresses?: Array<{
      id: string;
      address_line1: string | null;
      address_line2: string | null;
      city: string | null;
      state: string | null;
      postal_code: string | null;
      country: string | null;
      default_billing: boolean;
      default_shipping: boolean;
      attention_to: string | null;
    }>;
  } | null;
  quotes?: {
    id: string;
    quote_number: string;
  } | null;
  /** One row per physical part inside the job. */
  job_parts?: JobPartWithRelations[];
  /** Summary of the most-progressed operation across parts (list view). */
  currentOperation?: CurrentOperationInfo | null;
  /**
   * Set only by getAllJobs when a search query matched this row — values
   * mirror search_jobs_by_identifier's match_source column. Used by the
   * jobs-list job-number cell renderer to surface "matched packing slip"
   * sub-text without an extra round-trip.
   */
  match_source?: string | null;
}

/**
 * Filters for the jobs list.
 */
export interface JobFilters {
  productionStatus?: ProductionStatus[] | 'all';
  fulfillmentStatus?: FulfillmentStatus[] | 'all';
  customerId?: string;
  /**
   * Search text. When set, getAllJobs routes through the
   * search_jobs_by_identifier RPC (job_number, customer_po, customer
   * name, part number, packing slip number) and surfaces the match_source
   * on the returned rows.
   */
  search?: string;
  overdue?: boolean;
  /** When true (default), hide "closed" jobs — the FR-18 done predicate OR
   *  cancelled (see isJobClosed). The jobs list turns this off when the user
   *  ticks "Show completed & cancelled" or selects a closed stage. */
  excludeClosed?: boolean;
}

/**
 * Production-status display configuration.
 */
export const PRODUCTION_STATUS_CONFIG: Record<
  ProductionStatus,
  { label: string; color: 'default' | 'info' | 'success' | 'error' }
> = {
  not_started: { label: 'Not Started', color: 'default' },
  in_progress: { label: 'In Progress', color: 'info' },
  completed: { label: 'Completed', color: 'success' },
  cancelled: { label: 'Cancelled', color: 'error' },
};

/**
 * Fulfillment-status display configuration.
 */
export const FULFILLMENT_STATUS_CONFIG: Record<
  FulfillmentStatus,
  { label: string; color: 'default' | 'info' | 'success' }
> = {
  unshipped: { label: 'Not Shipped', color: 'default' },
  partially_shipped: { label: 'Partially Shipped', color: 'info' },
  fully_shipped: { label: 'Shipped', color: 'success' },
};

/**
 * Combined lifecycle-stage display + classification config for the jobs
 * list. `closed: true` marks the terminal stages that are hidden by default
 * (revealed by the "Show completed & cancelled" toggle). Key order defines
 * the Status dropdown option order. Colors are MUI Chip palette slots.
 */
export const JOB_LIFECYCLE_STAGE_CONFIG: Record<
  JobLifecycleStage,
  {
    label: string;
    color: 'default' | 'info' | 'success' | 'error' | 'warning' | 'secondary';
    closed: boolean;
  }
> = {
  not_started: { label: 'Not Started', color: 'default', closed: false },
  in_progress: { label: 'In Progress', color: 'info', closed: false },
  ready_to_ship: { label: 'Ready to Ship', color: 'warning', closed: false },
  partially_shipped: { label: 'Partially Shipped', color: 'secondary', closed: false },
  completed: { label: 'Completed', color: 'success', closed: true },
  cancelled: { label: 'Cancelled', color: 'error', closed: true },
};

/**
 * Inverse of getJobLifecycleStage: translate a selected stage into the
 * existing getAllJobs filter params. The two `.in()` column filters combine
 * as AND server-side, which is exactly the semantics each stage needs.
 * `showClosed: true` on the terminal stages means picking "Completed" or
 * "Cancelled" turns off excludeClosed so those otherwise-hidden rows appear.
 * The `completed` production set is "not cancelled" (all three non-cancelled
 * statuses) so it matches getJobLifecycleStage's `completed` = fully shipped
 * AND not cancelled, including the shipped-but-ops-in-progress edge.
 */
export const STAGE_TO_JOB_FILTERS: Record<
  JobLifecycleStage,
  Pick<JobFilters, 'productionStatus' | 'fulfillmentStatus'> & { showClosed?: boolean }
> = {
  not_started: { productionStatus: ['not_started'], fulfillmentStatus: ['unshipped'] },
  in_progress: { productionStatus: ['in_progress'], fulfillmentStatus: ['unshipped'] },
  ready_to_ship: { productionStatus: ['completed'], fulfillmentStatus: ['unshipped'] },
  partially_shipped: { fulfillmentStatus: ['partially_shipped'] },
  completed: {
    productionStatus: ['not_started', 'in_progress', 'completed'],
    fulfillmentStatus: ['fully_shipped'],
    showClosed: true,
  },
  cancelled: { productionStatus: ['cancelled'], showClosed: true },
};

// ============== Operation Types ==============

/**
 * Operation status values.
 *
 * `sent` is the external-operation (outside vendor) waypoint: an external op
 * moves pending → sent (Mark Sent Out) → completed (Mark Received). `sent` is
 * optional — Mark Received also completes directly from `pending`. `received`
 * is not a distinct value; a received external op is `completed`.
 */
export type OperationStatus = 'pending' | 'in_progress' | 'completed' | 'sent';

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
  sent: { label: 'At Vendor', color: 'warning' },
};

/**
 * Data for completing an operation.
 */
export interface CompleteOperationData {
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
  newJobPartProductionStatus?: ProductionStatus;
  /** True when the parent job's aggregate status changed as a side effect. */
  jobStatusChanged: boolean;
  newJobProductionStatus?: ProductionStatus;
}
