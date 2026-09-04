'use client';

import { useRef, useState } from 'react';
import { useLoad } from '@/hooks/useLoad';
import Button from '@mui/material/Button';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemText from '@mui/material/ListItemText';
import Divider from '@mui/material/Divider';
import CircularProgress from '@mui/material/CircularProgress';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import AddIcon from '@mui/icons-material/Add';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';
import posthog from 'posthog-js';

import StatusChip from '@/components/common/StatusChip';
import {
  getQuickBooksInvoiceLinksForJob,
  syncQuickBooksInvoiceStatus,
  localDateISO,
  QuickBooksError,
  type QuickBooksInvoiceView,
  type QuickBooksInvoiceStatusRow,
} from '@/utils/quickbooksAccess';
import {
  invoicePaymentDisplay,
  formatCheckedAt,
  toInvoiceStatus,
  type InvoicePaymentFacts,
} from '@/utils/invoicePaymentStatus';
import { copyText } from '@/utils/clipboard';

const EMPTY: QuickBooksInvoiceView[] = [];

/**
 * Toolbar dropdown consolidating "view invoices" + "create invoice" into one
 * button (a standard MUI Menu), so invoices are reachable from the top of the
 * job page without scrolling and the toolbar doesn't grow a separate button.
 *
 * Opening it is also what brings each QuickBooks Online invoice's payment status
 * up to date -- see reconcilePaymentStatus() for why that is not a violation of
 * the never-call-a-third-party-from-a-lifecycle-hook rule.
 */
export default function InvoicesMenu({
  companyId,
  jobId,
  refreshKey = 0,
  onCreate,
  disabled,
}: {
  companyId: string;
  jobId: string;
  refreshKey?: number;
  onCreate: () => void;
  disabled?: boolean;
}) {
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);
  const [copied, setCopied] = useState<{ id: string; ok: boolean } | null>(null);
  const [checking, setChecking] = useState(false);
  /** Non-null once a check has failed. `message` carries a 400's wording, shown
   *  verbatim -- a 400 names a state the shop can act on ("Reconnect QuickBooks
   *  first"), which beats our generic sentence. A null message means Intuit
   *  simply did not answer, and the generic line is drawn instead. */
  const [checkError, setCheckError] = useState<{ message: string | null } | null>(null);
  const [skippedOtherRealm, setSkippedOtherRealm] = useState(0);
  /** Guards against a second call while one is in flight. A ref, not the
   *  `checking` state: two clicks can be dispatched before React re-renders with
   *  the flag set, and the whole point is that one open costs one call. */
  const inFlight = useRef(false);
  const { data, refresh } = useLoad(
    () => getQuickBooksInvoiceLinksForJob(companyId, jobId),
    [companyId, jobId, refreshKey],
    { onError: (err) => console.warn('InvoicesMenu load failed', err) },
  );
  const invoices = data ?? EMPTY;
  const online = invoices.filter((inv) => inv.provider === 'qbo');
  const today = localDateISO();

  /**
   * Bring this job's payment mirror up to date, then let the list re-read it.
   *
   * WHY THIS IS NOT a third-party call on mount. It is a bounded reconcile on an
   * explicit user action -- the same shape as the billing card's
   * POST /api/stripe/reconcile (api/routes/stripe_routes.py:478). A click opens
   * the menu, that click makes at most ONE call to our own backend, and the
   * BACKEND decides whether Intuit is asked at all: only when a webhook marked a
   * row stale, a row has never been checked, or the last answer is over ten
   * minutes old. The browser deliberately holds none of that logic -- one
   * freshness rule, in one place -- which is also why there is no "Check payment
   * status" button here. A button would be a second, unbounded way to spend an
   * Intuit call, and one the shop owner would have to think about.
   *
   * A Desktop-only (or still-loading, or empty) menu makes no call at all: the
   * route refuses Desktop with a 400, and asking is a round trip whose answer we
   * already have.
   */
  const reconcilePaymentStatus = async () => {
    if (online.length === 0 || inFlight.current) return;
    inFlight.current = true;
    setChecking(true);
    setCheckError(null);

    let ok = true;
    let checked = false;
    // What we will report on. Defaults to the rows already on screen, which stay
    // correct on every path that writes nothing -- a failed read, or a check the
    // backend decided was unnecessary.
    let reported: InvoicePaymentFacts[] = online;
    try {
      const result = await syncQuickBooksInvoiceStatus(companyId, jobId);
      checked = result.checked;
      setSkippedOtherRealm(result.skipped_other_realm);
      if (result.checked) {
        reported = factsFromStatusRows(result.invoices, result.checked_at);
        // Only re-read when something was actually written. `checked: false`
        // means the stored rows already are what QuickBooks last said.
        await refresh();
      }
    } catch (err) {
      ok = false;
      setCheckError({
        message: err instanceof QuickBooksError && err.status === 400 ? err.message : null,
      });
    } finally {
      inFlight.current = false;
      setChecking(false);
    }

    // ONE capture with ONE literal property set, on success and failure alike.
    // scripts/analyticsEventsCheck.ts reads the keys off the object literal per
    // call site, so a per-branch capture would document properties that only half
    // the events carry. `ok: false` is an Intuit outage or a lapsed connection,
    // not a Jigged defect; `checked: false` means nothing was stale so QuickBooks
    // was never asked -- the denominator that says whether the webhook path is
    // doing its job. Counts only: what an invoice is worth is the shop's business
    // data and does not belong in analytics.
    const counts = paymentCounts(reported, today);
    posthog.capture('invoice status checked', {
      ok,
      checked,
      invoice_count: reported.length,
      paid_count: counts.paid,
      overdue_count: counts.overdue,
      voided_count: counts.voided,
    });
  };

  const handleCopy = async (inv: QuickBooksInvoiceView) => {
    if (!inv.docNumber) return;
    setCopied({ id: inv.id, ok: await copyText(inv.docNumber) });
  };

  const lastCheckedAt = newestCheck(online);
  const asOf = lastCheckedAt ? formatCheckedAt(lastCheckedAt) : '';
  const checkedLabel = lastCheckedAt ? formatCheckedAtWithTime(lastCheckedAt) : '';

  return (
    <>
      <Button
        variant="outlined"
        startIcon={<ReceiptLongIcon />}
        endIcon={<ArrowDropDownIcon />}
        onClick={(e) => {
          setAnchor(e.currentTarget);
          void reconcilePaymentStatus();
        }}
        disabled={disabled}
      >
        Invoices ({invoices.length})
      </Button>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
        {invoices.length === 0 ? (
          <MenuItem disabled>
            <ListItemText primary="No invoices yet" />
          </MenuItem>
        ) : (
          invoices.map((inv) => {
            // Both fields come back null for Desktop, which is how a Desktop row
            // keeps exactly the behaviour it had before payment status existed.
            const payment = invoicePaymentDisplay(inv, today);
            return inv.url ? (
              <MenuItem
                key={inv.id}
                component="a"
                href={inv.url}
                target="_blank"
                rel="noopener"
                onClick={() => setAnchor(null)}
                sx={{ whiteSpace: 'normal', maxWidth: 460 }}
              >
                <ListItemText
                  primary={`#${inv.docNumber ?? '—'} · ${formatCurrency(inv.total)}`}
                  secondary={
                    payment.secondary ? (
                      // Two stacked lines rather than one long one: the first is
                      // when JIGGED billed it, the second is what QuickBooks says
                      // became of it. Joined with a separator they would read as
                      // one sentence about a single event.
                      <>
                        <span style={{ display: 'block' }}>{formatDate(inv.createdAt)}</span>
                        <span style={{ display: 'block' }}>{payment.secondary}</span>
                      </>
                    ) : (
                      formatDate(inv.createdAt)
                    )
                  }
                />
                {payment.chip && (
                  <StatusChip
                    label={payment.chip.label}
                    color={payment.chip.color}
                    sx={{ ml: 2, flexShrink: 0 }}
                  />
                )}
                <OpenInNewIcon fontSize="small" sx={{ ml: 2, color: 'text.secondary' }} />
              </MenuItem>
            ) : (
              // No url means QuickBooks Desktop, which has no web page to open --
              // so the row copies the invoice number instead of navigating. That
              // number is the only handle a human has for finding the transaction
              // in QuickBooks, and retyping it from the screen is where the digit
              // gets transposed. The menu deliberately stays open afterwards so
              // the confirmation is seen.
              <MenuItem
                key={inv.id}
                onClick={() => handleCopy(inv)}
                disabled={!inv.docNumber}
                aria-label={inv.docNumber ? `Copy invoice number ${inv.docNumber}` : undefined}
              >
                <ListItemText
                  primary={`#${inv.docNumber ?? '—'} · ${formatCurrency(inv.total)}`}
                  secondary={
                    copied?.id === inv.id
                      ? copied.ok
                        ? 'Copied'
                        : 'Press Ctrl+C to copy'
                      : formatDate(inv.createdAt)
                  }
                  slotProps={
                    copied?.id === inv.id
                      ? { secondary: { color: copied.ok ? 'success.main' : 'warning.main' } }
                      : undefined
                  }
                />
                {copied?.id === inv.id && copied.ok ? (
                  <CheckIcon fontSize="small" sx={{ ml: 2, color: 'success.main' }} />
                ) : (
                  <ContentCopyIcon fontSize="small" sx={{ ml: 2, color: 'text.secondary' }} />
                )}
              </MenuItem>
            );
          })
        )}
        {online.length > 0 && (
          // How fresh the chips above are, in the menu's existing caption style.
          // Deliberately NOT a button: MUI's Menu closes on Tab and its MenuList
          // skips children that carry no tabindex, so a BusyButton in here would
          // be unreachable from the keyboard. aria-busy plus a named pending
          // state is the accessible equivalent -- and there is no action to
          // offer anyway, because opening the menu already took it.
          <MenuItem
            disabled
            aria-busy={checking || undefined}
            sx={{ whiteSpace: 'normal', maxWidth: 460 }}
          >
            {checking && <CircularProgress size={16} sx={{ mr: 1.5, flexShrink: 0 }} />}
            <ListItemText
              secondary={
                checking
                  ? 'Checking QuickBooks…'
                  : checkError
                    ? // The chips stay on screen through a failure: a read we could
                      // not make is never written down, and "couldn't check" must
                      // never render as "nothing is owed".
                      (checkError.message ??
                      (asOf
                        ? `Couldn’t reach QuickBooks — showing what it said on ${asOf}.`
                        : 'Couldn’t reach QuickBooks — nothing has been checked yet.'))
                    : checkedLabel
                      ? `Checked ${checkedLabel}`
                      : 'Payment status not checked yet'
              }
              slotProps={{
                secondary: {
                  variant: 'caption',
                  color: !checking && checkError ? 'warning.main' : undefined,
                },
              }}
            />
          </MenuItem>
        )}
        {skippedOtherRealm > 0 && (
          // Their stored mirror is left untouched on purpose: it was true of a
          // QuickBooks company we can no longer ask, and an invoice Id is unique
          // only within one company file -- querying it against the current
          // connection could return a different shop's invoice of the same number.
          <MenuItem disabled sx={{ whiteSpace: 'normal', maxWidth: 460 }}>
            <ListItemText
              secondary={`${skippedOtherRealm} ${
                skippedOtherRealm === 1 ? 'invoice belongs' : 'invoices belong'
              } to a QuickBooks company this shop was connected to before, so ${
                skippedOtherRealm === 1 ? 'its' : 'their'
              } payment status can’t be checked from here.`}
              slotProps={{ secondary: { variant: 'caption' } }}
            />
          </MenuItem>
        )}
        {invoices.length > 0 && invoices.every((i) => !i.url) && (
          <MenuItem disabled sx={{ whiteSpace: 'normal', maxWidth: 320 }}>
            <ListItemText
              secondary="QuickBooks Desktop has no web page to link to. Copy an invoice number, then in QuickBooks press Ctrl+F, paste it into Invoice #, and press Enter. Payment status is only available for QuickBooks Online."
              slotProps={{ secondary: { variant: 'caption' } }}
            />
          </MenuItem>
        )}
        <Divider />
        <MenuItem
          onClick={() => {
            setAnchor(null);
            onCreate();
          }}
        >
          <AddIcon fontSize="small" sx={{ mr: 1 }} />
          Create invoice
        </MenuItem>
      </Menu>
    </>
  );
}

/**
 * The mirror rows the backend just wrote, in the shape the display rule reads.
 *
 * Used only to COUNT for telemetry -- what the menu draws comes from the
 * refreshed Supabase read, never from here. `provider` is 'qbo' because the route
 * returns QuickBooks Online links only (Desktop is refused with a 400), and
 * `checked_at` is the row's own timestamp rather than a stand-in: one pass stamps
 * every row it writes with exactly that instant.
 */
function factsFromStatusRows(
  rows: QuickBooksInvoiceStatusRow[],
  checkedAt: string | null,
): InvoicePaymentFacts[] {
  return rows.map((r) => ({
    provider: 'qbo' as const,
    qbStatus: toInvoiceStatus(r.qb_status),
    qbTotalAmt: r.qb_total_amt,
    qbBalance: r.qb_balance,
    qbDueDate: r.qb_due_date,
    qbStatusCheckedAt: checkedAt,
  }));
}

/**
 * How many of the reported invoices read as paid / overdue / voided.
 *
 * Overdue is counted by running the SAME display rule the rows render with,
 * instead of re-deriving "the due date has passed" here. Overdue is a
 * render-time judgement -- it depends on today AND on the status word -- so a
 * second copy of it would eventually disagree with what the shop owner saw, and
 * a metric that disagrees with the screen is worse than no metric. Paid and
 * voided are stored words, so they are read straight off.
 */
function paymentCounts(facts: InvoicePaymentFacts[], todayISO: string) {
  let paid = 0;
  let overdue = 0;
  let voided = 0;
  for (const f of facts) {
    if (f.qbStatus === 'paid') paid += 1;
    if (f.qbStatus === 'voided') voided += 1;
    if (invoicePaymentDisplay(f, todayISO).chip?.label === 'Overdue') overdue += 1;
  }
  return { paid, overdue, voided };
}

/** The most recent moment QuickBooks answered about any invoice on this job. One
 *  pass stamps them all together, so this is normally every row's value; it
 *  differs only where the monotonic guard in apply_qbo_invoice_mirror skipped a
 *  row that already held a newer reading. */
function newestCheck(invoices: QuickBooksInvoiceView[]): string | null {
  return invoices.reduce<string | null>((newest, inv) => {
    const at = inv.qbStatusCheckedAt;
    if (!at) return newest;
    if (!newest) return at;
    return new Date(at).getTime() > new Date(newest).getTime() ? at : newest;
  }, null);
}

function formatCurrency(n: number): string {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}
function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
/** When Intuit last answered, to the minute. The per-row "as of" is day-granular
 *  on purpose (utils/invoicePaymentStatus.ts -> formatCheckedAt); this line's
 *  whole job is to say how fresh the answer is, and after a successful open it is
 *  seconds old, so the time is the informative part. */
function formatCheckedAtWithTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
}
