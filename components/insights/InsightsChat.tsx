'use client';

import * as Sentry from "@sentry/nextjs";
import posthog from 'posthog-js';
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
import CloudOffIcon from '@mui/icons-material/CloudOff';
import InsightChart from './InsightChart';
import { useAiJob } from '@/hooks/useAiJob';
import { submitChatQuery, type ChartConfig } from '@/utils/insightsAccess';
import { saveInsight } from '@/utils/savedInsightsAccess';

const EXAMPLE_PROMPTS = [
  'What is my revenue trend over time?',
  'Who is my top customer by revenue?',
  'What is my quote pipeline worth?',
];

/**
 * Rotating status while the answer is being worked out.
 *
 * interaction-standards.md §5 puts anything over ten seconds in a tier that must
 * say WHERE the wait is, not just that there is one. A local model on shop
 * hardware routinely takes tens of seconds, so the last line says so plainly
 * rather than implying it is nearly done.
 */
const LOADING_MESSAGES = [
  'Reading your shop data…',
  'Working out the answer…',
  'Still going — this can take up to a minute.',
];

interface InsightsChatProps {
  companyId: string;
  /** Called when user saves an insight so InsightsSection can refresh */
  onInsightSaved?: () => void;
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
export default function InsightsChat({ companyId, onInsightSaved }: InsightsChatProps) {
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askedQuestion, setAskedQuestion] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loadingTick, setLoadingTick] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const loadingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // The answer arrives on a job row, not on the POST. Keyed by company so two tabs
  // on different shops do not re-attach to each other's question after a reload.
  const job = useAiJob(`insights.${companyId}`);

  const pending = asking || job.phase === 'pending';

  // Fires once per settled job. `phase` is what a rollout is judged on: the ratio
  // of offline to done is exactly the question "is the shop's box reliable
  // enough", and no other signal answers it.
  const settledRef = useRef<string | null>(null);
  useEffect(() => {
    const id = job.job?.id;
    if (!id || job.phase === 'pending' || job.phase === 'idle') return;
    if (settledRef.current === id) return;
    settledRef.current = id;
    posthog.capture('ai job settled', {
      feature: 'insights',
      phase: job.phase,
      executor: job.job?.executor ?? 'unknown',
      model: job.job?.model ?? 'unknown',
      error_kind: job.job?.error_kind ?? null,
      has_chart: !!job.result?.chart_config,
      tool_call_count: job.result?.tool_calls?.length ?? 0,
    });
  }, [job.phase, job.job, job.result]);

  /**
   * DERIVED, not mirrored into state by an effect. Copying job.result into local
   * state would mean a setState inside an effect body -- a cascading render, and
   * the rule hooks/useLoad.ts documents -- for no benefit: the row IS the source of
   * truth and `dismissed` is the only thing this component adds to it.
   */
  const result: ChatResult | null =
    job.phase === 'done' && job.result && !dismissed
      ? {
          question: askedQuestion,
          answer: job.result.answer,
          chart_config: job.result.chart_config,
        }
      : null;

  // Only the interval callback writes state; the effect body does not. Resetting
  // the tick belongs to the submit handler, which is a real user action rather
  // than a render side effect.
  useEffect(() => {
    if (!pending) {
      if (loadingIntervalRef.current) {
        clearInterval(loadingIntervalRef.current);
        loadingIntervalRef.current = null;
      }
      return;
    }
    loadingIntervalRef.current = setInterval(() => setLoadingTick((n) => n + 1), 4000);
    return () => {
      if (loadingIntervalRef.current) clearInterval(loadingIntervalRef.current);
      loadingIntervalRef.current = null;
    };
  }, [pending]);

  const handleSubmit = async (inputQuestion?: string) => {
    const q = (inputQuestion || question).trim();
    if (!q || pending) return;

    setAsking(true);
    setError(null);
    setSaved(false);
    setDismissed(false);
    setLoadingTick(0);
    setAskedQuestion(q);
    setQuestion('');

    try {
      const enqueued = await submitChatQuery(companyId, q);
      // Shape, never content: `executor` is the whole point of the rollout -- it
      // says whether the local box or a hosted model served this shop, and the
      // question itself never leaves the row it was stored in.
      posthog.capture('ai job enqueued', {
        feature: 'insights',
        executor: enqueued.executor,
        from_example: !!inputQuestion,
      });
      job.watch(enqueued.job_id);
    } catch (err) {
      // The enqueue response is the AUTHORITATIVE signal -- it carries the real
      // rate-limit number on 429, the disabled text on 403, and the offline
      // sentence on 503. Sentry only wants the ones that are ours: a shop hitting
      // its own cap, or a box being off, is not an incident.
      const message =
        err instanceof Error ? err.message : 'Failed to send your question. Please try again.';
      if (!/offline|rate limit|disabled/i.test(message)) {
        Sentry.captureException(err);
      }
      setError(message);
    } finally {
      setAsking(false);
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

  const handleSave = async () => {
    if (!result || saving || saved) return;

    setSaving(true);
    try {
      await saveInsight(companyId, result.question, result.answer, result.chart_config);
      setSaved(true);
      onInsightSaved?.();
      // Dismiss inline response after brief feedback — chart now lives in "Your Charts"
      setTimeout(() => {
        setDismissed(true);
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
          disabled={pending}
          slotProps={{
            input: {
              sx: { minHeight: 48 },
            },
          }}
        />
        <Button
          variant="contained"
          onClick={() => handleSubmit()}
          disabled={!question.trim() || pending}
          sx={{ minWidth: 48, minHeight: 48, px: 2 }}
          aria-label="Send question"
          aria-busy={pending}
        >
          {pending ? <CircularProgress size={20} color="inherit" /> : <SendIcon />}
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
            disabled={pending}
            sx={{
              cursor: 'pointer',
              '&:hover': { bgcolor: 'action.hover' },
            }}
          />
        ))}
      </Stack>

      {/* Working. aria-live so a screen reader is told the wait started and ended. */}
      {pending && (
        <Box
          role="status"
          aria-live="polite"
          sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mt: 2 }}
        >
          <CircularProgress size={16} />
          <Typography variant="body2" color="text.secondary">
            {LOADING_MESSAGES[loadingTick % LOADING_MESSAGES.length]}
          </Typography>
        </Box>
      )}

      {/* Offline. severity="info", not error, and it names what still works --
          matching SuggestFixesPanel, which already had to say this sentence. The
          shop's AI box being asleep is not the user's mistake and not a fault of
          the page they are on. Distinct from the flag being off, which renders
          nothing at all. */}
      {!pending && job.phase === 'offline' && (
        <Alert severity="info" icon={<CloudOffIcon fontSize="inherit" />} sx={{ mt: 2 }}>
          {job.message}
        </Alert>
      )}

      {/* Failed, including the poll wall -- which renders rather than stopping
          silently, because a spinner that quietly gives up is worse than an error. */}
      {!pending && job.phase === 'failed' && (
        <Alert
          severity="error"
          sx={{ mt: 2 }}
          action={
            <Button color="inherit" size="small" onClick={() => handleSubmit(askedQuestion)}>
              Try again
            </Button>
          }
        >
          {job.message}
        </Alert>
      )}

      {error && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {error}
        </Alert>
      )}

      {/* Inline Response */}
      {result && !pending && (
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
      )}
    </Box>
  );
}
