'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Box from '@mui/material/Box';

import { DashboardMetrics } from '@/components/dashboard';
import { InsightsChat } from '@/components/insights';
import OnboardingCard from '@/components/demo/OnboardingCard';
import UnfinishedWorkBand from '@/components/dashboard/UnfinishedWorkBand';
import { useCompanyFeatures } from '@/hooks/useCompanyFeatures';
import { isDashboardEmpty } from '@/utils/dashboardAccess';

/**
 * The dashboard: four scorecards, and the AI area below them.
 *
 * THE AI AREA OWNS EVERYTHING UNDER THE CARDS (2026-09-10). It used to be the
 * fourth block on a scrolling page, under the scorecards, the unfinished-work
 * card and a Recent Activity feed — an unbounded block of content in a column of
 * glass panels, with its own History button orphaned hundreds of pixels to the
 * right of the composer it belonged to. A centred input reads as calm when it IS
 * the page and as an afterthought when it is a footer, which is what a shop owner
 * meant by calling the surface intimidating.
 *
 * RECENT ACTIVITY IS GONE, not moved. `/dashboard/{id}/activity` had already
 * outgrown it — nine type filters, pagination, a fuller query than the card's six-row read — and the sidebar links
 * straight to it. A six-row preview of a better screen is a worse screen.
 *
 * UNFINISHED WORK IS A BAND, NOT A CARD, and it sits ABOVE the scorecards rather
 * than below them: it is a data-hygiene prompt rather than a business metric, so
 * it stops occupying a metric-sized block of the page on the days it has nothing
 * to say. See UnfinishedWorkBand.tsx for why it is one button.
 */
export default function DashboardPage() {
  const params = useParams();
  const companyId = params.companyId as string;
  const { features, loading: featuresLoading } = useCompanyFeatures();
  const [isEmpty, setIsEmpty] = useState(false);

  useEffect(() => {
    if (!companyId) return;
    isDashboardEmpty(companyId)
      .then(setIsEmpty)
      .catch(() => {});
  }, [companyId]);

  // AI Insights is opt-out (on unless a system admin disabled it for this
  // tenant). Gate the whole AI area on the flag; kept hidden while the flag is
  // still loading so it never flashes in then out.
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

      {/* Unfinished on the floor — open time intervals, and steps the floor
          paused and did not resume. The only route to a running clock whose owner
          has gone home, and the only place a forgotten PAUSE is visible to
          anyone. Renders nothing on the normal day when everything has been
          closed, so it costs no space until it matters. */}
      <UnfinishedWorkBand companyId={companyId} />

      {/* Scorecard row — four fixed metrics */}
      <Box sx={{ mb: 4 }}>
        <DashboardMetrics companyId={companyId} revenueEnabled={revenueEnabled} />
      </Box>

      {/* AI Insights, gated per company. Everything below the cards is its own:
          one centred question until a conversation exists, then the transcript
          grows in place above a composer that never moves. */}
      {aiInsightsEnabled && <InsightsChat companyId={companyId} />}
    </Box>
  );
}
