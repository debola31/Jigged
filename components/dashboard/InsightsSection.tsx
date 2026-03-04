'use client';

import { useEffect, useState, useCallback } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import RefreshIcon from '@mui/icons-material/Refresh';
import InsightCard from '@/components/insights/InsightCard';
import {
  getDashboardInsights,
  refreshInsights,
  type InsightCard as InsightCardType,
} from '@/utils/insightsAccess';

interface InsightsSectionProps {
  companyId: string;
}

/**
 * InsightsSection: Container for 5 insight cards on the dashboard.
 * Displays in a responsive 2-column grid (1-column on mobile).
 * Includes a Refresh button to force-recompute insights.
 */
export default function InsightsSection({ companyId }: InsightsSectionProps) {
  const [insights, setInsights] = useState<InsightCardType[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchInsights = useCallback(async () => {
    if (!companyId) return;

    try {
      setLoading(true);
      setError(null);
      const data = await getDashboardInsights(companyId);
      setInsights(data);
    } catch (err) {
      console.error('Error fetching insights:', err);
      setError('Failed to load AI insights. The insights service may be temporarily unavailable.');
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    fetchInsights();
  }, [fetchInsights]);

  const handleRefresh = async () => {
    if (!companyId || refreshing) return;

    try {
      setRefreshing(true);
      setError(null);
      const data = await refreshInsights(companyId);
      setInsights(data);
    } catch (err) {
      console.error('Error refreshing insights:', err);
      setError('Failed to refresh insights. Please try again.');
    } finally {
      setRefreshing(false);
    }
  };

  const placeholderTypes = [
    'revenue_trend',
    'job_pipeline',
    'quote_conversion',
    'at_risk_jobs',
    'inventory_alerts',
  ];

  return (
    <Box sx={{ mb: 4 }}>
      {/* Section Header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          mb: 2,
        }}
      >
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          AI Insights
        </Typography>
        <Button
          variant="outlined"
          size="small"
          startIcon={<RefreshIcon />}
          onClick={handleRefresh}
          disabled={refreshing || loading}
          sx={{ minHeight: 48 }}
        >
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </Button>
      </Box>

      {/* Error State */}
      {error && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {/* Insight Cards Grid */}
      <Grid container spacing={3}>
        {loading
          ? placeholderTypes.map((type) => (
              <Grid key={type} size={{ xs: 12, md: 6 }}>
                <InsightCard insight={null} loading={true} />
              </Grid>
            ))
          : insights.map((insight) => (
              <Grid key={insight.type} size={{ xs: 12, md: 6 }}>
                <InsightCard insight={insight} />
              </Grid>
            ))}
      </Grid>
    </Box>
  );
}
