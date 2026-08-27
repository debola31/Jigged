'use client';

import { useState } from 'react';
import { useLoad } from '@/hooks/useLoad';
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

// Stable empty fallback so derived data doesn't churn while the first load runs.
const EMPTY_INSIGHTS: SavedInsight[] = [];

interface InsightsSectionProps {
  companyId: string;
  /** Incremented when a new insight is saved, to trigger refetch */
  savedVersion?: number;
}

/**
 * InsightsSection: User-built chart dashboard.
 * Displays saved insight cards from ask bar responses.
 * Shows simple empty state when no saved insights exist.
 */
export default function InsightsSection({
  companyId,
  savedVersion = 0,
}: InsightsSectionProps) {
  const [error, setError] = useState<string | null>(null);

  const {
    data: savedData,
    loading,
    reload: fetchSavedInsights,
  } = useLoad(
    async () => {
      // No company yet → nothing to fetch.
      if (!companyId) {
        return [] as SavedInsight[];
      }
      return await getSavedInsights(companyId);
    },
    [companyId, savedVersion],
    {
      onError: (err) => {
        console.error('Error fetching saved insights:', err);
        setError('Failed to load saved charts.');
      },
    },
  );
  const savedInsights = savedData ?? EMPTY_INSIGHTS;

  const handleRemoveSaved = async (insightId: string) => {
    try {
      await deleteSavedInsight(companyId, insightId);
      // Re-pull so the list + reported count come from one source of truth.
      await fetchSavedInsights();
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
                  summary: saved.answer,
                  chart_config: saved.chart_config,
                  computed_at: saved.created_at,
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
