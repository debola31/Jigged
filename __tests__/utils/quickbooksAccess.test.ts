import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  getTypedSupabase: () => mockSupabase,
}));

import {
  getJobPartInvoiceSummaries,
  getQuickBooksInvoiceLinksForJob,
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

describe('getQuickBooksInvoiceLinksForJob', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps links to views with per-part lines, part names, and a summed total', async () => {
    const links = buildQueryStub({
      data: [
        {
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
});
