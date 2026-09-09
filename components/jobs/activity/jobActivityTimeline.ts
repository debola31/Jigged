/**
 * The job activity timeline — PURE. No React, no Supabase, no clock.
 *
 * Everything that has happened to a job, merged into one chronological list for
 * the office activity rail: notes people wrote, completions people recorded, and
 * parts moving to and from an outside vendor.
 *
 * WHY THIS IS A SEPARATE MODULE. The operator feed does the equivalent merge
 * inside a useMemo in a 950-line component (components/operator/JobFeed.tsx),
 * which is why its two-rows-per-interval rule and its dedupe are not testable on
 * their own. The movement derivation here is strictly harder — one slip fans out
 * to a send, N receipts and possibly a short-close — so it lives where it can be
 * asserted directly.
 *
 * WHAT IS DELIBERATELY ABSENT: recorded-time rows. job_operation_intervals has
 * no admin SELECT policy (20260816203641), and 20260825170421 removed the one
 * audited exception, so there is no office route to a named person's hours at
 * all. The operator feed has start/finish rows; this one cannot and should not.
 * See getJobCompletionsForOffice for the full reasoning.
 */
import type { JobNote } from '@/types/operator';
import type { JobActivityCompletion } from '@/utils/operationCompletionsAccess';
import type { OutsideShipmentWithRelations } from '@/types/outsideShipment';
import type { ShipmentWithRelations } from '@/types/shipment';
import type { QuickBooksInvoiceView } from '@/utils/quickbooksAccess';
import { roundQty } from '@/utils/outsideShipmentsAccess';

/**
 * One movement of parts to or from a vendor.
 *
 * ONE SLIP FANS OUT TO SEVERAL ROWS rather than one row that rewrites itself as
 * the slip progresses — the same call JobFeed makes for interval start/finish,
 * for the same reason: a feed is a log, and a row that changes after the fact
 * reads as the surface losing track of what happened.
 */
export type JobActivityMovement =
  | {
      kind: 'sent';
      at: string;
      shipmentId: string;
      slipNumber: string;
      jobOperationId: string;
      operationName: string;
      quantity: number;
      vendorName: string;
      /** A voided slip still happened. It renders struck through, never hidden. */
      voided: boolean;
    }
  | {
      kind: 'received';
      at: string;
      shipmentId: string;
      receiptId: string;
      slipNumber: string;
      jobOperationId: string;
      operationName: string;
      /**
       * GOOD ONLY. Receipts carry no scrap number — what a vendor lost is
       * settled by short-closing the slip, not recorded here.
       */
      quantityGood: number;
      vendorName: string;
      note: string | null;
      voided: boolean;
    }
  | {
      kind: 'short_closed';
      at: string;
      shipmentId: string;
      slipNumber: string;
      jobOperationId: string;
      operationName: string;
      /** What the close retired: sent minus what came back, never negative. */
      outstanding: number;
      vendorName: string;
    };

/**
 * A note, a completion, a movement, a document the job produced, or the job's
 * own beginning.
 *
 * SHIPMENT AND INVOICE ARE JOB-LEVEL (`jobOperationId: null`), so the step
 * filter drops them. That is correct rather than incidental: a packing slip is
 * not an answer to a question about one operation.
 *
 * Each member carries only what its row renders — never the raw row — the same
 * call `movement` makes in carrying a narrowed JobActivityMovement rather than
 * the slip it came from.
 */
export type JobActivityItem =
  | { kind: 'created'; key: string; at: string; jobOperationId: null }
  | { kind: 'note'; key: string; at: string; jobOperationId: string | null; note: JobNote }
  | {
      kind: 'completion';
      key: string;
      at: string;
      jobOperationId: string;
      completion: JobActivityCompletion;
    }
  | {
      kind: 'movement';
      key: string;
      at: string;
      jobOperationId: string;
      movement: JobActivityMovement;
    }
  | {
      kind: 'shipment';
      key: string;
      at: string;
      jobOperationId: null;
      shipmentId: string;
      packingSlipNumber: string;
      /** Pieces on this slip: the sum of its line items for this job. */
      quantity: number;
      /**
       * The business ship date, which is a DATE and may be backdated — shown
       * only when it disagrees with the day the row was recorded. See `at`
       * below for why it is not the sort key.
       */
      shipDate: string;
      shippedBy: string | null;
      /** A voided slip still happened. It renders struck through, never hidden. */
      voided: boolean;
    }
  | {
      kind: 'invoice';
      key: string;
      at: string;
      jobOperationId: null;
      invoiceLinkId: string;
      docNumber: string | null;
      /** Jigged's line total, NOT the tax-inclusive QuickBooks figure. */
      total: number;
      /** The QuickBooks deep link, null until the push comes back with one. */
      url: string | null;
      voided: boolean;
    };

/**
 * Turn slips into movement rows.
 *
 * A voided slip and its voided receipts still emit rows — the vendor was holding
 * that paperwork, and erasing it from the history would make the operation's
 * quantities unexplainable. `closed_at` emits a third row only when something
 * was actually retired; a slip closed with nothing outstanding says nothing.
 */
export function movementsFromShipments(
  shipments: OutsideShipmentWithRelations[],
): JobActivityMovement[] {
  const out: JobActivityMovement[] = [];

  for (const slip of shipments) {
    const operationName = slip.job_operation?.operation_name ?? '';
    const jobOperationId = slip.job_operation_id;
    const shared = {
      shipmentId: slip.id,
      slipNumber: slip.slip_number,
      jobOperationId,
      operationName,
      vendorName: slip.vendor_name,
    };

    out.push({
      kind: 'sent',
      at: slip.shipped_at,
      quantity: roundQty(Number(slip.quantity)),
      voided: slip.voided_at != null,
      ...shared,
    });

    const receipts = slip.receipts ?? [];
    for (const receipt of receipts) {
      out.push({
        kind: 'received',
        at: receipt.received_at,
        receiptId: receipt.id,
        quantityGood: roundQty(Number(receipt.quantity_good)),
        note: receipt.note,
        // A receipt on a voided slip is itself void in effect, even when its own
        // column is null — the send it books against never counted.
        voided: receipt.voided_at != null || slip.voided_at != null,
        ...shared,
      });
    }

    if (slip.closed_at) {
      const back = receipts
        .filter((r) => !r.voided_at)
        .reduce((n, r) => n + Number(r.quantity_good), 0);
      const outstanding = roundQty(Math.max(0, Number(slip.quantity) - back));
      if (outstanding > 0) {
        out.push({
          kind: 'short_closed',
          at: slip.closed_at,
          outstanding,
          ...shared,
        });
      }
    }
  }

  return out;
}

/** A stable key per row, so React and the sort tiebreak agree on identity. */
function movementKey(m: JobActivityMovement): string {
  if (m.kind === 'received') return `movement-received-${m.receiptId}`;
  return `movement-${m.kind}-${m.shipmentId}`;
}

export interface JobActivityInput {
  notes: JobNote[];
  completions: JobActivityCompletion[];
  /**
   * OUTSIDE / VENDOR slips, not the customer's. The two are different tables
   * and different documents (`VPS-` vs `PS-`), and this field predates the
   * other; `customerShipments` is the one that leaves the building.
   */
  shipments: OutsideShipmentWithRelations[];
  /** Packing slips sent to the customer — `shipments`, via getShipmentsForJob. */
  customerShipments: ShipmentWithRelations[];
  /**
   * Invoices this job produced. Already narrowed to `status = 'created'` by
   * getQuickBooksInvoiceLinksForJob, so a push that never landed cannot reach
   * the feed and the "when does an invoice become real" question is answered
   * upstream rather than here.
   */
  invoices: QuickBooksInvoiceView[];
  /**
   * `jobs.created_at`, which becomes the feed's oldest row.
   *
   * A JOB'S FEED IS NEVER EMPTY THIS WAY. Before it, a job nobody had touched
   * showed "Nothing has been recorded on this job yet" — true, and useless: it
   * left the reader unsure whether the feed was broken or the job was new. The
   * date also stops being a field on the details card, where it was a fact with
   * no neighbours; here it is the start of a sequence.
   *
   * Nullable because the column is. No row rather than a row reading "Invalid
   * Date" — the beginning of the timeline is not a thing to guess at.
   */
  createdAt: string | null;
}

/**
 * Merge everything into one list, newest first.
 *
 * TIEBROKEN ON KEY, not left to insertion order. Two completions recorded in the
 * same second are common — the office clears a backlog — and a comparator that
 * returned 0 for them would let the list reorder between renders even though
 * nothing changed, which reads as the page flickering.
 *
 * `shipped_at` is deliberately backdatable (20260903203741), so a send entered
 * after the fact sorts into the middle of the history rather than at the top.
 * That is correct, and it is the thing most likely to be reported as a sort bug.
 *
 * A CUSTOMER SLIP SORTS ON `created_at`, NOT `ship_date`, which is the opposite
 * call to the one above and for a reason the column forces: `ship_date` is a
 * DATE, so it resolves to midnight, and a slip cut this afternoon would sort
 * below every note written this morning. `created_at` is when Jigged recorded
 * it — the same thing the Invoices menu shows for an invoice. The ship date is
 * not lost: the row prints it whenever the two disagree.
 */
export function buildJobActivity({
  notes,
  completions,
  shipments,
  customerShipments,
  invoices,
  createdAt,
}: JobActivityInput): JobActivityItem[] {
  const items: JobActivityItem[] = [];

  if (createdAt) {
    items.push({ kind: 'created', key: 'job-created', at: createdAt, jobOperationId: null });
  }

  for (const note of notes) {
    items.push({
      kind: 'note',
      key: `note-${note.id}`,
      at: note.created_at,
      jobOperationId: note.job_operation_id ?? null,
      note,
    });
  }

  for (const completion of completions) {
    items.push({
      kind: 'completion',
      key: `completion-${completion.id}`,
      at: completion.completed_at,
      jobOperationId: completion.job_operation_id,
      completion,
    });
  }

  for (const movement of movementsFromShipments(shipments)) {
    items.push({
      kind: 'movement',
      key: movementKey(movement),
      at: movement.at,
      jobOperationId: movement.jobOperationId,
      movement,
    });
  }

  for (const slip of customerShipments) {
    items.push({
      kind: 'shipment',
      key: `shipment-${slip.id}`,
      at: slip.created_at,
      jobOperationId: null,
      shipmentId: slip.id,
      packingSlipNumber: slip.packing_slip_number,
      quantity: roundQty(
        (slip.shipment_line_items ?? []).reduce((n, li) => n + Number(li.quantity), 0),
      ),
      shipDate: slip.ship_date,
      shippedBy: slip.created_by_member?.name ?? null,
      voided: slip.voided_at != null,
    });
  }

  for (const invoice of invoices) {
    items.push({
      kind: 'invoice',
      key: `invoice-${invoice.id}`,
      at: invoice.createdAt,
      jobOperationId: null,
      invoiceLinkId: invoice.id,
      docNumber: invoice.docNumber,
      total: invoice.total,
      url: invoice.url,
      // Set by the QBO mirror (voided or deleted in QuickBooks) as well as by a
      // human void, and the row reads the same either way: it happened, and it
      // no longer counts.
      voided: invoice.voidedAt != null,
    });
  }

  return items.sort((a, b) => {
    const delta = new Date(b.at).getTime() - new Date(a.at).getTime();
    if (delta !== 0) return delta;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/**
 * Narrow the list to one step.
 *
 * JOB-LEVEL NOTES ARE EXCLUDED. The filter is reached by pressing the note count
 * on a step card, which is a question about that step; a note nobody tagged to a
 * step is not an answer to it. Clearing the filter is how you get back to
 * everything, and the rail always offers that.
 */
export function filterToOperation(
  items: JobActivityItem[],
  jobOperationId: string,
): JobActivityItem[] {
  return items.filter((item) => item.jobOperationId === jobOperationId);
}

/** How many NOTES the rail holds per step — what the step card's badge shows. */
export function noteCountsByOperation(notes: JobNote[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const note of notes) {
    if (!note.job_operation_id) continue;
    counts.set(note.job_operation_id, (counts.get(note.job_operation_id) ?? 0) + 1);
  }
  return counts;
}
