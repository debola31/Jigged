import * as Sentry from '@sentry/nextjs';
import { getSupabase } from '@/lib/supabase';

// ============== Types ==============

export interface ActivityItem {
  id: string;
  type: 'quote' | 'job';
  entityNumber: string;
  action: 'created' | 'started' | 'completed' | 'shipped';
  timestamp: string;
  customerName?: string;
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

// Overdue is always pinned in slot 1 (not user-configurable). The user's
// picked metrics fill slots 2-4 — so the pinned list holds up to 3 keys.
export const PINNED_METRIC_SLOTS = 3;

export const DEFAULT_PINNED_METRICS: MetricKey[] = [
  'open_quotes',
  'not_started_jobs',
  'in_progress_jobs',
];

// Metrics the user is allowed to pin (Overdue is always pinned separately).
export const PICKABLE_METRICS: MetricDefinition[] = AVAILABLE_METRICS.filter(
  (m) => m.key !== 'overdue_jobs'
);

// The always-pinned alert-class metric.
export const ALWAYS_PINNED_METRIC: MetricKey = 'overdue_jobs';

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
    // Migrate legacy keys
    const migrated = pinned
      .map((k: string) => LEGACY_KEY_MAP[k] || k)
      .filter((k: string) => !REMOVED_KEYS.includes(k))
      .filter((k: string, i: number, arr: string[]) => arr.indexOf(k) === i) as MetricKey[];

    // Persist migration if keys changed
    const changed = migrated.length !== pinned.length || migrated.some((k, i) => k !== pinned[i]);
    if (changed) {
      setPinnedMetricKeys(migrated).catch((err) => Sentry.captureException(err, { level: 'warning' }));
    }

    return migrated.length > 0 ? migrated : DEFAULT_PINNED_METRICS;
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
  const updatedPrefs = { ...currentPrefs, dashboard_pinned_metrics: keys };

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

async function getCount(table: string, companyId: string, filters?: Record<string, string[]>): Promise<number> {
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
  const { data, error } = await supabase
    .from('jobs')
    .select('id, quotes!jobs_quote_id_fkey(total_price)')
    .eq('company_id', companyId)
    .eq('status', 'shipped')
    .gte('shipped_at', startIso)
    .lt('shipped_at', endIso);

  if (error) throw error;

  return (data || []).reduce(
    (sum: number, job: { quotes: { total_price: number | null } | null }) => {
      return sum + (job.quotes?.total_price || 0);
    },
    0
  );
}

async function getCompletedJobsInRange(
  companyId: string,
  startIso: string,
  endIso: string
): Promise<number> {
  const supabase = getSupabase();
  const { count, error } = await supabase
    .from('jobs')
    .select('*', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .in('status', ['completed', 'shipped'])
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
    .in('status', ['not_started', 'in_progress'])
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
      return { value: await getCount('jobs', companyId, { status: ['not_started'] }) };
    case 'in_progress_jobs':
      return { value: await getCount('jobs', companyId, { status: ['in_progress'] }) };
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
