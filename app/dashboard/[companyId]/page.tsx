'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Alert from '@mui/material/Alert';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import WorkOutlineIcon from '@mui/icons-material/WorkOutline';
import AttachMoneyIcon from '@mui/icons-material/AttachMoney';

import { SummaryCard, RecentActivity, QuickActions } from '@/components/dashboard';
import {
  getDashboardMetrics,
  getRecentActivity,
  type DashboardMetrics,
  type ActivityItem,
} from '@/utils/dashboardAccess';

/**
 * Format a number as currency
 */
function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

export default function DashboardPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;

  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDashboardData = useCallback(async () => {
    if (!companyId) return;

    try {
      setLoading(true);
      setError(null);

      const [metricsData, activityData] = await Promise.all([
        getDashboardMetrics(companyId),
        getRecentActivity(companyId, 10),
      ]);

      setMetrics(metricsData);
      setActivities(activityData);
    } catch (err) {
      console.error('Error fetching dashboard data:', err);
      setError('Failed to load dashboard data. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    fetchDashboardData();
  }, [fetchDashboardData]);

  const handleQuotesClick = () => {
    router.push(`/dashboard/${companyId}/quotes?status=draft,pending_approval`);
  };

  const handleJobsClick = () => {
    router.push(`/dashboard/${companyId}/jobs?status=active`);
  };

  return (
    <Box>
      {error && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {error}
        </Alert>
      )}

      {/* Summary Cards */}
      <Grid container spacing={3} sx={{ mb: 4 }}>
        <Grid size={{ xs: 12, sm: 6, md: 4 }}>
          <SummaryCard
            title="Open Quotes"
            value={metrics?.openQuotesCount ?? 0}
            icon={DescriptionOutlinedIcon}
            color="default"
            onClick={handleQuotesClick}
            loading={loading}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 4 }}>
          <SummaryCard
            title="Active Jobs"
            value={metrics?.activeJobsCount ?? 0}
            icon={WorkOutlineIcon}
            color="default"
            onClick={handleJobsClick}
            loading={loading}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 12, md: 4 }}>
          <SummaryCard
            title="Revenue This Week"
            value={formatCurrency(metrics?.weeklyRevenue ?? 0)}
            icon={AttachMoneyIcon}
            color="success"
            loading={loading}
          />
        </Grid>
      </Grid>

      {/* Activity and Quick Actions */}
      <Grid container spacing={3}>
        <Grid size={{ xs: 12, md: 8 }}>
          <RecentActivity activities={activities} loading={loading} />
        </Grid>
        <Grid size={{ xs: 12, md: 4 }}>
          <QuickActions companyId={companyId} />
        </Grid>
      </Grid>
    </Box>
  );
}
