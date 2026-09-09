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
import ConversationTurn from './ConversationTurn';
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
 * Enqueue rejections that are EXPECTED, mapped to the reason that leaves in the
 * event. These are exactly the five statuses the Sentry call below has always
 * skipped, and this map is now the single place that list lives -- so the
 * routing reads as one decision rather than a status array and a negation.
 *
 * 503 IS A REASON HERE AND NOT AN INCIDENT, deliberately. A box that is asleep
 * has no code fix, so paging on it would fill the queue with exactly the
 * non-actionable issues `ignoreErrors` in instrumentation-client.ts exists to
 * keep out -- the failure mode that left this project with 55 stale ones. What
 * was actually missing was never the alert, it was the RATE: how often a shop
 * asks and finds the box off. That is a product question, so it lands in
 * PostHog beside its siblings.
 *
 * Sentry's behaviour is UNCHANGED by this map. Anything unmapped still pages,
 * which is what keeps an unforeseen status an error rather than quietly
 * becoming a statistic.
 */
const REFUSAL_REASONS: Record<number, string> = {
  403: 'disabled',
  404: 'thread_missing',
  409: 'busy',
  429: 'rate_limited',
  503: 'offline',
};

/**
 * How long the shop waited for an answer, as a bucket.
 *
 * BUCKETED, NOT A DURATION, for the reason `elapsed_bucket` is on the operator
 * events: the product question is which band a wait fell into, and a raw
 * per-answer figure answers nothing the band does not. The scale is seconds to
 * minutes rather than the operator helper's minutes to hours, which is why this
 * is its own function and not a reuse of that one.
 */
function answerDurationBucket(createdAt: string | null | undefined): string {
  if (!createdAt) return 'unknown';
  const started = new Date(createdAt).getTime();
  if (Number.isNaN(started)) return 'unknown';
  const seconds = Math.max(0, Date.now() - started) / 1000;
  if (seconds < 5) return 'under_5s';
  if (seconds < 15) return '5s_15s';
  if (seconds < 60) return '15s_60s';
  if (seconds < 180) return '1m_3m';
  return 'over_3m';
}

/**
 * The SHAPE of a question — whether someone typed keywords or a sentence — and
 * never a word of it. The shop's questions are its business data, so the text
 * stays in `ai_jobs`; this is the most the registry allows about what was asked.
 */
function questionLengthBucket(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words < 5) return 'under_5w';
  if (words < 15) return '5w_15w';
  if (words < 40) return '15w_40w';
  return 'over_40w';
}

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
 * say WHERE the wait is, not just that there is one. A question routinely takes
 * tens of seconds and a report minutes, and which of the two this is only shows
 * on the job row when it settles (the model decides mid-job), so the last line
 * states both.
 *
 * NAMES NO HARDWARE, deliberately. Where inference runs is our deployment
 * detail; a shop owner has no use for it and no action to take on it. The
 * offline copy in useAiJob.ts is held to the same rule.
 */
const LOADING_MESSAGES = [
  'Reading your shop data…',
  'Working out the answer…',
  'Still going — a question can take up to a minute, a one-page report a few minutes.',
];

const THREAD_STORAGE_PREFIX = 'jigged.aiThread.';

/**
 * How the person got to the question they asked. Reported as two booleans rather
 * than one enum because analyticsEventsCheck reads literal property keys, and
 * because `from_example` already exists and its history stays comparable.
 */
type QuestionSource = 'typed' | 'example' | 'suggestion';

/**
 * How tall the transcript is allowed to be.
 *
 * A HEIGHT, NOT A max-height (the same trap JobActivityRail documents): with a
 * max, the pane is only as tall as its content, so it grows turn by turn and
 * pushes the composer down the page -- which is the behaviour this replaced. A
 * fixed height means the dashboard above never moves and the transcript scrolls
 * inside itself. dvh, not vh, so a phone's collapsing address bar does not
 * change it mid-conversation.
 *
 * THE CEILING IS SET BY WHAT SITS ABOVE IT, not by taste. The scorecards,
 * Recent Activity, this area's own header and the composer and its caveat come to
 * roughly 460px on a desktop viewport; at 58dvh the pane pushed the caveat past
 * the fold, so the last line of the screen was a sentence you had to scroll to
 * finish reading. 44dvh keeps the whole exchange -- newest answer, composer,
 * caveat -- on one screen at 900px and up, which is the point of giving the
 * transcript its own scrollport at all.
 */
const TRANSCRIPT_HEIGHT = { xs: 'clamp(260px, 40dvh, 420px)', md: 'clamp(300px, 44dvh, 520px)' };

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
  followUps: string[];
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
      followUps: next.follow_ups,
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
  const paneRef = useRef<HTMLDivElement | null>(null);

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
        duration_bucket: answerDurationBucket(job.job?.created_at),
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
      follow_up_count: job.result?.follow_ups?.length ?? 0,
      // How long the shop waited. On a model running on the shop's own box this
      // is the complaint that arrives before any other, and nothing recorded it.
      duration_bucket: answerDurationBucket(job.job?.created_at),
      // WHICH tools ran, not just how many. These are OUR schema — the names of
      // the queries the model chose — so unlike the question they carry nothing
      // of the customer's, and they are the closest the registry can legally get
      // to what a shop asks ABOUT. Sorted and deduped so `parts,jobs` and
      // `jobs,parts` are one breakdown value rather than two.
      tool_names: Array.from(new Set(job.result?.tool_calls ?? [])).sort(),
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

  // Keep the newest thing in view: a new turn, or the wait for one.
  //
  // SCROLLS THE PANE, NOT THE DOCUMENT. scrollIntoView() moves the nearest
  // scrolling ancestor, which used to be the window -- so every answer dragged
  // the scorecards and Recent Activity off the top of the page. The transcript
  // owns a real scrollport now, so this sets its scrollTop and the dashboard
  // above it never moves.
  useEffect(() => {
    if (!hasConversation && !pending) return;
    const pane = paneRef.current;
    if (!pane) return;
    const reduce =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // scrollTo may be absent in jsdom; scrollTop is the fallback that always works.
    if (typeof pane.scrollTo === 'function') {
      pane.scrollTo({ top: pane.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
    } else {
      pane.scrollTop = pane.scrollHeight;
    }
  }, [turns.length, pending, hasConversation]);

  const startNewConversation = () => {
    job.reset();
    setError(null);
    setAskedQuestion('');
    rememberThread(null);
    setHistoryOpen(false);
  };

  const handleSubmit = async (input?: string, source: QuestionSource = 'typed') => {
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
        from_example: source === 'example',
        from_suggestion: source === 'suggestion',
        turn_index: turns.length,
        question_length_bucket: questionLengthBucket(q),
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
      // A question REFUSED AT THE DOOR never becomes a job row, so `ai job
      // settled` cannot see it -- and until this event existed the refusal was
      // invisible in BOTH tools: this catch captured nothing, and Sentry is
      // skipped for every one of these statuses. That is how "does the shop ever
      // ask and find the box off" stayed unanswerable through the whole pilot.
      //
      // ONE LIST, TWO OUTCOMES, and it is the SAME list as before: a mapped
      // status is an expected refusal and becomes a rate in PostHog; anything
      // unmapped is still ours and still pages. Sentry's behaviour does not
      // change here -- REFUSAL_REASONS holds exactly the statuses the old
      // `[403, 404, 409, 429, 503]` array skipped, so the negation it replaced
      // is now spelled as the map's own absence.
      const refusal = status === undefined ? undefined : REFUSAL_REASONS[status];
      if (refusal) {
        posthog.capture('ai job refused', {
          feature: 'insights',
          reason: refusal,
          turn_index: turns.length,
          from_example: source === 'example',
          from_suggestion: source === 'suggestion',
          question_length_bucket: questionLengthBucket(q),
        });
      } else {
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
    handleSubmit(prompt, 'example');
  };

  const handleFollowUp = (prompt: string) => {
    setQuestion(prompt);
    handleSubmit(prompt, 'suggestion');
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
      {/* Working. aria-live so a screen reader is told the wait started and ended.
          AMBER ON THE MOVING PART ONLY. Grey text.secondary read as inert -- people
          could not tell "thinking" from "finished with nothing to say" on a wait
          that routinely runs tens of seconds. But the echoed question is not the
          signal; it is context, and colouring it too makes the whole line read as a
          warning about the question. So the question keeps text.secondary and the
          rotating status carries the colour, which is also the only part that
          changes while you watch it.

          warning.LIGHT for the text and warning.MAIN for the spinner:
          design-system.md measures #fbbf24 at 6.28:1 on this ground against
          #f59e0b's 4.89:1, and states the split as a rule -- light for text, main
          for the mark. */}
      {pending && (
        <Box role="status" aria-live="polite" sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <CircularProgress size={16} color="warning" />
          <Typography variant="body2" color="text.secondary">
            {askedQuestion ? `${askedQuestion} — ` : ''}
            <Box component="span" sx={{ color: 'warning.light' }}>
              {LOADING_MESSAGES[loadingTick % LOADING_MESSAGES.length]}
            </Box>
          </Typography>
        </Box>
      )}

      {/* Offline. severity="info", not error, and it names what still works.
          Insights being unavailable is not the user's mistake and not a fault of
          the page they are on. Distinct from the flag being off, which renders
          nothing at all. The copy names no hardware -- see useAiJob.ts. */}
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

      {/* An enqueue-time 503 is the SAME state as a mid-job outage -- insights
          are unavailable -- and gets the same quiet notice. */}
      {error && error.status === 503 && (
        <Alert severity="info" icon={<CloudOffIcon fontSize="inherit" />}>
          {error.message}
        </Alert>
      )}
      {error && error.status !== 503 && <Alert severity="error">{error.message}</Alert>}
    </>
  );

  // Said under the composer in both states. The assistant writes SQL against the
  // shop's own data and can pick the wrong reading of a business term -- which it
  // has, live -- so the surface says so rather than letting a confident sentence
  // imply otherwise.
  const disclaimer = (
    <Typography
      variant="caption"
      color="text.secondary"
      sx={{ display: 'block', textAlign: 'center', mt: 1 }}
    >
      Jigged AI can make mistakes. Please double-check responses.
    </Typography>
  );

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* Top row: the way back to everything asked before.
          NO TITLE AND NO BETA CHIP. Both were tried and both were clutter: the
          empty state's own question already says what the area is, and the caveat
          under the composer -- which is read on every turn rather than once at the
          top -- says the thing a BETA pill was standing in for. Two labels for one
          idea is one label too many on a surface this quiet.

          New conversation is CONTAINED. As a text button beside an outlined one it
          read as the lesser of the two, which is backwards: starting over is the
          thing people reach for when an answer went wrong, and it was the first
          thing missed on this screen. */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <Stack direction="row" spacing={1}>
          {hasConversation && (
            <Button
              variant="contained"
              startIcon={<AddCommentOutlinedIcon />}
              onClick={startNewConversation}
              sx={{ minHeight: 48 }}
            >
              New conversation
            </Button>
          )}
          <Button variant="outlined" startIcon={<HistoryIcon />} onClick={() => openHistory('chats')} sx={{ minHeight: 48 }}>
            Chat History
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
          <Box sx={{ width: '100%', maxWidth: 760 }}>{disclaimer}</Box>
        </Box>
      ) : (
        // A conversation owns a fixed-height column: the transcript scrolls
        // INSIDE it and the composer is a flex sibling below, so the scorecards
        // and Recent Activity above stay where the owner left them. `position:
        // sticky` is gone from the composer -- inside a real scrollport there is
        // nothing for it to stick to, which is why it never docked before.
        <Box sx={{ display: 'flex', flexDirection: 'column', height: TRANSCRIPT_HEIGHT }}>
          <Box
            ref={paneRef}
            // minHeight: 0 is load-bearing. A flex child's default min-height is
            // its content, so without this the column grows instead of scrolling.
            sx={{ flex: 1, minHeight: 0, overflowY: 'auto', pr: 1 }}
          >
            <Stack spacing={2.5}>
              {turns.map((turn, i) => (
                <ConversationTurn
                  key={turn.key}
                  question={turn.question}
                  answer={turn.answer}
                  chartConfig={turn.chartConfig}
                  report={turn.report}
                  onOpenReport={() => openReportTurn(turn)}
                  followUps={i === turns.length - 1 ? turn.followUps : []}
                  onFollowUp={handleFollowUp}
                  followUpsDisabled={pending}
                />
              ))}
              {status}
            </Stack>
          </Box>
          {/* NO bgcolor HERE. `background.default` was needed when this was
              position: sticky and rows scrolled underneath it; as a flex sibling
              below a real scrollport nothing passes behind it, and the opaque
              #111439 painted a visible rectangle over the page's gradient. */}
          <Box sx={{ pt: 1.5 }}>
            {composer}
            {disclaimer}
          </Box>
        </Box>
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
