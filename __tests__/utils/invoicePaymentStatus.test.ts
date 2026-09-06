import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';

/**
 * The one import that would otherwise drag @supabase/ssr and @sentry/nextjs into a
 * test of a module that touches neither. `localDateISO` is a pure date helper that
 * happens to live in the access layer; nothing here ever reaches a client.
 */
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => {
    throw new Error('invoicePaymentStatus must never reach Supabase');
  },
}));

import {
  invoicePaymentDisplay,
  formatCheckedAt,
  toInvoiceStatus,
  QB_INVOICE_STATUSES,
  type InvoicePaymentFacts,
} from '@/utils/invoicePaymentStatus';
import { localDateISO } from '@/utils/quickbooksAccess';

/**
 * Pinned, because the module formats every date in the VIEWER's timezone and half
 * these assertions name a day. Los Angeles is the extreme of the audience — the
 * furthest a US shop's calendar day can sit from UTC's — so a bug that only shows
 * up west of Greenwich shows up here rather than on someone's laptop.
 */
beforeAll(() => vi.stubEnv('TZ', 'America/Los_Angeles'));
afterAll(() => vi.unstubAllEnvs());
afterEach(() => vi.useRealTimers());

/** 11:00 on Sep 1 in Los Angeles. Every "as of Sep 1" below is this instant. */
const CHECKED_AT = '2026-09-01T18:00:00Z';
const TODAY = '2026-09-15';

/**
 * A QuickBooks Online invoice as the mirror stores it: $1,077.50 billed, $577.50
 * still owed. The two figures differ on purpose — QBO totals are tax-inclusive, so
 * a balance printed alone would read as the whole bill.
 */
function facts(overrides: Partial<InvoicePaymentFacts> = {}): InvoicePaymentFacts {
  return {
    provider: 'qbo',
    qbStatus: 'open',
    qbTotalAmt: 1077.5,
    qbBalance: 577.5,
    qbDueDate: '2026-10-15',
    qbStatusCheckedAt: CHECKED_AT,
    ...overrides,
  };
}

describe('invoicePaymentDisplay', () => {
  it('says nothing at all for QuickBooks Desktop', () => {
    // Desktop is push-only: there is no read API, so any chip here would be a
    // guess. The menu's own Desktop caption is the honest answer.
    expect(invoicePaymentDisplay(facts({ provider: 'qbd' }), TODAY)).toEqual({
      chip: null,
      secondary: null,
    });
  });

  it('says "not checked yet" in words, and draws no chip, before Intuit has ever answered', () => {
    // A row Jigged pushed but never read back. The absence is stated rather than
    // left blank: an empty chip slot next to an invoice reads as "nothing owed".
    const display = invoicePaymentDisplay(
      facts({ qbStatus: null, qbStatusCheckedAt: null, qbTotalAmt: null, qbBalance: null }),
      TODAY,
    );
    expect(display.chip).toBeNull();
    expect(display.secondary).toBe('Payment status not checked yet');
  });

  it('draws no chip when a status somehow has no timestamp beside it', () => {
    // Unreachable in the database — quickbooks_invoice_links_qb_status_checked_consistent
    // ties the two columns together — and asserted anyway, because the branch exists
    // to stop any line below printing "as of " with nothing after it.
    const display = invoicePaymentDisplay(
      facts({ qbStatus: 'paid', qbStatusCheckedAt: null }),
      TODAY,
    );
    expect(display.chip).toBeNull();
    expect(display.secondary).toBe('Payment status not checked yet');
  });

  it('renders a paid invoice as a dated success chip', () => {
    expect(invoicePaymentDisplay(facts({ qbStatus: 'paid', qbBalance: 0 }), TODAY)).toEqual({
      chip: { label: 'Paid', color: 'success' },
      secondary: 'Paid · as of Sep 1',
    });
  });

  it('names both QuickBooks figures on a part-paid invoice', () => {
    // "$577.50 open" alone next to a $1,077.50 invoice reads as the whole bill.
    expect(invoicePaymentDisplay(facts({ qbStatus: 'partial' }), TODAY)).toEqual({
      chip: { label: 'Partly paid', color: 'info' },
      secondary: 'QuickBooks: $577.50 of $1,077.50 open as of Sep 1 · due Oct 15',
    });
  });

  it('prints one figure, not the same figure twice, when nothing has been paid', () => {
    expect(invoicePaymentDisplay(facts({ qbStatus: 'open', qbBalance: 1077.5 }), TODAY)).toEqual({
      chip: { label: 'Open', color: 'default' },
      secondary: 'QuickBooks: $1,077.50 open as of Sep 1 · due Oct 15',
    });
  });

  it('drops the money segment rather than inventing a zero when the balance is null', () => {
    // Number(null) is 0 and a zero balance is the one value that means "paid in
    // full", so an absent balance must stay absent all the way to the screen.
    const display = invoicePaymentDisplay(facts({ qbStatus: 'open', qbBalance: null }), TODAY);
    expect(display.secondary).toBe('due Oct 15');
  });

  it('never calls an invoice overdue when QuickBooks reported no due date', () => {
    const display = invoicePaymentDisplay(facts({ qbStatus: 'open', qbDueDate: null }), TODAY);
    expect(display.chip).toEqual({ label: 'Open', color: 'default' });
    expect(display.secondary).toBe(
      'QuickBooks: $577.50 of $1,077.50 open as of Sep 1 · no due date in QuickBooks',
    );
  });

  it('leads with the due date once it has passed', () => {
    expect(invoicePaymentDisplay(facts({ qbDueDate: '2026-08-31' }), TODAY)).toEqual({
      chip: { label: 'Overdue', color: 'warning' },
      secondary: 'Due Aug 31 · QuickBooks: $577.50 of $1,077.50 open as of Sep 1',
    });
  });

  it('overrides "Partly paid" with "Overdue" — the lateness is the news', () => {
    const display = invoicePaymentDisplay(
      facts({ qbStatus: 'partial', qbDueDate: '2026-08-31' }),
      TODAY,
    );
    expect(display.chip?.label).toBe('Overdue');
  });

  it('colours an overdue invoice amber and never red', () => {
    // docs/design-system.md → "Red means broken; amber means behind". Every shop
    // has late invoices; spending the loudest colour on an ordinary Tuesday leaves
    // nothing louder for the one row that IS a failure — the deleted invoice below,
    // which is the only 'error' this table ever produces.
    for (const status of ['open', 'partial'] as const) {
      const { chip } = invoicePaymentDisplay(
        facts({ qbStatus: status, qbDueDate: '2026-01-01' }),
        TODAY,
      );
      expect(chip).toEqual({ label: 'Overdue', color: 'warning' });
      expect(chip?.color).not.toBe('error');
    }
  });

  it('says the quantities came back when QuickBooks reports the invoice voided', () => {
    // The mirror stamped voided_at, which fired the recompute trigger. The shop
    // owner's next question after "it's voided" is "so can I bill it again".
    expect(invoicePaymentDisplay(facts({ qbStatus: 'voided', qbTotalAmt: 0 }), TODAY)).toEqual({
      chip: { label: 'Voided in QuickBooks', color: 'default' },
      secondary: 'Quantities reopened for invoicing · as of Sep 1',
    });
  });

  it('treats an invoice that vanished from QuickBooks as an error, not a warning', () => {
    // Unlike a void there is no document left on the QuickBooks side to look at:
    // someone deleted a record Jigged issued, and that is genuinely broken.
    expect(invoicePaymentDisplay(facts({ qbStatus: 'missing' }), TODAY)).toEqual({
      chip: { label: 'Deleted in QuickBooks', color: 'error' },
      secondary: 'Not returned by QuickBooks twice · quantities reopened · as of Sep 1',
    });
  });

  it('draws something for every status the CHECK constraint allows', () => {
    // The five words are the database's, not this module's. A sixth added to the
    // constraint without a branch here would fall out of the switch as undefined,
    // which renders as a blank row rather than as an obvious failure.
    for (const status of QB_INVOICE_STATUSES) {
      const display = invoicePaymentDisplay(facts({ qbStatus: status }), TODAY);
      expect(display.chip, status).not.toBeNull();
      expect(display.secondary, status).toBeTruthy();
    }
  });
});

describe('the due-today boundary, from a shop working late', () => {
  /**
   * 22:30 on Sep 30 in Los Angeles — and already Oct 1 in UTC.
   *
   * This is the hour the whole date design exists for. A "today" taken from
   * `toISOString()` reads as the 1st here, and `new Date('2026-09-30')` parses as
   * UTC midnight and reads as the 29th, so a naive implementation calls an invoice
   * that is due TODAY overdue — for every US shop still on the floor at 10pm.
   *
   * The arming assertions matter as much as the subject ones: without them this
   * test could quietly stop testing anything if the frozen instant or the pinned
   * timezone were ever changed.
   */
  function armTheTrap(): string {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T05:30:00Z'));
    expect(new Date().toISOString().slice(0, 10)).toBe('2026-10-01');
    expect(localDateISO()).toBe('2026-09-30');
    return localDateISO();
  }

  it('is not overdue on the day it falls due', () => {
    // "Net 30" gives the customer all of day 30. Being an hour and a half from
    // midnight in California does not make them late.
    const display = invoicePaymentDisplay(facts({ qbDueDate: '2026-09-30' }), armTheTrap());
    expect(display.chip).toEqual({ label: 'Open', color: 'default' });
    expect(display.secondary).toContain('due Sep 30');
  });

  it('is overdue the day after', () => {
    const display = invoicePaymentDisplay(facts({ qbDueDate: '2026-09-29' }), armTheTrap());
    expect(display.chip).toEqual({ label: 'Overdue', color: 'warning' });
    // Sep 29, not Sep 28: the date is split into parts and rebuilt as a LOCAL date
    // rather than handed to new Date(), which would land on the previous evening.
    expect(display.secondary).toContain('Due Sep 29');
  });
});

describe('toInvoiceStatus', () => {
  it('passes through every word the CHECK constraint allows', () => {
    for (const status of QB_INVOICE_STATUSES) {
      expect(toInvoiceStatus(status)).toBe(status);
    }
  });

  it('keeps null as null — never checked is a state, not a missing value', () => {
    expect(toInvoiceStatus(null)).toBeNull();
    expect(toInvoiceStatus(undefined)).toBeNull();
  });

  it('resolves an impossible value to "open", never to "paid"', () => {
    // Unreachable while the constraint holds. If it ever happened, showing money
    // as still owed is the harmless error; telling a shop owner an invoice is PAID
    // when we do not know is the one wrong answer that costs them.
    expect(toInvoiceStatus('settled')).toBe('open');
    expect(toInvoiceStatus('')).toBe('open');
  });
});

describe('formatCheckedAt', () => {
  it('formats the instant Intuit last answered', () => {
    expect(formatCheckedAt(CHECKED_AT)).toBe('Sep 1');
  });

  it('returns an empty string rather than "Invalid Date" for anything unusable', () => {
    // The caller uses the empty string as its "nothing to show" signal, so a
    // thrown-together Date must never reach the screen as text.
    expect(formatCheckedAt(null)).toBe('');
    expect(formatCheckedAt(undefined)).toBe('');
    expect(formatCheckedAt('not a timestamp')).toBe('');
  });
});
