'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  AiJob,
  ChatResponse,
  chatResultOf,
  getAiJob,
  isAiWorkerAvailable,
  isInFlight,
  WORKER_STALE_AFTER_MS,
} from '@/utils/insightsAccess';

/**
 * Watch one AI job until it settles.
 *
 * THE CLIENT NEVER TRUSTS A NON-TERMINAL STATUS PAST ITS OWN DEADLINE, and never
 * stops polling silently. Both halves matter, and the second is the one that is
 * easy to leave out: a poller that reaches its wall and simply stops is a spinner
 * that never resolves.
 *
 * The deadline rules are not belt-and-braces — one of them is the ONLY thing
 * covering a serverless-killed inline job. That row sits `running`, the desktop
 * worker's sweep cannot see it (sweep_ai_jobs() is SECURITY INVOKER and the
 * worker's RLS scopes it to executor='worker'), and the person watching the
 * spinner is by definition not enqueueing anything to trigger the service-role
 * sweep. Without rule 2 that job spins until the tab closes.
 *
 * Polling rather than Realtime, deliberately: adding ai_jobs to
 * supabase_realtime would be the first ALTER PUBLICATION in this schema's history,
 * against two table comments that establish a "never add this to realtime"
 * doctrine. A SELECT on one row the user already owns costs no function
 * invocation and no AI credits. Realtime is a later decision, not a prerequisite.
 */

export type AiJobPhase = 'idle' | 'pending' | 'done' | 'failed' | 'offline';

export interface UseAiJobResult {
  phase: AiJobPhase;
  job: AiJob | null;
  result: ChatResponse | null;
  /** Human-facing sentence. Never a provider name. */
  message: string | null;
  watch: (jobId: string) => void;
  reset: () => void;
}

/** Slow the poll as a wait lengthens: snappy at first, cheap once it is clearly long. */
function intervalFor(elapsedMs: number): number {
  if (elapsedMs < 10_000) return 1_000;
  if (elapsedMs < 60_000) return 2_000;
  return 5_000;
}

/**
 * Interactive surfaces only. A batch watcher derives its wall from page_count --
 * a fixed 15 minutes loses to the 60-page fan-out cap, since 60 pages at ~30s is
 * half an hour, and the back half of a maximum-legal package would report failure
 * while sitting healthy and queued behind its siblings.
 */
export const INTERACTIVE_WALL_MS = 15 * 60_000;

const OFFLINE_COPY =
  'The AI box is offline right now — everything else on this page still works.';
const FAILED_COPY = "That didn't finish. You can ask again.";
const WALL_COPY = "That's taken longer than it should. You can ask again.";

interface Verdict {
  phase: AiJobPhase;
  message: string | null;
}

/**
 * The deadline table, as one function so it can be tested without a timer.
 *
 * `workerLive` is only consulted for rule 3, and is `null` when it has not been
 * checked -- which is most of the time, because that rule needs a worker job that
 * has been queued past one heartbeat window before it can apply.
 */
export function verdictFor(
  job: AiJob | null,
  opts: { startedAtMs: number; nowMs: number; wallMs: number; workerLive: boolean | null },
): Verdict {
  if (!job) return { phase: 'pending', message: null };

  // 1. Already terminal.
  if (job.status === 'succeeded') return { phase: 'done', message: null };
  if (job.status === 'failed' || job.status === 'timed_out') {
    return {
      phase: job.error_kind === 'ai_offline' ? 'offline' : 'failed',
      message: job.error_kind === 'ai_offline' ? OFFLINE_COPY : FAILED_COPY,
    };
  }

  const past = (iso: string | null) => !!iso && Date.parse(iso) < opts.nowMs;

  // 2. Held by someone, but the lease has gone stale. Covers a dead worker AND a
  //    platform-killed inline request -- the case nothing server-side will collect
  //    while this tab is the only thing watching.
  if (isInFlight(job) && past(job.lease_expires_at)) {
    return { phase: 'offline', message: OFFLINE_COPY };
  }

  if (job.status === 'queued') {
    // 3. WORKER ROWS ONLY. A backend job's model is a hosted one that no worker
    //    will ever advertise, so an unscoped heartbeat rule would render every
    //    inline job offline the moment it passed 60 seconds.
    if (job.executor === 'worker') {
      const settled = opts.nowMs - Date.parse(job.created_at) > WORKER_STALE_AFTER_MS;
      if (settled && opts.workerLive === false) {
        return { phase: 'offline', message: OFFLINE_COPY };
      }
    }
    // 4. Backend rows use their own clock: they are marked running within
    //    milliseconds of insert, so still queued past the deadline means the
    //    request that should have worked it died.
    if (job.executor === 'backend' && past(job.expires_at)) {
      return { phase: 'failed', message: FAILED_COPY };
    }
  }

  // 5. The wall, last. Never a silent stop.
  if (opts.nowMs - opts.startedAtMs > opts.wallMs) {
    return { phase: 'failed', message: WALL_COPY };
  }

  return { phase: 'pending', message: null };
}

const STORAGE_PREFIX = 'jigged.aiJob.';

export function useAiJob(
  storageKey: string,
  opts?: { wallMs?: number },
): UseAiJobResult {
  const wallMs = opts?.wallMs ?? INTERACTIVE_WALL_MS;
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<AiJob | null>(null);
  const [verdict, setVerdict] = useState<Verdict>({ phase: 'idle', message: null });

  const startedAt = useRef(0);
  // Only the most-recent watch may write state, so a stale response from a
  // previous question cannot clobber the current one. Same guard useLoad uses.
  const runId = useRef(0);

  const key = `${STORAGE_PREFIX}${storageKey}`;

  const reset = useCallback(() => {
    runId.current += 1;
    setJobId(null);
    setJob(null);
    setVerdict({ phase: 'idle', message: null });
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      /* private mode, or storage disabled — losing the handle is not fatal */
    }
  }, [key]);

  const watch = useCallback(
    (id: string) => {
      runId.current += 1;
      startedAt.current = Date.now();
      setJobId(id);
      setJob(null);
      setVerdict({ phase: 'pending', message: null });
      try {
        window.sessionStorage.setItem(key, JSON.stringify({ id, at: Date.now() }));
      } catch {
        /* see reset() */
      }
    },
    [key],
  );

  // Re-attach to an in-flight question after a reload. Without this an async
  // answer has nowhere to land: the old synchronous flow kept its one result in
  // component state, so navigating away lost it — and making the wait longer
  // makes that worse rather than better.
  useEffect(() => {
    let cancelled = false;
    // Deferred into a microtask rather than run in the effect body, because a
    // synchronous setState here is a cascading render (and the rule
    // hooks/useLoad.ts exists to satisfy). It also avoids a hydration mismatch:
    // sessionStorage does not exist during SSR, so reading it in a lazy state
    // initialiser would make the server and the first client render disagree.
    void Promise.resolve().then(() => {
      if (cancelled) return;
      let raw: string | null = null;
      try {
        raw = window.sessionStorage.getItem(key);
      } catch {
        return;
      }
      if (!raw) return;
      try {
        const saved = JSON.parse(raw) as { id: string; at: number };
        if (!saved?.id || Date.now() - saved.at > wallMs) {
          window.sessionStorage.removeItem(key);
          return;
        }
        runId.current += 1;
        startedAt.current = saved.at;
        setJobId(saved.id);
        setVerdict({ phase: 'pending', message: null });
      } catch {
        /* corrupt handle; ignore */
      }
    });
    return () => {
      cancelled = true;
    };
  }, [key, wallMs]);

  useEffect(() => {
    if (!jobId) return;
    const id = ++runId.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const stop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };

    const tick = async () => {
      if (stopped || id !== runId.current) return;

      // Paused while the tab is hidden: a background tab polling every second for
      // fifteen minutes is a battery cost with nobody watching the result.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        timer = setTimeout(tick, 2_000);
        return;
      }

      let next: AiJob | null = null;
      try {
        next = await getAiJob(jobId);
      } catch {
        // A dropped read is not a verdict. Keep polling; the wall is what ends it.
        timer = setTimeout(tick, intervalFor(Date.now() - startedAt.current));
        return;
      }
      if (stopped || id !== runId.current) return;

      let workerLive: boolean | null = null;
      const stale =
        next?.status === 'queued' &&
        next.executor === 'worker' &&
        Date.now() - Date.parse(next.created_at) > WORKER_STALE_AFTER_MS;
      if (stale) {
        // Only asked when rule 3's other conditions already hold, so the common
        // path is one query per tick rather than two.
        workerLive = await isAiWorkerAvailable(next!.model).catch(() => null);
        if (stopped || id !== runId.current) return;
      }

      const v = verdictFor(next, {
        startedAtMs: startedAt.current,
        nowMs: Date.now(),
        wallMs,
        workerLive,
      });
      setJob(next);
      setVerdict(v);

      if (v.phase === 'pending') {
        timer = setTimeout(tick, intervalFor(Date.now() - startedAt.current));
        return;
      }
      try {
        window.sessionStorage.removeItem(key);
      } catch {
        /* see reset() */
      }
    };

    void tick();
    return stop;
  }, [jobId, key, wallMs]);

  return {
    phase: verdict.phase,
    job,
    result: verdict.phase === 'done' ? chatResultOf(job) : null,
    message: verdict.message,
    watch,
    reset,
  };
}

