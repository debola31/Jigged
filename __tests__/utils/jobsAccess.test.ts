import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockQueryBuilder, mockSupabase } = vi.hoisted(() => {
  const builder: Record<string, ReturnType<typeof vi.fn> | unknown> = {};
  const chainMethods = [
    'from', 'select', 'insert', 'update', 'delete',
    'eq', 'neq', 'or', 'in', 'order', 'range', 'limit', 'lt', 'not', 'single', 'maybeSingle',
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

import {
  deleteJob,
  bulkCancelJobs,
  createJobFromPurchaseOrder,
  getCustomersForSelect,
  getOverdueJobsCount,
  getReadyOperationsForJobs,
  reopenJob,
  searchJobsByIdentifier,
  updateJobAddressContact,
} from '@/utils/jobsAccess';

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
    it('deletes by job id scoped to company_id', async () => {
      mockQueryBuilder.error = null;
      await deleteJob('j1', 'co-1');
      expect(mockSupabase.from).toHaveBeenCalledWith('jobs');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('id', 'j1');
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('company_id', 'co-1');
    });

    it('throws when supabase returns an error', async () => {
      mockQueryBuilder.error = { message: 'boom' };
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

  describe('getOverdueJobsCount', () => {
    it('uses count: exact head:true with company + due_date + status filters', async () => {
      mockQueryBuilder.count = 4;
      const count = await getOverdueJobsCount('co-1');
      expect(count).toBe(4);
      expect(mockQueryBuilder.eq).toHaveBeenCalledWith('company_id', 'co-1');
      expect(mockQueryBuilder.not).toHaveBeenCalledWith('due_date', 'is', null);
      expect(mockQueryBuilder.lt).toHaveBeenCalledWith('due_date', expect.any(String));
      expect(mockQueryBuilder.not).toHaveBeenCalledWith('fulfillment_status', 'eq', 'fully_shipped');
      expect(mockQueryBuilder.not).toHaveBeenCalledWith('production_status', 'eq', 'cancelled');
    });

    it('returns 0 when supabase returns null count', async () => {
      mockQueryBuilder.count = null;
      const count = await getOverdueJobsCount('co-1');
      expect(count).toBe(0);
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
});
