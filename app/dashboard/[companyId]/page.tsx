'use client';

import { useState, useCallback, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import UploadFileIcon from '@mui/icons-material/UploadFile';

import { InsightsSection, PinnedMetrics, RecentActivity } from '@/components/dashboard';
import { InsightsChat } from '@/components/insights';
import OnboardingCard from '@/components/demo/OnboardingCard';
import { useCompanyFeatures } from '@/hooks/useCompanyFeatures';
import { getMetricValue, getDashboardActivity, type ActivityItem } from '@/utils/dashboardAccess';

export default function DashboardPage() {
  const params = useParams();
  const companyId = params.companyId as string;
  const router = useRouter();
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

  // AI Insights is opt-out (on unless a system admin disabled it for this
  // tenant). Gate the whole AI area — ask-bar + saved charts — on the flag;
  // kept hidden while the flag is still loading so it never flashes in then out.
  const aiInsightsEnabled = !featuresLoading && features.ai_insights;
  // Persistent "Import data" entry for a shop that already has data (the empty-shop case
  // is covered by the OnboardingCard checklist). Launches the one unified importer.
  const importEnabled = !featuresLoading && !!features.data_health_report;

  return (
    <Box>
      {importEnabled && !isEmpty && (
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 2 }}>
          <Button
            variant="outlined"
            startIcon={<UploadFileIcon />}
            onClick={() => router.push(`/dashboard/${companyId}/import`)}
          >
            Import data
          </Button>
        </Box>
      )}

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
