'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLoad } from '@/hooks/useLoad';
import { elapsedMs } from '@/lib/duration';
import type { ReactNode } from 'react';
import { useParams } from 'next/navigation';
import posthog from 'posthog-js';
import {
  cancelOperationInterval,
  closeOperationInterval,
  getMyOpenIntervals,
  getMyPausedOperations,
  pauseOperationInterval,
  startOperationInterval,
} from '@/utils/operationIntervalsAccess';
import type {
  IntervalAdjustment,
  MyPausedOperation,
  OperationIntervalWithContext,
} from '@/types/operationInterval';

/**
 * The operator's open intervals.
 *
 * TWO CONSUMERS AGAIN since 2026-09-07: the step screen, and RunningNowPanel on
 * the jobs list. A note for whoever reads the history — the 2026-08-26 correction
 * here said there was exactly ONE consumer because the header strip had been
 * withdrawn, and that was true when written. The panel is NOT that strip back: the
 * strip lived in the shell and duplicated a single step screen's own clock, where
 * this renders on ONE page and answers a question the step screen structurally
 * cannot — "what else am I holding?" — which only has an answer because the chain
 * keys on the work centre. The half of the withdrawal that stands is that no
 * step-level CONTROL may leave the step screen, and an E2E assertion still watches
 * for that.
 *
 * IT REMAINS A CONTEXT for the reason that outlived the strip and now has a second:
 * the lists are a cross-cutting fact about the operator rather than about the step
 * being viewed — one operator legitimately holds several open intervals, on steps
 * they are not currently looking at — and the request-id guard plus the visibility
 * refresh below are worth owning once rather than re-deriving per mount.
 *
 * `openIntervals` IS A LIST, not one row. One operator legitimately holds several
 * — three spindles is a normal Tuesday — because the chain is per work centre,
 * not per person.
 */
/**
 * Coarse buckets for how long a cancelled interval had been running.
 *
 * Deliberately coarse and deliberately not a number: this distinguishes "tapped
 * START on the wrong step" from "walked away and left it running", which is the
 * only thing the answer changes. Anything finer starts describing the person.
 */
function bucketElapsed(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 1) return 'under_1m';
  if (minutes < 15) return '1m_15m';
  if (minutes < 60) return '15m_1h';
  if (minutes < 360) return '1h_6h';
  return 'over_6h';
}

interface IntervalContextValue {
  openIntervals: OperationIntervalWithContext[];
  /**
   * Steps the operator paused and has not resumed.
   *
   * A SEPARATE LIST rather than a flag on `openIntervals`, because a paused span
   * is closed — it holds no work centre, contributes a finished duration, and is
   * not something the elapsed clock should tick on. Merging them would need every
   * consumer to branch anyway, and the one that forgot would render a running
   * clock on work that stopped hours ago.
   */
  pausedOperations: MyPausedOperation[];
  /**
   * `server_now − Date.now()` from the last start. Elapsed time must be rendered
   * as `(Date.now() + serverSkewMs) − started_at`, never from a tick count: a
   * backgrounded mobile tab is throttled or suspended, so a counter comes back
   * short by however long the phone was in a pocket.
   */
  serverSkewMs: number;
  loading: boolean;
  /** The open interval on this operation, if the operator has one. */
  intervalFor: (jobOperationId: string) => OperationIntervalWithContext | null;
  /** The operator's unresumed pause on this operation, if there is one. */
  pausedFor: (jobOperationId: string) => MyPausedOperation | null;
  start: (jobOperationId: string) => Promise<void>;
  /**
   * Pick a paused step back up. Deliberately `start_operation_interval` under the
   * hood — a new span, not a reopened one — with its own capture so the funnel can
   * tell a resume from a cold start.
   */
  resume: (jobOperationId: string) => Promise<void>;
  /** Close a running span as paused, keeping its minutes. */
  pause: (intervalId: string) => Promise<void>;
  close: (intervalId: string, completionId?: string | null, adjustment?: IntervalAdjustment) => Promise<void>;
  /** Discard a running interval outright — see `cancelOperationInterval`. */
  cancel: (intervalId: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const IntervalContext = createContext<IntervalContextValue>({
  openIntervals: [],
  pausedOperations: [],
  serverSkewMs: 0,
  loading: true,
  intervalFor: () => null,
  pausedFor: () => null,
  start: async () => {},
  resume: async () => {},
  pause: async () => {},
  close: async () => {},
  cancel: async () => {},
  refresh: async () => {},
});

export function useIntervalContext() {
  return useContext(IntervalContext);
}

export function OperatorIntervalProvider({ children }: { children: ReactNode }) {
  const params = useParams();
  const companyId = params.companyId as string;

  const [serverSkewMs, setServerSkewMs] = useState(0);

  /**
   * `useLoad` rather than a hand-rolled fetch effect, for two reasons beyond
   * house style: it keeps every `setState` inside the async callback (so this
   * does not trip `react-hooks/set-state-in-effect`), and its request-id guard
   * drops a stale in-flight response — which matters here because starting and
   * closing both refresh, and on cellular those can easily land out of order.
   *
   * A failed read is swallowed: it must not break every operator screen. The
   * `.from()` read has already reported itself through the Supabase integration.
   *
   * THE COST IS NOT SYMMETRIC and both halves are worth naming. A failed OPEN read
   * leaves the step screen showing START on a step that is running, and tapping it
   * chain-closes the old span as `switched` — a real span, correctly ended, so the
   * data survives. A failed PAUSED read leaves it showing START on a step you
   * paused; tapping that opens a second span, which is also what RESUME does. So
   * the worst case on either side is a mislabelled button and a correct write, and
   * the next action reloads both lists.
   */
  const {
    data,
    loading: openLoading,
    reload: refreshOpen,
  } = useLoad(() => getMyOpenIntervals(companyId), [companyId]);

  /**
   * A SECOND load rather than one call returning both, and the reason is the
   * failure mode rather than tidiness: these have different blast radii. A failed
   * open-interval read leaves the step screen showing START on a step that is
   * running, which the next action corrects. A failed paused read costs a list
   * entry. Merging them makes the cheap failure take out the expensive one.
   */
  const { data: pausedData, loading: pausedLoading, reload: refreshPaused } = useLoad(
    () => getMyPausedOperations(companyId),
    [companyId],
  );

  /**
   * TRUE UNTIL BOTH HAVE SETTLED, and the paused half is the one that matters.
   *
   * `primaryAction` on the step screen reads `pausedFor()`, which is empty while
   * that load is in flight — so on a cold load straight to a step URL (the printed
   * per-operation QR lands exactly there) the button would render START THIS STEP
   * and then swap to RESUME THIS STEP. Harmless for data, since both write the
   * same thing, but it is precisely the "the app has forgotten what I was doing"
   * impression the RESUME label exists to prevent. Consumers hold the button busy
   * on this instead.
   */
  const loading = openLoading || pausedLoading;

  // Memoised: `data ?? []` allocates a new array every render, which would make
  // the `intervalFor` callback below change identity on every render and defeat
  // its memoisation in every consumer.
  const openIntervals = useMemo(() => data ?? [], [data]);
  const pausedOperations = useMemo(() => pausedData ?? [], [pausedData]);

  /**
   * Both lists move together on every write — pausing removes an open interval AND
   * adds a paused one, resuming does the reverse — so no caller should have to
   * remember to refresh the other half.
   */
  const refresh = useCallback(async () => {
    await Promise.all([refreshOpen(), refreshPaused()]);
  }, [refreshOpen, refreshPaused]);

  /**
   * Re-read when the tab comes back to the foreground.
   *
   * Not cosmetic: the chain means someone ELSE can close your interval by
   * starting on the same machine, so a phone that has been in a pocket may be
   * showing a timer that stopped an hour ago. `visibilitychange` on the document
   * is the reliable half of the pair; `pagehide` is for teardown and there is
   * nothing to tear down here.
   */
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  const start = useCallback(
    async (jobOperationId: string) => {
      const running = await startOperationInterval(jobOperationId);
      setServerSkewMs(running.serverSkewMs);
      posthog.capture('time interval started', {
        had_open_interval: openIntervals.length > 0,
      });
      await refresh();
    },
    [refresh, openIntervals.length],
  );

  const close = useCallback(
    async (
      intervalId: string,
      completionId: string | null = null,
      adjustment: IntervalAdjustment = {},
    ) => {
      await closeOperationInterval(intervalId, completionId, adjustment);
      posthog.capture('time interval closed', {
        was_adjusted: Boolean(adjustment.adjustedStartedAt || adjustment.adjustedEndedAt),
      });
      await refresh();
    },
    [refresh],
  );

  /**
   * Discard a running interval. See `cancelOperationInterval` for why it voids
   * rather than closes.
   *
   * `elapsed_bucket` AND NOT AN ELAPSED FIGURE. The product question is whether
   * these are forgotten timers or fat-finger mistakes, and a bucket answers it. A
   * raw per-person duration in PostHog is the thing the surveillance guardrail is
   * about (docs/modules/operator-view.md#surveillance-guardrail-non-negotiable),
   * and it would answer no question a bucket does not.
   *
   * Read from `openIntervals` BEFORE the await: after it resolves the row is gone
   * from the list, so computing the bucket afterwards would silently always
   * produce the same value.
   */
  const cancel = useCallback(
    async (intervalId: string) => {
      const row = openIntervals.find((i) => i.id === intervalId);
      const elapsedBucket = row ? bucketElapsed(elapsedMs(row.effective_started_at)) : 'unknown';

      await cancelOperationInterval(intervalId);
      posthog.capture('time interval cancelled', {
        elapsed_bucket: elapsedBucket,
      });
      await refresh();
    },
    [refresh, openIntervals],
  );

  /**
   * Close a running span as paused.
   *
   * `elapsed_bucket` AND NOT AN ELAPSED FIGURE, for the reason spelled out on
   * `cancel` below: the product question is whether pauses are short breaks or
   * end-of-shift, and a coarse bucket answers it. A raw per-person duration in
   * PostHog is the thing the surveillance guardrail is about.
   *
   * Read from `openIntervals` BEFORE the await, because after it resolves the row
   * has moved to the paused list and the bucket would be computed from nothing.
   */
  const pause = useCallback(
    async (intervalId: string) => {
      const row = openIntervals.find((i) => i.id === intervalId);
      const elapsedBucket = row ? bucketElapsed(elapsedMs(row.effective_started_at)) : 'unknown';

      await pauseOperationInterval(intervalId);
      posthog.capture('time interval paused', {
        elapsed_bucket: elapsedBucket,
      });
      await refresh();
    },
    [refresh, openIntervals],
  );

  /**
   * Pick a paused step back up.
   *
   * Calls `startOperationInterval`, exactly like `start` — resume IS a start, on a
   * step that already has spans. It is a separate function here only so the funnel
   * can tell the two apart, and so `paused_bucket` can be read before the row
   * leaves the list. `had_open_interval` is not captured: it belongs to the
   * question `start` exists to answer, and repeating it here would double-count.
   */
  const resume = useCallback(
    async (jobOperationId: string) => {
      const row = pausedOperations.find((pausedRow) => pausedRow.job_operation_id === jobOperationId);
      const pausedBucket = row ? bucketElapsed(elapsedMs(row.paused_at)) : 'unknown';

      const running = await startOperationInterval(jobOperationId);
      setServerSkewMs(running.serverSkewMs);
      posthog.capture('time interval resumed', {
        paused_bucket: pausedBucket,
      });
      await refresh();
    },
    [refresh, pausedOperations],
  );

  const intervalFor = useCallback(
    (jobOperationId: string) =>
      openIntervals.find((i) => i.job_operation_id === jobOperationId) ?? null,
    [openIntervals],
  );

  const pausedFor = useCallback(
    (jobOperationId: string) =>
      pausedOperations.find((row) => row.job_operation_id === jobOperationId) ?? null,
    [pausedOperations],
  );

  return (
    <IntervalContext.Provider
      value={{
        openIntervals,
        pausedOperations,
        serverSkewMs,
        loading,
        intervalFor,
        pausedFor,
        start,
        resume,
        pause,
        close,
        cancel,
        refresh,
      }}
    >
      {children}
    </IntervalContext.Provider>
  );
}
