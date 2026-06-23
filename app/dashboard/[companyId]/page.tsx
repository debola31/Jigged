'use client';

import { useState, useCallback, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Box from '@mui/material/Box';

import { InsightsSection, PinnedMetrics, RecentActivity } from '@/components/dashboard';
import { InsightsChat } from '@/components/insights';
import OnboardingCard from '@/components/demo/OnboardingCard';
import { getMetricValue, getDashboardActivity, type ActivityItem } from '@/utils/dashboardAccess';

export default function DashboardPage() {
  const params = useParams();
  const companyId = params.companyId as string;
  const [savedVersion, setSavedVersion] = useState(0);
  const [savedCount, setSavedCount] = useState(0);
  const [isEmpty, setIsEmpty] = useState(false);
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [activitiesLoading, setActivitiesLoading] = useState(true);

  const handleInsightSaved = useCallback(() => {
    setSavedVersion((v) => v + 1);
  }, []);

  const handleSavedCountChange = useCallback((count: number) => {
    setSavedCount(count);
  }, []);

  useEffect(() => {
    if (!companyId) return;
    Promise.all([
      getMetricValue(companyId, 'open_quotes'),
      getMetricValue(companyId, 'not_started_jobs'),
      getMetricValue(companyId, 'in_progress_jobs'),
      getMetricValue(companyId, 'revenue'),
    ]).then(([quotes, notStarted, inProgress, revenue]) => {
      setIsEmpty(quotes === 0 && notStarted === 0 && inProgress === 0 && revenue === 0);
    }).catch(() => {});
  }, [companyId]);

  // Recent Activity card — a plain Supabase read (no AI on mount). Async-only
  // setState (loading starts true) to stay clear of set-state-in-effect.
  useEffect(() => {
    if (!companyId) return;
    let active = true;
    getDashboardActivity(companyId, { limit: 6 })
      .then((items) => { if (active) setActivities(items); })
      .catch(() => {})
      .finally(() => { if (active) setActivitiesLoading(false); });
    return () => { active = false; };
  }, [companyId]);

  return (
    <Box>
      {/* Onboarding Card — shown when dashboard is empty and no demo exists */}
      <OnboardingCard companyId={companyId} isEmpty={isEmpty} />

      {/* Pinned Metrics */}
      <Box sx={{ mb: 4 }}>
        <PinnedMetrics companyId={companyId} />
      </Box>

      {/* Recent Activity — compact business-milestone feed + "View all" hop */}
      <Box sx={{ mb: 4 }}>
        <RecentActivity
          activities={activities}
          loading={activitiesLoading}
          viewAllHref={`/dashboard/${companyId}/activity`}
        />
      </Box>

      {/* Ask Bar */}
      <Box sx={{ mb: 4 }}>
        <InsightsChat
          companyId={companyId}
          onInsightSaved={handleInsightSaved}
          savedCount={savedCount}
        />
      </Box>

      {/* Saved Charts */}
      <InsightsSection
        companyId={companyId}
        savedVersion={savedVersion}
        onSavedCountChange={handleSavedCountChange}
      />
    </Box>
  );
}
