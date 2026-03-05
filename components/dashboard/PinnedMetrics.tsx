'use client';

import { useEffect, useState, useCallback } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Skeleton from '@mui/material/Skeleton';
import Grid from '@mui/material/Grid';
import CloseIcon from '@mui/icons-material/Close';
import AddIcon from '@mui/icons-material/Add';
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

  const handleRemove = async (key: MetricKey) => {
    const updated = pinnedKeys.filter((k) => k !== key);
    setPinnedKeys(updated);
    await setPinnedMetricKeys(updated);
  };

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
      <Grid container spacing={2}>
        {pinnedKeys.map((key) => {
          const def = AVAILABLE_METRICS.find((m) => m.key === key);
          if (!def) return null;

          return (
            <Grid key={key} size={{ xs: 6, sm: 6, md: 3 }}>
              <Card elevation={2} sx={{ position: 'relative' }}>
                <IconButton
                  size="small"
                  onClick={() => handleRemove(key)}
                  aria-label={`Remove ${def.label}`}
                  sx={{
                    position: 'absolute',
                    top: 4,
                    right: 4,
                    opacity: 0.4,
                    '&:hover': { opacity: 1 },
                  }}
                >
                  <CloseIcon sx={{ fontSize: 16 }} />
                </IconButton>
                <CardContent sx={{ py: 2.5, px: 2.5 }}>
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ mb: 0.5, fontWeight: 500 }}
                  >
                    {def.label}
                  </Typography>
                  {loading ? (
                    <Skeleton variant="text" width={60} height={40} />
                  ) : (
                    <Typography
                      variant="h4"
                      component="div"
                      sx={{ fontWeight: 600, lineHeight: 1.2 }}
                    >
                      {formatValue(values[key] ?? 0, def.format)}
                    </Typography>
                  )}
                </CardContent>
              </Card>
            </Grid>
          );
        })}

        {/* Add Metric Button (only show if < 4 pinned) */}
        {pinnedKeys.length < 4 && (
          <Grid size={{ xs: 6, sm: 6, md: 3 }}>
            <Card
              elevation={1}
              sx={{
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                border: '1px dashed',
                borderColor: 'divider',
                bgcolor: 'transparent',
                minHeight: 95,
                '&:hover': {
                  borderColor: 'primary.main',
                  bgcolor: 'rgba(70, 130, 180, 0.04)',
                },
              }}
              onClick={() => setPickerOpen(true)}
            >
              <Box sx={{ textAlign: 'center' }}>
                <AddIcon sx={{ fontSize: 24, color: 'text.secondary', mb: 0.5 }} />
                <Typography variant="caption" color="text.secondary" display="block">
                  Add Metric
                </Typography>
              </Box>
            </Card>
          </Grid>
        )}
      </Grid>

      <MetricPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        currentKeys={pinnedKeys}
        onSave={handleSave}
      />
    </Box>
  );
}
