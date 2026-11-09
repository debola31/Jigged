import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

import type { CompanyToolEnv } from '@/lib/mcp/defineTool';
import { getJobInvoices } from '@/lib/mcp/tools/invoices';
import type { QuickBooksInvoiceView } from '@/utils/quickbooksAccess';

/**
 * get_job_invoices, run directly. What matters: it reads only the stored invoice rows (no
 * QuickBooks call), finds the job in this company by id or number, and shows a salesperson the
 * same amounts the job page's Invoices menu does.
 */

const mockInvoices = vi.fn();
const mockSync = vi.fn();
vi.mock('@/utils/quickbooksAccess', () => ({
  getQuickBooksInvoiceLinksForJob: (...a: unknown[]) => mockInvoices(...a),
  syncQuickBooksInvoiceStatus: (...a: unknown[]) => mockSync(...a),
}));

const db = vi.hoisted(() => ({
  job: null as { id: string; job_number: string } | null,
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
  link: (path) => `https://jigged.app${path}`,
};

function invoice(overrides: Partial<QuickBooksInvoiceView>): QuickBooksInvoiceView {
  return {
    id: 'link-1',
    invoiceId: 'qb-77',
    docNumber: '1042',
    url: 'https://app.qbo.intuit.com/app/invoice?txnId=77',
    createdAt: '2026-11-03T16:00:00Z',
    lines: [{ jobPartId: 'jp-1', partName: 'BRKT-100', quantity: 10, unitPrice: 12.5, totalPrice: 125 }],
    total: 125,
    provider: 'qbo',
    realmId: 'realm-1',
    voidedAt: null,
    qbTxnDate: '2026-11-03',
    correctedAt: null,
    qbStatus: 'partial',
    qbTotalAmt: 135,
    qbBalance: 35,
    qbDueDate: '2026-12-03',
    qbStatusCheckedAt: '2026-11-05T12:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.job = null;
  db.ops = [];
});

describe('get_job_invoices', () => {
  it('returns each invoice with its lines and QuickBooks status, amounts included for an office user', async () => {
    db.job = { id: 'job-1', job_number: 'J-1001' };
    mockInvoices.mockResolvedValue([invoice({})]);
    const res = await getJobInvoices.run({ job_id: '00000000-0000-4000-8000-000000000001' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(mockInvoices).toHaveBeenCalledWith('co-1', 'job-1');
    expect(mockSync).not.toHaveBeenCalled();
    expect(db.ops).toEqual(
      expect.arrayContaining([
        ['eq', ['company_id', 'co-1']],
        ['eq', ['id', '00000000-0000-4000-8000-000000000001']],
      ]),
    );
    // A by-id read: an archived job's invoices still resolve.
    expect(db.ops.some(([m]) => m === 'is')).toBe(false);
    expect(res.data).toMatchObject({ job_id: 'job-1', job_number: 'J-1001', url: 'https://jigged.app/dashboard/co-1/jobs/job-1' });
    expect(res.data.invoices[0]).toEqual({
      invoice_id: 'link-1',
      invoice_number: '1042',
      quickbooks: 'online',
      issued_at: '2026-11-03T16:00:00Z',
      invoice_date: '2026-11-03',
      due_date: '2026-12-03',
      lines: [{ job_part_id: 'jp-1', part_name: 'BRKT-100', quantity: 10, unit_price: 12.5, total_price: 125 }],
      total: 125,
      quickbooks_total: 135,
      quickbooks_balance: 35,
      payment_status: 'partial',
      payment_status_checked_at: '2026-11-05T12:00:00Z',
      voided: false,
      voided_at: null,
      quantities_corrected_at: null,
      quickbooks_url: 'https://app.qbo.intuit.com/app/invoice?txnId=77',
      url: 'https://jigged.app/dashboard/co-1/jobs/job-1',
    });
  });

  it('marks a Desktop invoice and a voided one', async () => {
    db.job = { id: 'job-1', job_number: 'J-1001' };
    mockInvoices.mockResolvedValue([
      invoice({ id: 'd', provider: 'qbd', url: null, qbStatus: null, qbBalance: null, qbTotalAmt: null, qbStatusCheckedAt: null }),
      invoice({ id: 'v', voidedAt: '2026-11-04T00:00:00Z', qbStatus: 'voided' }),
    ]);
    const res = await getJobInvoices.run({ job_number: 'J-1001' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(res.data.invoices[0]).toMatchObject({ quickbooks: 'desktop', quickbooks_url: null, payment_status: null });
    expect(res.data.invoices[1]).toMatchObject({ voided: true, payment_status: 'voided' });
    expect(() => z.object(getJobInvoices.output).parse(res.data)).not.toThrow();
  });

  it('finds the job by number among live jobs', async () => {
    db.job = { id: 'job-1', job_number: 'J-1001' };
    mockInvoices.mockResolvedValue([]);
    const res = await getJobInvoices.run({ job_number: ' J-1001 ' }, env);
    expect(res).toMatchObject({ ok: true, text: 'Job J-1001 has no QuickBooks invoices in Jigged.' });
    expect(db.ops).toEqual(
      expect.arrayContaining([
        ['eq', ['job_number', 'J-1001']],
        ['is', ['deleted_at', null]],
      ]),
    );
  });

  it('says so when the job is not there, or none was named', async () => {
    expect(await getJobInvoices.run({ job_number: 'J-404' }, env)).toEqual({
      ok: false,
      message: 'There is no job J-404 in Acme Machining.',
    });
    expect(await getJobInvoices.run({ job_id: '00000000-0000-4000-8000-000000000404' }, env)).toEqual({
      ok: false,
      message: 'There is no job with that id in Acme Machining.',
    });
    expect(await getJobInvoices.run({}, env)).toEqual({ ok: false, message: 'Give a job_id or a job_number.' });
    expect(mockInvoices).not.toHaveBeenCalled();
  });
});
