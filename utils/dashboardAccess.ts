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
  | 'weekly_revenue'
  | 'monthly_revenue'
  | 'at_risk_count'
  | 'low_inventory_count'
  | 'total_customers'
  | 'total_parts';

export interface MetricDefinition {
  key: MetricKey;
  label: string;
  format: 'number' | 'currency';
}

export const AVAILABLE_METRICS: MetricDefinition[] = [
  { key: 'open_quotes', label: 'Open Quotes', format: 'number' },
  { key: 'active_jobs', label: 'Active Jobs', format: 'number' },
  { key: 'weekly_revenue', label: 'Revenue This Week', format: 'currency' },
  { key: 'monthly_revenue', label: 'Revenue This Month', format: 'currency' },
  { key: 'at_risk_count', label: 'At-Risk Jobs', format: 'number' },
  { key: 'low_inventory_count', label: 'Low Inventory', format: 'number' },
  { key: 'total_customers', label: 'Customers', format: 'number' },
  { key: 'total_parts', label: 'Parts', format: 'number' },
];

export const DEFAULT_PINNED_METRICS: MetricKey[] = [
  'open_quotes',
  'active_jobs',
  'weekly_revenue',
];

/**
 * Get the user's pinned metric keys from user_preferences.
 * Returns defaults if no preference is stored.
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
    return pinned as MetricKey[];
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

async function getMonthlyRevenue(companyId: string): Promise<number> {
  const supabase = getSupabase();
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const { data, error } = await supabase
    .from('jobs')
    .select('id, quotes!jobs_quote_id_fkey(total_price)')
    .eq('company_id', companyId)
    .eq('status', 'shipped')
    .gte('shipped_at', startOfMonth.toISOString());

  if (error) throw error;

  return (data || []).reduce(
    (sum: number, job: { quotes: { total_price: number | null } | null }) => {
      return sum + (job.quotes?.total_price || 0);
    },
    0
  );
}

async function getAtRiskCount(companyId: string): Promise<number> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('jobs')
    .select('id, due_date, job_operations(status)')
    .eq('company_id', companyId)
    .in('status', ['pending', 'in_progress'])
    .not('due_date', 'is', null);

  if (error) throw error;

  const now = new Date();
  let atRisk = 0;
  for (const job of data || []) {
    if (!job.due_date) continue;
    const dueDate = new Date(job.due_date);
    const totalDays = Math.max(1, (dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    // Simple heuristic: if less than 3 days remaining, it's at risk
    if (totalDays < 3) atRisk++;
  }
  return atRisk;
}

async function getLowInventoryCount(companyId: string): Promise<number> {
  const supabase = getSupabase();
  // Items where quantity <= reorder_point
  const { data, error } = await supabase
    .from('inventory_items')
    .select('id, quantity, reorder_point')
    .eq('company_id', companyId)
    .not('reorder_point', 'is', null);

  if (error) throw error;

  return (data || []).filter(
    (item: { quantity: number | null; reorder_point: number | null }) =>
      (item.quantity ?? 0) <= (item.reorder_point ?? 0)
  ).length;
}

/**
 * Get the value for a single metric key.
 */
export async function getMetricValue(companyId: string, key: MetricKey): Promise<number> {
  switch (key) {
    case 'open_quotes':
      return getCount('quotes', companyId, { status: ['draft', 'pending_approval'] });
    case 'active_jobs':
      return getCount('jobs', companyId, { status: ['pending', 'in_progress'] });
    case 'weekly_revenue':
      return getWeeklyRevenue(companyId);
    case 'monthly_revenue':
      return getMonthlyRevenue(companyId);
    case 'at_risk_count':
      return getAtRiskCount(companyId);
    case 'low_inventory_count':
      return getLowInventoryCount(companyId);
    case 'total_customers':
      return getCount('customers', companyId);
    case 'total_parts':
      return getCount('parts', companyId);
    default:
      return 0;
  }
}

/**
 * Get values for all pinned metrics in parallel.
 */
export async function getPinnedMetricValues(
  companyId: string,
  keys: MetricKey[]
): Promise<Record<MetricKey, number>> {
  const results = await Promise.all(
    keys.map(async (key) => {
      try {
        const value = await getMetricValue(companyId, key);
        return [key, value] as const;
      } catch {
        return [key, 0] as const;
      }
    })
  );
  return Object.fromEntries(results) as Record<MetricKey, number>;
}
