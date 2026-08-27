// Typed Supabase client (typed-client rollout). Aliased so the 8 call
// sites stay untouched. See CLAUDE.md "Typed Supabase client".
import { getSupabase } from '@/lib/supabase';
import { applyOverdueJobsFilter } from '@/utils/jobsAccess';

// ============== Types ==============

export type ActivityType = 'quote' | 'job' | 'shipment' | 'note' | 'photo' | 'operation' | 'inventory';

export type ActivityAction =
  | 'created'
  | 'started'
  | 'completed'
  | 'shipped'
  | 'noted'
  | 'photo_added'
  // Outside (external-vendor) operation lifecycle — same 'operation' type as an
  // internal completion, distinguished by action + vendorName.
  | 'sent'
  | 'received'
  // Stock movements. `moved` covers both halves of a transfer, which the feed folds into one row
  // the same way the operator's does — see `foldTransfers` in inventoryLocationsAccess.
  | 'stock_in'
  | 'stock_out'
  | 'moved'
  | 'counted';

export interface ActivityItem {
  id: string;
  type: ActivityType;
  /** The job/quote number the event hangs off (the row's bold label). */
  entityNumber: string;
  action: ActivityAction;
  timestamp: string;
  customerName?: string;
  /** For note/photo events: who authored it. */
  authorName?: string;
  /** For outside-op sent/received activities: the vendor the part went to. */
  vendorName?: string;
  /** Deep link to the underlying record. */
  href?: string;
  /** Inventory events: where it happened, and how much. */
  locationName?: string;
  quantityLabel?: string;
}

// ============== Dashboard metrics ==============

/**
 * Four metrics, fixed, in this order. There is no picker and no second page:
 * the scorecard row is one screen of four cards and that is the whole of it.
 *
 * They read left to right as an alert followed by the flow of work — what is
 * late, what is in hand, what went out, what might come in.
 */
export type MetricKey = 'overdue_jobs' | 'open_jobs' | 'completed_jobs' | 'open_quotes';

export type MetricTimePeriod = 'today' | 'this_week';

export interface MetricDefinition {
  key: MetricKey;
  label: string;
  /**
   * Only Completed is scoped to a period. The other three are a snapshot of
   * right now — "12 jobs in progress this week" is not a thing, and a period
   * control that three of four cards ignore reads as broken. The Today / This
   * Week toggle therefore lives ON the Completed card, not over the row.
   */
  supportsTimePeriod?: boolean;
}

export const DASHBOARD_METRICS: readonly MetricDefinition[] = [
  { key: 'overdue_jobs', label: 'Overdue Jobs' },
  { key: 'open_jobs', label: 'Open Jobs' },
  { key: 'completed_jobs', label: 'Completed Jobs', supportsTimePeriod: true },
  { key: 'open_quotes', label: 'Open Quotes' },
];

/**
 * A metric's count, and the money behind it.
 *
 * `money` is `null` where no honest figure exists — which is Open Quotes, and
 * for a real reason rather than a shortcut. A quote may carry several priced
 * options for the same part so the customer can choose; summing its lines adds
 * up alternatives that were never all going to happen. On the pilot shop's live
 * data that overstates the book by ~8%, and the "right" number is not merely
 * hard to compute but undefined, because nobody has chosen yet.
 */
export interface MetricValue {
  count: number;
  money: number | null;
  /** Prior-period money, for the delta. Only Completed carries one. */
  previousMoney?: number;
  /**
   * Open Jobs only: how the total divides between work that has not begun and
   * work on the floor. The merged tile would otherwise hide whether the shop is
   * flowing or piling up.
   */
  split?: {
    notStarted: { count: number; money: number };
    inProgress: { count: number; money: number };
    completed: { count: number; money: number };
  };
}

/** The shape every job-money query selects. */
type JobValueRow = {
  id: string;
  production_status: string | null;
  fulfillment_status: string | null;
  job_parts:
    | { total_price: number | null; unit_price: number | null; quantity: number | null }[]
    | null;
};

const JOB_VALUE_SELECT =
  'id, production_status, fulfillment_status, job_parts(total_price, unit_price, quantity)';

/**
 * The agreed money on a job: its OWN job_parts line totals, never the source
 * quote's. The job part is the post-conversion source of truth, so this follows
 * a quantity edited after conversion and does not over-count a price-options
 * quote's unchosen lines.
 *
 * This used to point at `insights_service._job_part_revenue` as "the same rule on
 * the backend, and the two must not drift". That helper is deleted along with the
 * predefined metric functions it served -- and nothing ever compared the two, so
 * the sentence asserted a parity it could not keep. The definition the AI reads is
 * api/services/ai/semantics.md; this is the only other implementation.
 */
function jobValue(row: JobValueRow): number {
  const parts = row.job_parts ?? [];
  return parts.reduce((sum, jp) => {
    if (jp.total_price !== null) return sum + jp.total_price;
    if (jp.unit_price !== null && jp.quantity !== null) return sum + jp.unit_price * jp.quantity;
    return sum;
  }, 0);
}


/**
 * Work still owed: **not fully shipped and not cancelled.**
 *
 * That is the whole rule, and Overdue is the same rule plus "past its due date"
 * — so every overdue job is an open job, by construction rather than by
 * coincidence. `applyOverdueJobsFilter` states it with the identical two
 * clauses.
 *
 * `production_status` is NOT part of the rule. It used to be
 * (`IN ('not_started','in_progress')`), which quietly meant a job finished on
 * the floor but not yet shipped counted as neither open nor — until 2026-08-27 —
 * overdue. It is plainly still owed: the customer does not have it. That
 * exclusion was also what broke containment for a day when Overdue widened
 * first.
 *
 * Fulfillment is on the rule for a reason worth keeping. `production_status` and
 * `fulfillment_status` are independent — a shop that ships without operators
 * closing out operations leaves jobs `not_started` and `fully_shipped` at the
 * same time, and there are 39 such jobs on the pilot shop. Filtering on
 * production alone put $37,769 of already-delivered work in this tile under the
 * words "not yet shipped", while the same money also counted as revenue in
 * Completed Jobs.
 *
 * The money is what is still OWED — ordered minus already shipped — so a
 * part-shipped job contributes only the remainder. Its shipped half is revenue
 * and is counted once, in Completed Jobs. Nothing on the row is double counted.
 */
async function getOpenJobs(companyId: string): Promise<MetricValue> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('jobs')
    .select(JOB_VALUE_SELECT)
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .not('production_status', 'eq', 'cancelled')
    .not('fulfillment_status', 'eq', 'fully_shipped');

  if (error) throw error;

  const rows = (data || []) as unknown as JobValueRow[];

  // Only a part-shipped job has anything to subtract, and there are few of
  // them, so the second query stays small rather than pulling every shipment
  // the company has ever made.
  const partIds = rows
    .filter((r) => r.fulfillment_status === 'partially_shipped')
    .map((r) => r.id);

  const shippedByJob = new Map<string, number>();
  if (partIds.length > 0) {
    const { data: shipments, error: shipErr } = await supabase
      .from('shipments')
      .select(SHIPMENT_VALUE_SELECT)
      .eq('company_id', companyId)
      .is('voided_at', null)
      .is('jobs.deleted_at', null)
      .in('job_id', partIds);

    if (shipErr) throw shipErr;

    for (const row of (shipments || []) as unknown as ShipmentValueRow[]) {
      if (!row.job_id) continue;
      shippedByJob.set(row.job_id, (shippedByJob.get(row.job_id) ?? 0) + shipmentValue(row));
    }
  }

  const notStarted = { count: 0, money: 0 };
  const inProgress = { count: 0, money: 0 };
  const completed = { count: 0, money: 0 };

  for (const row of rows) {
    // Three buckets, because the filter admits three production states. A
    // finished-but-unshipped job used to be excluded from the tile entirely;
    // folding it into "Not Started" instead would be worse than excluding it,
    // since it is the one bucket it is definitely not in.
    const bucket =
      row.production_status === 'completed'
        ? completed
        : row.production_status === 'in_progress'
          ? inProgress
          : notStarted;
    bucket.count += 1;
    // Never below zero: shipping more than was ordered is a data problem, not a
    // negative amount of backlog.
    bucket.money += Math.max(0, jobValue(row) - (shippedByJob.get(row.id) ?? 0));
  }

  // These three states are disjoint and cover the filter exactly, so this is the
  // one figure on the dashboard that is genuinely additive. Every other pair of
  // cards overlaps or measures a different kind of money.
  return {
    count: notStarted.count + inProgress.count + completed.count,
    money: notStarted.money + inProgress.money + completed.money,
    split: { notStarted, inProgress, completed },
  };
}

/**
 * Jobs past their due date and not yet shipped.
 *
 * Uses the shared `applyOverdueJobsFilter` so this card and the jobs list can
 * never disagree about what "overdue" means. Note the predicate restricts to
 * `production_status IN ('not_started','in_progress')` — so every overdue job is
 * ALSO counted in Open Jobs. Its money is a slice of that tile's, not a separate
 * pot, which is why the card says "past due" rather than naming a bucket.
 */
async function getOverdueJobs(companyId: string): Promise<MetricValue> {
  const supabase = getSupabase();
  const query = supabase
    .from('jobs')
    .select(JOB_VALUE_SELECT)
    .eq('company_id', companyId)
    .is('deleted_at', null);

  const { data, error } = await applyOverdueJobsFilter(query);
  if (error) throw error;

  const rows = (data || []) as unknown as JobValueRow[];
  return {
    count: rows.length,
    money: rows.reduce((sum, row) => sum + jobValue(row), 0),
  };
}

/**
 * Local calendar bounds for the period, as `YYYY-MM-DD`.
 *
 * `shipments.ship_date` is a DATE, not a timestamp — it is the calendar day the
 * shop says the truck left, carrying no time and no zone. So the window is
 * compared date-to-date and there is nothing to smear: a Saturday-evening ship
 * cannot land in Sunday because the office is west of UTC, which is exactly
 * what the old `updated_at` timestamp comparison could do.
 *
 * The day still starts at midnight in the BROWSER's timezone, and the week on
 * the local Sunday. That is the device's clock rather than a stored company
 * setting, so a laptop travelling across a timezone shifts the window with it.
 */
function periodDateBounds(
  period: MetricTimePeriod,
  offsetPeriods = 0,
): { start: string; end: string } {
  const localDate = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const now = new Date();
  const start = new Date(now);
  if (period === 'today') {
    start.setDate(start.getDate() + offsetPeriods);
  } else {
    // getDay() is 0 on Sunday, so this lands on the week's opening Sunday.
    start.setDate(now.getDate() - now.getDay() + offsetPeriods * 7);
  }
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(start.getDate() + (period === 'today' ? 1 : 7));

  return { start: localDate(start), end: localDate(end) };
}

/** A shipment with enough on it to price what left the building. */
type ShipmentValueRow = {
  job_id: string | null;
  shipment_line_items:
    | { quantity: number | null; job_parts: { unit_price: number | null } | null }[]
    | null;
};

// `jobs!inner(deleted_at)` is a filter, not data: shipments carry no deleted_at
// of their own (they are voided, not archived), so without the inner join an
// archived job's shipments keep counting as revenue while every other tile has
// already dropped that job. Soft-delete standard, CLAUDE.md.
const SHIPMENT_VALUE_SELECT =
  'id, job_id, ship_date, jobs!inner(deleted_at), shipment_line_items(quantity, job_parts(unit_price))';

/** What one shipment was worth: each line's shipped quantity at its agreed price. */
function shipmentValue(row: ShipmentValueRow): number {
  const lines = row.shipment_line_items ?? [];
  return lines.reduce((sum, li) => {
    const price = li.job_parts?.unit_price;
    if (li.quantity === null || price === null || price === undefined) return sum;
    return sum + li.quantity * price;
  }, 0);
}

/**
 * Revenue is what SHIPPED, priced per shipped unit, dated by the shipment.
 *
 * This used to count whole jobs at their full value, bucketed by
 * `jobs.updated_at` because no ship date exists on a job — `jobs.shipped_at` is
 * not in the dual-status model and `job_last_ship_date` is a `(uuid)` function
 * rather than a column, so PostgREST answers 400 if you select it. That proxy
 * was wrong in three ways at once, and all three fall out of reading the
 * shipment instead:
 *
 *   * `updated_at` meant "last written", not "shipped". Editing a PO number on a
 *     job shipped in March pulled it into this week, and rows only ever drifted
 *     INTO the current window, never out of it.
 *   * A PARTIAL shipment earned nothing. A job 60% shipped had 60% of its money
 *     in the customer's hands and contributed $0 here, while its full value sat
 *     in Open Jobs as backlog.
 *   * A job counted at its whole value the moment it went `fully_shipped`, even
 *     if that happened across two months.
 *
 * Voided shipments are excluded — that is the point of voiding one.
 *
 * The count follows the money: jobs SHIPPED FROM in the window, not jobs that
 * reached `fully_shipped`. Both halves of the card then describe the same act,
 * so "6 · $12,480 shipped this week" is one statement rather than two
 * measurements that happen to share a tile.
 */
async function getCompletedInRange(
  companyId: string,
  startDate: string,
  endDate: string,
): Promise<{ count: number; money: number }> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('shipments')
    .select(SHIPMENT_VALUE_SELECT)
    .eq('company_id', companyId)
    .is('voided_at', null)
    .is('jobs.deleted_at', null)
    .gte('ship_date', startDate)
    .lt('ship_date', endDate);

  if (error) throw error;

  const rows = (data || []) as unknown as ShipmentValueRow[];
  const jobs = new Set<string>();
  let money = 0;
  for (const row of rows) {
    if (row.job_id) jobs.add(row.job_id);
    money += shipmentValue(row);
  }
  return { count: jobs.size, money };
}

/**
 * Quotes still live — active AND never converted. Count only, see
 * `MetricValue.money`.
 *
 * `converted_at IS NULL` is the whole fix. `quotes.status` only ever holds
 * `active | expired`; winning a quote sets `converted_at` and leaves the status
 * alone, so a quote that became a job stays "active" forever and this tile
 * counted work already won as pipeline still to win. On the pilot shop it read
 * 25 when 11 were live; on demo companies it read 9 against 1, because nearly
 * every demo quote is converted.
 *
 * The drill-down goes to `?status=open`, which the quotes list resolves through
 * the same two conditions — the tile and the list it opens must never disagree.
 */
async function getOpenQuotes(companyId: string): Promise<MetricValue> {
  const supabase = getSupabase();
  const { count, error } = await supabase
    .from('quotes')
    .select('*', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .eq('status', 'active')
    .is('converted_at', null);

  if (error) throw error;
  return { count: count || 0, money: null };
}

/**
 * Every tile's value in one call.
 *
 * Each read is allowed to fail on its own — one broken metric should not blank
 * the row — but a failure surfaces as `null` rather than as zero. "Couldn't
 * check" must never render as a confident 0, which is what the old
 * per-metric `catch → { value: 0 }` did.
 */
export async function getDashboardMetrics(
  companyId: string,
  completedPeriod: MetricTimePeriod,
): Promise<Partial<Record<MetricKey, MetricValue>>> {
  const current = periodDateBounds(completedPeriod, 0);
  const previous = periodDateBounds(completedPeriod, -1);

  const [overdue, openJobs, completedNow, completedPrev, openQuotes] = await Promise.allSettled([
    getOverdueJobs(companyId),
    getOpenJobs(companyId),
    getCompletedInRange(companyId, current.start, current.end),
    getCompletedInRange(companyId, previous.start, previous.end),
    getOpenQuotes(companyId),
  ]);

  const out: Partial<Record<MetricKey, MetricValue>> = {};

  if (overdue.status === 'fulfilled') out.overdue_jobs = overdue.value;
  if (openJobs.status === 'fulfilled') out.open_jobs = openJobs.value;
  if (openQuotes.status === 'fulfilled') out.open_quotes = openQuotes.value;
  if (completedNow.status === 'fulfilled') {
    out.completed_jobs = {
      count: completedNow.value.count,
      money: completedNow.value.money,
      previousMoney:
        completedPrev.status === 'fulfilled' ? completedPrev.value.money : undefined,
    };
  }

  for (const settled of [overdue, openJobs, completedNow, completedPrev, openQuotes]) {
    if (settled.status === 'rejected') {
      console.error('Error loading a dashboard metric:', settled.reason);
    }
  }

  return out;
}

/**
 * True when the company has no quotes and no jobs at all — drives the
 * onboarding card.
 *
 * "Nothing here yet" is about never having started, not about having finished:
 * a shop whose every job has shipped is not empty. The previous check fired
 * four metric queries and folded in revenue to reach roughly the same answer.
 */
export async function isDashboardEmpty(companyId: string): Promise<boolean> {
  const supabase = getSupabase();
  const [quotes, jobs] = await Promise.all([
    supabase
      .from('quotes')
      .select('*', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .is('deleted_at', null),
    supabase
      .from('jobs')
      .select('*', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .is('deleted_at', null),
  ]);

  if (quotes.error) throw quotes.error;
  if (jobs.error) throw jobs.error;
  return (quotes.count || 0) === 0 && (jobs.count || 0) === 0;
}

// ============== Completed-card period preference ==============

const COMPLETED_PERIOD_KEY = 'dashboard_completed_period';

/** Which window the Completed card is showing. Defaults to the week. */
export async function getCompletedPeriod(): Promise<MetricTimePeriod> {
  const supabase = getSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return 'this_week';

  const { data, error } = await supabase
    .from('user_preferences')
    .select('preferences')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error || !data) return 'this_week';

  const prefs = data.preferences as Record<string, unknown> | null;
  return prefs?.[COMPLETED_PERIOD_KEY] === 'today' ? 'today' : 'this_week';
}

export async function setCompletedPeriod(period: MetricTimePeriod): Promise<void> {
  const supabase = getSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  const { data: existing } = await supabase
    .from('user_preferences')
    .select('preferences')
    .eq('user_id', user.id)
    .maybeSingle();

  const currentPrefs = (existing?.preferences as Record<string, unknown>) || {};

  await supabase.from('user_preferences').upsert(
    {
      user_id: user.id,
      preferences: { ...currentPrefs, [COMPLETED_PERIOD_KEY]: period },
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );
}
// ============== Activity feed ==============
//
// A cross-module "what happened" stream, built UNION-on-read over the
// authoritative tables (jobs, quotes, shipments, notes, job_operations) —
// NOT a materialized/fan-out activity table. Per-tenant volume is tiny and the
// status/timestamps already live on those rows, so a second source of truth
// would only invite drift (mirrors the getPartActivity aggregate-on-read).
// All reads are plain Supabase (no AI on mount). company_id leads every query.

/** Cap pulled per source before the in-memory merge, so one busy source can't starve the feed. */
const ACTIVITY_PER_SOURCE = 50;

/** Flatten a Supabase joined relation (object | array | null) to a single row. */
function firstRel<T>(rel: T | T[] | null | undefined): T | null {
  if (!rel) return null;
  return Array.isArray(rel) ? rel[0] ?? null : rel;
}

interface CollectOptions {
  /** Only items strictly older than this ISO timestamp (pagination cursor). */
  before?: string;
  /** Restrict to these activity types. Undefined = all. */
  types?: ActivityType[];
  /** Rows to pull per source query. */
  perSource?: number;
}

type JobRow = {
  id: string;
  job_number: string;
  created_at: string | null;
  completed_at: string | null;
  customer: { name: string | null } | { name: string | null }[] | null;
};

async function fetchJobActivity(
  companyId: string,
  before: string | undefined,
  perSource: number,
): Promise<ActivityItem[]> {
  const supabase = getSupabase();

  let createdQ = supabase
    .from('jobs')
    .select('id, job_number, created_at, completed_at, customer:customers(name)')
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(perSource);
  if (before) createdQ = createdQ.lt('created_at', before);

  let completedQ = supabase
    .from('jobs')
    .select('id, job_number, created_at, completed_at, customer:customers(name)')
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .not('completed_at', 'is', null)
    .order('completed_at', { ascending: false })
    .limit(perSource);
  if (before) completedQ = completedQ.lt('completed_at', before);

  const [created, completed] = await Promise.all([createdQ, completedQ]);
  const items: ActivityItem[] = [];

  for (const r of (created.data ?? []) as unknown as JobRow[]) {
    if (!r.created_at) continue;
    items.push({
      id: `job-created-${r.id}`,
      type: 'job',
      action: 'created',
      entityNumber: r.job_number,
      timestamp: r.created_at,
      customerName: firstRel(r.customer)?.name ?? undefined,
      href: `/dashboard/${companyId}/jobs/${r.id}`,
    });
  }
  for (const r of (completed.data ?? []) as unknown as JobRow[]) {
    if (!r.completed_at) continue;
    items.push({
      id: `job-completed-${r.id}`,
      type: 'job',
      action: 'completed',
      entityNumber: r.job_number,
      timestamp: r.completed_at,
      customerName: firstRel(r.customer)?.name ?? undefined,
      href: `/dashboard/${companyId}/jobs/${r.id}`,
    });
  }
  return items;
}

type QuoteRow = {
  id: string;
  quote_number: string;
  created_at: string | null;
  customer: { name: string | null } | { name: string | null }[] | null;
};

async function fetchQuoteActivity(
  companyId: string,
  before: string | undefined,
  perSource: number,
): Promise<ActivityItem[]> {
  const supabase = getSupabase();
  let q = supabase
    .from('quotes')
    .select('id, quote_number, created_at, customer:customers(name)')
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(perSource);
  if (before) q = q.lt('created_at', before);

  const { data } = await q;
  const items: ActivityItem[] = [];
  for (const r of (data ?? []) as unknown as QuoteRow[]) {
    if (!r.created_at) continue;
    items.push({
      id: `quote-created-${r.id}`,
      type: 'quote',
      action: 'created',
      entityNumber: r.quote_number,
      timestamp: r.created_at,
      customerName: firstRel(r.customer)?.name ?? undefined,
      href: `/dashboard/${companyId}/quotes/${r.id}`,
    });
  }
  return items;
}

type ShipmentRow = {
  id: string;
  created_at: string;
  job_id: string;
  job: { job_number: string } | { job_number: string }[] | null;
  customer: { name: string | null } | { name: string | null }[] | null;
};

async function fetchShipmentActivity(
  companyId: string,
  before: string | undefined,
  perSource: number,
): Promise<ActivityItem[]> {
  const supabase = getSupabase();
  let q = supabase
    .from('shipments')
    .select('id, created_at, job_id, job:jobs(job_number), customer:customers(name)')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(perSource);
  if (before) q = q.lt('created_at', before);

  const { data } = await q;
  const items: ActivityItem[] = [];
  for (const r of (data ?? []) as unknown as ShipmentRow[]) {
    if (!r.created_at) continue;
    items.push({
      id: `shipment-${r.id}`,
      type: 'shipment',
      action: 'shipped',
      entityNumber: firstRel(r.job)?.job_number ?? '',
      timestamp: r.created_at,
      customerName: firstRel(r.customer)?.name ?? undefined,
      href: `/dashboard/${companyId}/jobs/${r.job_id}`,
    });
  }
  return items;
}

type NoteActivityRow = {
  id: string;
  created_at: string;
  // Both nullable now: a job-subject note has job_id, a durable part-subject note has
  // captured_job_id, and a work-center-subject note has neither.
  job_id: string | null;
  captured_job_id: string | null;
  job: { job_number: string } | { job_number: string }[] | null;
  captured_job: { job_number: string } | { job_number: string }[] | null;
  author: { name: string | null } | { name: string | null }[] | null;
  media: { id: string }[] | null;
};

async function fetchNoteActivity(
  companyId: string,
  before: string | undefined,
  perSource: number,
): Promise<ActivityItem[]> {
  const supabase = getSupabase();
  // A note now resolves to a job one of two ways: job_id (a job-subject note) or
  // captured_job_id (a DURABLE part-subject note, whose subject is the part but which
  // was written while running a job). Both are embedded and coalesced below —
  // PostgREST cannot COALESCE in a select, and keying only on job_id would silently
  // drop every new operator capture from the activity feed.
  // Two FKs point at `jobs`, so each embed must name its constraint to disambiguate.
  let q = supabase
    .from('notes')
    .select(
      'id, created_at, job_id, captured_job_id, ' +
        'job:jobs!notes_job_fk(job_number), ' +
        'captured_job:jobs!notes_captured_job_fk(job_number), ' +
        'author:user_company_access(name), media:note_media(id)',
    )
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(perSource);
  if (before) q = q.lt('created_at', before);

  const { data } = await q;
  const items: ActivityItem[] = [];
  for (const r of (data ?? []) as unknown as NoteActivityRow[]) {
    if (!r.created_at) continue;
    const hasMedia = (r.media ?? []).length > 0;
    const jobId = r.job_id ?? r.captured_job_id;
    const jobNumber =
      firstRel(r.job)?.job_number ?? firstRel(r.captured_job)?.job_number ?? '';
    items.push({
      id: `note-${r.id}`,
      // A note carrying photos surfaces as a 'photo' event so the /activity
      // filter can separate the two; text-only notes are 'note'.
      type: hasMedia ? 'photo' : 'note',
      action: hasMedia ? 'photo_added' : 'noted',
      entityNumber: jobNumber,
      timestamp: r.created_at,
      authorName: firstRel(r.author)?.name ?? undefined,
      // A work-center-subject note has no job at all; link to the feed itself
      // rather than emitting /jobs/undefined.
      href: jobId
        ? `/dashboard/${companyId}/jobs/${jobId}`
        : `/dashboard/${companyId}/activity`,
    });
  }
  return items;
}

type VendorRel = { name: string } | { name: string }[] | null;
type VsRel = { vendor: VendorRel } | { vendor: VendorRel }[] | null;

type OperationActivityRow = {
  id: string;
  completed_at: string | null;
  sent_at?: string | null;
  job_id: string;
  /** Non-null iff this op was performed by an outside vendor. */
  vendor_service_id: string | null;
  jobs: { job_number: string } | { job_number: string }[] | null;
  vendor_service: VsRel;
};

function opActivityHref(companyId: string, jobId: string): string {
  return `/dashboard/${companyId}/jobs/${jobId}`;
}

/**
 * Stock movements, for the `inventory` filter on the activity page.
 *
 * The owner had no shop-wide view of stock moving. `getRecentActivity` exists and does exactly
 * this, but its only caller is the operator's Inventory tab — so the person paying for the
 * software could see one part's ledger, or one place's, and never the shop. This puts it where
 * every other cross-module event already lives rather than building a second feed.
 *
 * Deliberately NOT reusing `getRecentActivity`: that one folds transfer pairs, signs photos and
 * resolves author names for a card list on a phone. Here the row is one line in a mixed feed, so
 * it skips the photo round trip entirely and folds by taking only the destination leg of a
 * transfer — the same rule, a tenth of the work.
 */
async function fetchInventoryActivity(
  companyId: string,
  before: string | undefined,
  perSource: number,
): Promise<ActivityItem[]> {
  const supabase = getSupabase();

  let q = supabase
    .from('inventory_transactions')
    .select('id, created_at, type, item_name, quantity, unit, part_id, location_name, transfer_group_id, notes')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(perSource);
  if (before) q = q.lt('created_at', before);

  const { data, error } = await q;
  if (error) {
    console.error('Error fetching inventory activity:', error);
    return [];
  }

  type Row = {
    id: string;
    created_at: string;
    type: string;
    item_name: string;
    quantity: number;
    unit: string;
    part_id: string | null;
    location_name: string | null;
    transfer_group_id: string | null;
    notes: string | null;
  };
  const rows = (data ?? []) as unknown as Row[];

  // A transfer writes two rows sharing a group id. Showing both puts the same event in the feed
  // twice with opposite signs; keeping the ADDITION leg keeps the place the stock ended up in.
  const groupsWithArrival = new Set(
    rows.filter((r) => r.transfer_group_id && r.type === 'addition').map((r) => r.transfer_group_id),
  );

  const items: ActivityItem[] = [];
  for (const r of rows) {
    if (r.transfer_group_id && r.type === 'depletion' && groupsWithArrival.has(r.transfer_group_id)) {
      continue;
    }
    const moved = Boolean(r.transfer_group_id);
    const action: ActivityAction = moved
      ? 'moved'
      : r.type === 'addition'
        ? 'stock_in'
        : r.type === 'depletion'
          ? 'stock_out'
          : 'counted';

    items.push({
      id: `inv-${r.id}`,
      type: 'inventory',
      entityNumber: r.item_name,
      action,
      timestamp: r.created_at,
      locationName: r.location_name ?? undefined,
      quantityLabel: `${Number(r.quantity ?? 0).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${r.unit}`,
      href: r.part_id ? `/dashboard/${companyId}/parts/${r.part_id}?tab=inventory` : undefined,
    });
  }
  return items;
}

/**
 * Operation lifecycle activities. Two sources, both scoped through the inner
 * jobs join (job_operations has no company_id):
 *  - completed_at → 'completed' (internal) or 'received' (external, from vendor)
 *  - external sent_at → 'sent' (parts went out to the vendor)
 * A received external op has both stamps, so it emits BOTH a sent and a received
 * activity. Undo just clears the stamp, so the activity drops off on reload (no
 * tombstone) — same behavior as internal completion undo.
 */
async function fetchOperationActivity(
  companyId: string,
  before: string | undefined,
  perSource: number,
): Promise<ActivityItem[]> {
  const supabase = getSupabase();
  // The vendor comes through the SERVICE now. `vendor_service_id` on the row is
  // what says "this was outside work"; the join only supplies the name.
  const VS_SELECT = 'vendor_service:vendor_services(vendor:vendors(name))';

  let completedQ = supabase
    .from('job_operations')
    .select(`id, completed_at, job_id, vendor_service_id, jobs!inner(job_number, company_id), ${VS_SELECT}`)
    .eq('jobs.company_id', companyId)
    .not('completed_at', 'is', null)
    .order('completed_at', { ascending: false })
    .limit(perSource);
  if (before) completedQ = completedQ.lt('completed_at', before);

  // Sent (at-vendor) events — outside ops only. The !inner join on
  // vendor_services is itself the filter: only an outside op has one, so the
  // separate .eq('kind','external') this used to need is gone.
  let sentQ = supabase
    .from('job_operations')
    .select(`id, sent_at, job_id, vendor_service_id, jobs!inner(job_number, company_id), vendor_service:vendor_services!inner(vendor:vendors(name))`)
    .eq('jobs.company_id', companyId)
    .not('sent_at', 'is', null)
    .order('sent_at', { ascending: false })
    .limit(perSource);
  if (before) sentQ = sentQ.lt('sent_at', before);

  const [completed, sent] = await Promise.all([completedQ, sentQ]);
  const items: ActivityItem[] = [];

  const vendorOf = (vs: VsRel): string | undefined => {
    const v = firstRel(vs);
    return v ? firstRel(v.vendor)?.name : undefined;
  };

  for (const r of (completed.data ?? []) as unknown as OperationActivityRow[]) {
    if (!r.completed_at) continue;
    // Boolean(), not `!== null`: a select that omits the column yields
    // undefined, and `undefined !== null` is true — which would label every
    // in-house completion as 'received from vendor'.
    const isExternal = Boolean(r.vendor_service_id);
    items.push({
      id: `op-comp-${r.id}`,
      type: 'operation',
      action: isExternal ? 'received' : 'completed',
      vendorName: isExternal ? vendorOf(r.vendor_service) : undefined,
      entityNumber: firstRel(r.jobs)?.job_number ?? '',
      timestamp: r.completed_at,
      href: opActivityHref(companyId, r.job_id),
    });
  }

  for (const r of (sent.data ?? []) as unknown as OperationActivityRow[]) {
    if (!r.sent_at) continue;
    items.push({
      id: `op-sent-${r.id}`,
      type: 'operation',
      action: 'sent',
      vendorName: vendorOf(r.vendor_service),
      entityNumber: firstRel(r.jobs)?.job_number ?? '',
      timestamp: r.sent_at,
      href: opActivityHref(companyId, r.job_id),
    });
  }

  return items;
}

async function collectActivity(
  companyId: string,
  { before, types, perSource = ACTIVITY_PER_SOURCE }: CollectOptions,
): Promise<ActivityItem[]> {
  const want = (t: ActivityType) => !types || types.includes(t);

  const tasks: Promise<ActivityItem[]>[] = [];
  if (want('job')) tasks.push(fetchJobActivity(companyId, before, perSource));
  if (want('quote')) tasks.push(fetchQuoteActivity(companyId, before, perSource));
  if (want('shipment')) tasks.push(fetchShipmentActivity(companyId, before, perSource));
  // 'note' and 'photo' both come from notes (one query yields both kinds).
  if (want('note') || want('photo')) tasks.push(fetchNoteActivity(companyId, before, perSource));
  if (want('operation')) tasks.push(fetchOperationActivity(companyId, before, perSource));
  if (want('inventory')) tasks.push(fetchInventoryActivity(companyId, before, perSource));

  const results = await Promise.all(tasks.map((t) => t.catch(() => [] as ActivityItem[])));
  let items = results.flat();
  if (types) items = items.filter((i) => types.includes(i.type));
  items.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return items;
}

/**
 * Compact dashboard "Recent Activity" card: the latest manager-relevant
 * business milestones (jobs created/completed, quotes created, shipments) —
 * deliberately NOT the high-volume per-note/photo floor chatter, which lives on
 * the dedicated /activity page. Newest first, capped (default 6).
 */
export async function getDashboardActivity(
  companyId: string,
  opts?: { limit?: number },
): Promise<ActivityItem[]> {
  const limit = opts?.limit ?? 6;
  const items = await collectActivity(companyId, {
    types: ['job', 'quote', 'shipment'],
    perSource: Math.max(limit * 3, 12),
  });
  return items.slice(0, limit);
}

/**
 * The dedicated /activity page stream: the full cross-module feed including
 * floor activity (notes, photos, operation completions). Optionally filtered by
 * type and paginated with a `before` cursor (pass the last item's timestamp to
 * load older). Newest first.
 */
export async function getActivityStream(
  companyId: string,
  opts?: { types?: ActivityType[]; limit?: number; before?: string },
): Promise<ActivityItem[]> {
  const limit = opts?.limit ?? 30;
  const items = await collectActivity(companyId, {
    before: opts?.before,
    types: opts?.types,
    perSource: Math.max(limit, ACTIVITY_PER_SOURCE),
  });
  return items.slice(0, limit);
}
