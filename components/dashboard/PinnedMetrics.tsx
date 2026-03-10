'use client';

import * as Sentry from "@sentry/nextjs";
import { useEffect, useState, useCallback } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Skeleton from '@mui/material/Skeleton';
import Divider from '@mui/material/Divider';
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
      const vals = await getPinnedMetricValues(companyId, keys, buildTimePeriods(period));
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
      const vals = await getPinnedMetricValues(companyId, keys, buildTimePeriods(globalPeriod));
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
      const vals = await getPinnedMetricValues(companyId, pinnedKeys, buildTimePeriods(newPeriod));
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
        {pinnedKeys.map((key, index) => {
          const def = AVAILABLE_METRICS.find((m) => m.key === key);
          if (!def) return null;
          return (
            <Box
              key={key}
              sx={{
                flex: { xs: '0 0 calc(50% - 8px)', md: 1 },
                display: 'flex',
                alignItems: 'center',
              }}
            >
              {/* Divider between metrics (desktop only) */}
              {index > 0 && (
                <Divider orientation="vertical" flexItem sx={{ mr: 3, display: { xs: 'none', md: 'block' } }} />
              )}
              <Box>
                <Typography variant="body2" sx={{ mb: 0.5, fontWeight: 500, color: 'text.primary' }}>
                  {def.label}
                </Typography>
                {loading ? (
                  <Skeleton variant="text" width={60} height={36} />
                ) : (
                  <Typography variant="h4" sx={{ fontWeight: 600, lineHeight: 1.2 }}>
                    {formatValue(values[key] ?? 0, def.format)}
                  </Typography>
                )}
              </Box>
            </Box>
          );
        })}
      </Box>
      {/* Controls row: Edit link + time period toggle */}
      <Box sx={{ mt: 1.5, display: 'flex', alignItems: 'center', gap: 2 }}>
        <Typography
          variant="caption"
          color="primary"
          sx={{ cursor: 'pointer', '&:hover': { textDecoration: 'underline' } }}
          onClick={() => setPickerOpen(true)}
        >
          {pinnedKeys.length < 4 ? '+ Add metric' : 'Edit metrics'}
        </Typography>
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
