import { getSupabase } from '@/lib/supabase';

// ============== Dashboard Metrics ==============

/**
 * Activity item for the recent activity feed
 */
export interface ActivityItem {
  id: string;
  type: 'quote' | 'job';
  entityNumber: string;
  action: 'created' | 'started' | 'completed' | 'shipped';
  timestamp: string;
  customerName?: string;
}

/**
 * Dashboard metrics summary
 */
export interface DashboardMetrics {
  openQuotesCount: number;
  activeJobsCount: number;
  weeklyRevenue: number;
}

/**
 * Get count of open quotes (draft + pending_approval)
 */
export async function getOpenQuotesCount(companyId: string): Promise<number> {
  const supabase = getSupabase();

  const { count, error } = await supabase
    .from('quotes')
    .select('*', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .in('status', ['draft', 'pending_approval']);

  if (error) {
    console.error('Error fetching open quotes count:', error);
    throw error;
  }

  return count || 0;
}

/**
 * Get count of active jobs (pending + in_progress)
 */
export async function getActiveJobsCount(companyId: string): Promise<number> {
  const supabase = getSupabase();

  const { count, error } = await supabase
    .from('jobs')
    .select('*', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .in('status', ['pending', 'in_progress']);

  if (error) {
    console.error('Error fetching active jobs count:', error);
    throw error;
  }

  return count || 0;
}

/**
 * Get revenue from shipped jobs this week
 */
export async function getWeeklyRevenue(companyId: string): Promise<number> {
  const supabase = getSupabase();

  // Calculate start of current week (Sunday)
  const now = new Date();
  const dayOfWeek = now.getDay();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - dayOfWeek);
  startOfWeek.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from('jobs')
    .select('price')
    .eq('company_id', companyId)
    .eq('status', 'shipped')
    .gte('shipped_at', startOfWeek.toISOString());

  if (error) {
    console.error('Error fetching weekly revenue:', error);
    throw error;
  }

  // Sum up the prices
  const total = (data || []).reduce(
    (sum: number, job: { price: number | null }) => sum + (job.price || 0),
    0
  );
  return total;
}

/**
 * Get all dashboard metrics in a single call
 */
export async function getDashboardMetrics(
  companyId: string
): Promise<DashboardMetrics> {
  const [openQuotesCount, activeJobsCount, weeklyRevenue] = await Promise.all([
    getOpenQuotesCount(companyId),
    getActiveJobsCount(companyId),
    getWeeklyRevenue(companyId),
  ]);

  return {
    openQuotesCount,
    activeJobsCount,
    weeklyRevenue,
  };
}

/**
 * Get recent activity by inferring from timestamps
 * Combines quotes and jobs, sorted by most recent timestamp
 */
export async function getRecentActivity(
  companyId: string,
  limit: number = 10
): Promise<ActivityItem[]> {
  const supabase = getSupabase();

  // Fetch recent quotes (created_at)
  const { data: quotes, error: quotesError } = await supabase
    .from('quotes')
    .select(
      `
      id,
      quote_number,
      created_at,
      customers!left(name)
    `
    )
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (quotesError) {
    console.error('Error fetching quotes for activity:', quotesError);
    throw quotesError;
  }

  // Fetch recent jobs with their various timestamps
  const { data: jobs, error: jobsError } = await supabase
    .from('jobs')
    .select(
      `
      id,
      job_number,
      created_at,
      started_at,
      completed_at,
      shipped_at,
      customers!left(name)
    `
    )
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(limit * 2); // Fetch more since each job can have multiple activities

  if (jobsError) {
    console.error('Error fetching jobs for activity:', jobsError);
    throw jobsError;
  }

  // Build activity items
  const activities: ActivityItem[] = [];

  // Add quote created activities
  for (const quote of quotes || []) {
    activities.push({
      id: `quote-created-${quote.id}`,
      type: 'quote',
      entityNumber: quote.quote_number,
      action: 'created',
      timestamp: quote.created_at,
      customerName: (quote.customers as { name: string } | null)?.name,
    });
  }

  // Add job activities (created, started, completed, shipped)
  for (const job of jobs || []) {
    const customerName = (job.customers as { name: string } | null)?.name;

    // Job created
    if (job.created_at) {
      activities.push({
        id: `job-created-${job.id}`,
        type: 'job',
        entityNumber: job.job_number,
        action: 'created',
        timestamp: job.created_at,
        customerName,
      });
    }

    // Job started
    if (job.started_at) {
      activities.push({
        id: `job-started-${job.id}`,
        type: 'job',
        entityNumber: job.job_number,
        action: 'started',
        timestamp: job.started_at,
        customerName,
      });
    }

    // Job completed
    if (job.completed_at) {
      activities.push({
        id: `job-completed-${job.id}`,
        type: 'job',
        entityNumber: job.job_number,
        action: 'completed',
        timestamp: job.completed_at,
        customerName,
      });
    }

    // Job shipped
    if (job.shipped_at) {
      activities.push({
        id: `job-shipped-${job.id}`,
        type: 'job',
        entityNumber: job.job_number,
        action: 'shipped',
        timestamp: job.shipped_at,
        customerName,
      });
    }
  }

  // Sort by timestamp descending and take the top N
  activities.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  return activities.slice(0, limit);
}
