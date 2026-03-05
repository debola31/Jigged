'use client';

import { useState, useCallback, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Box from '@mui/material/Box';

import { InsightsSection, PinnedMetrics } from '@/components/dashboard';
import { InsightsChat } from '@/components/insights';
import OnboardingCard from '@/components/demo/OnboardingCard';
import { getMetricValue } from '@/utils/dashboardAccess';

export default function DashboardPage() {
  const params = useParams();
  const companyId = params.companyId as string;
  const [savedVersion, setSavedVersion] = useState(0);
  const [isEmpty, setIsEmpty] = useState(false);

  const handleInsightSaved = useCallback(() => {
    setSavedVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    if (!companyId) return;
    Promise.all([
      getMetricValue(companyId, 'open_quotes'),
      getMetricValue(companyId, 'active_jobs'),
      getMetricValue(companyId, 'weekly_revenue'),
    ]).then(([quotes, jobs, revenue]) => {
      setIsEmpty(quotes === 0 && jobs === 0 && revenue === 0);
    }).catch(() => {});
  }, [companyId]);

  return (
    <Box>
      {/* Onboarding Card — shown when dashboard is empty and no demo exists */}
      <OnboardingCard companyId={companyId} isEmpty={isEmpty} />

      {/* Pinned Metrics */}
      <Box sx={{ mb: 4 }}>
        <PinnedMetrics companyId={companyId} />
      </Box>

      {/* Ask Bar */}
      <Box sx={{ mb: 4 }}>
        <InsightsChat companyId={companyId} onInsightSaved={handleInsightSaved} />
      </Box>

      {/* Insights */}
      <InsightsSection companyId={companyId} savedVersion={savedVersion} />
    </Box>
  );
}
