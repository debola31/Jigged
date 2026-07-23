import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockQueryBuilder, mockSupabase } = vi.hoisted(() => {
  const builder: Record<string, ReturnType<typeof vi.fn> | unknown> = {};
  const chainMethods = [
    'from', 'select', 'insert', 'update', 'delete',
    'eq', 'neq', 'or', 'in', 'is', 'order', 'range', 'limit', 'lt', 'not', 'single', 'maybeSingle',
  ];
  chainMethods.forEach((m) => {
    builder[m] = vi.fn().mockImplementation(() => builder);
  });
  builder.data = null;
  builder.error = null;
  builder.count = null;
  const supabase = {
    from: vi.fn().mockImplementation(() => builder),
    rpc: vi.fn(),
  };
  return { mockQueryBuilder: builder, mockSupabase: supabase };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mockSupabase,
  getTypedSupabase: () => mockSupabase,
}));

// updateJobPartQuantity / deleteJob orchestrate cross-module readers — stub them
// so the test drives only the job_parts / jobs queries it owns.
vi.mock('@/utils/shipmentsAccess', () => ({
  getJobPartShipmentSummaries: vi.fn(),
  countShipmentsForJob: vi.fn(),
}));
vi.mock('@/utils/quickbooksAccess', () => ({
  getQuickBooksInvoiceLinkForJob: vi.fn(),
  getJobPartInvoiceSummaries: vi.fn(),
}));

import {
  applyOverdueJobsFilter,
  deleteJob,
  bulkCancelJobs,
  completeJobOperation,
  undoJobOperation,
  deriveStatusFromOps,
  createJobFromPurchaseOrder,
  getAllJobs,
  getCustomersForSelect,
  getReadyOperationsForJobs,
  reopenJob,
  searchJobsByIdentifier,
  updateJobAddressContact,
  updateJobDetails,
  updateJobPartPrice,
  updateJobPartQuantity,
} from '@/utils/jobsAccess';
import { getJobPartShipmentSummaries, countShipmentsForJob } from '@/utils/shipmentsAccess';
import {
  getQuickBooksInvoiceLinkForJob,
  getJobPartInvoiceSummaries,
} from '@/utils/quickbooksAccess';

describe('jobsAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation(() => mockQueryBuilder);
    Object.keys(mockQueryBuilder).forEach((k) => {
      const v = mockQueryBuilder[k];
      if (typeof v === 'function' && 'mockClear' in v) {
        (v as ReturnType<typeof vi.fn>).mockClear();
        (v as ReturnType<typeof vi.fn>).mockImplementation(() => mockQueryBuilder);
      }
    });
    mockQueryBuilder.data = null;
    mockQueryBuilder.error = null;
    mockQueryBuilder.count = null;
  });

  describe('deleteJob', () => {
    // deleteJob ARCHIVES (universal soft-delete): confirm existence + tenant scope,
    // then stamp deleted_at via .update() scoped by id + company_id. It is never
    // gated by records of value — shipments/invoices no longer block it — and does
    // no storage cleanup. The existence load and the archive update both hit
    // from('jobs'); the mock serves select + update and captures the update patch
    // and its eq() scoping.
    function installJobsFrom(opts: {
      jobRow?: { id: string } | null;
      loadError?: { message: string } | null;
      updateError?: { message: string } | null;
    }) {
      const jobRow = opts.jobRow === undefined ? { id: 'j1' } : opts.jobRow;
      const updateEqArgs: Array<[string, unknown]> = [];
      const updateFn = vi.fn().mockImplementation(() => ({
        eq: vi.fn().mockImplementation((c1: string, v1: unknown) => {
          updateEqArgs.push([c1, v1]);
          return {
            eq: vi.fn().mockImplementation((c2: string, v2: unknown) => {
              updateEqArgs.push([c2, v2]);
              return Promise.resolve({ error: opts.updateError ?? null });
            }),
          };
        }),
      }));
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
        if (table === 'jobs') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi
                    .fn()
                    .mockResolvedValue({ data: jobRow, error: opts.loadError ?? null }),
                }),
              }),
            }),
            update: updateFn,
          };
        }
        throw new Error(`unexpected table ${table}`);
      });
      return { updateFn, updateEqArgs };
    }

    it('archives a job by stamping deleted_at, scoped to id + company_id (any status)', async () => {
      const { updateFn, updateEqArgs } = installJobsFrom({});
      await deleteJob('j1', 'co-1');
      expect(updateFn).toHaveBeenCalledTimes(1);
      const patch = updateFn.mock.calls[0][0] as Record<string, unknown>;
      expect(patch).toHaveProperty('deleted_at');
      expect(typeof patch.deleted_at).toBe('string');
      expect(updateEqArgs).toContainEqual(['id', 'j1']);
      expect(updateEqArgs).toContainEqual(['company_id', 'co-1']);
    });

    it('archives even when the job has shipments and an invoice (records-of-value guards removed)', async () => {
      // The old hard-delete refused shipped/invoiced jobs. Archiving preserves the
      // row and all its history, so it always succeeds regardless of downstream refs.
      vi.mocked(countShipmentsForJob).mockResolvedValue(2);
      vi.mocked(getQuickBooksInvoiceLinkForJob).mockResolvedValue({
        invoiceId: 'i1',
        docNumber: '1001',
        url: 'http://qb.example/invoice/1',
      });
      const { updateFn } = installJobsFrom({});
      await expect(deleteJob('j1', 'co-1')).resolves.toBeUndefined();
      expect(updateFn).toHaveBeenCalledTimes(1);
      expect(updateFn.mock.calls[0][0]).toHaveProperty('deleted_at');
    });

    it('throws "Job not found" when the job row is missing', async () => {
      installJobsFrom({ jobRow: null });
      await expect(deleteJob('j1', 'co-1')).rejects.toThrow(/not found/i);
    });

    it('throws a friendly error when the archive update fails', async () => {
      installJobsFrom({ updateError: { message: 'boom' } });
      await expect(deleteJob('j1', 'co-1')).rejects.toBeTruthy();
    });
  });

  describe('bulkCancelJobs', () => {
    it('short-circuits on empty input without calling supabase', async () => {
      await bulkCancelJobs([]);
      expect(mockSupabase.from).not.toHaveBeenCalled();
    });

    it('filters out non-string ids and marks job_parts cancelled by job_id', async () => {
      mockQueryBuilder.error = null;
      // @ts-expect-error — runtime defense exercise; the function filters
      // out anything that isn't a non-empty string.
      await bulkCancelJobs(['j1', null, '', 'j2']);
      expect(mockSupabase.from).toHaveBeenCalledWith('job_parts');
      const patch = (mockQueryBuilder.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(patch.production_status).toBe('cancelled');
      const inCall = (mockQueryBuilder.in as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => c[0] === 'job_id',
      );
      expect(inCall).toBeDefined();
      expect(inCall![1]).toEqual(['j1', 'j2']);
    });

    it('throws a friendly (non-raw) error when supabase returns an error', async () => {
      // Raw "permission denied" must be translated, not surfaced verbatim.
      mockQueryBuilder.error = { message: 'permission denied' };
      await expect(bulkCancelJobs(['j1'])).rejects.toThrow(/don't have permission/);
    });
  });

  describe('getCustomersForSelect', () => {
    it('queries customers by company_id and orders by name', async () => {
      mockQueryBuilder.data = [
        { id: 'cu1', name: 'Acme' },
        { id: 'cu2', name: 'Beta' },
      ];
      const customers = await getCustomersForSelect('co-1');
      expect(mockSupabase.from).toHaveBeenCalledWith('customers');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('company_id', 'co-1');
      expect(mockQueryBuilder.order).toHaveBeenCalledWith('name');
      expect(customers).toHaveLength(2);
    });

    it('returns [] when data is null', async () => {
      mockQueryBuilder.data = null;
      const customers = await getCustomersForSelect('co-1');
      expect(customers).toEqual([]);
    });
  });

  describe('applyOverdueJobsFilter', () => {
    it('applies the canonical overdue clauses and returns the same builder', () => {
      const builder: Record<string, ReturnType<typeof vi.fn>> = {};
      ['not', 'lt', 'in'].forEach((m) => {
        builder[m] = vi.fn().mockImplementation(() => builder);
      });

      const result = applyOverdueJobsFilter(builder);

      expect(result).toBe(builder);
      // Past due (local date), production active, not fully shipped — the single
      // server-side definition shared by the list filter and dashboard count.
      expect(builder.not).toHaveBeenNthCalledWith(1, 'due_date', 'is', null);
      expect(builder.lt).toHaveBeenCalledWith('due_date', expect.any(String));
      expect(builder.not).toHaveBeenNthCalledWith(2, 'fulfillment_status', 'eq', 'fully_shipped');
      expect(builder.in).toHaveBeenCalledWith('production_status', ['not_started', 'in_progress']);
    });
  });

  describe('getReadyOperationsForJobs', () => {
    it('short-circuits on empty input without calling RPC', async () => {
      const result = await getReadyOperationsForJobs([]);
      expect(result.size).toBe(0);
      expect(mockSupabase.rpc).not.toHaveBeenCalled();
    });

    it('maps RPC rows into a Map<job_id, CurrentOperationInfo>', async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [
          { job_id: 'j1', operation_name: 'Mill', ready_count: 2 },
          { job_id: 'j2', operation_name: 'Drill', ready_count: 1 },
        ],
        error: null,
      });
      const result = await getReadyOperationsForJobs(['j1', 'j2']);
      expect(mockSupabase.rpc).toHaveBeenCalledWith('get_ready_operations_batch', {
        p_job_ids: ['j1', 'j2'],
      });
      expect(result.get('j1')).toEqual({ operationName: 'Mill', readyCount: 2 });
      expect(result.get('j2')).toEqual({ operationName: 'Drill', readyCount: 1 });
    });

    it('returns an empty Map when RPC errors (defensive — dashboard tile should not crash)', async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: null,
        error: { message: 'timeout' },
      });
      const result = await getReadyOperationsForJobs(['j1']);
      expect(result.size).toBe(0);
    });
  });

  describe('updateJobAddressContact', () => {
    it('writes the three FKs scoped to job + company, translating "" to null', async () => {
      mockQueryBuilder.data = { id: 'j1' };
      mockQueryBuilder.error = null;
      await updateJobAddressContact('j1', 'co-1', {
        shipping_address_id: 'addr-ship',
        billing_address_id: '',
        contact_id: 'contact-1',
      });
      expect(mockSupabase.from).toHaveBeenCalledWith('jobs');
      const patch = (mockQueryBuilder.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(patch.shipping_address_id).toBe('addr-ship');
      expect(patch.billing_address_id).toBeNull();
      expect(patch.contact_id).toBe('contact-1');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'j1');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('company_id', 'co-1');
    });

    it('omits keys left undefined so a partial update does not clobber other FKs', async () => {
      mockQueryBuilder.data = { id: 'j1' };
      mockQueryBuilder.error = null;
      await updateJobAddressContact('j1', 'co-1', { contact_id: 'contact-2' });
      const patch = (mockQueryBuilder.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(patch.contact_id).toBe('contact-2');
      expect(patch.shipping_address_id).toBeUndefined();
      expect(patch.billing_address_id).toBeUndefined();
    });

    it('throws a friendly (non-raw) error when supabase returns an error', async () => {
      mockQueryBuilder.error = { message: 'permission denied' };
      await expect(
        updateJobAddressContact('j1', 'co-1', { contact_id: 'c1' }),
      ).rejects.toThrow(/don't have permission/);
    });
  });

  describe('searchJobsByIdentifier', () => {
    it('short-circuits on empty/whitespace queries', async () => {
      const result = await searchJobsByIdentifier('co-1', '   ');
      expect(result).toEqual([]);
      expect(mockSupabase.rpc).not.toHaveBeenCalled();
    });

    it('passes the trimmed query to the RPC and returns its rows', async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [{ job_id: 'j1', match_source: 'job_number' }],
        error: null,
      });
      const result = await searchJobsByIdentifier('co-1', '  ADP-001  ');
      expect(mockSupabase.rpc).toHaveBeenCalledWith('search_jobs_by_identifier', {
        p_company_id: 'co-1',
        p_query: 'ADP-001',
      });
      expect(result).toEqual([{ job_id: 'j1', match_source: 'job_number' }]);
    });

    it('throws when the RPC returns an error', async () => {
      (mockSupabase.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: null,
        error: { message: 'invalid query' },
      });
      await expect(searchJobsByIdentifier('co-1', 'x')).rejects.toThrow(/invalid query/);
    });
  });

  describe('createJobFromPurchaseOrder', () => {
    const baseInput = {
      customer_id: 'cu-1',
      customer_po_number: 'PO-9',
      due_date: null as string | null,
      lines: [{ part_id: 'part-A', quantity: 2, unit_price: 10 }],
    };

    it('requires a customer PO (no silent NULL) and writes nothing', async () => {
      await expect(
        createJobFromPurchaseOrder('co-1', { ...baseInput, customer_po_number: '   ' }),
      ).rejects.toThrow(/Customer PO is required/);
      expect(mockSupabase.from).not.toHaveBeenCalled();
    });

    it('requires a customer', async () => {
      await expect(
        createJobFromPurchaseOrder('co-1', { ...baseInput, customer_id: '' }),
      ).rejects.toThrow(/Select a customer/);
    });

    it('requires at least one line', async () => {
      await expect(
        createJobFromPurchaseOrder('co-1', { ...baseInput, lines: [] }),
      ).rejects.toThrow(/at least one part/);
    });

    it('rejects a non-positive or non-integer quantity', async () => {
      await expect(
        createJobFromPurchaseOrder('co-1', {
          ...baseInput,
          lines: [{ part_id: 'part-A', quantity: 0, unit_price: 10 }],
        }),
      ).rejects.toThrow(/whole number greater than zero/);
    });

    it('rejects a negative unit price', async () => {
      await expect(
        createJobFromPurchaseOrder('co-1', {
          ...baseInput,
          lines: [{ part_id: 'part-A', quantity: 1, unit_price: -5 }],
        }),
      ).rejects.toThrow(/valid unit price/);
    });

    it('rejects duplicate parts before any write', async () => {
      await expect(
        createJobFromPurchaseOrder('co-1', {
          ...baseInput,
          lines: [
            { part_id: 'part-A', quantity: 1, unit_price: 10 },
            { part_id: 'part-A', quantity: 2, unit_price: 9 },
          ],
        }),
      ).rejects.toThrow(/only once/);
      expect(mockSupabase.from).not.toHaveBeenCalled();
    });

    it('fails fast when a part has no routing (existing-parts-only gate)', async () => {
      mockQueryBuilder.data = []; // routings lookup returns none
      await expect(createJobFromPurchaseOrder('co-1', baseInput)).rejects.toThrow(
        /No routing defined/,
      );
      expect(mockSupabase.from).toHaveBeenCalledWith('routings');
    });
  });

  describe('reopenJob', () => {
    it('recomputes each part status from its operations (bypassing the cancelled-skip)', async () => {
      // reopenJob deliberately ignores the parts' current (cancelled) status —
      // it derives each one purely from its operations. Capture every update so
      // we can assert the resolved status per part.
      const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];

      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
        if (table === 'job_parts') {
          return {
            // .select('id, started_at, completed_at').eq('job_id', jobId)
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({
                data: [
                  { id: 'p-done', started_at: null, completed_at: null },
                  { id: 'p-mixed', started_at: null, completed_at: null },
                  { id: 'p-fresh', started_at: '2026-01-01T00:00:00Z', completed_at: '2026-02-01T00:00:00Z' },
                ],
                error: null,
              }),
            }),
            // .update(patch).eq('id', id)
            update: vi.fn().mockImplementation((patch: Record<string, unknown>) => ({
              eq: vi.fn().mockImplementation((_col: string, id: string) => {
                updates.push({ id, patch });
                return Promise.resolve({ error: null });
              }),
            })),
          };
        }
        if (table === 'job_operations') {
          return {
            // .select('job_part_id, status').in('job_part_id', ids)
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({
                data: [
                  { job_part_id: 'p-done', status: 'completed' },
                  { job_part_id: 'p-done', status: 'completed' },
                  { job_part_id: 'p-mixed', status: 'completed' },
                  { job_part_id: 'p-mixed', status: 'pending' },
                  // p-fresh intentionally has no operations
                ],
                error: null,
              }),
            }),
          };
        }
        // jobs: .select('*').eq('id', jobId).single()
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { id: 'job-1', production_status: 'in_progress' },
                error: null,
              }),
            }),
          }),
        };
      });

      const job = await reopenJob('job-1');

      const byId = (id: string) => updates.find((u) => u.id === id);
      expect(byId('p-done')?.patch.production_status).toBe('completed');
      expect(byId('p-mixed')?.patch.production_status).toBe('in_progress');
      // No operations → reactivated to not_started, with started/completed cleared.
      expect(byId('p-fresh')?.patch.production_status).toBe('not_started');
      expect(byId('p-fresh')?.patch.started_at).toBeNull();
      expect(byId('p-fresh')?.patch.completed_at).toBeNull();
      expect(updates).toHaveLength(3);

      // Returns the job row the aggregation trigger flipped off 'cancelled'.
      expect(job).toEqual({ id: 'job-1', production_status: 'in_progress' });
    });
  });

  describe('updateJobPartQuantity', () => {
    // Frozen 3-tier snapshot: qty 1 → $130, qty 10 → $100, qty 50 → $90.
    const snapshot = {
      tiers: [
        { id: 't1', quantity: 1, unit_price: 130, markup_percent: null },
        { id: 't2', quantity: 10, unit_price: 100, markup_percent: null },
        { id: 't3', quantity: 50, unit_price: 90, markup_percent: null },
      ],
      resolved_tier_id: 't2',
      resolved_quantity: 10,
      captured_at: '2026-06-01T00:00:00Z',
    };

    const baseJobPart = {
      id: 'jp1',
      job_id: 'job1',
      company_id: 'co1',
      quantity: 10,
      unit_price: 100,
      total_price: 1000,
      source_quote_line_item_id: 'qli1',
      production_status: 'in_progress',
    };

    // from() impl serving the job_part fetch, the pricing-basis quote_line_items
    // fetch, and capturing the job_parts update patch.
    function installFrom(opts: {
      jobPart?: Record<string, unknown> | null;
      quoteLine?: Record<string, unknown> | null;
      updates: Array<Record<string, unknown>>;
    }) {
      const jobPart = opts.jobPart === undefined ? baseJobPart : opts.jobPart;
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
        if (table === 'job_parts') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: jobPart, error: null }),
              }),
            }),
            update: vi.fn().mockImplementation((patch: Record<string, unknown>) => ({
              eq: vi.fn().mockReturnValue({
                select: vi.fn().mockReturnValue({
                  single: vi.fn().mockImplementation(() => {
                    opts.updates.push(patch);
                    return Promise.resolve({ data: { ...jobPart, ...patch }, error: null });
                  }),
                }),
              }),
            })),
          };
        }
        if (table === 'quote_line_items') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: opts.quoteLine ?? null, error: null }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      });
    }

    const tieredLine = { is_quote_override: false, basis_unknown: false, pricing_basis_snapshot: snapshot };

    beforeEach(() => {
      vi.mocked(getJobPartShipmentSummaries).mockResolvedValue([
        { job_part_id: 'jp1', qty_ordered: 10, qty_shipped: 0, qty_remaining: 10, last_ship_date: null },
      ]);
      vi.mocked(getJobPartInvoiceSummaries).mockResolvedValue([
        { job_part_id: 'jp1', qty_ordered: 10, qty_invoiced: 0 },
      ]);
    });

    it('keeps the agreed unit price by default and recomputes the total; never writes fulfillment_status', async () => {
      const updates: Array<Record<string, unknown>> = [];
      installFrom({ quoteLine: tieredLine, updates });
      const result = await updateJobPartQuantity('jp1', 15);
      expect(updates).toHaveLength(1);
      expect(updates[0].quantity).toBe(15);
      expect(updates[0].unit_price).toBe(100);
      expect(updates[0].total_price).toBe(1500);
      expect(result.priceReresolved).toBe(false);
      // fulfillment_status is recomputed by the DB trigger, never written here.
      expect(updates[0]).not.toHaveProperty('fulfillment_status');
    });

    it('applies the quantity-break price when the caller opts in and the tier crosses', async () => {
      const updates: Array<Record<string, unknown>> = [];
      installFrom({ quoteLine: tieredLine, updates });
      const result = await updateJobPartQuantity('jp1', 50, { useNewTierPrice: true });
      expect(updates[0].unit_price).toBe(90);
      expect(updates[0].total_price).toBe(4500);
      expect(result.priceReresolved).toBe(true);
    });

    it('keeps the agreed price across a tier when the caller does NOT opt in', async () => {
      const updates: Array<Record<string, unknown>> = [];
      installFrom({ quoteLine: tieredLine, updates });
      const result = await updateJobPartQuantity('jp1', 50);
      expect(updates[0].unit_price).toBe(100);
      expect(updates[0].total_price).toBe(5000);
      expect(result.priceReresolved).toBe(false);
    });

    it('never re-resolves an override line (price pinned even with opt-in)', async () => {
      const updates: Array<Record<string, unknown>> = [];
      installFrom({ quoteLine: { ...tieredLine, is_quote_override: true }, updates });
      await updateJobPartQuantity('jp1', 50, { useNewTierPrice: true });
      expect(updates[0].unit_price).toBe(100);
      expect(updates[0].total_price).toBe(5000);
    });

    it('keeps the price for a PO-sourced job_part (no source quote line)', async () => {
      const updates: Array<Record<string, unknown>> = [];
      installFrom({ jobPart: { ...baseJobPart, source_quote_line_item_id: null }, updates });
      await updateJobPartQuantity('jp1', 25, { useNewTierPrice: true });
      expect(updates[0].unit_price).toBe(100);
      expect(updates[0].total_price).toBe(2500);
    });

    it('accepts a fractional quantity', async () => {
      const updates: Array<Record<string, unknown>> = [];
      installFrom({ jobPart: { ...baseJobPart, source_quote_line_item_id: null }, updates });
      await updateJobPartQuantity('jp1', 12.5);
      expect(updates[0].quantity).toBe(12.5);
      expect(updates[0].total_price).toBe(1250);
    });

    it('rounds the line total to 4 decimal places (matching numeric(12,4))', async () => {
      const updates: Array<Record<string, unknown>> = [];
      installFrom({ jobPart: { ...baseJobPart, source_quote_line_item_id: null, unit_price: 1.3333 }, updates });
      await updateJobPartQuantity('jp1', 3);
      expect(updates[0].total_price).toBe(3.9999);
    });

    it('blocks reducing below the already-shipped quantity', async () => {
      vi.mocked(getJobPartShipmentSummaries).mockResolvedValue([
        { job_part_id: 'jp1', qty_ordered: 10, qty_shipped: 10, qty_remaining: 0, last_ship_date: '2026-06-10' },
      ]);
      const updates: Array<Record<string, unknown>> = [];
      installFrom({ quoteLine: tieredLine, updates });
      await expect(updateJobPartQuantity('jp1', 5)).rejects.toThrow(/already shipped/i);
      expect(updates).toHaveLength(0);
    });

    it('allows INCREASING quantity even after the part is invoiced (the 10 -> 15 case)', async () => {
      // 9 invoiced; raising the order to 15 is how you bill the extra 6 on a new invoice.
      vi.mocked(getJobPartInvoiceSummaries).mockResolvedValue([
        { job_part_id: 'jp1', qty_ordered: 10, qty_invoiced: 9 },
      ]);
      const updates: Array<Record<string, unknown>> = [];
      installFrom({ quoteLine: tieredLine, updates });
      const result = await updateJobPartQuantity('jp1', 15);
      expect(updates).toHaveLength(1);
      expect(updates[0].quantity).toBe(15);
      expect(result.newQuantity).toBe(15);
    });

    it('blocks reducing below the already-invoiced quantity', async () => {
      // Shipment voided after invoicing → invoiced (9) exceeds shipped (0); the
      // invoiced-floor still blocks dropping below 9.
      vi.mocked(getJobPartInvoiceSummaries).mockResolvedValue([
        { job_part_id: 'jp1', qty_ordered: 10, qty_invoiced: 9 },
      ]);
      const updates: Array<Record<string, unknown>> = [];
      installFrom({ quoteLine: tieredLine, updates });
      await expect(updateJobPartQuantity('jp1', 5)).rejects.toThrow(/already been invoiced/i);
      expect(updates).toHaveLength(0);
    });

    it('rejects a non-positive quantity before any read', async () => {
      await expect(updateJobPartQuantity('jp1', 0)).rejects.toThrow(/greater than zero/i);
    });

    it('refuses to edit a cancelled part', async () => {
      const updates: Array<Record<string, unknown>> = [];
      installFrom({ jobPart: { ...baseJobPart, production_status: 'cancelled' }, updates });
      await expect(updateJobPartQuantity('jp1', 15)).rejects.toThrow(/cancelled/i);
      expect(updates).toHaveLength(0);
    });
  });

  describe('updateJobPartPrice', () => {
    const baseJobPart = {
      id: 'jp1',
      job_id: 'job1',
      company_id: 'co1',
      quantity: 10,
      unit_price: 100,
      total_price: 1000,
      production_status: 'in_progress',
    };

    // updateJobPartPrice writes job_parts via .update().eq('id').eq('company_id')
    // .select('*').single() — two eq's, unlike the quantity path's single eq.
    function installFrom(opts: {
      jobPart?: Record<string, unknown> | null;
      updates: Array<Record<string, unknown>>;
    }) {
      const jobPart = opts.jobPart === undefined ? baseJobPart : opts.jobPart;
      (mockSupabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
        if (table === 'job_parts') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: jobPart, error: null }),
              }),
            }),
            update: vi.fn().mockImplementation((patch: Record<string, unknown>) => ({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  select: vi.fn().mockReturnValue({
                    single: vi.fn().mockImplementation(() => {
                      opts.updates.push(patch);
                      return Promise.resolve({ data: { ...jobPart, ...patch }, error: null });
                    }),
                  }),
                }),
              }),
            })),
          };
        }
        throw new Error(`unexpected table ${table}`);
      });
    }

    beforeEach(() => {
      vi.mocked(getJobPartInvoiceSummaries).mockResolvedValue([
        { job_part_id: 'jp1', qty_ordered: 10, qty_invoiced: 0 },
      ]);
    });

    it('recomputes the total at the new price; never writes fulfillment_status', async () => {
      const updates: Array<Record<string, unknown>> = [];
      installFrom({ updates });
      const result = await updateJobPartPrice('jp1', 125);
      expect(updates).toHaveLength(1);
      expect(updates[0].unit_price).toBe(125);
      expect(updates[0].total_price).toBe(1250);
      expect(updates[0]).not.toHaveProperty('fulfillment_status');
      expect(result.oldUnitPrice).toBe(100);
      expect(result.newUnitPrice).toBe(125);
      expect(result.oldTotalPrice).toBe(1000);
      expect(result.newTotalPrice).toBe(1250);
    });

    it('rounds the recomputed total to 4dp', async () => {
      const updates: Array<Record<string, unknown>> = [];
      installFrom({ jobPart: { ...baseJobPart, quantity: 3 }, updates });
      await updateJobPartPrice('jp1', 1.3333);
      expect(updates[0].total_price).toBe(3.9999);
    });

    it('allows a zero (no-charge) price', async () => {
      const updates: Array<Record<string, unknown>> = [];
      installFrom({ updates });
      const result = await updateJobPartPrice('jp1', 0);
      expect(updates[0].unit_price).toBe(0);
      expect(updates[0].total_price).toBe(0);
      expect(result.newTotalPrice).toBe(0);
    });

    it('sets a real price on a NULL-priced (legacy) line', async () => {
      const updates: Array<Record<string, unknown>> = [];
      installFrom({
        jobPart: { ...baseJobPart, unit_price: null, total_price: null, quantity: 4 },
        updates,
      });
      const result = await updateJobPartPrice('jp1', 50);
      expect(updates[0].unit_price).toBe(50);
      expect(updates[0].total_price).toBe(200);
      expect(result.oldUnitPrice).toBeNull();
      expect(result.newUnitPrice).toBe(50);
    });

    it('rejects a negative price before any read', async () => {
      const updates: Array<Record<string, unknown>> = [];
      installFrom({ updates });
      await expect(updateJobPartPrice('jp1', -5)).rejects.toThrow(/zero or more/i);
      expect(updates).toHaveLength(0);
    });

    it('locks the price once ANY quantity of the part is invoiced', async () => {
      vi.mocked(getJobPartInvoiceSummaries).mockResolvedValue([
        { job_part_id: 'jp1', qty_ordered: 10, qty_invoiced: 4 },
      ]);
      const updates: Array<Record<string, unknown>> = [];
      installFrom({ updates });
      await expect(updateJobPartPrice('jp1', 125)).rejects.toThrow(/price is locked/i);
      expect(updates).toHaveLength(0);
    });

    it('still allows repricing a part with no invoiced quantity on a partially-invoiced job', async () => {
      // jp1 has 0 invoiced (a sibling part on the job may be invoiced) → repriceable.
      vi.mocked(getJobPartInvoiceSummaries).mockResolvedValue([
        { job_part_id: 'jp1', qty_ordered: 10, qty_invoiced: 0 },
        { job_part_id: 'jp2', qty_ordered: 5, qty_invoiced: 5 },
      ]);
      const updates: Array<Record<string, unknown>> = [];
      installFrom({ updates });
      const result = await updateJobPartPrice('jp1', 125);
      expect(updates[0].unit_price).toBe(125);
      expect(result.newUnitPrice).toBe(125);
    });

    it('refuses to edit a cancelled part', async () => {
      const updates: Array<Record<string, unknown>> = [];
      installFrom({ jobPart: { ...baseJobPart, production_status: 'cancelled' }, updates });
      await expect(updateJobPartPrice('jp1', 125)).rejects.toThrow(/cancelled/i);
      expect(updates).toHaveLength(0);
    });
  });

  describe('updateJobDetails', () => {
    it('patches only the provided header fields; empty string clears to null', async () => {
      mockQueryBuilder.data = { id: 'j1' };
      mockQueryBuilder.error = null;
      await updateJobDetails('j1', 'co-1', { customer_po_number: 'PO-9', due_date: '' });
      expect(mockSupabase.from).toHaveBeenCalledWith('jobs');
      const patch = (mockQueryBuilder.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(patch.customer_po_number).toBe('PO-9');
      expect(patch.due_date).toBeNull();
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'j1');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('company_id', 'co-1');
    });

    it('omits keys that were not provided', async () => {
      mockQueryBuilder.data = { id: 'j1' };
      await updateJobDetails('j1', 'co-1', { customer_po_number: 'PO-1' });
      const patch = (mockQueryBuilder.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(patch).not.toHaveProperty('due_date');
      expect(patch.customer_po_number).toBe('PO-1');
    });

    it('sets is_hot true (the Hot toggle) without touching other fields', async () => {
      mockQueryBuilder.data = { id: 'j1', is_hot: true };
      await updateJobDetails('j1', 'co-1', { is_hot: true });
      const patch = (mockQueryBuilder.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(patch.is_hot).toBe(true);
      expect(patch).not.toHaveProperty('customer_po_number');
      expect(patch).not.toHaveProperty('due_date');
    });

    it('clears is_hot when passed false (unmark Hot)', async () => {
      mockQueryBuilder.data = { id: 'j1', is_hot: false };
      await updateJobDetails('j1', 'co-1', { is_hot: false });
      const patch = (mockQueryBuilder.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(patch.is_hot).toBe(false);
    });

    it('leaves is_hot untouched when the key is omitted', async () => {
      mockQueryBuilder.data = { id: 'j1' };
      await updateJobDetails('j1', 'co-1', { customer_po_number: 'PO-1' });
      const patch = (mockQueryBuilder.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(patch).not.toHaveProperty('is_hot');
    });

    it('throws a friendly (non-raw) error when supabase fails', async () => {
      mockQueryBuilder.error = { message: 'permission denied' };
      await expect(
        updateJobDetails('j1', 'co-1', { due_date: '2026-07-01' }),
      ).rejects.toThrow(/don't have permission/);
    });
  });

  describe('getAllJobs', () => {
    const rows = [
      { id: 'active-ns', production_status: 'not_started', fulfillment_status: 'unshipped' },
      { id: 'active-ip', production_status: 'in_progress', fulfillment_status: 'partially_shipped' },
      { id: 'ready', production_status: 'completed', fulfillment_status: 'unshipped' },
      { id: 'done', production_status: 'completed', fulfillment_status: 'fully_shipped' },
      { id: 'cancelled-unshipped', production_status: 'cancelled', fulfillment_status: 'unshipped' },
    ];

    it('hides closed jobs (done + cancelled) by default', async () => {
      mockQueryBuilder.data = rows;
      const result = await getAllJobs('co-1');
      const ids = result.map((j) => j.id);
      expect(ids).toEqual(['active-ns', 'active-ip', 'ready']);
      // Behavior change: the cancelled-but-unshipped job is now hidden too,
      // alongside the fully-shipped done job.
      expect(ids).not.toContain('done');
      expect(ids).not.toContain('cancelled-unshipped');
    });

    it('keeps closed jobs when excludeClosed is false (Show completed & cancelled)', async () => {
      mockQueryBuilder.data = rows;
      const result = await getAllJobs('co-1', { excludeClosed: false });
      expect(result.map((j) => j.id)).toEqual(rows.map((r) => r.id));
    });

    it('applies production/fulfillment status filters server-side via .in()', async () => {
      mockQueryBuilder.data = [];
      await getAllJobs('co-1', {
        productionStatus: ['completed'],
        fulfillmentStatus: ['fully_shipped'],
      });
      expect(mockQueryBuilder.in).toHaveBeenCalledWith('production_status', ['completed']);
      expect(mockQueryBuilder.in).toHaveBeenCalledWith('fulfillment_status', ['fully_shipped']);
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('company_id', 'co-1');
    });

    it('orders hot jobs first (is_hot desc) as a primary tier, before the caller sort', async () => {
      mockQueryBuilder.data = [];
      await getAllJobs('co-1', {}, 'created_at', 'desc');
      const orderCalls = (mockQueryBuilder.order as ReturnType<typeof vi.fn>).mock.calls;
      // is_hot desc must be requested before the user's chosen column sort so hot
      // rows float to the top with the sort applied within each tier.
      expect(orderCalls[0]).toEqual(['is_hot', { ascending: false }]);
      expect(orderCalls[1]).toEqual(['created_at', { ascending: false }]);
    });
  });
});

// ============================================================================
// External (outside-vendor) operations: derive-status + admin guards
// ============================================================================

describe('deriveStatusFromOps with the sent (at-vendor) state', () => {
  it("treats a 'sent' op as work-in-progress (not completed, not not_started)", () => {
    expect(deriveStatusFromOps(['completed', 'sent'])).toBe('in_progress');
    expect(deriveStatusFromOps(['sent'])).toBe('in_progress');
    expect(deriveStatusFromOps(['pending', 'sent'])).toBe('in_progress');
  });

  it("still completes a part only when every op is 'completed' (a received external op counts)", () => {
    expect(deriveStatusFromOps(['completed', 'completed'])).toBe('completed');
  });
});

describe('admin op guards refuse external (outside-vendor) ops', () => {
  const externalOpRow = {
    job_id: 'job-1',
    job_part_id: 'jp-1',
    jobs: { production_status: 'in_progress' },
    work_center: { kind: 'external' },
  };

  it('completeJobOperation throws for an external op (never completes via the internal path)', async () => {
    mockQueryBuilder.data = externalOpRow;
    await expect(completeJobOperation('op-1', 'job-1')).rejects.toThrow(/outside/i);
    expect(mockQueryBuilder.update).not.toHaveBeenCalled();
  });

  it('undoJobOperation throws for an external op (undo goes through its own lifecycle)', async () => {
    mockQueryBuilder.data = externalOpRow;
    await expect(undoJobOperation('op-1')).rejects.toThrow(/outside/i);
    expect(mockQueryBuilder.update).not.toHaveBeenCalled();
  });

  it('completeJobOperation reaches the update path for an internal op (no guard throw)', async () => {
    // The shared builder can't serve the distinct array shape recomputeJobPartStatus
    // needs, so assert only that the internal op passes the guard and issues the
    // completion update (the rollup itself is covered elsewhere).
    mockQueryBuilder.data = {
      job_id: 'job-1',
      job_part_id: 'jp-1',
      jobs: { production_status: 'in_progress' },
      work_center: { kind: 'internal' },
    };
    mockSupabase.auth = { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) };
    await completeJobOperation('op-1', 'job-1').catch(() => {});
    expect(mockQueryBuilder.update).toHaveBeenCalled();
    expect(mockQueryBuilder.update.mock.calls[0][0]).toMatchObject({ status: 'completed' });
  });
});
