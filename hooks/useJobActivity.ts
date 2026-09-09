'use client';

import { useCallback, useMemo } from 'react';

import { useLoad } from '@/hooks/useLoad';
import { getJobNotes } from '@/utils/operatorAccess';
import { getJobCompletionsForOffice } from '@/utils/operationCompletionsAccess';
import { getOutsideShipmentsForJob } from '@/utils/outsideShipmentsAccess';
import { getShipmentsForJob } from '@/utils/shipmentsAccess';
import { getQuickBooksInvoiceLinksForJob } from '@/utils/quickbooksAccess';
import type { JobNote } from '@/types/operator';
import type { JobActivityCompletion } from '@/utils/operationCompletionsAccess';
import type { OutsideShipmentWithRelations } from '@/types/outsideShipment';
import type { ShipmentWithRelations } from '@/types/shipment';
import type { QuickBooksInvoiceView } from '@/utils/quickbooksAccess';
import {
  buildJobActivity,
  noteCountsByOperation,
  type JobActivityItem,
} from '@/components/jobs/activity/jobActivityTimeline';

/** Stable empties so a null load result does not rebuild the timeline every render. */
const NO_NOTES: JobNote[] = [];
const NO_COMPLETIONS: JobActivityCompletion[] = [];
const NO_SHIPMENTS: OutsideShipmentWithRelations[] = [];
const NO_CUSTOMER_SHIPMENTS: ShipmentWithRelations[] = [];
const NO_INVOICES: QuickBooksInvoiceView[] = [];

export interface UseJobActivityResult {
  /** Everything that has happened to this job, newest first. */
  items: JobActivityItem[];
  /** Note count per step — what a step card's badge shows. */
  noteCounts: Map<string, number>;
  /** True until the first load of all five sources settles. */
  loading: boolean;
  error: unknown;
  /**
   * Re-read all five WITHOUT blanking the rail (`refresh`, not `reload`).
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
 * FIVE READS, NOT ONE, and deliberately so: notes, completions, outside slips,
 * customer packing slips and invoices live in five tables with five different
 * visibility rules, and the merge that joins them is pure
 * (jobActivityTimeline.ts) precisely so it can be tested without any of them.
 *
 * THE LAST TWO ARE READ TWICE PER PAGE, here and inside ShipmentsMenu /
 * InvoicesMenu, and that is a knowing trade rather than an oversight. Feeding
 * both menus from here instead would mean rewriting InvoicesMenu's
 * load-and-reconcile plumbing — it re-reads itself after asking the backend to
 * refresh the QuickBooks payment mirror — for a saving of two round trips on a
 * page that already makes several. Worth doing the day that cost shows up;
 * not worth coupling the rail to the toolbar for.
 *
 * MOUNTED ONCE, IN THE PAGE — never inside the rail. The rail renders in two
 * branches (a docked column above `lg`, an overlay drawer below) and both are in
 * the DOM at once as CSS-hidden siblings, so a hook living inside it would fetch
 * everything twice on every load.
 *
 * `getJobCompletionsForOffice` is the OFFICE reader and must stay that way; see
 * its docblock for the guardrail that separates it from the operator one.
 */
export function useJobActivity(
  companyId: string,
  jobId: string,
  /** `jobs.created_at` — the feed's oldest row, so a new job's feed is not empty. */
  createdAt: string | null,
): UseJobActivityResult {
  const notesLoad = useLoad(() => getJobNotes(jobId, companyId), [jobId, companyId]);
  const completionsLoad = useLoad(
    () => getJobCompletionsForOffice(companyId, jobId),
    [companyId, jobId],
  );
  const shipmentsLoad = useLoad(() => getOutsideShipmentsForJob(jobId), [jobId]);
  const customerShipmentsLoad = useLoad(() => getShipmentsForJob(jobId), [jobId]);
  const invoicesLoad = useLoad(
    () => getQuickBooksInvoiceLinksForJob(companyId, jobId),
    [companyId, jobId],
  );

  const notes = notesLoad.data ?? NO_NOTES;
  const completions = completionsLoad.data ?? NO_COMPLETIONS;
  const shipments = shipmentsLoad.data ?? NO_SHIPMENTS;
  const customerShipments = customerShipmentsLoad.data ?? NO_CUSTOMER_SHIPMENTS;
  const invoices = invoicesLoad.data ?? NO_INVOICES;

  const items = useMemo(
    () =>
      buildJobActivity({
        notes,
        completions,
        shipments,
        customerShipments,
        invoices,
        createdAt,
      }),
    [notes, completions, shipments, customerShipments, invoices, createdAt],
  );
  const noteCounts = useMemo(() => noteCountsByOperation(notes), [notes]);

  const { refresh: refreshNotes } = notesLoad;
  const { refresh: refreshCompletions } = completionsLoad;
  const { refresh: refreshShipments } = shipmentsLoad;
  const { refresh: refreshCustomerShipments } = customerShipmentsLoad;
  const { refresh: refreshInvoices } = invoicesLoad;

  const reload = useCallback(async () => {
    await Promise.all([
      refreshNotes(),
      refreshCompletions(),
      refreshShipments(),
      refreshCustomerShipments(),
      refreshInvoices(),
    ]);
  }, [
    refreshNotes,
    refreshCompletions,
    refreshShipments,
    refreshCustomerShipments,
    refreshInvoices,
  ]);

  return {
    items,
    noteCounts,
    loading:
      notesLoad.loading ||
      completionsLoad.loading ||
      shipmentsLoad.loading ||
      customerShipmentsLoad.loading ||
      invoicesLoad.loading,
    // First error wins. The rail shows one retryable message rather than five;
    // a partial rail that silently omits a whole row kind is the worse failure.
    error:
      notesLoad.error ??
      completionsLoad.error ??
      shipmentsLoad.error ??
      customerShipmentsLoad.error ??
      invoicesLoad.error,
    reload,
  };
}
