import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * One chainable builder per .from(...) call — matches the two-query shape of
 * getJobPartInvoiceSummaries (job_parts, then line items). The builder doubles as
 * the awaited result so `const { data, error } = await query` sees .data / .error.
 */
function buildQueryStub(initial?: { data?: unknown; error?: unknown }) {
  const builder: Record<string, unknown> = {};
  const chainMethods = [
    'select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'is', 'not', 'order', 'limit',
    'single', 'maybeSingle',
  ];
  chainMethods.forEach((m) => {
    builder[m] = vi.fn().mockImplementation(() => builder);
  });
  builder.data = initial?.data ?? null;
  builder.error = initial?.error ?? null;
  return builder as Record<string, ReturnType<typeof vi.fn>> & { data: unknown; error: unknown };
}

const { mockSupabase, queueBuilders } = vi.hoisted(() => {
  let queue: ReturnType<typeof Object>[] = [];
  const supabase = {
    from: vi.fn().mockImplementation(() => {
      const next = queue.shift();
      if (!next) throw new Error('queueBuilders: ran out of stubbed builders');
      return next;
    }),
    // Only the backend-bound helpers touch this: authHeader() reads the session to
    // put a bearer token on the FastAPI call. The PostgREST reads above never do.
    auth: { getSession: vi.fn() },
  };
  return {
    mockSupabase: supabase,
    queueBuilders: (builders: ReturnType<typeof Object>[]) => {
      queue = builders;
    },
  };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
}));

import {
  getJobPartInvoiceSummaries,
  getQuickBooksInvoiceLinksForJob,
  syncQuickBooksInvoiceStatus,
  isQuickBooksUnreachable,
  QuickBooksError,
  QB_ERROR,
} from '@/utils/quickbooksAccess';

describe('getJobPartInvoiceSummaries', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sums only created, non-voided invoice lines per part', async () => {
    const parts = buildQueryStub({
      data: [
        { id: 'jp-1', quantity: 10 },
        { id: 'jp-2', quantity: 5 },
      ],
      error: null,
    });
    const lines = buildQueryStub({
      data: [
        // jp-1: 4 (created) + 3 (created) = 7 counted; a pending + a voided one ignored.
        { job_part_id: 'jp-1', quantity: 4, link: { status: 'created', voided_at: null } },
        { job_part_id: 'jp-1', quantity: 3, link: { status: 'created', voided_at: null } },
        { job_part_id: 'jp-1', quantity: 99, link: { status: 'pending', voided_at: null } },
        { job_part_id: 'jp-1', quantity: 99, link: { status: 'created', voided_at: '2026-07-01' } },
        // jp-2: nothing created → 0.
        { job_part_id: 'jp-2', quantity: 2, link: { status: 'error', voided_at: null } },
      ],
      error: null,
    });
    queueBuilders([parts, lines]);

    const result = await getJobPartInvoiceSummaries('job-1');
    expect(result).toEqual([
      { job_part_id: 'jp-1', qty_ordered: 10, qty_invoiced: 7 },
      { job_part_id: 'jp-2', qty_ordered: 5, qty_invoiced: 0 },
    ]);
  });

  it('returns [] when the job has no parts (no second query)', async () => {
    queueBuilders([buildQueryStub({ data: [], error: null })]);
    const result = await getJobPartInvoiceSummaries('job-1');
    expect(result).toEqual([]);
    // Only the job_parts query ran.
    expect(mockSupabase.from).toHaveBeenCalledTimes(1);
  });
});

/**
 * The mirror columns every `quickbooks_invoice_links` row now carries. Spread into
 * a fixture so a row in these tests has the same shape PostgREST returns —
 * `null`, never absent. `nullableNumber` distinguishes null from a number, and a
 * key that simply is not there is a different thing again.
 */
const NEVER_CHECKED = {
  provider: 'qbo',
  realm_id: '4620816365',
  voided_at: null,
  qb_status: null,
  qb_total_amt: null,
  qb_balance: null,
  qb_due_date: null,
  qb_txn_date: null,
  qb_status_checked_at: null,
};

describe('getQuickBooksInvoiceLinksForJob', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps links to views with per-part lines, part names, and a summed total', async () => {
    const links = buildQueryStub({
      data: [
        {
          ...NEVER_CHECKED,
          id: 'link-1',
          qb_invoice_id: 'i1',
          qb_invoice_doc_number: '1001',
          qb_invoice_url: 'http://qb/1',
          created_at: '2026-07-01T00:00:00Z',
          quickbooks_invoice_line_items: [
            {
              job_part_id: 'jp-1',
              quantity: 4,
              unit_price: 100,
              total_price: 400,
              job_part: { part: { part_name: 'Bracket' } },
            },
            {
              job_part_id: 'jp-2',
              quantity: 2,
              unit_price: 50,
              total_price: 100,
              job_part: { part: { part_name: 'Flange' } },
            },
          ],
        },
      ],
      error: null,
    });
    queueBuilders([links]);

    const result = await getQuickBooksInvoiceLinksForJob('co-1', 'job-1');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'link-1', docNumber: '1001', url: 'http://qb/1', total: 500 });
    expect(result[0].lines).toEqual([
      { jobPartId: 'jp-1', partName: 'Bracket', quantity: 4, unitPrice: 100, totalPrice: 400 },
      { jobPartId: 'jp-2', partName: 'Flange', quantity: 2, unitPrice: 50, totalPrice: 100 },
    ]);
  });

  it('falls back to "Part" when a line has no part name', async () => {
    const links = buildQueryStub({
      data: [
        {
          ...NEVER_CHECKED,
          id: 'link-1',
          qb_invoice_id: 'i1',
          qb_invoice_doc_number: '1001',
          qb_invoice_url: 'http://qb/1',
          created_at: '2026-07-01T00:00:00Z',
          quickbooks_invoice_line_items: [
            { job_part_id: 'jp-1', quantity: 1, unit_price: 10, total_price: 10, job_part: null },
          ],
        },
      ],
      error: null,
    });
    queueBuilders([links]);
    const result = await getQuickBooksInvoiceLinksForJob('co-1', 'job-1');
    expect(result[0].lines[0].partName).toBe('Part');
  });

  it('carries the payment mirror onto the view, keeping a zero balance zero', async () => {
    const links = buildQueryStub({
      data: [
        {
          ...NEVER_CHECKED,
          id: 'link-1',
          qb_invoice_id: 'i1',
          qb_invoice_doc_number: '1001',
          qb_invoice_url: 'http://qb/1',
          created_at: '2026-07-01T00:00:00Z',
          qb_status: 'paid',
          // 1,077.50 against 1,000.00 of Jigged lines: QuickBooks totals are
          // TAX-INCLUSIVE, so the two legitimately differ and the view keeps them
          // as two separate fields rather than reconciling them.
          qb_total_amt: 1077.5,
          qb_balance: 0,
          qb_due_date: '2026-10-15',
          qb_txn_date: '2026-09-15',
          qb_status_checked_at: '2026-09-01T18:00:00Z',
          quickbooks_invoice_line_items: [
            {
              job_part_id: 'jp-1',
              quantity: 10,
              unit_price: 100,
              total_price: 1000,
              job_part: { part: { part_name: 'Bracket' } },
            },
          ],
        },
      ],
      error: null,
    });
    queueBuilders([links]);

    const [view] = await getQuickBooksInvoiceLinksForJob('co-1', 'job-1');
    expect(view).toMatchObject({
      provider: 'qbo',
      realmId: '4620816365',
      voidedAt: null,
      qbStatus: 'paid',
      qbTotalAmt: 1077.5,
      qbDueDate: '2026-10-15',
      qbTxnDate: '2026-09-15',
      qbStatusCheckedAt: '2026-09-01T18:00:00Z',
      total: 1000,
    });
    // Spelled out separately because toMatchObject would accept `undefined` here
    // and this is the value that must not become one: Number(null) is 0, so the
    // mapper has to tell "paid in full" apart from "we have no figure".
    expect(view.qbBalance).toBe(0);
  });

  it('leaves a never-checked row null rather than guessing a status', async () => {
    const links = buildQueryStub({
      data: [
        {
          ...NEVER_CHECKED,
          id: 'link-1',
          qb_invoice_id: 'i1',
          qb_invoice_doc_number: '1001',
          qb_invoice_url: 'http://qb/1',
          created_at: '2026-07-01T00:00:00Z',
          quickbooks_invoice_line_items: [],
        },
      ],
      error: null,
    });
    queueBuilders([links]);

    const [view] = await getQuickBooksInvoiceLinksForJob('co-1', 'job-1');
    expect(view.qbStatus).toBeNull();
    expect(view.qbStatusCheckedAt).toBeNull();
    expect(view.qbBalance).toBeNull();
    expect(view.qbTotalAmt).toBeNull();
  });

  it('keeps a voided invoice on the list instead of making it disappear', async () => {
    // The query used to filter `voided_at IS NULL`, so an invoice voided in
    // QuickBooks simply vanished from the menu — and the quantity it put back on
    // the job looked like a bug with no visible cause. The row stays; the chip
    // explains it. The invoiced-quantity maths is unaffected either way: that is
    // computed in SQL from voided_at, never from this list.
    const links = buildQueryStub({
      data: [
        {
          ...NEVER_CHECKED,
          id: 'link-voided',
          qb_invoice_id: 'i1',
          qb_invoice_doc_number: '1001',
          qb_invoice_url: 'http://qb/1',
          created_at: '2026-07-01T00:00:00Z',
          voided_at: '2026-09-01T18:00:00Z',
          qb_status: 'voided',
          qb_total_amt: 0,
          qb_balance: 0,
          qb_status_checked_at: '2026-09-01T18:00:00Z',
          quickbooks_invoice_line_items: [],
        },
      ],
      error: null,
    });
    queueBuilders([links]);

    const result = await getQuickBooksInvoiceLinksForJob('co-1', 'job-1');
    expect(result.map((r) => r.id)).toEqual(['link-voided']);
    expect(result[0].voidedAt).toBe('2026-09-01T18:00:00Z');
    // The regression guard proper: the filter must be gone from the QUERY, not
    // merely absent from this fixture's data.
    expect(links.is).not.toHaveBeenCalledWith('voided_at', null);
  });

  it('narrows the provider column instead of trusting it', async () => {
    const links = buildQueryStub({
      data: [
        {
          ...NEVER_CHECKED,
          id: 'link-1',
          provider: 'qbd',
          qb_invoice_id: 'i1',
          qb_invoice_doc_number: '1100',
          // Desktop has no web app, so there is never a url to open.
          qb_invoice_url: null,
          created_at: '2026-07-01T00:00:00Z',
          quickbooks_invoice_line_items: [],
        },
      ],
      error: null,
    });
    queueBuilders([links]);

    const [view] = await getQuickBooksInvoiceLinksForJob('co-1', 'job-1');
    expect(view.provider).toBe('qbd');
  });
});

describe('syncQuickBooksInvoiceStatus', () => {
  const fetchMock = vi.fn();

  /** jsdom Response stand-in — qbRequest only reads .ok, .status and .json(). */
  function httpResponse(status: number, body: unknown) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }

  /** Narrows without a cast, so a rejection of the wrong TYPE fails loudly here
   *  rather than passing an `as`-shaped assertion further down. */
  async function expectQuickBooksError(p: Promise<unknown>): Promise<QuickBooksError> {
    try {
      await p;
    } catch (e) {
      if (e instanceof QuickBooksError) return e;
      throw e;
    }
    throw new Error('expected the call to reject with a QuickBooksError');
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    mockSupabase.auth.getSession.mockResolvedValue({
      data: { session: { access_token: 'token-123' } },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('posts to the job’s invoice-status route with no body', async () => {
    const result = {
      checked: true,
      checked_at: '2026-09-01T18:00:00Z',
      invoices: [
        {
          link_id: 'link-1',
          qb_invoice_id: 'i1',
          qb_status: 'paid',
          qb_total_amt: 1077.5,
          qb_balance: 0,
          qb_due_date: '2026-10-15',
          qb_txn_date: '2026-09-15',
          voided_at: null,
        },
      ],
      skipped_other_realm: 0,
    };
    fetchMock.mockResolvedValue(httpResponse(200, result));

    await expect(syncQuickBooksInvoiceStatus('co-1', 'job-1')).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/quickbooks\/co-1\/jobs\/job-1\/invoice-status$/);
    expect(init.method).toBe('POST');
    // The route takes no request body on purpose: the BACKEND decides whether
    // Intuit is asked at all, so there is nothing for the browser to send.
    expect(init.body).toBeUndefined();
    expect(init.headers.Authorization).toBe('Bearer token-123');
  });

  it('surfaces a 409 as an unreachable QuickBooksError carrying the code', async () => {
    fetchMock.mockResolvedValue(
      httpResponse(409, {
        detail: {
          code: 'qbo_unreachable',
          message: 'Couldn’t reach QuickBooks to check payments. Showing what it last said.',
        },
      }),
    );

    const err = await expectQuickBooksError(syncQuickBooksInvoiceStatus('co-1', 'job-1'));
    expect(err.status).toBe(409);
    expect(err.code).toBe(QB_ERROR.onlineUnreachable);
    // 4xx, not 5xx: Intuit being down is the expected path, and the Starlette
    // Sentry integration only captures 5xx. Nothing here is a Jigged defect.
    expect(isQuickBooksUnreachable(err)).toBe(true);
  });

  it('passes a 400’s wording through verbatim, and does not call it unreachable', async () => {
    // A 400 names a state the shop can act on, so the menu prints it as-is. It is
    // NOT the unreachable class: retrying changes nothing until someone reconnects.
    fetchMock.mockResolvedValue(
      httpResponse(400, {
        detail: 'Reconnect QuickBooks first — we can’t check payments until then.',
      }),
    );

    const err = await expectQuickBooksError(syncQuickBooksInvoiceStatus('co-1', 'job-1'));
    expect(err.status).toBe(400);
    expect(err.message).toBe(
      'Reconnect QuickBooks first — we can’t check payments until then.',
    );
    expect(err.code).toBeUndefined();
    expect(isQuickBooksUnreachable(err)).toBe(false);
  });
});
