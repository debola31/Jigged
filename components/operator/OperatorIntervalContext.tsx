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
  startOperationInterval,
} from '@/utils/operationIntervalsAccess';
import type { IntervalAdjustment, OperationIntervalWithContext } from '@/types/operationInterval';

/**
 * The operator's open intervals.
 *
 * CORRECTED 2026-08-26. This docblock used to say the context existed "because two
 * surfaces have to agree: the strip renders on every screen…". There is no strip
 * — it was withdrawn 2026-08-17, and `useIntervalContext` has exactly ONE consumer,
 * the step screen. The stale claim mattered: it described a shared-state problem
 * that no longer exists, and a reader trusting it would look for a second consumer
 * that is not there.
 *
 * IT REMAINS A CONTEXT, for the reason that outlived the strip: the list is a
 * cross-cutting fact about the operator rather than about the step being viewed —
 * one operator legitimately holds several open intervals, on steps they are not
 * currently looking at — and the request-id guard plus the visibility refresh below
 * are worth owning once rather than re-deriving per mount.
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
   * `server_now − Date.now()` from the last start. Elapsed time must be rendered
   * as `(Date.now() + serverSkewMs) − started_at`, never from a tick count: a
   * backgrounded mobile tab is throttled or suspended, so a counter comes back
   * short by however long the phone was in a pocket.
   */
  serverSkewMs: number;
  loading: boolean;
  /** The open interval on this operation, if the operator has one. */
  intervalFor: (jobOperationId: string) => OperationIntervalWithContext | null;
  start: (jobOperationId: string) => Promise<void>;
  close: (intervalId: string, completionId?: string | null, adjustment?: IntervalAdjustment) => Promise<void>;
  /** Discard a running interval outright — see `cancelOperationInterval`. */
  cancel: (intervalId: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const IntervalContext = createContext<IntervalContextValue>({
  openIntervals: [],
  serverSkewMs: 0,
  loading: true,
  intervalFor: () => null,
  start: async () => {},
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
   * A failed read is swallowed: it must not break every operator screen. The step
   * screen simply shows START, and the next action reloads the list. The `.from()`
   * read has already reported itself through the Supabase integration.
   */
  const {
    data,
    loading,
    reload: refresh,
  } = useLoad(() => getMyOpenIntervals(companyId), [companyId]);

  // Memoised: `data ?? []` allocates a new array every render, which would make
  // the `intervalFor` callback below change identity on every render and defeat
  // its memoisation in every consumer.
  const openIntervals = useMemo(() => data ?? [], [data]);

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

  const intervalFor = useCallback(
    (jobOperationId: string) =>
      openIntervals.find((i) => i.job_operation_id === jobOperationId) ?? null,
    [openIntervals],
  );

  return (
    <IntervalContext.Provider
      value={{ openIntervals, serverSkewMs, loading, intervalFor, start, close, cancel, refresh }}
    >
      {children}
    </IntervalContext.Provider>
  );
}
