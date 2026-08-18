'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLoad } from '@/hooks/useLoad';
import type { ReactNode } from 'react';
import { useParams } from 'next/navigation';
import posthog from 'posthog-js';
import {
  closeOperationInterval,
  getMyOpenIntervals,
  startOperationInterval,
} from '@/utils/operationIntervalsAccess';
import type { IntervalAdjustment, OperationIntervalWithContext } from '@/types/operationInterval';

/**
 * The operator's open intervals, shared by the header strip and the step screen.
 *
 * A CONTEXT AND NOT PER-PAGE STATE because two surfaces have to agree: the strip
 * renders on every screen so the running fact is never invisible, and the step
 * screen needs the same row to decide whether it shows START or the running
 * card. Two independent fetches would disagree for a paint after every action,
 * which on this surface reads as the timer losing track.
 *
 * `openIntervals` IS A LIST, not one row. One operator legitimately holds several
 * — three spindles is a normal Tuesday — because the chain is per work centre,
 * not per person.
 */
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
  close: (intervalId: string, adjustment?: IntervalAdjustment) => Promise<void>;
  refresh: () => Promise<void>;
}

const IntervalContext = createContext<IntervalContextValue>({
  openIntervals: [],
  serverSkewMs: 0,
  loading: true,
  intervalFor: () => null,
  start: async () => {},
  close: async () => {},
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
   * strip simply does not render and the next action reloads it. The `.from()`
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
    async (intervalId: string, adjustment: IntervalAdjustment = {}) => {
      await closeOperationInterval(intervalId, adjustment);
      posthog.capture('time interval closed', {
        was_adjusted: Boolean(adjustment.adjustedStartedAt || adjustment.adjustedEndedAt),
      });
      await refresh();
    },
    [refresh],
  );

  const intervalFor = useCallback(
    (jobOperationId: string) =>
      openIntervals.find((i) => i.job_operation_id === jobOperationId) ?? null,
    [openIntervals],
  );

  return (
    <IntervalContext.Provider
      value={{ openIntervals, serverSkewMs, loading, intervalFor, start, close, refresh }}
    >
      {children}
    </IntervalContext.Provider>
  );
}
