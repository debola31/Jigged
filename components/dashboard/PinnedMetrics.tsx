'use client';

import * as Sentry from "@sentry/nextjs";
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useLoad } from '@/hooks/useLoad';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import ToggleButton from '@mui/material/ToggleButton';
import MetricPickerModal from './MetricPickerModal';
import MetricScorecard from './MetricScorecard';
import {
  type MetricKey,
  type MetricValue,
  type MetricTimePeriod,
  AVAILABLE_METRICS,
  PINNED_METRIC_SLOTS,
  getPinnedMetricKeys,
  setPinnedMetricKeys,
  getPinnedMetricValues,
  getMetricTimePeriods,
  setMetricTimePeriod,
} from '@/utils/dashboardAccess';

interface PinnedMetricsProps {
  companyId: string;
}

const PAGE_SIZE = 4;

function periodLabel(period: MetricTimePeriod): string {
  return period === 'today' ? 'today' : 'this week';
}

function comparisonLabel(period: MetricTimePeriod): string {
  return period === 'today' ? 'vs yesterday' : 'vs last week';
}

function drillDownHref(companyId: string, key: MetricKey): string | undefined {
  switch (key) {
    case 'open_quotes':
      return `/dashboard/${companyId}/quotes?status=active`;
    case 'not_started_jobs':
      return `/dashboard/${companyId}/jobs?status=not_started`;
    case 'in_progress_jobs':
      return `/dashboard/${companyId}/jobs?status=in_progress`;
    case 'completed_jobs':
      return `/dashboard/${companyId}/jobs?status=completed`;
    case 'overdue_jobs':
      return `/dashboard/${companyId}/jobs?overdue=true`;
    case 'revenue':
      return `/dashboard/${companyId}/jobs?status=shipped`;
    default:
      return undefined;
  }
}

export default function PinnedMetrics({ companyId }: PinnedMetricsProps) {
  const [pinnedKeys, setPinnedKeys] = useState<MetricKey[]>([]);
  const [values, setValues] = useState<Partial<Record<MetricKey, MetricValue>>>({});
  const [globalPeriod, setGlobalPeriod] = useState<MetricTimePeriod>('this_week');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [page, setPage] = useState(0);

  // Every key we need a value for — the user's pinned metrics first (in their
  // chosen order), then the rest so the pager can page through them.
  const allKeys = useMemo<MetricKey[]>(() => {
    const unpicked = AVAILABLE_METRICS.map((m) => m.key).filter((k) => !pinnedKeys.includes(k));
    return [...pinnedKeys, ...unpicked];
  }, [pinnedKeys]);

  const pages = useMemo<MetricKey[][]>(() => {
    if (allKeys.length === 0) return [];
    const chunks: MetricKey[][] = [];
    for (let i = 0; i < allKeys.length; i += PAGE_SIZE) {
      chunks.push(allKeys.slice(i, i + PAGE_SIZE));
    }
    return chunks;
  }, [allKeys]);

  useEffect(() => {
    if (page >= pages.length) setPage(0);
  }, [page, pages.length]);

  const visibleKeys = pages[page] ?? [];

  const buildTimePeriods = useCallback((period: MetricTimePeriod): Partial<Record<MetricKey, MetricTimePeriod>> => {
    const periods: Partial<Record<MetricKey, MetricTimePeriod>> = {};
    for (const m of AVAILABLE_METRICS) {
      if (m.supportsTimePeriod) periods[m.key] = period;
    }
    return periods;
  }, []);

  // pinnedKeys / globalPeriod / values are also mutated by the picker and the
  // period toggle, so they stay as independent state. useLoad owns only the
  // mount fetch + loading flag; every setState below runs inside the async
  // callback (never synchronously in an effect), so this stays clear of
  // set-state-in-effect.
  const { loading } = useLoad(
    async () => {
      if (!companyId) return;
      const [keys, storedPeriods] = await Promise.all([
        getPinnedMetricKeys(),
        getMetricTimePeriods(),
      ]);
      setPinnedKeys(keys);
      const firstPeriod = Object.values(storedPeriods)[0] as MetricTimePeriod | undefined;
      const period = firstPeriod ?? 'this_week';
      setGlobalPeriod(period);
      const allMetricKeys = AVAILABLE_METRICS.map((m) => m.key);
      const vals = await getPinnedMetricValues(companyId, allMetricKeys, buildTimePeriods(period));
      setValues(vals);
    },
    [companyId, buildTimePeriods],
    {
      onError: (err) => {
        console.error('Error loading pinned metrics:', err);
        Sentry.captureException(err);
      },
    },
  );

  const handleSave = async (keys: MetricKey[]) => {
    setPinnedKeys(keys);
    setPickerOpen(false);
    try {
      const allMetricKeys = AVAILABLE_METRICS.map((m) => m.key);
      const vals = await getPinnedMetricValues(companyId, allMetricKeys, buildTimePeriods(globalPeriod));
      setValues(vals);
    } catch (err) {
      console.error('Error fetching metric values:', err);
      Sentry.captureException(err);
    }
    await setPinnedMetricKeys(keys);
  };

  const handleGlobalPeriodChange = async (_: React.MouseEvent<HTMLElement>, newPeriod: MetricTimePeriod | null) => {
    if (!newPeriod) return;
    setGlobalPeriod(newPeriod);
    try {
      const allMetricKeys = AVAILABLE_METRICS.map((m) => m.key);
      const vals = await getPinnedMetricValues(companyId, allMetricKeys, buildTimePeriods(newPeriod));
      setValues(vals);
    } catch (err) {
      console.error('Error fetching metric values:', err);
      Sentry.captureException(err);
    }
    for (const m of AVAILABLE_METRICS) {
      if (m.supportsTimePeriod) {
        setMetricTimePeriod(m.key, newPeriod).catch((err) => Sentry.captureException(err, { level: 'warning' }));
      }
    }
  };

  const multiplePages = pages.length > 1;

  return (
    <Box sx={{ mb: 4 }}>
      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: {
            xs: 'repeat(2, 1fr)',
            md: `repeat(${PAGE_SIZE}, 1fr)`,
          },
        }}
      >
        {Array.from({ length: PAGE_SIZE }).map((_, index) => {
          const key = visibleKeys[index];
          const def = key ? AVAILABLE_METRICS.find((m) => m.key === key) : undefined;
          if (!def) {
            return <Box key={`empty-${index}`} sx={{ visibility: 'hidden' }} />;
          }
          const v = values[def.key] ?? { value: 0 };
          const isOverdue = def.key === 'overdue_jobs';
          const isTimeAware = !!def.supportsTimePeriod;
          return (
            <MetricScorecard
              key={def.key}
              label={def.label}
              periodSuffix={isTimeAware ? periodLabel(globalPeriod) : undefined}
              value={v.value}
              format={def.format}
              previousValue={v.previousValue}
              comparisonLabel={isTimeAware ? comparisonLabel(globalPeriod) : undefined}
              href={drillDownHref(companyId, def.key)}
              severity={isOverdue && v.value > 0 ? 'alert' : 'normal'}
              loading={loading}
            />
          );
        })}
      </Box>
      <Box sx={{ mt: 1.5, display: 'flex', alignItems: 'center', gap: 2 }}>
        <Typography
          variant="caption"
          color="primary"
          sx={{ cursor: 'pointer', '&:hover': { textDecoration: 'underline' } }}
          onClick={() => setPickerOpen(true)}
        >
          {pinnedKeys.length < PINNED_METRIC_SLOTS ? '+ Add metric' : 'Edit metrics'}
        </Typography>
        <Box sx={{ ml: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 0.5 }}>
          {multiplePages && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <IconButton
                size="small"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                aria-label="Previous metrics"
              >
                <ChevronLeftIcon fontSize="small" />
              </IconButton>
              <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
                {pages.map((_, i) => (
                  <Box
                    key={i}
                    sx={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      bgcolor: i === page ? 'primary.main' : 'action.disabled',
                    }}
                  />
                ))}
              </Box>
              <IconButton
                size="small"
                onClick={() => setPage((p) => Math.min(pages.length - 1, p + 1))}
                disabled={page >= pages.length - 1}
                aria-label="Next metrics"
              >
                <ChevronRightIcon fontSize="small" />
              </IconButton>
            </Box>
          )}
          <ToggleButtonGroup
            value={globalPeriod}
            exclusive
            onChange={handleGlobalPeriodChange}
            size="small"
          >
            <ToggleButton
              value="today"
              sx={{ px: 1.5, py: 0.25, fontSize: '0.75rem', textTransform: 'none' }}
            >
              Today
            </ToggleButton>
            <ToggleButton
              value="this_week"
              sx={{ px: 1.5, py: 0.25, fontSize: '0.75rem', textTransform: 'none' }}
            >
              This Week
            </ToggleButton>
          </ToggleButtonGroup>
        </Box>
      </Box>

      <MetricPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        currentKeys={pinnedKeys}
        onSave={handleSave}
      />
    </Box>
  );
}
