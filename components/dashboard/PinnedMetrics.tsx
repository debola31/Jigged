'use client';

import { useEffect, useState, useCallback } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Skeleton from '@mui/material/Skeleton';
import Divider from '@mui/material/Divider';
import MetricPickerModal from './MetricPickerModal';
import {
  type MetricKey,
  AVAILABLE_METRICS,
  getPinnedMetricKeys,
  setPinnedMetricKeys,
  getPinnedMetricValues,
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
  const [loading, setLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);

  const loadMetrics = useCallback(async () => {
    if (!companyId) return;
    try {
      setLoading(true);
      const keys = await getPinnedMetricKeys();
      setPinnedKeys(keys);
      const vals = await getPinnedMetricValues(companyId, keys);
      setValues(vals);
    } catch (err) {
      console.error('Error loading pinned metrics:', err);
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    loadMetrics();
  }, [loadMetrics]);

  const handleSave = async (keys: MetricKey[]) => {
    setPinnedKeys(keys);
    setPickerOpen(false);
    // Fetch values for any newly added metrics
    try {
      const vals = await getPinnedMetricValues(companyId, keys);
      setValues(vals);
    } catch (err) {
      console.error('Error fetching metric values:', err);
    }
    await setPinnedMetricKeys(keys);
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
                <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5, fontWeight: 500 }}>
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
      {/* Edit/Add link */}
      <Box sx={{ mt: 1.5, display: 'flex', gap: 2 }}>
        <Typography
          variant="caption"
          color="primary"
          sx={{ cursor: 'pointer', '&:hover': { textDecoration: 'underline' } }}
          onClick={() => setPickerOpen(true)}
        >
          {pinnedKeys.length < 4 ? '+ Add metric' : 'Edit metrics'}
        </Typography>
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
