'use client';

import * as Sentry from "@sentry/nextjs";
import { useState, useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import SendIcon from '@mui/icons-material/Send';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import BookmarkBorderIcon from '@mui/icons-material/BookmarkBorder';
import InsightChart from './InsightChart';
import {
  submitChatQuery,
  type ChatResponse,
  type ChartConfig,
} from '@/utils/insightsAccess';
import { saveInsight } from '@/utils/savedInsightsAccess';

const MAX_SAVED = 5;

const EXAMPLE_PROMPTS = [
  'What is my revenue trend over time?',
  'Who is my top customer by revenue?',
  'Are any jobs behind schedule?',
  'What is my quote pipeline worth?',
];

const LOADING_MESSAGES = [
  'Querying your data...',
  'Analyzing results...',
  'Building your answer...',
];

interface InsightsChatProps {
  companyId: string;
  /** Called when user saves an insight so InsightsSection can refresh */
  onInsightSaved?: () => void;
  /** Current number of saved insights (for limit enforcement) */
  savedCount?: number;
}

interface ChatResult {
  question: string;
  answer: string;
  chart_config: ChartConfig | null;
}

/**
 * AskBar: Compact question input with inline response.
 * Latest response appears directly below with optional chart + save action.
 */
export default function InsightsChat({ companyId, onInsightSaved, savedCount = 0 }: InsightsChatProps) {
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ChatResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loadingMsgIdx, setLoadingMsgIdx] = useState(0);
  const loadingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (loading) {
      setLoadingMsgIdx(0);
      loadingIntervalRef.current = setInterval(() => {
        setLoadingMsgIdx((prev) => (prev + 1) % LOADING_MESSAGES.length);
      }, 2000);
    } else if (loadingIntervalRef.current) {
      clearInterval(loadingIntervalRef.current);
      loadingIntervalRef.current = null;
    }
    return () => {
      if (loadingIntervalRef.current) clearInterval(loadingIntervalRef.current);
    };
  }, [loading]);

  const handleSubmit = async (inputQuestion?: string) => {
    const q = (inputQuestion || question).trim();
    if (!q || loading) return;

    setLoading(true);
    setError(null);
    setSaved(false);
    setQuestion('');

    try {
      const response: ChatResponse = await submitChatQuery(companyId, q);
      setResult({
        question: q,
        answer: response.answer,
        chart_config: response.chart_config,
      });
    } catch (err) {
      Sentry.captureException(err);
      const errorMessage =
        err instanceof Error ? err.message : 'Failed to process your question. Please try again.';
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleChipClick = (prompt: string) => {
    setQuestion(prompt);
    handleSubmit(prompt);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const atLimit = savedCount >= MAX_SAVED;

  const handleSave = async () => {
    if (!result || saving || saved || atLimit) return;

    setSaving(true);
    try {
      await saveInsight(companyId, result.question, result.answer, result.chart_config);
      setSaved(true);
      onInsightSaved?.();
      // Dismiss inline response after brief feedback — chart now lives in "Your Charts"
      setTimeout(() => {
        setResult(null);
        setSaved(false);
      }, 1500);
    } catch (err) {
      Sentry.captureException(err);
      const msg = err instanceof Error ? err.message : 'Failed to save';
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box sx={{ mb: 2 }}>
      {/* Input Row */}
      <Box sx={{ display: 'flex', gap: 1.5, mb: 1.5 }}>
        <TextField
          fullWidth
          size="small"
          placeholder="Ask about your shop data..."
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={loading}
          slotProps={{
            input: {
              sx: { minHeight: 48 },
            },
          }}
        />
        <Button
          variant="contained"
          onClick={() => handleSubmit()}
          disabled={!question.trim() || loading}
          sx={{ minWidth: 48, minHeight: 48, px: 2 }}
          aria-label="Send question"
        >
          {loading ? <CircularProgress size={20} color="inherit" /> : <SendIcon />}
        </Button>
      </Box>

      {/* Example Prompt Chips */}
      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
        {EXAMPLE_PROMPTS.map((prompt) => (
          <Chip
            key={prompt}
            label={prompt}
            variant="outlined"
            size="small"
            onClick={() => handleChipClick(prompt)}
            disabled={loading}
            sx={{
              cursor: 'pointer',
              '&:hover': { bgcolor: 'action.hover' },
            }}
          />
        ))}
      </Stack>

      {/* Loading State */}
      {loading && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mt: 2 }}>
          <CircularProgress size={16} />
          <Typography variant="body2" color="text.secondary">
            {LOADING_MESSAGES[loadingMsgIdx]}
          </Typography>
        </Box>
      )}

      {/* Error State */}
      {error && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {error}
        </Alert>
      )}

      {/* Inline Response */}
      {result && !loading && (
        <Card elevation={2} sx={{ mt: 2, p: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1.5 }}>
            <AutoAwesomeIcon sx={{ fontSize: 16, color: 'primary.main' }} />
            <Typography variant="caption" color="primary.main" sx={{ fontWeight: 600, flex: 1 }}>
              {result.question}
            </Typography>
          </Box>

          {result.chart_config && (
            <Box sx={{ mb: 1.5 }}>
              <InsightChart chartConfig={result.chart_config} height={220} />
            </Box>
          )}

          <Typography variant="body2" sx={{ lineHeight: 1.6 }}>
            {result.answer}
          </Typography>

          {result.chart_config && !saved && (
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1.5 }}>
              <Button
                size="small"
                variant="outlined"
                onClick={handleSave}
                disabled={saving || atLimit}
                startIcon={saving ? <CircularProgress size={14} /> : <BookmarkBorderIcon />}
              >
                {atLimit ? 'Limit reached' : 'Save to dashboard'}
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
      )}
    </Box>
  );
}
