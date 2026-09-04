import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, waitFor, fireEvent } from '../../test-utils';
import userEvent from '@testing-library/user-event';
import InvoicesMenu from '@/components/jobs/InvoicesMenu';

const getQuickBooksInvoiceLinksForJob = vi.fn();
const syncQuickBooksInvoiceStatus = vi.fn();
const localDateISO = vi.fn();

/**
 * A REAL class, hoisted so the mock factory can hand back the constructor itself
 * rather than a stand-in. The component narrows with `err instanceof
 * QuickBooksError` to decide whether a 400's wording is shown verbatim, and a
 * plain object would silently take the other branch — the one bug this file most
 * needs to be able to see.
 */
const { QuickBooksError } = vi.hoisted(() => {
  class QuickBooksError extends Error {
    status?: number;
    code?: string;
    constructor(message: string, status?: number, code?: string) {
      super(message);
      this.name = 'QuickBooksError';
      this.status = status;
      this.code = code;
    }
  }
  return { QuickBooksError };
});

vi.mock('@/utils/quickbooksAccess', () => ({
  getQuickBooksInvoiceLinksForJob: (...args: unknown[]) =>
    getQuickBooksInvoiceLinksForJob(...args),
  syncQuickBooksInvoiceStatus: (...args: unknown[]) => syncQuickBooksInvoiceStatus(...args),
  localDateISO: () => localDateISO(),
  QuickBooksError,
}));

const copyText = vi.fn();
vi.mock('@/utils/clipboard', () => ({
  copyText: (...args: unknown[]) => copyText(...args),
}));

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));

import posthog from 'posthog-js';

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

/**
 * Pinned, because the menu prints "as of Sep 1" and "Checked Sep 1, 1:00 PM" in
 * the VIEWER's timezone. Central US is the middle of the audience; without this
 * the same assertions read Sep 2 on a machine east of Greenwich.
 */
beforeAll(() => vi.stubEnv('TZ', 'America/Chicago'));
afterAll(() => vi.unstubAllEnvs());

/** 13:00 on Sep 1 in Chicago — the instant every "as of Sep 1" below refers to. */
const CHECKED_AT = '2026-09-01T18:00:00Z';
/** The shop's today, as localDateISO() reports it. Overdue is decided against it. */
const TODAY = '2026-09-15';

/**
 * One row of getQuickBooksInvoiceLinksForJob's output. Defaults to a QuickBooks
 * Online invoice Jigged has pushed but never read back — the state every existing
 * invoice is in until the first check.
 *
 * `total` is JIGGED's line total and stays 1,000.00 throughout; the `qb*` figures
 * are QuickBooks' own and are tax-inclusive, which is why they are larger.
 */
function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'l1',
    invoiceId: 'i1',
    docNumber: '1001',
    url: 'https://app.qbo.intuit.com/app/invoice?txnId=1',
    createdAt: '2026-08-10T00:00:00Z',
    lines: [],
    total: 1000,
    provider: 'qbo',
    realmId: '4620816365',
    voidedAt: null,
    qbStatus: null,
    qbTotalAmt: null,
    qbBalance: null,
    qbDueDate: null,
    qbTxnDate: null,
    qbStatusCheckedAt: null,
    ...overrides,
  };
}

const QBO = invoice();
// QuickBooks Desktop: url is ALWAYS null — there is no web page to open.
const QBD = invoice({
  id: 'l2',
  invoiceId: 'i2',
  docNumber: '1100',
  total: 683.48,
  url: null,
  provider: 'qbd',
});

/** A paid invoice as the mirror stores it: $1,077.50 billed, nothing outstanding. */
const PAID = invoice({
  qbStatus: 'paid',
  qbTotalAmt: 1077.5,
  qbBalance: 0,
  qbDueDate: '2026-10-15',
  qbTxnDate: '2026-08-10',
  qbStatusCheckedAt: CHECKED_AT,
});

/** What the route returns for that same invoice. Snake_case: it is JSON verbatim. */
const PAID_ROW = {
  link_id: 'l1',
  qb_invoice_id: 'i1',
  qb_status: 'paid',
  qb_total_amt: 1077.5,
  qb_balance: 0,
  qb_due_date: '2026-10-15',
  qb_txn_date: '2026-08-10',
  voided_at: null,
};

const NOTHING_WAS_STALE = {
  checked: false,
  checked_at: null,
  invoices: [],
  skipped_other_realm: 0,
};

/** A promise we control, so the in-flight state can actually be observed. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Open the menu, waiting for the invoice count first when one is given.
 *
 * The wait matters: the button renders as "Invoices (0)" until the first read
 * resolves, and clicking it then would find no QuickBooks Online rows and make no
 * check — a green test asserting nothing.
 */
async function openMenu(count?: number) {
  const name = count === undefined ? /Invoices/ : new RegExp(`Invoices \\(${count}\\)`);
  await userEvent.click(await screen.findByRole('button', { name }));
}

describe('InvoicesMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    copyText.mockResolvedValue(true);
    localDateISO.mockReturnValue(TODAY);
    syncQuickBooksInvoiceStatus.mockResolvedValue(NOTHING_WAS_STALE);
  });

  it('links out to QuickBooks Online when there is a url', async () => {
    getQuickBooksInvoiceLinksForJob.mockResolvedValue([QBO]);
    render(<InvoicesMenu companyId="c1" jobId="j1" onCreate={vi.fn()} />);
    await openMenu();

    const row = await screen.findByRole('menuitem', { name: /1001/ });
    expect(row).toHaveAttribute('href', QBO.url);
  });

  it('copies the invoice number instead of navigating for a Desktop invoice', async () => {
    getQuickBooksInvoiceLinksForJob.mockResolvedValue([QBD]);
    render(<InvoicesMenu companyId="c1" jobId="j1" onCreate={vi.fn()} />);
    await openMenu();

    const row = await screen.findByRole('menuitem', { name: /Copy invoice number 1100/ });
    // The delete-gate regression that a null url once caused makes this worth
    // stating outright: a Desktop row must never become a dead <a href>.
    expect(row).not.toHaveAttribute('href');

    await userEvent.click(row);

    // The NUMBER alone — it is pasted straight into the Invoice # field of
    // QuickBooks' Find window, so any decoration would have to be deleted.
    expect(copyText).toHaveBeenCalledWith('1100');
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('tells the user how to use the number when nothing can be linked', async () => {
    getQuickBooksInvoiceLinksForJob.mockResolvedValue([QBD]);
    render(<InvoicesMenu companyId="c1" jobId="j1" onCreate={vi.fn()} />);
    await openMenu();

    expect(await screen.findByText(/press Ctrl\+F, paste it into Invoice #/)).toBeInTheDocument();
  });

  it('does not show the Desktop hint when the invoices are linkable', async () => {
    getQuickBooksInvoiceLinksForJob.mockResolvedValue([QBO]);
    render(<InvoicesMenu companyId="c1" jobId="j1" onCreate={vi.fn()} />);
    await openMenu();

    await screen.findByRole('menuitem', { name: /1001/ });
    expect(screen.queryByText(/press Ctrl\+F/)).not.toBeInTheDocument();
  });

  it('says how to copy by hand rather than claiming success when the copy fails', async () => {
    copyText.mockResolvedValue(false);
    getQuickBooksInvoiceLinksForJob.mockResolvedValue([QBD]);
    render(<InvoicesMenu companyId="c1" jobId="j1" onCreate={vi.fn()} />);
    await openMenu();

    await userEvent.click(await screen.findByRole('menuitem', { name: /Copy invoice number 1100/ }));

    await waitFor(() => expect(screen.getByText('Press Ctrl+C to copy')).toBeInTheDocument());
    expect(screen.queryByText('Copied')).not.toBeInTheDocument();
  });
});

describe('InvoicesMenu — payment status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    copyText.mockResolvedValue(true);
    localDateISO.mockReturnValue(TODAY);
    syncQuickBooksInvoiceStatus.mockResolvedValue(NOTHING_WAS_STALE);
  });

  it('checks QuickBooks once per open and redraws the chips from what was written', async () => {
    getQuickBooksInvoiceLinksForJob
      .mockResolvedValueOnce([invoice()]) // never checked
      .mockResolvedValueOnce([PAID]); // what the re-read finds afterwards
    syncQuickBooksInvoiceStatus.mockResolvedValue({
      checked: true,
      checked_at: CHECKED_AT,
      invoices: [PAID_ROW],
      skipped_other_realm: 0,
    });

    render(<InvoicesMenu companyId="c1" jobId="j1" onCreate={vi.fn()} />);
    await openMenu(1);

    expect(await screen.findByText('Paid')).toBeInTheDocument();
    expect(screen.getByText('Paid · as of Sep 1')).toBeInTheDocument();
    expect(syncQuickBooksInvoiceStatus).toHaveBeenCalledTimes(1);
    expect(syncQuickBooksInvoiceStatus).toHaveBeenCalledWith('c1', 'j1');
    // Initial load + the one re-read the write earned. A `checked: false` answer
    // writes nothing and must not cost a second query — see the test below.
    expect(getQuickBooksInvoiceLinksForJob).toHaveBeenCalledTimes(2);
  });

  it('does not re-read Supabase when the backend decided nothing was stale', async () => {
    getQuickBooksInvoiceLinksForJob.mockResolvedValue([PAID]);

    render(<InvoicesMenu companyId="c1" jobId="j1" onCreate={vi.fn()} />);
    await openMenu(1);

    // The freshness caption is the proof the round trip finished.
    expect(await screen.findByText(/^Checked Sep 1, /)).toBeInTheDocument();
    expect(getQuickBooksInvoiceLinksForJob).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Paid')).toBeInTheDocument();
  });

  it('costs one call, not two, when a second open lands before React re-renders', async () => {
    // fireEvent, not userEvent, on purpose: two clicks dispatched in the SAME tick
    // is exactly the case the `inFlight` ref exists for. A `checking` state flag
    // would not be set yet on the second click, and the shop would pay Intuit
    // twice for one look at the menu.
    const gate = deferred<typeof NOTHING_WAS_STALE>();
    syncQuickBooksInvoiceStatus.mockReturnValue(gate.promise);
    getQuickBooksInvoiceLinksForJob.mockResolvedValue([PAID]);

    render(<InvoicesMenu companyId="c1" jobId="j1" onCreate={vi.fn()} />);
    const button = await screen.findByRole('button', { name: /Invoices \(1\)/ });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(await screen.findByText('Checking QuickBooks…')).toBeInTheDocument();
    expect(syncQuickBooksInvoiceStatus).toHaveBeenCalledTimes(1);

    gate.resolve(NOTHING_WAS_STALE);
    await waitFor(() => expect(screen.queryByText('Checking QuickBooks…')).not.toBeInTheDocument());
    expect(syncQuickBooksInvoiceStatus).toHaveBeenCalledTimes(1);

    // And the guard RELEASES. Without this the test could pass on a component
    // that never handled the second click at all, rather than on one that
    // deliberately declined it: the next open checks again, as it should.
    syncQuickBooksInvoiceStatus.mockResolvedValue(NOTHING_WAS_STALE);
    fireEvent.click(button);
    await waitFor(() => expect(syncQuickBooksInvoiceStatus).toHaveBeenCalledTimes(2));
  });

  it('names both QuickBooks figures on an overdue row, and never Jigged’s line total', async () => {
    // The trap this guards: QBO totals are tax-inclusive, so they exceed the sum of
    // Jigged's lines legitimately. A reader who takes $1,077.50 for a Jigged figure
    // concludes the invoice was written wrong; a bare "$577.50 open" next to a
    // $1,077.50 invoice reads as the whole bill.
    getQuickBooksInvoiceLinksForJob.mockResolvedValue([
      invoice({
        qbStatus: 'open',
        qbTotalAmt: 1077.5,
        qbBalance: 577.5,
        qbDueDate: '2026-08-31',
        qbStatusCheckedAt: CHECKED_AT,
      }),
    ]);

    render(<InvoicesMenu companyId="c1" jobId="j1" onCreate={vi.fn()} />);
    await openMenu(1);

    expect(await screen.findByText('Overdue')).toBeInTheDocument();
    const line = screen.getByText(/QuickBooks:/);
    expect(line).toHaveTextContent(
      'Due Aug 31 · QuickBooks: $577.50 of $1,077.50 open as of Sep 1',
    );
    expect(line).not.toHaveTextContent('$1,000.00');
    // Jigged's own total is not hidden — it just stays on its own line, beside the
    // invoice number, where it is unambiguously ours.
    expect(screen.getByText(/^#1001 · /)).toHaveTextContent('$1,000.00');
  });

  it('says a voided invoice was voided instead of dropping it off the list', async () => {
    getQuickBooksInvoiceLinksForJob.mockResolvedValue([
      invoice({
        qbStatus: 'voided',
        qbTotalAmt: 0,
        qbBalance: 0,
        qbStatusCheckedAt: CHECKED_AT,
        voidedAt: CHECKED_AT,
      }),
    ]);

    render(<InvoicesMenu companyId="c1" jobId="j1" onCreate={vi.fn()} />);
    await openMenu(1);

    expect(await screen.findByText('Voided in QuickBooks')).toBeInTheDocument();
    // The quantities going back on the job is the shop owner's actual next
    // question, so the row answers it rather than leaving the reopen unexplained.
    expect(
      screen.getByText('Quantities reopened for invoicing · as of Sep 1'),
    ).toBeInTheDocument();
  });

  it('shows no chip for a Desktop invoice and never calls the route for one', async () => {
    // The route refuses Desktop with a 400, so asking is a round trip whose answer
    // we already have — and a chip here could only ever say "unknown".
    getQuickBooksInvoiceLinksForJob.mockResolvedValue([QBD]);

    render(<InvoicesMenu companyId="c1" jobId="j1" onCreate={vi.fn()} />);
    await openMenu(1);

    await screen.findByRole('menuitem', { name: /Copy invoice number 1100/ });
    expect(syncQuickBooksInvoiceStatus).not.toHaveBeenCalled();
    expect(screen.queryByText('Paid')).not.toBeInTheDocument();
    expect(screen.queryByText(/Payment status not checked yet/)).not.toBeInTheDocument();
    // The Desktop caption is where the absence gets explained.
    expect(
      screen.getByText(/Payment status is only available for QuickBooks Online\./),
    ).toBeInTheDocument();
  });

  it('shows a pending caption while the check runs, and replaces it when it fails', async () => {
    const gate = deferred<typeof NOTHING_WAS_STALE>();
    syncQuickBooksInvoiceStatus.mockReturnValue(gate.promise);
    getQuickBooksInvoiceLinksForJob.mockResolvedValue([PAID]);

    render(<InvoicesMenu companyId="c1" jobId="j1" onCreate={vi.fn()} />);
    await openMenu(1);

    expect(await screen.findByText('Checking QuickBooks…')).toBeInTheDocument();

    gate.reject(new QuickBooksError('down', 409, 'qbo_unreachable'));

    await waitFor(() =>
      expect(screen.queryByText('Checking QuickBooks…')).not.toBeInTheDocument(),
    );
    expect(
      screen.getByText('Couldn’t reach QuickBooks — showing what it said on Sep 1.'),
    ).toBeInTheDocument();
  });

  it('keeps the chips on screen when the check fails — “couldn’t check” is not “unpaid”', async () => {
    getQuickBooksInvoiceLinksForJob.mockResolvedValue([PAID]);
    syncQuickBooksInvoiceStatus.mockRejectedValue(
      new QuickBooksError(
        'Couldn’t reach QuickBooks to check payments. Showing what it last said.',
        409,
        'qbo_unreachable',
      ),
    );

    render(<InvoicesMenu companyId="c1" jobId="j1" onCreate={vi.fn()} />);
    await openMenu(1);

    expect(
      await screen.findByText('Couldn’t reach QuickBooks — showing what it said on Sep 1.'),
    ).toBeInTheDocument();
    // The whole point: a read we could not make is never written down, so what is
    // on screen stays the last thing QuickBooks actually said, with its date.
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.getByText('Paid · as of Sep 1')).toBeInTheDocument();
    expect(getQuickBooksInvoiceLinksForJob).toHaveBeenCalledTimes(1);
  });

  it('prints a 400’s own wording rather than the generic sentence', async () => {
    // A 400 names a state the shop can act on, which beats anything we could write
    // generically — and unlike a 409 there is nothing to retry.
    getQuickBooksInvoiceLinksForJob.mockResolvedValue([PAID]);
    syncQuickBooksInvoiceStatus.mockRejectedValue(
      new QuickBooksError('Reconnect QuickBooks first — we can’t check payments until then.', 400),
    );

    render(<InvoicesMenu companyId="c1" jobId="j1" onCreate={vi.fn()} />);
    await openMenu(1);

    expect(
      await screen.findByText('Reconnect QuickBooks first — we can’t check payments until then.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Couldn’t reach QuickBooks/)).not.toBeInTheDocument();
  });

  it('offers no “check payment status” control, because opening the menu IS the check', async () => {
    // The refresh is automatic by design: the backend owns the freshness rule, and
    // a button would be a second, unbounded way to spend an Intuit call that the
    // shop owner would have to think about. A regression that adds one fails here.
    getQuickBooksInvoiceLinksForJob.mockResolvedValue([PAID]);

    render(<InvoicesMenu companyId="c1" jobId="j1" onCreate={vi.fn()} />);
    await openMenu(1);
    await screen.findByText('Paid');

    for (const wording of [/check payment/i, /refresh payment/i, /check status/i, /refresh/i]) {
      expect(screen.queryByRole('button', { name: wording })).not.toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: wording })).not.toBeInTheDocument();
    }
    // The only actionable item in the menu besides the invoices themselves.
    expect(screen.getByRole('menuitem', { name: /create invoice/i })).toBeInTheDocument();
  });

  it('captures the same property keys whether the check succeeded or failed', async () => {
    getQuickBooksInvoiceLinksForJob.mockResolvedValue([PAID]);
    syncQuickBooksInvoiceStatus.mockResolvedValue({
      checked: true,
      checked_at: CHECKED_AT,
      invoices: [PAID_ROW],
      skipped_other_realm: 0,
    });

    const { unmount } = render(<InvoicesMenu companyId="c1" jobId="j1" onCreate={vi.fn()} />);
    await openMenu(1);
    await waitFor(() => expect(posthog.capture).toHaveBeenCalledTimes(1));
    unmount();

    syncQuickBooksInvoiceStatus.mockRejectedValue(new QuickBooksError('down', 409, 'qbo_unreachable'));
    render(<InvoicesMenu companyId="c1" jobId="j1" onCreate={vi.fn()} />);
    await openMenu(1);
    await waitFor(() => expect(posthog.capture).toHaveBeenCalledTimes(2));

    const [okCall, failCall] = mock(posthog.capture).mock.calls;
    expect(okCall[0]).toBe('invoice status checked');
    expect(failCall[0]).toBe('invoice status checked');
    // scripts/analyticsEventsCheck.ts reads the keys off the object literal per
    // call site, so one literal has to serve both branches — a per-branch capture
    // would document properties only half the events carry.
    expect(Object.keys(failCall[1] as object)).toEqual(Object.keys(okCall[1] as object));
    expect(Object.keys(okCall[1] as object).sort()).toEqual([
      'checked',
      'invoice_count',
      'ok',
      'overdue_count',
      'paid_count',
      'voided_count',
    ]);
    expect(okCall[1]).toMatchObject({ ok: true, checked: true, invoice_count: 1, paid_count: 1 });
    // ok:false is an Intuit outage, not a Jigged defect; checked:false because
    // nothing was written, so the counts fall back to the rows already on screen.
    expect(failCall[1]).toMatchObject({
      ok: false,
      checked: false,
      invoice_count: 1,
      paid_count: 1,
    });
    // Counts only. What an invoice is worth is the shop's business data and has no
    // business in analytics — 1077.5 is the amount both branches had in hand.
    expect(JSON.stringify(okCall[1])).not.toContain('1077');
    expect(JSON.stringify(failCall[1])).not.toContain('1077');
  });
});
