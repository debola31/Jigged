import * as Sentry from '@sentry/nextjs';
// Typed Supabase client (typed-client rollout). Aliased so the 8 call
// sites stay untouched. See CLAUDE.md "Typed Supabase client".
import { getTypedSupabase as getSupabase } from '@/lib/supabase';

// ============== Types ==============

export type ActivityType = 'quote' | 'job' | 'shipment' | 'note' | 'photo' | 'operation';

export type ActivityAction =
  | 'created'
  | 'started'
  | 'completed'
  | 'shipped'
  | 'noted'
  | 'photo_added';

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
  /** Deep link to the underlying record. */
  href?: string;
}

// ============== Pinned Metrics ==============

export type MetricKey =
  | 'open_quotes'
  | 'not_started_jobs'
  | 'in_progress_jobs'
  | 'revenue'
  | 'completed_jobs'
  | 'overdue_jobs';

export type MetricTimePeriod = 'today' | 'this_week';

export interface MetricDefinition {
  key: MetricKey;
  label: string;
  format: 'number' | 'currency';
  supportsTimePeriod?: boolean;
}

export const AVAILABLE_METRICS: MetricDefinition[] = [
  { key: 'open_quotes', label: 'Open Quotes', format: 'number' },
  { key: 'not_started_jobs', label: 'Jobs Not Started', format: 'number' },
  { key: 'in_progress_jobs', label: 'Jobs In Progress', format: 'number' },
  { key: 'revenue', label: 'Revenue', format: 'currency', supportsTimePeriod: true },
  { key: 'completed_jobs', label: 'Completed Jobs', format: 'number', supportsTimePeriod: true },
  { key: 'overdue_jobs', label: 'Overdue Jobs', format: 'number' },
];

// The user pins up to this many metrics; they render as the primary dashboard
// cards (one page of the scorecard grid). Overdue Jobs is a normal pickable
// metric — included in the defaults so it shows out of the box, but the user
// can reorder or remove it like any other.
export const PINNED_METRIC_SLOTS = 4;

export const DEFAULT_PINNED_METRICS: MetricKey[] = [
  'overdue_jobs',
  'open_quotes',
  'not_started_jobs',
  'in_progress_jobs',
];

// Metrics the user is allowed to pin — every available metric.
export const PICKABLE_METRICS: MetricDefinition[] = AVAILABLE_METRICS;

// Legacy key migration map
const LEGACY_KEY_MAP: Record<string, MetricKey> = {
  weekly_revenue: 'revenue',
  monthly_revenue: 'revenue',
  // active_jobs used to count not_started + in_progress (a union); it has
  // been split into two separate metrics. Map old user prefs to the
  // not_started half so existing dashboards keep one tile in roughly the
  // same conceptual slot.
  active_jobs: 'not_started_jobs',
};
const REMOVED_KEYS = ['at_risk_count', 'low_inventory_count', 'total_customers', 'total_parts'];

/**
 * Get the user's pinned metric keys from user_preferences.
 * Returns defaults if no preference is stored.
 * Automatically migrates legacy keys.
 */
export async function getPinnedMetricKeys(): Promise<MetricKey[]> {
  const supabase = getSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return DEFAULT_PINNED_METRICS;

  const { data, error } = await supabase
    .from('user_preferences')
    .select('preferences')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error || !data) return DEFAULT_PINNED_METRICS;

  const prefs = data.preferences as Record<string, unknown> | null;
  const pinned = prefs?.dashboard_pinned_metrics;
  if (Array.isArray(pinned) && pinned.length > 0) {
    // Migrate legacy keys (rename / drop removed)
    const migrated = pinned
      .map((k: string) => LEGACY_KEY_MAP[k] || k)
      .filter((k: string) => !REMOVED_KEYS.includes(k))
      .filter((k: string, i: number, arr: string[]) => arr.indexOf(k) === i) as MetricKey[];

    // One-time Overdue migration: Overdue Jobs used to be force-pinned outside
    // the stored list, so pre-existing prefs never contain it. Now it's a normal
    // selectable metric — fold it in once (front, capped at the slot count) so it
    // stays visible on existing dashboards. Gated by a flag (stamped whenever
    // prefs are saved, see setPinnedMetricKeys) so a later deliberate removal
    // sticks instead of bouncing back on the next load.
    const overdueFolded =
      prefs?.dashboard_overdue_selectable_migrated !== true && !migrated.includes('overdue_jobs');
    const withOverdue = overdueFolded
      ? (['overdue_jobs', ...migrated].slice(0, PINNED_METRIC_SLOTS) as MetricKey[])
      : migrated;

    // Persist if legacy keys changed or we just folded Overdue in (the save also
    // stamps the migration flag).
    const changed =
      withOverdue.length !== pinned.length || withOverdue.some((k, i) => k !== pinned[i]);
    if (changed || overdueFolded) {
      setPinnedMetricKeys(withOverdue).catch((err) => Sentry.captureException(err, { level: 'warning' }));
    }

    return withOverdue.length > 0 ? withOverdue : DEFAULT_PINNED_METRICS;
  }
  return DEFAULT_PINNED_METRICS;
}

/**
 * Save the user's pinned metric keys to user_preferences.
 */
export async function setPinnedMetricKeys(keys: MetricKey[]): Promise<void> {
  const supabase = getSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  // Read existing preferences first
  const { data: existing } = await supabase
    .from('user_preferences')
    .select('preferences')
    .eq('user_id', user.id)
    .maybeSingle();

  const currentPrefs = (existing?.preferences as Record<string, unknown>) || {};
  const updatedPrefs = {
    ...currentPrefs,
    dashboard_pinned_metrics: keys,
    // Any explicit save makes the user's list authoritative (including whether
    // they kept Overdue), so stamp the one-time Overdue migration as done.
    dashboard_overdue_selectable_migrated: true,
  };

  await supabase
    .from('user_preferences')
    .upsert(
      {
        user_id: user.id,
        preferences: updatedPrefs,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );
}

// ============== Time Period Preferences ==============

/**
 * Get the user's saved time period preferences for metrics.
 */
export async function getMetricTimePeriods(): Promise<Partial<Record<MetricKey, MetricTimePeriod>>> {
  const supabase = getSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return {};

  const { data, error } = await supabase
    .from('user_preferences')
    .select('preferences')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error || !data) return {};

  const prefs = data.preferences as Record<string, unknown> | null;
  const periods = prefs?.dashboard_metric_periods;
  if (periods && typeof periods === 'object') {
    return periods as Partial<Record<MetricKey, MetricTimePeriod>>;
  }
  return {};
}

/**
 * Save a single metric's time period preference.
 */
export async function setMetricTimePeriod(key: MetricKey, period: MetricTimePeriod): Promise<void> {
  const supabase = getSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  const { data: existing } = await supabase
    .from('user_preferences')
    .select('preferences')
    .eq('user_id', user.id)
    .maybeSingle();

  const currentPrefs = (existing?.preferences as Record<string, unknown>) || {};
  const currentPeriods = (currentPrefs.dashboard_metric_periods as Record<string, string>) || {};
  const updatedPrefs = {
    ...currentPrefs,
    dashboard_metric_periods: { ...currentPeriods, [key]: period },
  };

  await supabase
    .from('user_preferences')
    .upsert(
      {
        user_id: user.id,
        preferences: updatedPrefs,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );
}

// ============== Metric Value Queries ==============

// The typed client needs a literal table name to resolve column types,
// so this helper is constrained to the tables it actually counts over.
// Add to the union if a new caller needs a different table.
type CountableTable = 'quotes' | 'jobs';

async function getCount(
  table: CountableTable,
  companyId: string,
  filters?: Record<string, string[]>,
): Promise<number> {
  const supabase = getSupabase();
  let query = supabase.from(table).select('*', { count: 'exact', head: true }).eq('company_id', companyId);

  if (filters) {
    for (const [col, values] of Object.entries(filters)) {
      query = query.in(col, values);
    }
  }

  const { count, error } = await query;
  if (error) throw error;
  return count || 0;
}

/**
 * Return [currentPeriodStart, nextPeriodStart] as ISO strings.
 * "today" → midnight today → midnight tomorrow.
 * "this_week" → Sunday 00:00 → next Sunday 00:00.
 */
function periodBounds(period: MetricTimePeriod, offsetPeriods = 0): { start: string; end: string } {
  const now = new Date();
  if (period === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() + offsetPeriods);
    const end = new Date(start);
    end.setDate(start.getDate() + 1);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  const start = new Date(now);
  start.setDate(now.getDate() - now.getDay() + offsetPeriods * 7);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 7);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function getRevenueInRange(
  companyId: string,
  startIso: string,
  endIso: string
): Promise<number> {
  const supabase = getSupabase();
  // "Revenue in range" used to filter jobs.shipped_at — but shipped_at is
  // gone in the dual-status model. Re-anchor on fulfillment_status =
  // fully_shipped + the new SQL helper job_last_ship_date, which PR 4
  // wires up to the shipments cascade. PR 3 ships a NULL-returning stub,
  // so this query returns 0 until shipments exist — that's the truthful
  // answer because no shipments exist yet.
  const { data, error } = await supabase
    .from('jobs')
    .select(
      'id, quotes!jobs_quote_id_fkey(quote_line_items(total_price)), last_ship_date:job_last_ship_date',
    )
    .eq('company_id', companyId)
    .eq('fulfillment_status', 'fully_shipped')
    .gte('updated_at', startIso)
    .lt('updated_at', endIso);

  if (error) throw error;

  type Row = {
    quotes: { quote_line_items: { total_price: number | null }[] | null } | null;
  };

  return ((data || []) as unknown as Row[]).reduce((sum, job) => {
    const lines = job.quotes?.quote_line_items ?? [];
    return sum + lines.reduce((s, li) => s + (li.total_price || 0), 0);
  }, 0);
}

async function getCompletedJobsInRange(
  companyId: string,
  startIso: string,
  endIso: string
): Promise<number> {
  const supabase = getSupabase();
  // "Completed" on the dashboard means the FR-18 done predicate
  // (production = completed/cancelled AND fulfillment = fully_shipped).
  // Server-side we approximate with the fulfillment half, which is the
  // tighter constraint — a fully_shipped job is by definition done.
  const { count, error } = await supabase
    .from('jobs')
    .select('*', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('fulfillment_status', 'fully_shipped')
    .gte('updated_at', startIso)
    .lt('updated_at', endIso);

  if (error) throw error;
  return count || 0;
}

async function getOverdueJobs(companyId: string): Promise<number> {
  const supabase = getSupabase();
  const now = new Date().toISOString();

  const { count, error } = await supabase
    .from('jobs')
    .select('*', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .in('production_status', ['not_started', 'in_progress'])
    .not('fulfillment_status', 'eq', 'fully_shipped')
    .lt('due_date', now);

  if (error) throw error;
  return count || 0;
}

/**
 * Value + optional prior-period value for a metric. `previousValue` is only
 * populated for time-aware metrics (revenue, completed_jobs) where a
 * period-over-period comparison is meaningful. Stateful counts like
 * open_quotes would need historical snapshots to support a delta and are
 * returned without one.
 */
export interface MetricValue {
  value: number;
  previousValue?: number;
}

async function getMetricValueWithDelta(
  companyId: string,
  key: MetricKey,
  timePeriod?: MetricTimePeriod
): Promise<MetricValue> {
  switch (key) {
    case 'open_quotes':
      return { value: await getCount('quotes', companyId, { status: ['active'] }) };
    case 'not_started_jobs':
      return {
        value: await getCount('jobs', companyId, { production_status: ['not_started'] }),
      };
    case 'in_progress_jobs':
      return {
        value: await getCount('jobs', companyId, { production_status: ['in_progress'] }),
      };
    case 'overdue_jobs':
      return { value: await getOverdueJobs(companyId) };
    case 'revenue': {
      const period = timePeriod ?? 'this_week';
      const curr = periodBounds(period, 0);
      const prev = periodBounds(period, -1);
      const [value, previousValue] = await Promise.all([
        getRevenueInRange(companyId, curr.start, curr.end),
        getRevenueInRange(companyId, prev.start, prev.end),
      ]);
      return { value, previousValue };
    }
    case 'completed_jobs': {
      const period = timePeriod ?? 'this_week';
      const curr = periodBounds(period, 0);
      const prev = periodBounds(period, -1);
      const [value, previousValue] = await Promise.all([
        getCompletedJobsInRange(companyId, curr.start, curr.end),
        getCompletedJobsInRange(companyId, prev.start, prev.end),
      ]);
      return { value, previousValue };
    }
    default:
      return { value: 0 };
  }
}

/**
 * Get the value for a single metric key (flat number — no delta).
 * Kept for callers that don't need period-over-period data.
 */
export async function getMetricValue(
  companyId: string,
  key: MetricKey,
  timePeriod?: MetricTimePeriod
): Promise<number> {
  const r = await getMetricValueWithDelta(companyId, key, timePeriod);
  return r.value;
}

/**
 * Get values + deltas for all requested metrics in parallel.
 */
export async function getPinnedMetricValues(
  companyId: string,
  keys: MetricKey[],
  timePeriods?: Partial<Record<MetricKey, MetricTimePeriod>>
): Promise<Record<MetricKey, MetricValue>> {
  const results = await Promise.all(
    keys.map(async (key) => {
      try {
        const v = await getMetricValueWithDelta(companyId, key, timePeriods?.[key]);
        return [key, v] as const;
      } catch {
        return [key, { value: 0 } as MetricValue] as const;
      }
    })
  );
  return Object.fromEntries(results) as Record<MetricKey, MetricValue>;
}

// ============== Activity feed ==============
//
// A cross-module "what happened" stream, built UNION-on-read over the
// authoritative tables (jobs, quotes, shipments, job_notes, job_operations) —
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
    .order('created_at', { ascending: false })
    .limit(perSource);
  if (before) createdQ = createdQ.lt('created_at', before);

  let completedQ = supabase
    .from('jobs')
    .select('id, job_number, created_at, completed_at, customer:customers(name)')
    .eq('company_id', companyId)
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
  job_id: string;
  job: { job_number: string } | { job_number: string }[] | null;
  author: { name: string | null } | { name: string | null }[] | null;
  media: { id: string }[] | null;
};

async function fetchNoteActivity(
  companyId: string,
  before: string | undefined,
  perSource: number,
): Promise<ActivityItem[]> {
  const supabase = getSupabase();
  let q = supabase
    .from('job_notes')
    .select('id, created_at, job_id, job:jobs(job_number), author:user_company_access(name), media:job_note_media(id)')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(perSource);
  if (before) q = q.lt('created_at', before);

  const { data } = await q;
  const items: ActivityItem[] = [];
  for (const r of (data ?? []) as unknown as NoteActivityRow[]) {
    if (!r.created_at) continue;
    const hasMedia = (r.media ?? []).length > 0;
    items.push({
      id: `note-${r.id}`,
      // A note carrying photos surfaces as a 'photo' event so the /activity
      // filter can separate the two; text-only notes are 'note'.
      type: hasMedia ? 'photo' : 'note',
      action: hasMedia ? 'photo_added' : 'noted',
      entityNumber: firstRel(r.job)?.job_number ?? '',
      timestamp: r.created_at,
      authorName: firstRel(r.author)?.name ?? undefined,
      href: `/dashboard/${companyId}/jobs/${r.job_id}`,
    });
  }
  return items;
}

type OperationActivityRow = {
  id: string;
  completed_at: string | null;
  job_id: string;
  jobs: { job_number: string } | { job_number: string }[] | null;
};

async function fetchOperationActivity(
  companyId: string,
  before: string | undefined,
  perSource: number,
): Promise<ActivityItem[]> {
  const supabase = getSupabase();
  // job_operations has no company_id; scope through the inner jobs join.
  let q = supabase
    .from('job_operations')
    .select('id, completed_at, job_id, jobs!inner(job_number, company_id)')
    .eq('jobs.company_id', companyId)
    .not('completed_at', 'is', null)
    .order('completed_at', { ascending: false })
    .limit(perSource);
  if (before) q = q.lt('completed_at', before);

  const { data } = await q;
  const items: ActivityItem[] = [];
  for (const r of (data ?? []) as unknown as OperationActivityRow[]) {
    if (!r.completed_at) continue;
    items.push({
      id: `op-${r.id}`,
      type: 'operation',
      action: 'completed',
      entityNumber: firstRel(r.jobs)?.job_number ?? '',
      timestamp: r.completed_at,
      href: `/dashboard/${companyId}/jobs/${r.job_id}`,
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
  // 'note' and 'photo' both come from job_notes (one query yields both kinds).
  if (want('note') || want('photo')) tasks.push(fetchNoteActivity(companyId, before, perSource));
  if (want('operation')) tasks.push(fetchOperationActivity(companyId, before, perSource));

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
