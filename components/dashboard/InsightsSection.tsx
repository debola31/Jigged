'use client';

import { useEffect, useState, useCallback } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import RefreshIcon from '@mui/icons-material/Refresh';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import InsightCard from '@/components/insights/InsightCard';
import {
  getDashboardInsights,
  refreshInsights,
  getSavedInsights,
  deleteSavedInsight,
  type InsightCard as InsightCardType,
  type SavedInsight,
} from '@/utils/insightsAccess';

interface InsightsSectionProps {
  companyId: string;
  /** Incremented when a new insight is saved, to trigger refetch */
  savedVersion?: number;
}

/**
 * InsightsSection: Container for 5 insight cards on the dashboard.
 * Displays in a responsive 2-column grid (1-column on mobile).
 * Includes a Refresh button to force-recompute insights.
 */
export default function InsightsSection({ companyId, savedVersion = 0 }: InsightsSectionProps) {
  const [insights, setInsights] = useState<InsightCardType[]>([]);
  const [savedInsights, setSavedInsights] = useState<SavedInsight[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchInsights = useCallback(async () => {
    if (!companyId) return;

    try {
      setLoading(true);
      setError(null);
      const [builtIn, saved] = await Promise.all([
        getDashboardInsights(companyId),
        getSavedInsights(companyId).catch(() => []),
      ]);
      setInsights(builtIn);
      setSavedInsights(saved);
    } catch (err) {
      console.error('Error fetching insights:', err);
      setError('Failed to load AI insights. The insights service may be temporarily unavailable.');
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    fetchInsights();
  }, [fetchInsights, savedVersion]);

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

  const handleRemoveSaved = async (insightId: string) => {
    try {
      await deleteSavedInsight(companyId, insightId);
      setSavedInsights((prev) => prev.filter((s) => s.id !== insightId));
    } catch (err) {
      console.error('Error deleting saved insight:', err);
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
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Insights
          </Typography>
          <AutoAwesomeIcon sx={{ fontSize: 20, color: 'primary.main' }} />
        </Box>
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
          : (
            <>
              {/* Pre-built insight cards */}
              {insights.map((insight) => (
                <Grid key={insight.type} size={{ xs: 12, md: 6 }}>
                  <InsightCard insight={insight} />
                </Grid>
              ))}
              {/* Saved insight cards */}
              {savedInsights.map((saved) => (
                <Grid key={saved.id} size={{ xs: 12, md: 6 }}>
                  <InsightCard
                    insight={{
                      type: 'saved',
                      summary: saved.answer,
                      metric_data: {},
                      chart_config: saved.chart_config,
                      computed_at: saved.created_at,
                      is_cached: false,
                    }}
                    title={saved.question}
                    removable
                    onRemove={() => handleRemoveSaved(saved.id)}
                  />
                </Grid>
              ))}
            </>
          )}
      </Grid>
    </Box>
  );
}
