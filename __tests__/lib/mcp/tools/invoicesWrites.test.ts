import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';

import type { CompanyToolEnv } from '@/lib/mcp/defineTool';
import {
  INVOICE_WRITE_TOOLS,
  invoiceRequestId,
  previewInvoicePush,
  pushInvoiceToQuickBooks,
} from '@/lib/mcp/tools/invoicesWrites';

/**
 * The QuickBooks invoice tools, run directly against a stand-in backend. What matters: the
 * preflight and push routes are called with the body the Invoice dialog sends, every answer is
 * parsed by the tool's own schema, the lines are checked as the dialog and the backend check
 * them, a retry of the same call carries the same idempotency key, and the customer is never
 * guessed among similar names.
 */

/** Each backend path answers with what `answers` holds, parsed by the schema the tool passed. */
const backend = vi.hoisted(() => ({
  answers: new Map<string, unknown>(),
  calls: [] as Array<{ path: string; body: unknown }>,
}));
vi.mock('@/lib/mcp/backend', () => ({
  callBackend: async (_env: unknown, path: string, schema: { parse: (v: unknown) => unknown }, init?: { body?: unknown }) => {
    backend.calls.push({ path, body: init?.body });
    if (!backend.answers.has(path)) throw new Error(`no answer for ${path}`);
    return schema.parse(backend.answers.get(path));
  },
}));

const db = vi.hoisted(() => ({
  job: null as { id: string; job_number: string; deleted_at: string | null } | null,
  ops: [] as Array<[string, unknown[]]>,
}));
vi.mock('@/lib/supabase', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'limit']) {
    chain[m] = (...args: unknown[]) => {
      db.ops.push([m, args]);
      return chain;
    };
  }
  chain.maybeSingle = async () => ({ data: db.job, error: null });
  return { getSupabase: () => ({ from: () => chain }), registerScopedClientResolver: () => {} };
});

const env: CompanyToolEnv = {
  caller: { token: 't', clientId: 'c', userId: 'u', email: null, expiresAt: 0 },
  company: { id: 'co-1', name: 'Acme Machining', role: 'user', isDemo: false, governingCompanyId: 'co-1' },
  origin: 'https://jigged.app',
  link: (path) => `https://jigged.app${path}`,
};

const JP1 = '00000000-0000-4000-8000-0000000000a1';
const JP2 = '00000000-0000-4000-8000-0000000000a2';
const PREFLIGHT = '/api/quickbooks/co-1/jobs/job-1/preflight';
const PUSH = '/api/quickbooks/co-1/jobs/job-1/invoice';

function part(overrides: Record<string, unknown> = {}) {
  return {
    job_part_id: JP1,
    part_name: 'BRKT-100',
    description: 'Bracket',
    unit_price: 12.5,
    qty_ordered: 10,
    qty_shipped: 6,
    qty_invoiced: 2,
    qty_invoiceable: 8,
    production_status: 'in_progress',
    ...overrides,
  };
}

function preflight(overrides: Record<string, unknown> = {}, customer: Record<string, unknown> = {}) {
  return {
    connected: true,
    provider: 'qbo',
    has_deep_links: true,
    blocked: null,
    customer: {
      status: 'mapped',
      qb_customer_id: '58',
      candidates: [],
      jigged_customer_id: 'cust-1',
      jigged_name: 'Boeing',
      ...customer,
    },
    parts: [
      part(),
      part({ job_part_id: JP2, part_name: 'PIN-7', description: null, unit_price: 3, qty_ordered: 5, qty_shipped: 5, qty_invoiced: 0, qty_invoiceable: 5 }),
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-09T18:00:00Z'));
  backend.answers.clear();
  backend.calls = [];
  db.job = { id: 'job-1', job_number: 'J-0141', deleted_at: null };
  db.ops = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('preview_invoice_push', () => {
  it('reports what the Invoice dialog would show, with the quantities it proposes', async () => {
    backend.answers.set(PREFLIGHT, preflight());
    const res = await previewInvoicePush.run({ job_number: ' J-0141 ' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(backend.calls).toEqual([{ path: PREFLIGHT, body: {} }]);
    expect(db.ops).toEqual(
      expect.arrayContaining([
        ['eq', ['company_id', 'co-1']],
        ['eq', ['job_number', 'J-0141']],
        ['is', ['deleted_at', null]],
      ]),
    );
    expect(res.data).toMatchObject({
      job_id: 'job-1',
      job_number: 'J-0141',
      quickbooks_connected: true,
      quickbooks: 'online',
      blocked_by_unconfirmed_invoice: false,
      customer: { customer_id: 'cust-1', name: 'Boeing', match: 'linked', quickbooks_customer_id: '58', on_push: 'use_linked' },
      missing: [],
      url: 'https://jigged.app/dashboard/co-1/jobs/job-1',
    });
    // Shipped but not yet invoiced: 6 − 2 = 4 of the bracket, all 5 pins.
    expect(res.data.parts.map((p) => [p.part_name, p.proposed_quantity])).toEqual([
      ['BRKT-100', 4],
      ['PIN-7', 5],
    ]);
    expect(res.data.proposed_total).toBe(65);
    expect(() => z.object(previewInvoicePush.output).parse(res.data)).not.toThrow();
  });

  it('says what is missing: no connection, an unconfirmed invoice, no price, a customer to choose', async () => {
    backend.answers.set(PREFLIGHT, { connected: false });
    const off = await previewInvoicePush.run({ job_number: 'J-0141' }, env);
    expect(off).toMatchObject({
      ok: true,
      data: { quickbooks_connected: false, quickbooks: null, customer: null, parts: [], missing: [expect.stringMatching(/^QuickBooks isn't connected/)] },
    });

    backend.answers.set(
      PREFLIGHT,
      preflight(
        { blocked: { code: 'qbd_blocked_unverified', link_id: 'l-1' }, provider: 'qbd', parts: [part({ unit_price: null })] },
        { status: 'candidates', qb_customer_id: null, candidates: [{ qb_id: '7', display_name: 'Boeing Co' }, { qb_id: '9', display_name: null }] },
      ),
    );
    const res = await previewInvoicePush.run({ job_number: 'J-0141' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(res.data.quickbooks).toBe('desktop');
    expect(res.data.customer).toMatchObject({
      match: 'candidates',
      on_push: 'choose',
      candidates: [
        { quickbooks_customer_id: '7', name: 'Boeing Co' },
        { quickbooks_customer_id: '9', name: null },
      ],
    });
    expect(res.data.parts[0].proposed_quantity).toBe(0);
    expect(res.data.missing).toEqual([
      'An earlier invoice for this job could not be confirmed in QuickBooks. Check it there before creating another.',
      'No part on this job has a price yet. Set one on the job, then invoice it.',
      expect.stringMatching(/^QuickBooks has several customers that could be Boeing/),
    ]);
  });

  it('says so when the job is not there', async () => {
    db.job = null;
    expect(await previewInvoicePush.run({ job_id: '00000000-0000-4000-8000-000000000404' }, env)).toEqual({
      ok: false,
      message: 'There is no job with that id in Acme Machining.',
    });
    expect(backend.calls).toEqual([]);
  });
});

describe('push_invoice_to_quickbooks', () => {
  it('pushes the chosen lines with the body the dialog sends, and returns the invoice', async () => {
    backend.answers.set(PREFLIGHT, preflight());
    backend.answers.set(PUSH, {
      qb_invoice_id: '177',
      doc_number: '1042',
      url: 'https://app.qbo.intuit.com/login?pagereq=invoice%3FtxnId%3D177',
      already_existed: false,
    });

    const lines = [
      { job_part_id: JP2, quantity: 5 },
      { job_part_id: JP1, quantity: 6 },
    ];
    const res = await pushInvoiceToQuickBooks.run({ job_id: '00000000-0000-4000-8000-000000000001', lines, invoice_date: '2026-11-09' }, env);
    if (!res.ok) throw new Error(res.message);

    const push = backend.calls.find((c) => c.path === PUSH);
    expect(push?.body).toEqual({
      customer: { action: 'use_existing', qb_customer_id: '58' },
      request_id: invoiceRequestId('co-1', 'job-1', lines, '2026-11-09'),
      // In the job's part order, as the dialog lists them.
      lines: [
        { job_part_id: JP1, quantity: 6 },
        { job_part_id: JP2, quantity: 5 },
      ],
      transaction_date: '2026-11-09',
    });
    expect(res.data).toEqual({
      job_id: 'job-1',
      job_number: 'J-0141',
      invoice_number: '1042',
      quickbooks_invoice_id: '177',
      already_existed: false,
      invoice_date: '2026-11-09',
      lines: [
        { job_part_id: JP1, part_name: 'BRKT-100', quantity: 6, unit_price: 12.5, total_price: 75 },
        { job_part_id: JP2, part_name: 'PIN-7', quantity: 5, unit_price: 3, total_price: 15 },
      ],
      total: 90,
      quickbooks_url: 'https://app.qbo.intuit.com/login?pagereq=invoice%3FtxnId%3D177',
      // 6 billed, only 4 shipped and not yet invoiced: the dialog's nudge.
      warnings: ['BRKT-100: billing 6, only 4 shipped so far.'],
      url: 'https://jigged.app/dashboard/co-1/jobs/job-1',
    });
    expect(() => z.object(pushInvoiceToQuickBooks.output).parse(res.data)).not.toThrow();
    expect(JSON.stringify(res.data)).not.toMatch(/pushed_by|linked_by|created_by/);
  });

  it('sends the same idempotency key when the same call is repeated the same day', async () => {
    backend.answers.set(PREFLIGHT, preflight());
    backend.answers.set(PUSH, { qb_invoice_id: '177', doc_number: '1042', url: null, already_existed: true });
    const args = { job_number: 'J-0141', lines: [{ job_part_id: JP1, quantity: 4 }, { job_part_id: JP2, quantity: 1 }] };

    const first = await pushInvoiceToQuickBooks.run(args, env);
    const again = await pushInvoiceToQuickBooks.run({ ...args, lines: [...args.lines].reverse() }, env);
    expect(again).toMatchObject({ ok: true, data: { already_existed: true, invoice_number: '1042' } });
    expect(first.ok).toBe(true);
    const keys = backend.calls.filter((c) => c.path === PUSH).map((c) => (c.body as { request_id: string }).request_id);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // A different quantity, job, company or day is a different invoice.
    const base = invoiceRequestId('co-1', 'job-1', [{ job_part_id: JP1, quantity: 4 }], '2026-11-09');
    expect(invoiceRequestId('co-1', 'job-1', [{ job_part_id: JP1, quantity: 5 }], '2026-11-09')).not.toBe(base);
    expect(invoiceRequestId('co-1', 'job-2', [{ job_part_id: JP1, quantity: 4 }], '2026-11-09')).not.toBe(base);
    expect(invoiceRequestId('co-2', 'job-1', [{ job_part_id: JP1, quantity: 4 }], '2026-11-09')).not.toBe(base);
    expect(invoiceRequestId('co-1', 'job-1', [{ job_part_id: JP1, quantity: 4 }], '2026-11-10')).not.toBe(base);
  });

  it('takes the exact match, creates an unmatched customer, and asks among similar names', async () => {
    backend.answers.set(PUSH, { qb_invoice_id: '1', doc_number: '1', url: null, already_existed: false });
    const lines = [{ job_part_id: JP1, quantity: 1 }];
    const pushBody = () => backend.calls.filter((c) => c.path === PUSH).at(-1)?.body as { customer: unknown };

    backend.answers.set(PREFLIGHT, preflight({}, { status: 'exact_match', qb_customer_id: '7', candidates: [{ qb_id: '7', display_name: 'Boeing' }] }));
    await pushInvoiceToQuickBooks.run({ job_number: 'J-0141', lines }, env);
    expect(pushBody().customer).toEqual({ action: 'use_existing', qb_customer_id: '7' });

    backend.answers.set(PREFLIGHT, preflight({}, { status: 'unmatched', qb_customer_id: null, candidates: [] }));
    await pushInvoiceToQuickBooks.run({ job_number: 'J-0141', lines }, env);
    expect(pushBody().customer).toEqual({ action: 'create' });
    expect(await pushInvoiceToQuickBooks.run({ job_number: 'J-0141', lines, quickbooks_customer_id: '7' }, env)).toEqual({
      ok: false,
      message: expect.stringMatching(/^QuickBooks has no customer matching Boeing/),
    });

    backend.answers.set(
      PREFLIGHT,
      preflight({}, { status: 'candidates', qb_customer_id: null, candidates: [{ qb_id: '7', display_name: 'Boeing Co' }, { qb_id: '9', display_name: 'Boeing Wichita' }] }),
    );
    const pushes = backend.calls.filter((c) => c.path === PUSH).length;
    expect(await pushInvoiceToQuickBooks.run({ job_number: 'J-0141', lines }, env)).toEqual({
      ok: false,
      message: expect.stringContaining('Choose one with quickbooks_customer_id (Boeing Co (quickbooks_customer_id 7); Boeing Wichita'),
    });
    expect(await pushInvoiceToQuickBooks.run({ job_number: 'J-0141', lines, quickbooks_customer_id: '8' }, env)).toEqual({
      ok: false,
      message: expect.stringMatching(/^That QuickBooks customer isn't one of the matches for Boeing/),
    });
    expect(backend.calls.filter((c) => c.path === PUSH).length).toBe(pushes);
    await pushInvoiceToQuickBooks.run({ job_number: 'J-0141', lines, quickbooks_customer_id: '9' }, env);
    expect(pushBody().customer).toEqual({ action: 'use_existing', qb_customer_id: '9' });
    await pushInvoiceToQuickBooks.run({ job_number: 'J-0141', lines, create_quickbooks_customer: true }, env);
    expect(pushBody().customer).toEqual({ action: 'create' });
  });

  it('refuses lines the dialog or the backend would refuse, before pushing', async () => {
    backend.answers.set(PREFLIGHT, preflight());
    const run = (lines: Array<{ job_part_id: string; quantity: number }>) =>
      pushInvoiceToQuickBooks.run({ job_number: 'J-0141', lines }, env);

    expect(await run([{ job_part_id: JP1, quantity: 9 }])).toEqual({
      ok: false,
      message: "Can't invoice 9 of BRKT-100: only 8 left to invoice.",
    });
    expect(await run([{ job_part_id: JP1, quantity: 1 }, { job_part_id: JP1, quantity: 1 }])).toEqual({
      ok: false,
      message: 'List each part once: BRKT-100 appears twice.',
    });
    expect(await run([{ job_part_id: '00000000-0000-4000-8000-0000000000ff', quantity: 1 }])).toEqual({
      ok: false,
      message: expect.stringContaining(`BRKT-100 (job_part_id ${JP1}); PIN-7 (job_part_id ${JP2})`),
    });
    backend.answers.set(PREFLIGHT, preflight({ parts: [part({ unit_price: null })] }));
    expect(await run([{ job_part_id: JP1, quantity: 1 }])).toEqual({
      ok: false,
      message: "BRKT-100 has no unit price and can't be invoiced. Set one on the job first.",
    });
    backend.answers.set(PREFLIGHT, preflight({ parts: [part({ qty_invoiced: 10, qty_invoiceable: 0 })] }));
    expect(await run([{ job_part_id: JP1, quantity: 1 }])).toEqual({ ok: false, message: 'BRKT-100 is already fully invoiced.' });
    expect(backend.calls.some((c) => c.path === PUSH)).toBe(false);

    const input = z.object(pushInvoiceToQuickBooks.input);
    expect(input.safeParse({ job_number: 'J-1', lines: [{ job_part_id: JP1, quantity: 0 }] }).success).toBe(false);
    expect(input.safeParse({ job_number: 'J-1', lines: [] }).success).toBe(false);
  });

  it('refuses when QuickBooks is not connected, a job is blocked or archived, or the date is out of range', async () => {
    const lines = [{ job_part_id: JP1, quantity: 1 }];
    backend.answers.set(PREFLIGHT, { connected: false });
    expect(await pushInvoiceToQuickBooks.run({ job_number: 'J-0141', lines }, env)).toEqual({
      ok: false,
      message: expect.stringMatching(/^QuickBooks isn't connected/),
    });
    backend.answers.set(PREFLIGHT, preflight({ blocked: { code: 'qbd_blocked_unverified', link_id: 'l-1' } }));
    expect(await pushInvoiceToQuickBooks.run({ job_number: 'J-0141', lines }, env)).toEqual({
      ok: false,
      message: 'An earlier invoice for this job could not be confirmed in QuickBooks. Check it there before creating another.',
    });
    expect(await pushInvoiceToQuickBooks.run({ job_number: 'J-0141', lines, invoice_date: '2026-11-01' }, env)).toEqual({
      ok: false,
      message: 'Invoice date must be within a day of today.',
    });
    db.job = { id: 'job-1', job_number: 'J-0141', deleted_at: '2026-11-01T00:00:00Z' };
    expect(await pushInvoiceToQuickBooks.run({ job_id: '00000000-0000-4000-8000-000000000001', lines }, env)).toEqual({
      ok: false,
      message: 'Job J-0141 is archived in Jigged, so no invoice was created.',
    });
    db.job = null;
    expect(await pushInvoiceToQuickBooks.run({ job_number: 'J-404', lines }, env)).toEqual({
      ok: false,
      message: 'There is no job J-404 in Acme Machining.',
    });
    expect(backend.calls.some((c) => c.path === PUSH)).toBe(false);
  });

  it('says so when a sibling push of the same draft is still running', async () => {
    backend.answers.set(PREFLIGHT, preflight());
    backend.answers.set(PUSH, { in_progress: true });
    expect(await pushInvoiceToQuickBooks.run({ job_number: 'J-0141', lines: [{ job_part_id: JP1, quantity: 1 }] }, env)).toEqual({
      ok: false,
      message: "This invoice is already being created. Check the job's invoices in a moment.",
    });
  });
});

describe('the invoice write catalogue', () => {
  it('declares the hints the brief sets', () => {
    const hints = Object.fromEntries(
      INVOICE_WRITE_TOOLS.map((t) => [t.name, [t.access, Boolean(t.destructive), Boolean(t.idempotent), Boolean(t.openWorld)]]),
    );
    expect(hints).toEqual({
      preview_invoice_push: ['read', false, false, true],
      push_invoice_to_quickbooks: ['write', true, false, true],
    });
  });
});
