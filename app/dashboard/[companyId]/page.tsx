'use client';

import { useState, useCallback, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Box from '@mui/material/Box';

import { InsightsSection, DashboardMetrics, RecentActivity } from '@/components/dashboard';
import { InsightsChat } from '@/components/insights';
import OnboardingCard from '@/components/demo/OnboardingCard';
import StillRunningCard from '@/components/dashboard/StillRunningCard';
import { useCompanyFeatures } from '@/hooks/useCompanyFeatures';
import { isDashboardEmpty, getDashboardActivity, type ActivityItem } from '@/utils/dashboardAccess';

export default function DashboardPage() {
  const params = useParams();
  const companyId = params.companyId as string;
  const { features, loading: featuresLoading } = useCompanyFeatures();
  const [savedVersion, setSavedVersion] = useState(0);
  const [isEmpty, setIsEmpty] = useState(false);
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [activitiesLoading, setActivitiesLoading] = useState(true);

  const handleInsightSaved = useCallback(() => {
    setSavedVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    if (!companyId) return;
    isDashboardEmpty(companyId)
      .then(setIsEmpty)
      .catch(() => {});
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

  // AI Insights is opt-out (on unless a system admin disabled it for this
  // tenant). Gate the whole AI area — ask-bar + saved charts — on the flag;
  // kept hidden while the flag is still loading so it never flashes in then out.
  const aiInsightsEnabled = !featuresLoading && features.ai_insights;

  // Dashboard revenue is opt-OUT too: the money lines under each scorecard count are on unless a
  // system admin has killed them for this tenant. Held back while the flag loads for the same
  // reason as the AI area — a dollar figure that appears and then vanishes reads as a glitch, and
  // an owner who turned these off does not want them flashing up on a shared screen at all.
  const revenueEnabled = !featuresLoading && features.dashboard_revenue;

  return (
    <Box>
      {/* Onboarding Card — shown when dashboard is empty and no demo exists */}
      <OnboardingCard companyId={companyId} isEmpty={isEmpty} />

      {/* Scorecard row — four fixed metrics */}
      <Box sx={{ mb: 4 }}>
        <DashboardMetrics companyId={companyId} revenueEnabled={revenueEnabled} />
      </Box>

      {/* Still running — open time intervals, and the only route to one whose
          owner has gone home. Renders nothing on the normal day when everything
          has been closed, so it costs no space until it matters. */}
      <Box sx={{ mb: 4 }}>
        <StillRunningCard companyId={companyId} />
      </Box>

      {/* Recent Activity — compact business-milestone feed + "View all" hop */}
      <Box sx={{ mb: 4 }}>
        <RecentActivity
          activities={activities}
          loading={activitiesLoading}
          viewAllHref={`/dashboard/${companyId}/activity`}
        />
      </Box>

      {/* AI Insights — ask-bar + saved charts, gated per-company */}
      {aiInsightsEnabled && (
        <>
          {/* Ask Bar */}
          <Box sx={{ mb: 4 }}>
            <InsightsChat
              companyId={companyId}
              onInsightSaved={handleInsightSaved}
            />
          </Box>

          {/* Saved Charts */}
          <InsightsSection
            companyId={companyId}
            savedVersion={savedVersion}
          />
        </>
      )}
    </Box>
  );
}
