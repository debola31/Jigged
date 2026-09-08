'use client';

import { useState } from 'react';
import * as Sentry from '@sentry/nextjs';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import BookmarkBorderIcon from '@mui/icons-material/BookmarkBorder';
import InsightChart from './InsightChart';
import type { ChartConfig } from '@/utils/insightsAccess';
import { saveInsight } from '@/utils/savedInsightsAccess';

interface ConversationTurnCardProps {
  companyId: string;
  question: string;
  answer: string;
  chartConfig: ChartConfig | null;
  /** Chart height in pixels. */
  chartHeight?: number;
  /** Called after a successful pin so the "Your Charts" grid can refresh. */
  onSaved?: () => void;
  onError?: (message: string) => void;
}

/**
 * One answered turn of a conversation: the question, the chart if one survived
 * validation, the answer, and the pin button. Extracted from the ask bar's single
 * inline card so a thread renders it once per turn.
 *
 * Save is offered only when a chart survived: "Your Charts" is a grid of charts,
 * and a card with no chart there would be a sentence in a chart slot.
 */
export default function ConversationTurnCard({
  companyId,
  question,
  answer,
  chartConfig,
  chartHeight = 220,
  onSaved,
  onError,
}: ConversationTurnCardProps) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    if (saving || saved) return;
    setSaving(true);
    try {
      await saveInsight(companyId, question, answer, chartConfig);
      setSaved(true);
      onSaved?.();
    } catch (err) {
      Sentry.captureException(err);
      onError?.(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card elevation={2} sx={{ p: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1.5 }}>
        <AutoAwesomeIcon sx={{ fontSize: 16, color: 'primary.main' }} />
        <Typography variant="caption" color="primary.main" sx={{ fontWeight: 600, flex: 1 }}>
          {question}
        </Typography>
      </Box>

      {chartConfig && (
        <Box sx={{ mb: 1.5 }}>
          <InsightChart chartConfig={chartConfig} height={chartHeight} />
        </Box>
      )}

      <Typography variant="body2" sx={{ lineHeight: 1.6 }}>
        {answer}
      </Typography>

      {chartConfig && !saved && (
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1.5 }}>
          <Button
            size="small"
            variant="outlined"
            onClick={handleSave}
            disabled={saving}
            startIcon={saving ? <CircularProgress size={14} /> : <BookmarkBorderIcon />}
          >
            Save to dashboard
          </Button>
        </Box>
      )}
      {saved && (
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1.5 }}>
          <Typography variant="caption" color="success.main" sx={{ fontWeight: 600 }}>
            Saved to dashboard
          </Typography>
        </Box>
      )}
    </Card>
  );
}
