'use client';

import { useState } from 'react';
import Box from '@mui/material/Box';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import ToggleButton from '@mui/material/ToggleButton';
import { useLoad } from '@/hooks/useLoad';
import { useUserRole } from '@/hooks/useUserRole';
import MetricScorecard from './MetricScorecard';
import {
  DASHBOARD_METRICS,
  getDashboardMetrics,
  getCompletedPeriod,
  setCompletedPeriod,
  type MetricKey,
  type MetricValue,
  type MetricTimePeriod,
} from '@/utils/dashboardAccess';

interface DashboardMetricsProps {
  companyId: string;
}

/**
 * The scorecard row: four fixed cards, one screen, no picker and no pager.
 *
 * Each card carries a count and — for company admins — the money behind it. The
 * count stays the primary number because a shop owner acts on jobs, not on
 * dollars, and because `0` is a stronger all-clear on Overdue than `$0`.
 */
function drillDownHref(companyId: string, key: MetricKey): string | undefined {
  switch (key) {
    case 'overdue_jobs':
      return `/dashboard/${companyId}/jobs?overdue=true`;
    case 'open_jobs':
      return `/dashboard/${companyId}/jobs?status=not_started`;
    case 'completed_jobs':
      return `/dashboard/${companyId}/jobs?status=completed`;
    case 'open_quotes':
      return `/dashboard/${companyId}/quotes?status=active`;
    default:
      return undefined;
  }
}

/** The verb that says WHICH KIND of money this is. See ScorecardMoney.label. */
function moneyLabel(key: MetricKey, period: MetricTimePeriod): string | null {
  switch (key) {
    case 'overdue_jobs':
      return 'past due';
    case 'open_jobs':
      return 'in hand';
    case 'completed_jobs':
      return period === 'today' ? 'shipped today' : 'shipped this week';
    default:
      return null;
  }
}

export default function DashboardMetrics({ companyId }: DashboardMetricsProps) {
  const [period, setPeriod] = useState<MetricTimePeriod>('this_week');
  const [values, setValues] = useState<Partial<Record<MetricKey, MetricValue>>>({});
  const { isAdmin } = useUserRole();

  // Every setState runs inside the async callback rather than synchronously in
  // an effect body, which keeps this clear of react-hooks/set-state-in-effect.
  const { loading } = useLoad(
    async () => {
      if (!companyId) return;
      const storedPeriod = await getCompletedPeriod();
      setPeriod(storedPeriod);
      setValues(await getDashboardMetrics(companyId, storedPeriod));
    },
    [companyId],
    {
      // No captureException here: every call below is a `.from()` read, and the
      // Supabase integration reports those itself with the query attached
      // (#708). The console line is for local debugging.
      onError: (err) => {
        console.error('Error loading dashboard metrics:', err);
      },
    },
  );

  const handlePeriodChange = async (
    _: React.MouseEvent<HTMLElement>,
    next: MetricTimePeriod | null,
  ) => {
    if (!next) return;
    setPeriod(next);
    try {
      setValues(await getDashboardMetrics(companyId, next));
    } catch (err) {
      console.error('Error loading dashboard metrics:', err);
    }
    setCompletedPeriod(next).catch(() => {});
  };

  const periodToggle = (
    <ToggleButtonGroup value={period} exclusive onChange={handlePeriodChange} size="small">
      <ToggleButton value="today" sx={{ px: 1, py: 0.1, fontSize: '0.65rem', textTransform: 'none' }}>
        Today
      </ToggleButton>
      <ToggleButton
        value="this_week"
        sx={{ px: 1, py: 0.1, fontSize: '0.65rem', textTransform: 'none' }}
      >
        Week
      </ToggleButton>
    </ToggleButtonGroup>
  );

  return (
    <Box
      sx={{
        mb: 4,
        display: 'grid',
        gap: 2,
        gridTemplateColumns: { xs: 'repeat(2, 1fr)', md: 'repeat(4, 1fr)' },
      }}
    >
      {DASHBOARD_METRICS.map((def) => {
        const v = values[def.key];
        const label = moneyLabel(def.key, period);

        // Money is admin-only. A `user` — a salesperson — still sees every
        // price on the quotes and jobs they work; what they do not see is the
        // shop's whole book totalled up. This is a DISPLAY choice, not a
        // security boundary: RLS is company-scoped, not column-scoped, so the
        // figures remain readable through the API.
        // Nothing to show when the count is zero: the money is necessarily zero
        // too, so the line adds no information the count did not already give.
        // It also protects the reason the count leads in the first place —
        // "0" is a cleaner all-clear on Overdue than "0" above "$0 past due".
        const money =
          isAdmin && v && v.count > 0 && v.money !== null && label
            ? {
                amount: v.money,
                label,
                previousAmount: v.previousMoney,
                comparisonLabel:
                  v.previousMoney !== undefined
                    ? period === 'today'
                      ? 'vs yesterday'
                      : 'vs last week'
                    : undefined,
              }
            : undefined;

        // The merged tile would otherwise hide whether work is flowing or
        // piling up, which is the one thing the old two-card split was good for.
        const detail =
          def.key === 'open_jobs' && v?.split
            ? `${v.split.notStarted.count.toLocaleString()} queued · ` +
              `${v.split.inProgress.count.toLocaleString()} running`
            : undefined;

        return (
          <MetricScorecard
            key={def.key}
            label={def.label}
            value={v?.count ?? 0}
            money={money}
            detail={detail}
            action={def.supportsTimePeriod ? periodToggle : undefined}
            href={drillDownHref(companyId, def.key)}
            severity={def.key === 'overdue_jobs' && (v?.count ?? 0) > 0 ? 'alert' : 'normal'}
            loading={loading}
          />
        );
      })}
    </Box>
  );
}
