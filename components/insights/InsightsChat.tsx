'use client';

import * as Sentry from '@sentry/nextjs';
import posthog from 'posthog-js';
import { useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddCommentOutlinedIcon from '@mui/icons-material/AddCommentOutlined';
import CloudOffIcon from '@mui/icons-material/CloudOff';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import HistoryIcon from '@mui/icons-material/History';
import SendIcon from '@mui/icons-material/Send';
import ConversationTurnCard from './ConversationTurnCard';
import HistoryDrawer, { type HistoryTab } from './HistoryDrawer';
import ReportPreviewDialog from './ReportPreviewDialog';
import { useAiJob } from '@/hooks/useAiJob';
import { useLoad } from '@/hooks/useLoad';
import {
  createThread,
  listThreadMessages,
  type ReportTurn,
  type ThreadMessage,
} from '@/utils/aiChatAccess';
import { ChatEnqueueError, reportResultOf, submitChatQuery, type ReportSummary } from '@/utils/insightsAccess';
import { reportSpecOf } from '@/utils/reportSpec';

const EXAMPLE_PROMPTS = [
  'What is my revenue trend over time?',
  'Who is my top customer by revenue?',
  'What is my quote pipeline worth?',
];

/**
 * Requests for a document, offered beside the questions. There is no Report
 * verb: the words carry the intent, and the model calls compose_report when it
 * reads one. The chips show what to say.
 */
const EXAMPLE_REPORTS = [
  'One-page report on this quarter',
  'PDF of the backlog and late jobs',
];

/**
 * Rotating status while the answer is being worked out.
 *
 * interaction-standards.md §5 puts anything over ten seconds in a tier that must
 * say WHERE the wait is, not just that there is one. A local model on shop
 * hardware routinely takes tens of seconds for a question and minutes for a
 * report, and which of the two this is only shows on the job row when it settles
 * (the model decides mid-job), so the last line states both.
 */
const LOADING_MESSAGES = [
  'Reading your shop data…',
  'Working out the answer…',
  'Still going — a question can take up to a minute, a one-page report a few minutes.',
];

const THREAD_STORAGE_PREFIX = 'jigged.aiThread.';

interface InsightsChatProps {
  companyId: string;
}

/** A displayed exchange: the question and the answer the trigger stored with it. */
interface Turn {
  key: string;
  question: string;
  answer: string;
  chartConfig: ThreadMessage['chart_config'];
  report: ReportTurn | null;
  jobId: string | null;
  createdAt: string;
}

/**
 * Pair the thread's user/assistant rows into exchanges, oldest first.
 *
 * Chronological because the composer now sits under the conversation, the way
 * every chat people know reads: the newest answer lands right above the box you
 * type the follow-up into.
 */
function pairTurns(messages: ThreadMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const next = messages[i + 1];
    if (!next || next.role !== 'assistant') continue;
    turns.push({
      key: next.id,
      question: m.content,
      answer: next.content,
      chartConfig: next.chart_config,
      report: next.report,
      jobId: next.job_id,
      createdAt: next.created_at,
    });
    i += 1;
  }
  return turns;
}

/**
 * The dashboard's AI area, chat first.
 *
 * Empty, it is one centred question with example chips -- the shape of a search
 * box or a chat app. Once a thread exists the composer docks to the bottom and
 * the conversation reads top to bottom above it. One History button opens the
 * rail with every conversation, report and chart asked for before. The composer
 * has one box and no picker: the form of the answer -- prose, a chart, or a
 * one-page report when the words ask for a document -- is the model's call
 * (compose_report), and a report comes back as a turn carrying the page.
 *
 * The thread is the record and the browser owns its identity: the first question
 * creates an ai_chat_threads row under RLS (created_by = auth.uid()) and every
 * later question -- or report -- carries its id. Nothing here writes a message;
 * the trigger on ai_jobs appends the turn when the job succeeds, so after a job
 * settles the thread is simply re-read.
 */
export default function InsightsChat({ companyId }: InsightsChatProps) {
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  // The status rides with the message so the render can tell downtime (503, the
  // quiet offline notice) from a refusal (429 / 403 / 409, an error) without
  // matching on the sentence.
  const [error, setError] = useState<{ message: string; status?: number } | null>(null);
  const [askedQuestion, setAskedQuestion] = useState('');
  const [loadingTick, setLoadingTick] = useState(0);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyTab, setHistoryTab] = useState<HistoryTab>('chats');
  const [preview, setPreview] = useState<ReportSummary | null>(null);
  const loadingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // The answer arrives on a job row, not on the POST. Keyed by company so two tabs
  // on different shops do not re-attach to each other's question after a reload.
  // Questions and reports share the key: a thread holds one job at a time.
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
  const hasConversation = turns.length > 0;

  // Fires once per settled job. `phase` is what a rollout is judged on: the ratio
  // of offline to done is exactly the question "is the shop's box reliable
  // enough", and no other signal answers it. A report settles into its own event,
  // whose counts are the shape of the page the model composed.
  const settledRef = useRef<string | null>(null);
  useEffect(() => {
    const id = job.job?.id;
    if (!id || job.phase === 'pending' || job.phase === 'idle') return;
    if (settledRef.current === id) return;
    settledRef.current = id;
    if (job.job?.kind === 'report') {
      const summary = reportResultOf(job.job);
      const spec = summary ? reportSpecOf(summary.report) : null;
      posthog.capture('report generated', {
        phase: job.phase,
        error_kind: job.job?.error_kind ?? null,
        kpi_count: spec?.kpis.length ?? 0,
        block_count: spec?.blocks.length ?? 0,
        chart_count: spec?.blocks.filter((b) => b.type === 'chart').length ?? 0,
        table_count: spec?.blocks.filter((b) => b.type === 'table').length ?? 0,
        has_text_block: !!spec?.blocks.some((b) => b.type === 'text'),
        dropped_count: summary?.dropped.length ?? 0,
        tool_call_count: summary?.tool_call_count ?? 0,
      });
      return;
    }
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
      grounding_corrected: !!job.result?.grounding_corrected,
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

  // Keep the newest thing in view: a new turn, or the wait for one. The composer
  // is sticky at the bottom, so this brings the conversation to it.
  useEffect(() => {
    if (!hasConversation && !pending) return;
    const reduce =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    bottomRef.current?.scrollIntoView?.({ block: 'end', behavior: reduce ? 'auto' : 'smooth' });
  }, [turns.length, pending, hasConversation]);

  const startNewConversation = () => {
    job.reset();
    setError(null);
    setAskedQuestion('');
    rememberThread(null);
    setHistoryOpen(false);
  };

  const handleSubmit = async (input?: string) => {
    const q = (input || question).trim();
    if (!q || pending) return;

    setAsking(true);
    setError(null);
    setLoadingTick(0);
    setAskedQuestion(q);
    setQuestion('');

    try {
      // The first message opens the thread; its title is the text itself.
      let tid = threadId;
      if (!tid) {
        tid = (await createThread(companyId, q)).id;
        rememberThread(tid);
      }
      // One door. Whether this comes back as prose, a chart or a one-page report
      // is decided by the model from the words, and shows on the job row's `kind`
      // when it settles (`report generated` fires for a report, below).
      const enqueued = await submitChatQuery(companyId, q, tid);
      // Shape, never content: `executor` is the whole point of the rollout -- it
      // says whether the local box or a hosted model served this shop -- and
      // `turn_index` is how many answered turns this thread already had, which is
      // the multi-turn adoption signal.
      posthog.capture('ai job enqueued', {
        feature: 'insights',
        executor: enqueued.executor,
        from_example: !!input,
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

  const openHistory = (tab: HistoryTab) => {
    setHistoryTab(tab);
    setHistoryOpen(true);
  };

  const switchThread = (id: string) => {
    setHistoryOpen(false);
    if (id === threadId) return;
    job.reset();
    setError(null);
    setAskedQuestion('');
    rememberThread(id);
  };

  const openReportTurn = (turn: Turn) => {
    if (!turn.report) return;
    setPreview({
      id: turn.jobId ?? turn.key,
      created_at: turn.createdAt,
      report: turn.report.report,
      dropped: turn.report.dropped,
      tool_call_count: turn.report.tool_call_count,
    });
  };

  const placeholder = hasConversation ? 'Ask a follow-up…' : 'Ask a question, or ask for a one-page report…';

  const composer = (
    <Box sx={{ display: 'flex', gap: 1.5 }}>
      <TextField
        fullWidth
        size="small"
        multiline
        maxRows={4}
        placeholder={placeholder}
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={pending}
        slotProps={{
          input: {
            sx: { minHeight: 48 },
            'aria-label': 'Your question',
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
  );

  const status = (
    <>
      {/* Working. aria-live so a screen reader is told the wait started and ended. */}
      {pending && (
        <Box role="status" aria-live="polite" sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <CircularProgress size={16} />
          <Typography variant="body2" color="text.secondary">
            {askedQuestion ? `${askedQuestion} — ` : ''}
            {LOADING_MESSAGES[loadingTick % LOADING_MESSAGES.length]}
          </Typography>
        </Box>
      )}

      {/* Offline. severity="info", not error, and it names what still works. The
          shop's AI box being asleep is not the user's mistake and not a fault of
          the page they are on. Distinct from the flag being off, which renders
          nothing at all. */}
      {!pending && job.phase === 'offline' && (
        <Alert severity="info" icon={<CloudOffIcon fontSize="inherit" />}>
          {job.message}
        </Alert>
      )}

      {/* Failed, including the poll wall -- which renders rather than stopping
          silently. A conversation that outgrew the window gets New conversation
          instead of Try again, because asking again walks into the same wall. */}
      {!pending && job.phase === 'failed' && (
        <Alert
          severity="error"
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
          off -- and gets the same quiet notice. */}
      {error && error.status === 503 && (
        <Alert severity="info" icon={<CloudOffIcon fontSize="inherit" />}>
          {error.message}
        </Alert>
      )}
      {error && error.status !== 503 && <Alert severity="error">{error.message}</Alert>}
    </>
  );

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* Top row: the way back to everything asked before. */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 1, flexWrap: 'wrap' }}>
        <Stack direction="row" spacing={1}>
          {hasConversation && (
            <Button
              variant="text"
              startIcon={<AddCommentOutlinedIcon />}
              onClick={startNewConversation}
              sx={{ minHeight: 48 }}
            >
              New conversation
            </Button>
          )}
          <Button variant="outlined" startIcon={<HistoryIcon />} onClick={() => openHistory('chats')} sx={{ minHeight: 48 }}>
            History
          </Button>
        </Stack>
      </Box>

      {!hasConversation && !pending ? (
        // Empty: one centred question, the shape of a search box.
        <Box sx={{ py: { xs: 4, md: 8 }, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2.5 }}>
          <Typography variant="h5" component="h2" sx={{ fontWeight: 600, textAlign: 'center' }}>
            What do you want to know about the shop?
          </Typography>
          <Box sx={{ width: '100%', maxWidth: 760 }}>{composer}</Box>
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 0.75, justifyContent: 'center', maxWidth: 760 }}>
            {EXAMPLE_PROMPTS.map((prompt) => (
              <Chip
                key={prompt}
                label={prompt}
                variant="outlined"
                onClick={() => handleChipClick(prompt)}
                disabled={pending}
                sx={{ cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' } }}
              />
            ))}
            {EXAMPLE_REPORTS.map((request) => (
              <Chip
                key={request}
                label={request}
                variant="outlined"
                color="primary"
                icon={<DescriptionOutlinedIcon />}
                onClick={() => handleChipClick(request)}
                disabled={pending}
                sx={{ cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' } }}
              />
            ))}
          </Stack>
          <Box sx={{ width: '100%', maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 2 }}>{status}</Box>
        </Box>
      ) : (
        <>
          <Stack spacing={2}>
            {turns.map((turn) => (
              <ConversationTurnCard
                key={turn.key}
                question={turn.question}
                answer={turn.answer}
                chartConfig={turn.chartConfig}
                report={turn.report}
                onOpenReport={() => openReportTurn(turn)}
              />
            ))}
            {status}
            <div ref={bottomRef} aria-hidden="true" />
          </Stack>
          {/* Docked: the composer stays in view while the conversation scrolls above it. */}
          <Box sx={{ position: 'sticky', bottom: 0, zIndex: 1, bgcolor: 'background.default', pt: 1.5, pb: 1 }}>
            {composer}
          </Box>
        </>
      )}

      <HistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        companyId={companyId}
        currentThreadId={threadId}
        tab={historyTab}
        onTabChange={setHistoryTab}
        onSelectThread={switchThread}
        onNewConversation={startNewConversation}
        onArchived={(id) => {
          if (id === threadId) startNewConversation();
        }}
        onOpenReport={(summary) => {
          setHistoryOpen(false);
          setPreview(summary);
        }}
      />
      <ReportPreviewDialog
        open={preview !== null}
        onClose={() => setPreview(null)}
        companyId={companyId}
        summary={preview}
      />
    </Box>
  );
}
