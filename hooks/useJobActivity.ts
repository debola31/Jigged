'use client';

import { useCallback, useMemo } from 'react';

import { useLoad } from '@/hooks/useLoad';
import { getJobNotes } from '@/utils/operatorAccess';
import { getJobCompletionsForOffice } from '@/utils/operationCompletionsAccess';
import { getOutsideShipmentsForJob } from '@/utils/outsideShipmentsAccess';
import type { JobNote } from '@/types/operator';
import type { JobActivityCompletion } from '@/utils/operationCompletionsAccess';
import type { OutsideShipmentWithRelations } from '@/types/outsideShipment';
import {
  buildJobActivity,
  noteCountsByOperation,
  type JobActivityItem,
} from '@/components/jobs/activity/jobActivityTimeline';

/** Stable empties so a null load result does not rebuild the timeline every render. */
const NO_NOTES: JobNote[] = [];
const NO_COMPLETIONS: JobActivityCompletion[] = [];
const NO_SHIPMENTS: OutsideShipmentWithRelations[] = [];

export interface UseJobActivityResult {
  /** Everything that has happened to this job, newest first. */
  items: JobActivityItem[];
  /** Note count per step — what a step card's badge shows. */
  noteCounts: Map<string, number>;
  /** True until the first load of all three sources settles. */
  loading: boolean;
  error: unknown;
  /**
   * Re-read all three WITHOUT blanking the rail (`refresh`, not `reload`).
   *
   * This is the callback both halves of the job page share: a completion
   * recorded on a step card and a void performed in the rail each change what
   * the other is showing, and the page passes ONE of these down so the two
   * cannot disagree about whether a step is done.
   */
  reload: () => Promise<void>;
}

/**
 * The office activity rail's data.
 *
 * THREE READS, NOT ONE, and deliberately so: notes, completions and outside
 * slips live in three tables with three different visibility rules, and the
 * merge that joins them is pure (jobActivityTimeline.ts) precisely so it can be
 * tested without any of them.
 *
 * MOUNTED ONCE, IN THE PAGE — never inside the rail. The rail renders in two
 * branches (a docked column above `lg`, an overlay drawer below) and both are in
 * the DOM at once as CSS-hidden siblings, so a hook living inside it would fetch
 * everything twice on every load.
 *
 * `getJobCompletionsForOffice` is the OFFICE reader and must stay that way; see
 * its docblock for the guardrail that separates it from the operator one.
 */
export function useJobActivity(companyId: string, jobId: string): UseJobActivityResult {
  const notesLoad = useLoad(() => getJobNotes(jobId, companyId), [jobId, companyId]);
  const completionsLoad = useLoad(
    () => getJobCompletionsForOffice(companyId, jobId),
    [companyId, jobId],
  );
  const shipmentsLoad = useLoad(() => getOutsideShipmentsForJob(jobId), [jobId]);

  const notes = notesLoad.data ?? NO_NOTES;
  const completions = completionsLoad.data ?? NO_COMPLETIONS;
  const shipments = shipmentsLoad.data ?? NO_SHIPMENTS;

  const items = useMemo(
    () => buildJobActivity({ notes, completions, shipments }),
    [notes, completions, shipments],
  );
  const noteCounts = useMemo(() => noteCountsByOperation(notes), [notes]);

  const { refresh: refreshNotes } = notesLoad;
  const { refresh: refreshCompletions } = completionsLoad;
  const { refresh: refreshShipments } = shipmentsLoad;

  const reload = useCallback(async () => {
    await Promise.all([refreshNotes(), refreshCompletions(), refreshShipments()]);
  }, [refreshNotes, refreshCompletions, refreshShipments]);

  return {
    items,
    noteCounts,
    loading: notesLoad.loading || completionsLoad.loading || shipmentsLoad.loading,
    // First error wins. The rail shows one retryable message rather than three;
    // a partial rail that silently omits a whole row kind is the worse failure.
    error: notesLoad.error ?? completionsLoad.error ?? shipmentsLoad.error,
    reload,
  };
}
