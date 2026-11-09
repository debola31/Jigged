'use client';

import { useState } from 'react';
import Box from '@mui/material/Box';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import ToggleButton from '@mui/material/ToggleButton';
import { useLoad } from '@/hooks/useLoad';
import { useUserRole } from '@/hooks/useUserRole';
import { PRODUCTION_STATUS_CONFIG } from '@/types/job';
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
      return `/dashboard/${companyId}/quotes?status=open`;
    default:
      return undefined;
  }
}

/**
 * What KIND of money this is — not which slice of work it belongs to.
 *
 * The card title already says which slice (Overdue, Open Jobs, Completed); the
 * label says whether the money has been earned yet. So Overdue and Open Jobs
 * share one, and deliberately: overdue money is a SLICE of open-jobs money, not
 * a separate pot, and giving it its own word would imply otherwise.
 *
 * The pair reads as one axis — `not yet shipped` → `shipped this week` — which
 * is the whole distinction these labels exist to draw. Both are the product's
 * existing fulfilment vocabulary rather than terms coined for this card.
 */
function moneyLabel(key: MetricKey, period: MetricTimePeriod): string | null {
  switch (key) {
    case 'overdue_jobs':
    case 'open_jobs':
      return 'not yet shipped';
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

        // TWO independent reasons the money line is absent, and both have to pass:
        //
        // (1) The viewer is a company admin. A `user` — a salesperson — still sees every price on
        //     the quotes and jobs they work; what they do not see is the shop's whole book
        //     totalled up. `isAdmin` is false until the role loads, so money never flashes in and
        //     out on a screen someone else can see.
        // (2) The count is non-zero. The money is necessarily zero too, so the line adds nothing
        //     the count did not already give, and it protects the reason the count leads: "0" is a
        //     cleaner all-clear on Overdue than "0" above "$0 past due".
        //
        // (1) IS NOT A SECURITY BOUNDARY. RLS is company-scoped, not column-scoped, so job_parts
        // prices stay readable through the API to anyone who can reach the company. The gate buys
        // what is on the screen, which is the entire claim; do not cite it as access control.
        //
        // There was a third, a per-tenant kill-switch (`dashboard_revenue`), removed 2026-11-08.
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
        //
        // Named from PRODUCTION_STATUS_CONFIG rather than spelled out here, so
        // the split says exactly what the jobs list and its status chips say. A
        // synonym invented for this one card ("queued", "running") makes a
        // reader wonder whether it means something different.
        // Three buckets since Open Jobs became "not shipped and not cancelled":
        // a job can be finished on the floor and still owed to the customer.
        // Completed is dropped from the line when it is empty — most shops ship
        // as they finish, and a permanent "· 0 Completed" is noise on the one
        // card that has to be readable at a glance.
        const detail =
          def.key === 'open_jobs' && v?.split
            ? [
                `${v.split.notStarted.count.toLocaleString()} ${PRODUCTION_STATUS_CONFIG.not_started.label}`,
                `${v.split.inProgress.count.toLocaleString()} ${PRODUCTION_STATUS_CONFIG.in_progress.label}`,
                ...(v.split.completed.count > 0
                  ? [`${v.split.completed.count.toLocaleString()} ${PRODUCTION_STATUS_CONFIG.completed.label}`]
                  : []),
              ].join(' · ')
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
            severity={def.key === 'overdue_jobs' && (v?.count ?? 0) > 0 ? 'warning' : 'normal'}
            loading={loading}
          />
        );
      })}
    </Box>
  );
}
