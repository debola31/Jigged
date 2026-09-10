'use client';

import * as Sentry from '@sentry/nextjs';
import posthog from 'posthog-js';
import { useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddCommentOutlinedIcon from '@mui/icons-material/AddCommentOutlined';
import CloudOffIcon from '@mui/icons-material/CloudOff';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import HistoryIcon from '@mui/icons-material/History';
import QuestionAnswerOutlinedIcon from '@mui/icons-material/QuestionAnswerOutlined';
import SendIcon from '@mui/icons-material/Send';
import ShowChartOutlinedIcon from '@mui/icons-material/ShowChartOutlined';
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

/**
 * Three starters: one that answers in prose, one that draws a chart, one that
 * comes back as a page. Five became three on 2026-09-10 — two rows of chips in
 * two unexplained colours read as a filter bar, and the two dropped questions
 * were the weakest of the five. "Quote pipeline" in particular is the only
 * user-facing word on this screen the rest of the app never shows (the scorecard
 * says Open Quotes), it was at the centre of the "16 then 6 then 11" bug, and the
 * owner marked its answer worse than Claude's twice in the final blind read.
 *
 * EVERY STRING IS ALREADY A MEASURED KEY, which is why this carries no eval risk:
 * the first two are verbatim `pairs.json` `source_question` entries and verbatim
 * `evals/insights_ab.py` DEFAULT_QUESTIONS, and the third is a verbatim
 * `evals/route_probe.py` case. A starter that stops being a verbatim key would
 * silently break the leave-one-out retrieval control, which excludes exemplars by
 * exact string equality and would then hold nothing out.
 *
 * The late-jobs question leads for a reason beyond its answer: its number is
 * checkable against the Overdue Jobs scorecard directly above it, and the two are
 * pinned to each other by test_late_job_parity.py and __tests__/types/job.test.ts
 * reading one shared fixture. That test exists because the chat once reported 7
 * overdue where the dashboard showed 6. Nothing else on this screen buys
 * first-contact trust that cheaply.
 *
 * KEEP THIS A FLAT ARRAY OF SINGLE-QUOTED STRING LITERALS UNDER THIS NAME.
 * `api/tests/unit/test_chart_exemplar.py` regex-parses it out of this file to
 * assert no starter is the prompt's chart exemplar and that none of them mentions
 * vendors — the exemplar is a vendor-spend question, and a chip that collided with
 * it would make the echo guard drop real answers. Icons ride alongside in
 * EXAMPLE_ICONS rather than turning these into objects.
 */
const EXAMPLE_PROMPTS = [
  'How many jobs are late right now?',
  'What is my revenue trend over time?',
  'One-page report on this quarter',
];

/**
 * One icon per starter, by index — the shape of the answer each one comes back as.
 *
 * THE CHART ICON IS LICENSED BY MEASUREMENT, not by hope: `trend` is in the
 * backend's `_CHART_TYPE_KEYWORDS` so it deterministically selects an area chart,
 * and the revenue-trend question is the one the local model charted in every eval
 * run. Do not put a chart icon on a starter whose words carry no chart keyword —
 * a chart is never guaranteed (the gate drops anything under three points), and an
 * icon promising one is a promise this surface cannot keep.
 */
const EXAMPLE_ICONS = [QuestionAnswerOutlinedIcon, ShowChartOutlinedIcon, DescriptionOutlinedIcon];

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

/**
 * The wait message CLAMPS at the last line; it does not cycle.
 *
 * It used to be `LOADING_MESSAGES[tick % length]` on a four-second tick, so at
 * twelve seconds the wait said "Reading your shop data…" a second time and kept
 * circling. A report runs for minutes: someone reading the same three lines for
 * the fourth time has learned the messages are theatre rather than progress, and
 * this is the first wait a first click produces. The last line is the honest
 * terminal state — it says the thing that stays true however long this takes.
 */
function loadingMessageFor(tick: number): string {
  return LOADING_MESSAGES[Math.min(tick, LOADING_MESSAGES.length - 1)];
}

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
 * THE CEILING IS SET BY WHAT SITS ABOVE IT, not by taste, and that budget
 * CHANGED on 2026-09-10. It used to count the scorecards, Recent Activity, this
 * area's own header, the composer and its caveat at roughly 460px. Recent
 * Activity is gone and the header moved inside this column, which gives back
 * about 120px: at a 900px viewport the page above now costs 64 (app header) + 24
 * (padding) + 160 (four scorecards and their margin) = 248, and this column
 * spends a further ~184 on its toolbar, composer, caveat and gaps. That leaves
 * ~444px, so 48dvh (432px at 900) still keeps the whole exchange -- newest
 * answer, composer, caveat -- on one screen, which is the point of giving the
 * transcript its own scrollport at all.
 */
const TRANSCRIPT_HEIGHT = { xs: 'clamp(240px, 38dvh, 400px)', md: 'clamp(320px, 48dvh, 560px)' };

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

  // NAMES THE MECHANIC, not the menu. The old empty-state placeholder listed what
  // you could ask for ("…or ask for a one-page report"), which is the starters'
  // job now that one of them is a report. It also never reached a screen reader:
  // the field's aria-label wins the accessible-name computation, so that
  // vocabulary was only ever visible to sighted users, and it is now carried by a
  // control that is reachable either way.
  const placeholder = hasConversation ? 'Ask a follow-up…' : 'Type your question…';

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
              {loadingMessageFor(loadingTick)}
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

  /**
   * Said under the composer ONCE THERE IS AN ANSWER TO SAY IT ABOUT.
   *
   * It used to be read on the empty page too, which put a warning about mistakes
   * in front of someone who had not yet done anything -- the single most
   * off-putting thing on a surface a shop owner called scary. The prior reasoning
   * for keeping it in both states was that "a caveat that only appears on an empty
   * page is a caveat nobody reads"; that argument was about it PERSISTING into the
   * conversation, and it still holds. This gates on a settled turn rather than on
   * `pending`, because `pending` flips at submit and would put the warning under
   * an empty box for the whole ten-second wait -- the same warning-before-you-begin
   * reading, just later.
   *
   * THE WORDING NAMES THE FAILURE THIS SYSTEM ACTUALLY HAS. "Jigged AI can make
   * mistakes. Please double-check responses." was Anthropic's footer with the name
   * swapped: it asks for distrust and offers no way to act on it, and "please" is a
   * plea from a product whose audience is described in brand-guide.md as skeptical
   * of software that over-promises. The assistant writes SQL against the shop's own
   * data and can pick the wrong reading of a business term -- which it has, live --
   * and the owner is the authority on what "revenue" means in his shop, so naming
   * that is an audit he can perform.
   *
   * IT IS A TONE CHANGE, NOT A SAFETY ONE. A randomised trial (PubMed 40998694)
   * found "can make mistakes" warnings moved verification behaviour not at all
   * (15.3% vs 15.9%). Do not let this line be cited as a mitigation.
   */
  const disclaimer = (
    <Typography
      variant="caption"
      color="text.secondary"
      sx={{ display: 'block', textAlign: 'center', mt: 1 }}
    >
      Answers are built from your shop&apos;s data. Jigged can read a term like &ldquo;revenue&rdquo;
      differently than you do — check the numbers before you act.
    </Typography>
  );

  /**
   * What the empty page says in the slot the caveat vacated: an invitation, not a
   * boundary and not a warning.
   *
   * THE NOUNS ARE LOAD-BEARING. Each one is a sidebar label AND a subject
   * `api/tools/schema_context.py` actually describes, so the line cannot invite a
   * question the assistant has to refuse. Storage is deliberately absent -- no
   * inventory-location table is exposed, so "where is part X" cannot be answered.
   * Invoices, payments and QuickBooks are deliberately absent for the opposite
   * reason: they are on SENSITIVE_TABLES by design, and advertising them
   * manufactures the one question the product refuses on purpose.
   *
   * NO PRIVACY CLAIM. "Nothing leaves your shop" would be untrue -- the question
   * and the rows its queries return go to the model provider -- and an unprompted
   * reassurance about a risk the reader had not considered is how you introduce
   * the worry rather than settle it.
   */
  const scopeLine = (
    <Typography
      variant="caption"
      color="text.secondary"
      sx={{ display: 'block', textAlign: 'center', mt: 1 }}
    >
      Ask about your jobs, quotes, parts, customers, vendors and work centers.
    </Typography>
  );

  /**
   * The three starters, as full-width rows rather than wrapped pills.
   *
   * PILLS WERE THE PROBLEM, not the copy. An outlined neutral chip is, in this
   * app's own vocabulary, the de-emphasised OFF state (design-system.md gives
   * `default` -> outlined for "Not connected", "No subscription"), and a row of
   * them reads as a filter bar someone has switched off -- especially beside the
   * Activity page's filter chips, which look exactly like this. Full sentences
   * also wrapped into a ragged two-then-one centred block at 760px.
   *
   * ONE TREATMENT, NOT TWO. The report starter used to be `color="primary"` with
   * an icon, encoding a two-category taxonomy nobody had explained. It was also a
   * contrast bug: primary.main #4682B4 measures ~3.3:1 against the real ambient
   * backdrop, under the 4.5:1 body floor. The icon now carries the distinction and
   * the label colour is the same for all three.
   *
   * `variant="outlined"`, never `"text"` -- the theme paints text buttons
   * primary.light with a hover underline, which would make three suggestions look
   * like three links.
   */
  const starters = (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {/* Subordinate to the box above it, and that is the whole job of the word
          "Or": these are an option, not the recommended path. Sentence case
          because brand-guide.md asks for it; the uppercase TRY NEXT in the
          transcript is labelling a group inside a conversation, a different job. */}
      <Typography variant="caption" color="text.secondary">
        Or try one of these
      </Typography>
      {EXAMPLE_PROMPTS.map((prompt, i) => {
        const Icon = EXAMPLE_ICONS[i];
        return (
          <Button
            key={prompt}
            fullWidth
            variant="outlined"
            startIcon={<Icon sx={{ color: 'text.secondary' }} />}
            onClick={() => handleChipClick(prompt)}
            disabled={pending}
            sx={{
              minHeight: 48,
              justifyContent: 'flex-start',
              textAlign: 'left',
              px: 2,
              fontWeight: 400,
              // MUI's ButtonBase sets `outline: 0` and neither the theme nor
              // CssBaseline puts one back, so NO button in this app currently
              // shows a keyboard focus ring -- verified in a browser, and the same
              // gap design-system.md records for hand-rolled ButtonBase bands.
              // These three are the primary way into the feature for someone who
              // has not thought of a question yet, so they get one here rather
              // than waiting for the app-wide fix.
              // LONGHANDS, not the `outline` shorthand: measured in a browser, the
              // shorthand landed as `solid 0px` -- the style applied and the width
              // did not, so the ring was invisible while looking correct in source.
              '&:focus-visible': {
                outlineWidth: '2px',
                outlineStyle: 'solid',
                outlineColor: 'primary.light',
                outlineOffset: '2px',
              },
            }}
          >
            {prompt}
          </Button>
        );
      })}
    </Box>
  );

  return (
    /**
     * ONE COLUMN, IN EVERY STATE.
     *
     * This used to be a ternary between an empty state and a conversation state,
     * and the swap was the surface's worst moment: submitting the first question
     * replaced a calm centred box with a tall, nearly empty pane holding one
     * spinner line, and if that first question failed at enqueue the layout
     * snapped back again. A first-time user could watch the page change shape
     * twice before reading anything.
     *
     * The order is fixed -- heading, transcript, composer, footer -- and each slot
     * empties rather than moving. THE COMPOSER IS ONE DOM NODE AT ONE INDEX for
     * the life of the component: React reconciles children positionally and a
     * `{cond && ...}` slot renders `false` in place rather than collapsing, so the
     * node (and anything typed into it, and its focus) survives every transition.
     * Do not wrap a slot in a fragment that changes the child count.
     */
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <Box sx={{ width: '100%', maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {/* The way back to everything asked before, and the way to start over.
            BOTH LIVE INSIDE THE COLUMN. Chat History used to be right-aligned to
            the full content width while the composer was a 760px centred column,
            so on a wide office monitor it floated several hundred pixels clear of
            the thing it belonged to -- and further the wider the screen, on a
            surface whose whole audience is at a desktop. Aligning it to the
            composer's edge is the fix; it keeps `variant="outlined"` because
            proximity already demotes it.

            NO TITLE AND NO BETA CHIP. Both were tried and both were clutter: the
            empty state's own heading says what the area is.

            New conversation is CONTAINED. As a text button beside an outlined one
            it read as the lesser of the two, which is backwards: starting over is
            what people reach for when an answer went wrong.

            On the empty page this row is not rendered at all -- History sits under
            the starters instead, because returning to old work should never
            outrank asking something new on the screen that exists to invite it. */}
        {hasConversation && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <Stack direction="row" spacing={1}>
              <Button
                variant="contained"
                startIcon={<AddCommentOutlinedIcon />}
                onClick={startNewConversation}
                sx={{ minHeight: 48 }}
              >
                New conversation
              </Button>
              <Button variant="outlined" startIcon={<HistoryIcon />} onClick={() => openHistory('chats')} sx={{ minHeight: 48 }}>
                Chat history
              </Button>
            </Stack>
          </Box>
        )}

        {/* AN OFFER, NOT A DEMAND. "What do you want to know about the shop?" asked
            the reader to introspect and specify at the exact moment they have no
            question in mind, and said "the shop" while the chips said "my revenue".
            Every approved headline in brand-guide.md is imperative.

            DELIBERATELY SCOPED TO WHAT THIS DOES TODAY. Agentic work is planned --
            raising a quote, starting a job, turning an uploaded PO into one -- and
            a heading promising it now would earn the off-topic refusal on the first
            attempt, which is the worst possible first contact. This heading, the
            scope line and the starters are one package to revisit when the first of
            those ships.

            h4 at weight 500, not h5 at 600: bigger and calmer. Stopping at 500
            rather than 400 is deliberate -- light-on-dark halates, and this theme
            is built for 50-60 year old eyes under shop lighting. */}
        {!hasConversation && (
          <Typography variant="h4" component="h2" sx={{ fontWeight: 500, textAlign: 'center', mt: { xs: 2, md: 5 } }}>
            Ask about your shop
          </Typography>
        )}

        {/* The transcript owns a scrollport of its own so the scorecards above it
            never move when an answer lands. Only present once there is a
            conversation: while the first question is in flight the wait shows under
            the composer instead, so the hero does not vanish into a tall empty box
            for ten seconds. */}
        {hasConversation && (
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
          </Box>
        )}

        {composer}

        {/* The wait and the alerts render where the answer will: inside the
            transcript once one exists, directly under the composer before then.
            Status carries no input and no focus, so moving it between the two
            costs nothing and each position is the right one. */}
        {!hasConversation && <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{status}</Box>}

        {hasConversation ? (
          disclaimer
        ) : (
          <>
            {starters}
            <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button variant="outlined" startIcon={<HistoryIcon />} onClick={() => openHistory('chats')} sx={{ minHeight: 48 }}>
                Chat history
              </Button>
            </Box>
            {scopeLine}
          </>
        )}
      </Box>

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
