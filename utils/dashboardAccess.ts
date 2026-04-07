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
  | 'active_jobs'
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
  { key: 'active_jobs', label: 'Active Jobs', format: 'number' },
  { key: 'in_progress_jobs', label: 'In Progress', format: 'number' },
  { key: 'revenue', label: 'Revenue', format: 'currency', supportsTimePeriod: true },
  { key: 'completed_jobs', label: 'Completed Jobs', format: 'number', supportsTimePeriod: true },
  { key: 'overdue_jobs', label: 'Overdue Jobs', format: 'number' },
];

export const DEFAULT_PINNED_METRICS: MetricKey[] = [
  'open_quotes',
  'active_jobs',
  'in_progress_jobs',
  'completed_jobs',
];

// Legacy key migration map
const LEGACY_KEY_MAP: Record<string, MetricKey> = {
  weekly_revenue: 'revenue',
  monthly_revenue: 'revenue',
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

async function getDailyRevenue(companyId: string): Promise<number> {
  const supabase = getSupabase();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from('jobs')
    .select('id, quotes!jobs_quote_id_fkey(total_price)')
    .eq('company_id', companyId)
    .eq('status', 'shipped')
    .gte('shipped_at', startOfDay.toISOString());

  if (error) throw error;

  return (data || []).reduce(
    (sum: number, job: { quotes: { total_price: number | null } | null }) => {
      return sum + (job.quotes?.total_price || 0);
    },
    0
  );
}

async function getWeeklyRevenue(companyId: string): Promise<number> {
  const supabase = getSupabase();
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from('jobs')
    .select('id, quotes!jobs_quote_id_fkey(total_price)')
    .eq('company_id', companyId)
    .eq('status', 'shipped')
    .gte('shipped_at', startOfWeek.toISOString());

  if (error) throw error;

  return (data || []).reduce(
    (sum: number, job: { quotes: { total_price: number | null } | null }) => {
      return sum + (job.quotes?.total_price || 0);
    },
    0
  );
}

async function getCompletedJobs(companyId: string, period: MetricTimePeriod): Promise<number> {
  const supabase = getSupabase();
  const now = new Date();
  let startDate: Date;

  if (period === 'today') {
    startDate = new Date(now);
    startDate.setHours(0, 0, 0, 0);
  } else {
    startDate = new Date(now);
    startDate.setDate(now.getDate() - now.getDay());
    startDate.setHours(0, 0, 0, 0);
  }

  const { count, error } = await supabase
    .from('jobs')
    .select('*', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .in('status', ['completed', 'shipped'])
    .gte('updated_at', startDate.toISOString());

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
 * Get the value for a single metric key.
 */
export async function getMetricValue(
  companyId: string,
  key: MetricKey,
  timePeriod?: MetricTimePeriod
): Promise<number> {
  switch (key) {
    case 'open_quotes':
      return getCount('quotes', companyId, { status: ['pending_approval'] });
    case 'active_jobs':
      return getCount('jobs', companyId, { status: ['not_started', 'in_progress'] });
    case 'in_progress_jobs':
      return getCount('jobs', companyId, { status: ['in_progress'] });
    case 'revenue':
      return timePeriod === 'today' ? getDailyRevenue(companyId) : getWeeklyRevenue(companyId);
    case 'completed_jobs':
      return getCompletedJobs(companyId, timePeriod ?? 'this_week');
    case 'overdue_jobs':
      return getOverdueJobs(companyId);
    default:
      return 0;
  }
}

/**
 * Get values for all pinned metrics in parallel.
 */
export async function getPinnedMetricValues(
  companyId: string,
  keys: MetricKey[],
  timePeriods?: Partial<Record<MetricKey, MetricTimePeriod>>
): Promise<Record<MetricKey, number>> {
  const results = await Promise.all(
    keys.map(async (key) => {
      try {
        const value = await getMetricValue(companyId, key, timePeriods?.[key]);
        return [key, value] as const;
      } catch {
        return [key, 0] as const;
      }
    })
  );
  return Object.fromEntries(results) as Record<MetricKey, number>;
}
