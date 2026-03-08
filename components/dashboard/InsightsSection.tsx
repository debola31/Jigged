'use client';

import { useEffect, useState, useCallback } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import InsightCard from '@/components/insights/InsightCard';
import {
  getSavedInsights,
  deleteSavedInsight,
} from '@/utils/savedInsightsAccess';
import type { SavedInsight } from '@/utils/insightsAccess';

const MAX_SAVED = 5;

interface InsightsSectionProps {
  companyId: string;
  /** Incremented when a new insight is saved, to trigger refetch */
  savedVersion?: number;
  /** Called with current saved count so parent can pass to InsightsChat */
  onSavedCountChange?: (count: number) => void;
}

/**
 * InsightsSection: User-built chart dashboard.
 * Displays saved insight cards from ask bar responses.
 * Shows simple empty state when no saved insights exist.
 */
export default function InsightsSection({
  companyId,
  savedVersion = 0,
  onSavedCountChange,
}: InsightsSectionProps) {
  const [savedInsights, setSavedInsights] = useState<SavedInsight[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSavedInsights = useCallback(async () => {
    if (!companyId) return;

    try {
      setLoading(true);
      setError(null);
      const saved = await getSavedInsights(companyId);
      setSavedInsights(saved);
      onSavedCountChange?.(saved.length);
    } catch (err) {
      console.error('Error fetching saved insights:', err);
      setError('Failed to load saved charts.');
    } finally {
      setLoading(false);
    }
  }, [companyId, onSavedCountChange]);

  useEffect(() => {
    fetchSavedInsights();
  }, [fetchSavedInsights, savedVersion]);

  const handleRemoveSaved = async (insightId: string) => {
    try {
      await deleteSavedInsight(companyId, insightId);
      setSavedInsights((prev) => {
        const next = prev.filter((s) => s.id !== insightId);
        onSavedCountChange?.(next.length);
        return next;
      });
    } catch (err) {
      console.error('Error deleting saved insight:', err);
    }
  };

  const savedCount = savedInsights.length;

  return (
    <Box sx={{ mb: 4 }}>
      {/* Section Header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          mb: 2,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Your Charts
          </Typography>
          <AutoAwesomeIcon sx={{ fontSize: 20, color: 'primary.main' }} />
        </Box>
        {!loading && savedCount > 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ ml: 1.5 }}>
            ({savedCount}/{MAX_SAVED})
          </Typography>
        )}
      </Box>

      {/* Error State */}
      {error && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {/* Loading State */}
      {loading && (
        <Grid container spacing={2}>
          {[0, 1].map((i) => (
            <Grid key={i} size={{ xs: 12, md: 6 }}>
              <InsightCard insight={null} loading={true} />
            </Grid>
          ))}
        </Grid>
      )}

      {/* Saved Insight Cards */}
      {!loading && savedCount > 0 && (
        <Grid container spacing={2}>
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
                chartHeight={150}
              />
            </Grid>
          ))}
        </Grid>
      )}

      {/* Empty State */}
      {!loading && savedCount === 0 && (
        <Box
          sx={{
            py: 5,
            px: 3,
            textAlign: 'center',
            borderRadius: 2,
            border: '1px dashed',
            borderColor: 'divider',
          }}
        >
          <Typography variant="body1" sx={{ fontWeight: 500 }}>
            Ask a question above and save the answer to build your dashboard.
          </Typography>
        </Box>
      )}
    </Box>
  );
}
