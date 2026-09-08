'use client';

import * as Sentry from '@sentry/nextjs';
import posthog from 'posthog-js';
import { useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddCommentOutlinedIcon from '@mui/icons-material/AddCommentOutlined';
import CloudOffIcon from '@mui/icons-material/CloudOff';
import HistoryIcon from '@mui/icons-material/History';
import SendIcon from '@mui/icons-material/Send';
import ConversationTurnCard from './ConversationTurnCard';
import { useAiJob } from '@/hooks/useAiJob';
import { useLoad } from '@/hooks/useLoad';
import {
  archiveThread,
  createThread,
  listThreadMessages,
  listThreads,
  type ChatThread,
  type ThreadMessage,
} from '@/utils/aiChatAccess';
import { ChatEnqueueError, submitChatQuery } from '@/utils/insightsAccess';

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

const THREAD_STORAGE_PREFIX = 'jigged.aiThread.';

interface InsightsChatProps {
  companyId: string;
  /** Called when user saves an insight so InsightsSection can refresh */
  onInsightSaved?: () => void;
}

/** A displayed exchange: the question and the answer the trigger stored with it. */
interface Turn {
  key: string;
  question: string;
  answer: string;
  chartConfig: ThreadMessage['chart_config'];
}

/**
 * Pair the thread's user/assistant rows into exchanges, newest first.
 *
 * Newest first because the ask bar sits at the top of the dashboard and the
 * latest answer has always landed directly under it; a chat that scrolled away
 * from the input would put the newest answer furthest from the question box.
 */
function pairTurns(messages: ThreadMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const next = messages[i + 1];
    if (!next || next.role !== 'assistant') continue;
    turns.push({ key: next.id, question: m.content, answer: next.content, chartConfig: next.chart_config });
    i += 1;
  }
  return turns.reverse();
}

/**
 * AskBar: a question input over one conversation.
 *
 * The thread is the record and the browser owns its identity: the first question
 * creates an ai_chat_threads row under RLS (created_by = auth.uid()) and every
 * later question carries its id, so the route can ship the replay set to the
 * model. Nothing here writes a message -- the trigger on ai_jobs appends the turn
 * when the job succeeds -- so after a job settles the thread is simply re-read.
 */
export default function InsightsChat({ companyId, onInsightSaved }: InsightsChatProps) {
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  // The status rides with the message so the render can tell downtime (503, the
  // quiet offline notice) from a refusal (429 / 403 / 409, an error) without
  // matching on the sentence.
  const [error, setError] = useState<{ message: string; status?: number } | null>(null);
  const [askedQuestion, setAskedQuestion] = useState('');
  const [loadingTick, setLoadingTick] = useState(0);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [recent, setRecent] = useState<ChatThread[] | null>(null);
  const loadingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // The answer arrives on a job row, not on the POST. Keyed by company so two tabs
  // on different shops do not re-attach to each other's question after a reload.
  const job = useAiJob(`insights.${companyId}`);

  const pending = asking || job.phase === 'pending';
  const storageKey = `${THREAD_STORAGE_PREFIX}${companyId}`;

  // Re-attach to the conversation after a reload. Deferred into a microtask for
  // the same two reasons useAiJob gives: a synchronous setState here is a
  // cascading render, and sessionStorage does not exist during SSR.
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      try {
        const saved = window.sessionStorage.getItem(storageKey);
        if (saved) setThreadId(saved);
      } catch {
        /* private mode, or storage disabled — a lost handle starts a new thread */
      }
    });
    return () => {
      cancelled = true;
    };
  }, [storageKey]);

  const rememberThread = (id: string | null) => {
    setThreadId(id);
    try {
      if (id) window.sessionStorage.setItem(storageKey, id);
      else window.sessionStorage.removeItem(storageKey);
    } catch {
      /* see above */
    }
  };

  // Re-read the thread whenever a job settles: the trigger has appended the
  // turn by the time the row reads `succeeded`. A primitive dep, so a settle is
  // one refetch rather than a setState in an effect.
  const settledJobId = job.phase === 'done' ? job.job?.id ?? null : null;
  const { data: messages } = useLoad(
    () => (threadId ? listThreadMessages(threadId) : Promise.resolve([] as ThreadMessage[])),
    [threadId, settledJobId],
    {
      onError: (err) => {
        Sentry.captureException(err);
      },
    },
  );
  const turns = useMemo(() => pairTurns(messages ?? []), [messages]);

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
      // The templated refusal for a question that was not about the shop. The
      // rate is the trigger for building an input gate; the question itself never
      // leaves its row.
      off_topic: !!job.result?.off_topic,
    });
  }, [job.phase, job.job, job.result]);

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

  const startNewConversation = () => {
    job.reset();
    setError(null);
    setAskedQuestion('');
    rememberThread(null);
  };

  const handleSubmit = async (inputQuestion?: string) => {
    const q = (inputQuestion || question).trim();
    if (!q || pending) return;

    setAsking(true);
    setError(null);
    setLoadingTick(0);
    setAskedQuestion(q);
    setQuestion('');

    try {
      // The first question opens the thread; its title is the question itself.
      let tid = threadId;
      if (!tid) {
        tid = (await createThread(companyId, q)).id;
        rememberThread(tid);
      }
      const enqueued = await submitChatQuery(companyId, q, tid);
      // Shape, never content: `executor` is the whole point of the rollout -- it
      // says whether the local box or a hosted model served this shop -- and
      // `turn_index` is how many answered turns this thread already had, which is
      // the multi-turn adoption signal. The question itself never leaves its row.
      posthog.capture('ai job enqueued', {
        feature: 'insights',
        executor: enqueued.executor,
        from_example: !!inputQuestion,
        turn_index: turns.length,
      });
      job.watch(enqueued.job_id);
    } catch (err) {
      // The enqueue response is the AUTHORITATIVE signal -- it carries the real
      // rate-limit number on 429, the disabled text on 403, the offline sentence
      // on 503, and the one-at-a-time sentence on 409. Sentry only wants the ones
      // that are ours: a shop hitting its own cap, or a box being off, is not an
      // incident.
      const message =
        err instanceof Error ? err.message : 'Failed to send your question. Please try again.';
      const status = err instanceof ChatEnqueueError ? err.status : undefined;
      if (!(status !== undefined && [403, 404, 409, 429, 503].includes(status))) {
        Sentry.captureException(err);
      }
      // A thread the route no longer recognises (archived elsewhere, or gone) is
      // not worth keeping a handle to; the next question starts a fresh one.
      if (status === 404) rememberThread(null);
      setError({ message, status });
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

  // Recent conversations are read when the menu opens, never on mount: a
  // dashboard load should not pay for a list nobody asked to see.
  const openRecent = async (anchor: HTMLElement) => {
    setMenuAnchor(anchor);
    try {
      setRecent(await listThreads(companyId));
    } catch (err) {
      Sentry.captureException(err);
      setRecent([]);
    }
  };

  const switchThread = (id: string) => {
    setMenuAnchor(null);
    if (id === threadId) return;
    job.reset();
    setError(null);
    setAskedQuestion('');
    rememberThread(id);
  };

  const archiveCurrent = async () => {
    setMenuAnchor(null);
    if (!threadId) return;
    try {
      await archiveThread(threadId);
      startNewConversation();
    } catch (err) {
      Sentry.captureException(err);
      setError({ message: err instanceof Error ? err.message : 'Failed to archive' });
    }
  };

  const hasConversation = turns.length > 0;

  return (
    <Box sx={{ mb: 2 }}>
      {/* Input Row */}
      <Box sx={{ display: 'flex', gap: 1.5, mb: 1.5 }}>
        <TextField
          fullWidth
          size="small"
          placeholder={hasConversation ? 'Ask a follow-up...' : 'Ask about your shop data...'}
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
        <IconButton
          onClick={(e) => openRecent(e.currentTarget)}
          aria-label="Recent conversations"
          sx={{ minWidth: 48, minHeight: 48 }}
        >
          <HistoryIcon />
        </IconButton>
        <Menu anchorEl={menuAnchor} open={!!menuAnchor} onClose={() => setMenuAnchor(null)}>
          <MenuItem onClick={() => { setMenuAnchor(null); startNewConversation(); }}>
            <AddCommentOutlinedIcon fontSize="small" sx={{ mr: 1 }} />
            <ListItemText primary="New conversation" />
          </MenuItem>
          {threadId && hasConversation && (
            <MenuItem onClick={archiveCurrent}>
              <ListItemText primary="Archive this conversation" />
            </MenuItem>
          )}
          {recent === null && (
            <MenuItem disabled>
              <CircularProgress size={16} sx={{ mr: 1 }} /> Loading…
            </MenuItem>
          )}
          {recent && recent.length === 0 && (
            <MenuItem disabled>
              <ListItemText secondary="No earlier conversations" />
            </MenuItem>
          )}
          {recent?.map((t) => (
            <MenuItem key={t.id} selected={t.id === threadId} onClick={() => switchThread(t.id)}>
              <ListItemText
                primary={t.title}
                secondary={new Date(t.updated_at).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                })}
              />
            </MenuItem>
          ))}
        </Menu>
      </Box>

      {/* Example Prompt Chips — for an empty conversation only */}
      {!hasConversation && (
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
      )}

      {/* Working. aria-live so a screen reader is told the wait started and ended. */}
      {pending && (
        <Box
          role="status"
          aria-live="polite"
          sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mt: 2 }}
        >
          <CircularProgress size={16} />
          <Typography variant="body2" color="text.secondary">
            {askedQuestion ? `${askedQuestion} — ` : ''}
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
          silently, because a spinner that quietly gives up is worse than an error.
          A conversation that outgrew the window gets New conversation instead of
          Try again, because asking again walks into the same wall. */}
      {!pending && job.phase === 'failed' && (
        <Alert
          severity="error"
          sx={{ mt: 2 }}
          action={
            job.job?.error_kind === 'context_overflow' ? (
              <Button color="inherit" size="small" onClick={startNewConversation}>
                New conversation
              </Button>
            ) : (
              <Button color="inherit" size="small" onClick={() => handleSubmit(askedQuestion)}>
                Try again
              </Button>
            )
          }
        >
          {job.message}
        </Alert>
      )}

      {/* An enqueue-time 503 is the SAME state as a mid-job outage -- the box is
          off -- and gets the same quiet notice. Rendering it red, like every other
          enqueue failure, told the user their question had gone wrong when nothing
          had. */}
      {error && error.status === 503 && (
        <Alert severity="info" icon={<CloudOffIcon fontSize="inherit" />} sx={{ mt: 2 }}>
          {error.message}
        </Alert>
      )}
      {error && error.status !== 503 && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {error.message}
        </Alert>
      )}

      {/* The conversation, newest exchange first. */}
      {turns.length > 0 && (
        <Stack spacing={2} sx={{ mt: 2 }}>
          {turns.map((turn) => (
            <ConversationTurnCard
              key={turn.key}
              companyId={companyId}
              question={turn.question}
              answer={turn.answer}
              chartConfig={turn.chartConfig}
              onSaved={onInsightSaved}
              onError={(message) => setError({ message })}
            />
          ))}
        </Stack>
      )}
    </Box>
  );
}
