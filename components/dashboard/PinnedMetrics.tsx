'use client';

import * as Sentry from "@sentry/nextjs";
import { useEffect, useState, useCallback, useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Skeleton from '@mui/material/Skeleton';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import ToggleButton from '@mui/material/ToggleButton';
import MetricPickerModal from './MetricPickerModal';
import {
  type MetricKey,
  type MetricTimePeriod,
  AVAILABLE_METRICS,
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

function formatValue(value: number, format: 'number' | 'currency'): string {
  if (format === 'currency') {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  }
  return value.toLocaleString();
}

export default function PinnedMetrics({ companyId }: PinnedMetricsProps) {
  const [pinnedKeys, setPinnedKeys] = useState<MetricKey[]>([]);
  const [values, setValues] = useState<Record<string, number>>({});
  const [globalPeriod, setGlobalPeriod] = useState<MetricTimePeriod>('this_week');
  const [loading, setLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [page, setPage] = useState(0);

  const allKeys = useMemo<MetricKey[]>(() => {
    const unpinned = AVAILABLE_METRICS.map((m) => m.key).filter((k) => !pinnedKeys.includes(k));
    return [...pinnedKeys, ...unpinned];
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
    if (page >= pages.length) {
      setPage(0);
    }
  }, [page, pages.length]);

  const visibleKeys = pages[page] ?? [];

  const buildTimePeriods = useCallback((period: MetricTimePeriod): Partial<Record<MetricKey, MetricTimePeriod>> => {
    const periods: Partial<Record<MetricKey, MetricTimePeriod>> = {};
    for (const m of AVAILABLE_METRICS) {
      if (m.supportsTimePeriod) {
        periods[m.key] = period;
      }
    }
    return periods;
  }, []);

  const loadMetrics = useCallback(async () => {
    if (!companyId) return;
    try {
      setLoading(true);
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
    } catch (err) {
      console.error('Error loading pinned metrics:', err);
      Sentry.captureException(err);
    } finally {
      setLoading(false);
    }
  }, [companyId, buildTimePeriods]);

  useEffect(() => {
    loadMetrics();
  }, [loadMetrics]);

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
          display: 'flex',
          flexWrap: 'wrap',
          gap: { xs: 2, md: 0 },
          alignItems: 'flex-start',
        }}
      >
        {Array.from({ length: PAGE_SIZE }).map((_, index) => {
          const key = visibleKeys[index];
          const def = key ? AVAILABLE_METRICS.find((m) => m.key === key) : undefined;
          return (
            <Box
              key={key ?? `empty-${index}`}
              sx={{
                flex: { xs: '0 0 calc(50% - 8px)', md: 1 },
                display: 'flex',
                alignItems: 'center',
                visibility: def ? 'visible' : 'hidden',
              }}
            >
              {index > 0 && (
                <Divider orientation="vertical" flexItem sx={{ mr: 3, display: { xs: 'none', md: 'block' } }} />
              )}
              <Box>
                <Typography variant="body2" sx={{ mb: 0.5, fontWeight: 500, color: 'text.primary' }}>
                  {def?.label ?? '\u00A0'}
                </Typography>
                {loading ? (
                  <Skeleton variant="text" width={60} height={36} />
                ) : (
                  <Typography variant="h4" sx={{ fontWeight: 600, lineHeight: 1.2 }}>
                    {def ? formatValue(values[def.key] ?? 0, def.format) : '\u00A0'}
                  </Typography>
                )}
              </Box>
            </Box>
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
          {pinnedKeys.length < 4 ? '+ Add metric' : 'Edit metrics'}
        </Typography>
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
        <Box sx={{ ml: 'auto' }}>
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
