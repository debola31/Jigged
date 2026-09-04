import type { StatusChipColor } from '@/components/common/StatusChip';

/**
 * How to render what QuickBooks Online last said about one invoice.
 *
 * Pure and clock-free: every date decision comes from the `todayISO` argument, so
 * the same input always produces the same output and the whole table below is
 * testable without freezing a clock. Nothing here touches Supabase or React —
 * `StatusChipColor` is a type-only import (erased at compile time) so the caller
 * gets exactly the shape <StatusChip> wants and does no branching of its own.
 *
 * The mirror this reads is described in
 * supabase/migrations/20260903203624_qbo_invoice_payment_mirror.sql. It is a
 * cached answer, never a live one — which is why every line ends up carrying the
 * date it was true on.
 */

/** The five words QuickBooks Online's answer is reduced to, matching the
 *  `quickbooks_invoice_links_qb_status_check` CHECK constraint exactly. The
 *  backend derives them; nothing in the browser may invent a sixth. */
export const QB_INVOICE_STATUSES = ['paid', 'partial', 'open', 'voided', 'missing'] as const;
export type QuickBooksInvoiceStatus = (typeof QB_INVOICE_STATUSES)[number];

/**
 * Widen the `qb_status` column back to its union at the read boundary.
 *
 * The column is enum-via-CHECK rather than a Postgres enum type, so the generated
 * `types/database.ts` types it as plain `string`. Done explicitly rather than with
 * `as`, because a cast would compile just as happily on a column that had drifted.
 *
 * `quickbooks_invoice_links_qb_status_check` makes any other value unreachable, so
 * the last branch exists only to be honest about the type. It resolves to 'open'
 * deliberately: if the impossible ever happened, showing money as still owed is
 * the harmless error — telling a shop owner an invoice is PAID when we do not
 * actually know is the one wrong answer that costs them.
 */
export function toInvoiceStatus(
  value: string | null | undefined,
): QuickBooksInvoiceStatus | null {
  if (value == null) return null;
  return (QB_INVOICE_STATUSES as readonly string[]).includes(value)
    ? (value as QuickBooksInvoiceStatus)
    : 'open';
}

/**
 * The mirror fields this module reads. `QuickBooksInvoiceView` satisfies it
 * structurally, which is how this file stays free of any import from the access
 * layer (and therefore of the Supabase client).
 */
export interface InvoicePaymentFacts {
  provider: 'qbo' | 'qbd';
  qbStatus: QuickBooksInvoiceStatus | null;
  qbTotalAmt: number | null;
  qbBalance: number | null;
  /** `YYYY-MM-DD` as QuickBooks computed it from the terms, or null when it
   *  reported none. */
  qbDueDate: string | null;
  /** Timestamptz ISO string. Null means Intuit has never answered for this row —
   *  a state with no backfill, since only a successful read can produce one. */
  qbStatusCheckedAt: string | null;
}

/** What the Invoices menu should draw for one invoice. Both fields null means
 *  "say nothing here" — the only such case is QuickBooks Desktop, which the menu
 *  already explains with its own caption. */
export interface InvoicePaymentDisplay {
  chip: { label: string; color: StatusChipColor } | null;
  secondary: string | null;
}

/**
 * Decide the chip and the one-line explanation for an invoice.
 *
 * `todayISO` is the shop's local date as `YYYY-MM-DD` (utils/quickbooksAccess →
 * `localDateISO()`), compared LEXICOGRAPHICALLY against `qbDueDate`. Both are
 * plain calendar dates and string order is date order for ISO, so this needs no
 * Date at all. `new Date('2026-09-30')` would parse as UTC midnight and read as
 * the 29th anywhere west of Greenwich — an invoice would show as overdue a day
 * early for every shop in the US.
 */
export function invoicePaymentDisplay(
  view: InvoicePaymentFacts,
  todayISO: string,
): InvoicePaymentDisplay {
  // Desktop is push-only: there is no API to read a balance back from, so a chip
  // here could only ever say "unknown". The menu's existing Desktop caption is the
  // honest answer and this adds nothing to it.
  if (view.provider === 'qbd') return { chip: null, secondary: null };

  const asOf = formatCheckedAt(view.qbStatusCheckedAt);
  // "Never checked" is a real state, not a missing one, and it is deliberately NOT
  // a chip: a blank chip slot invites the reader to assume nothing is owed, so the
  // line says it in words instead. The `!asOf` half is unreachable in the database
  // — quickbooks_invoice_links_qb_status_checked_consistent ties the status and the
  // timestamp together — and exists so no branch below can ever print "as of "
  // with nothing after it.
  if (view.qbStatus === null || !asOf) {
    return { chip: null, secondary: 'Payment status not checked yet' };
  }

  switch (view.qbStatus) {
    case 'paid':
      return { chip: { label: 'Paid', color: 'success' }, secondary: `Paid · as of ${asOf}` };

    case 'voided':
      // The mirror stamped voided_at, which fired the recompute trigger and put the
      // quantities back on the table. Saying so is the point: the shop owner's next
      // question after "it's voided" is "so can I bill it again".
      return {
        chip: { label: 'Voided in QuickBooks', color: 'default' },
        secondary: `Quantities reopened for invoicing · as of ${asOf}`,
      };

    case 'missing':
      // Error, not warning: someone deleted a document Jigged issued, and unlike a
      // void there is no record of it left on the QuickBooks side to look at.
      return {
        chip: { label: 'Deleted in QuickBooks', color: 'error' },
        secondary: `Not returned by QuickBooks twice · quantities reopened · as of ${asOf}`,
      };

    case 'partial':
    case 'open': {
      const money = formatOutstanding(view.qbBalance, view.qbTotalAmt, asOf);
      const due = view.qbDueDate;
      // Overdue is derived here, never stored: it depends on today, so a stored
      // answer would be wrong by morning. A null due date is never overdue —
      // QuickBooks reported no date, so there is nothing to be late against. Due
      // TODAY is not overdue either: "net 30" gives the customer all of day 30.
      if (due !== null && due < todayISO) {
        // Amber, NOT red. docs/design-system.md → "Red means broken; amber means
        // behind": every shop has late invoices, and spending the loudest colour on
        // an ordinary Tuesday leaves nothing for a genuine failure.
        return {
          chip: { label: 'Overdue', color: 'warning' },
          secondary: join([`Due ${formatDueDate(due)}`, money]),
        };
      }
      return {
        chip:
          view.qbStatus === 'partial'
            ? { label: 'Partly paid', color: 'info' }
            : { label: 'Open', color: 'default' },
        secondary: join([
          money,
          due === null ? 'no due date in QuickBooks' : `due ${formatDueDate(due)}`,
        ]),
      };
    }
  }
}

/**
 * The money segment: what QuickBooks says is still owed, always attributed and
 * always dated.
 *
 * Two rules are load-bearing here. **The figures are named as QuickBooks'** —
 * QBO totals are tax-inclusive, so they legitimately exceed the sum of Jigged's
 * line items, and a reader who takes them for Jigged's numbers concludes the
 * invoice was written wrong. **A balance never appears alone unless it IS the
 * total**: printing "$577.50 open" next to a $1,077.50 invoice reads as the whole
 * bill. When the two are equal, naming the same figure twice is noise, so the
 * shape follows the data rather than the status word.
 *
 * The "as of" is unconditional, so a reading left over from a failed refresh can
 * never be mistaken for a live one.
 */
function formatOutstanding(
  balance: number | null,
  total: number | null,
  asOf: string,
): string | null {
  if (balance === null) return null;
  const amounts =
    total !== null && total !== balance
      ? `${formatCurrency(balance)} of ${formatCurrency(total)}`
      : formatCurrency(balance);
  return `QuickBooks: ${amounts} open as of ${asOf}`;
}

/** When Intuit last answered, e.g. `Sep 1`. The year is omitted deliberately:
 *  opening the menu refreshes anything older than ten minutes, so on a successful
 *  read this is minutes old and a year would be four characters of noise in a
 *  line that already carries three facts. */
export function formatCheckedAt(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Format a `YYYY-MM-DD` calendar date without ever handing it to `new Date()`,
 *  which would read it as UTC midnight and print the previous day for any shop
 *  west of Greenwich. Split, then build a LOCAL date from the parts. */
function formatDueDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Matches components/jobs/InvoicesMenu.tsx's own formatCurrency, so the chip's
 *  line and the invoice row above it cannot disagree on how money looks. */
function formatCurrency(n: number): string {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

function join(parts: Array<string | null>): string {
  return parts.filter((p): p is string => !!p).join(' · ');
}
