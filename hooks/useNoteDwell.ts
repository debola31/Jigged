'use client';

import { useCallback, useEffect, useRef } from 'react';
import { reportWriteFailure } from '@/lib/sentryEventPolicy';
import { getTypedSupabase as getSupabase } from '@/lib/supabase';

/**
 * Logs that a note was actually READ.
 *
 * The number this feeds is shown to the note's author ("4 people used this"), so
 * the governing rule is that it must never overstate. An author who sees a count
 * they can tell is wrong — in a fifteen-person shop they can simply ask — stops
 * believing the whole loop. Every decision below biases toward undercounting.
 *
 * WHAT COUNTS AS A READ
 *   - The note BODY has to be on screen. Observe the body element, never a card
 *     header and never a count badge: scrolling past a list must not mark
 *     everything in it as read.
 *   - It has to stay there for DWELL_MS. A note that flicks past during a scroll
 *     produces nothing.
 *   - The tab has to be FOCUSED. An IntersectionObserver happily reports
 *     "intersecting" for a phone in someone's pocket with the tab backgrounded;
 *     without this gate the count would climb while nobody is looking, which is
 *     precisely the overstatement that is forbidden.
 *
 * WHAT IT DOES NOT DO
 *   Nothing here decides WHO gets logged. "Never the author" and "never an
 *   account excluded from metrics" live inside log_note_views(), which is
 *   SECURITY DEFINER — the browser has no INSERT grant on note_views at all, so
 *   a client bug cannot forge or bypass those rules. Dedupe is likewise a UNIQUE
 *   constraint, not a promise made here.
 *
 * FAILURE IS SILENT TO THE OPERATOR
 *   Fire-and-forget, Sentry only. A view-write is invisible bookkeeping; it must
 *   never produce a toast, block a tap, or make a feed look broken.
 */

/** Time a note body must be continuously visible AND focused before it counts. */
const DWELL_MS = 2000;

/** Batch window, so a screenful of notes is one round trip rather than one each. */
const FLUSH_MS = 1000;

export interface NoteDwellTracker {
  /**
   * Ref callback for the element wrapping a note's BODY. Pass the note id; pass
   * the element or null on unmount.
   */
  observe: (noteId: string) => (el: HTMLElement | null) => void;
}

export function useNoteDwell(
  companyId: string,
  jobId: string | null,
  enabled = true,
): NoteDwellTracker {
  const observerRef = useRef<IntersectionObserver | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const elements = useRef(new Map<Element, string>());
  // Per mount. The DB dedupes permanently anyway; this just avoids pointless
  // round trips when React re-renders or a note scrolls in and out repeatedly.
  const logged = useRef(new Set<string>());
  const queue = useRef(new Set<string>());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // jobId is a plain dependency rather than a ref kept in sync during render:
  // mutating a ref while rendering is unsafe under concurrent rendering, and the
  // lint rule rejects it. Changing jobs tears down and rebuilds the observer,
  // which is correct — a different job is a different read context.
  const flush = useCallback(() => {
    flushTimer.current = null;
    const ids = Array.from(queue.current);
    queue.current.clear();
    if (ids.length === 0) return;

    // Never awaited into a user-visible path, and no success branch to render.
    void getSupabase()
      .rpc('log_note_views', {
        p_note_ids: ids,
        p_job_id: jobId ?? undefined,
      })
      .then(({ error }) => {
        if (error) {
          reportWriteFailure(error, { op: 'logNoteViews', area: 'note_views', level: 'warning' });
        }
      });
  }, [jobId]);

  const enqueue = useCallback(
    (noteId: string) => {
      if (logged.current.has(noteId)) return;
      logged.current.add(noteId);
      queue.current.add(noteId);
      if (flushTimer.current === null) {
        flushTimer.current = setTimeout(flush, FLUSH_MS);
      }
    },
    [flush],
  );

  const clearTimer = useCallback((noteId: string) => {
    const t = timers.current.get(noteId);
    if (t) {
      clearTimeout(t);
      timers.current.delete(noteId);
    }
  }, []);

  const startTimer = useCallback(
    (noteId: string) => {
      if (logged.current.has(noteId) || timers.current.has(noteId)) return;
      if (document.visibilityState !== 'visible') return;
      timers.current.set(
        noteId,
        setTimeout(() => {
          timers.current.delete(noteId);
          enqueue(noteId);
        }, DWELL_MS),
      );
    },
    [enqueue],
  );

  useEffect(() => {
    if (!enabled || typeof IntersectionObserver === 'undefined') return;

    // Elements are attached by their ref callbacks during commit, which happens
    // BEFORE this effect runs — so anything already registered has to be picked
    // up here. Observing only from the ref callback silently tracked nothing on
    // first render, which is the failure mode a "no views were logged" test
    // cannot distinguish from correct undercounting.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const noteId = elements.current.get(entry.target);
          if (!noteId) continue;
          if (entry.isIntersecting) startTimer(noteId);
          // Scrolled away before the dwell elapsed — it was passed, not read.
          else clearTimer(noteId);
        }
      },
      // Most of the body visible, not a sliver at the edge of the viewport.
      { threshold: 0.5 },
    );
    observerRef.current = observer;
    elements.current.forEach((_noteId, el) => observer.observe(el));

    // Captured for the cleanup closure. The Map identity never changes, so this
    // is the same object either way — but reading `timers.current` inside
    // cleanup trips react-hooks/exhaustive-deps, and the warning budget is a
    // hard build gate.
    const activeTimers = timers.current;

    // Backgrounding the tab cancels everything in flight, and returning to it
    // restarts from zero rather than crediting time spent away.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') return;
      timers.current.forEach((t) => clearTimeout(t));
      timers.current.clear();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      observer.disconnect();
      observerRef.current = null;
      activeTimers.forEach((t) => clearTimeout(t));
      activeTimers.clear();
      // Send whatever already earned its dwell; dropping it would undercount
      // reads that genuinely happened.
      if (flushTimer.current !== null) {
        clearTimeout(flushTimer.current);
        flush();
      }
    };
  }, [enabled, startTimer, clearTimer, flush]);

  const observe = useCallback(
    (noteId: string) => (el: HTMLElement | null) => {
      if (el) {
        // Register unconditionally; the effect observes whatever is registered
        // when it runs, so ref-before-effect ordering is handled either way.
        elements.current.set(el, noteId);
        observerRef.current?.observe(el);
        return;
      }
      clearTimer(noteId);
      elements.current.forEach((id, key) => {
        if (id === noteId) elements.current.delete(key);
      });
    },
    [clearTimer],
  );

  return { observe };
}
