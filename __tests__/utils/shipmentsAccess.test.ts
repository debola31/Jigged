import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Builds a fresh chainable query-builder mock. All chain methods return
 * the builder; the builder doubles as the awaited result, so call sites
 * doing `const { data, error } = await query` see `.data` / `.error`.
 *
 * One builder per .from(...) call — that's how we let the two-query
 * functions (getOpenJobPartsForCustomer, listShipmentsForCompanyWithJobs)
 * stub distinct responses for parts vs. line items vs. members.
 */
function buildQueryStub(initial?: { data?: unknown; error?: unknown }) {
  const builder: Record<string, unknown> = {};
  const chainMethods = [
    'select',
    'insert',
    'update',
    'delete',
    'eq',
    'neq',
    'ilike',
    'or',
    'in',
    'is',
    'not',
    'gte',
    'lte',
    'order',
    'range',
    'single',
    'maybeSingle',
    'limit',
  ];
  chainMethods.forEach((m) => {
    builder[m] = vi.fn().mockImplementation(() => builder);
  });
  builder.data = initial?.data ?? null;
  builder.error = initial?.error ?? null;
  return builder as Record<string, ReturnType<typeof vi.fn>> & {
    data: unknown;
    error: unknown;
  };
}

const { mockSupabase, queueBuilders } = vi.hoisted(() => {
  let queue: ReturnType<typeof Object>[] = [];
  const supabase = {
    from: vi.fn().mockImplementation(() => {
      const next = queue.shift();
      if (!next) {
        // Unexpected extra .from() — surface as an obvious test failure.
        throw new Error('queueBuilders: ran out of stubbed builders');
      }
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
  // shipmentsAccess.ts adopted getTypedSupabase under the typed-client rollout.
  getTypedSupabase: () => mockSupabase,
  createClient: () => mockSupabase,
  supabase: mockSupabase,
}));

import { getOpenJobPartsForCustomer } from '@/utils/shipmentsAccess';
import type { OpenJobPartRow } from '@/types/shipment';

describe('getOpenJobPartsForCustomer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns lines from one open job for the customer', async () => {
    const partsBuilder = buildQueryStub({
      data: [
        {
          id: 'jp-1',
          quantity: 10,
          production_status: 'completed',
          fulfillment_status: 'partially_shipped',
          part: { id: 'p-1', part_name: 'Bracket', description: 'L-bracket' },
          job: {
            id: 'j-1',
            job_number: 'J-101',
            customer_po_number: 'PO-A',
            customer_id: 'cust-1',
            company_id: 'co-1',
          },
        },
      ],
      error: null,
    });
    const shippedBuilder = buildQueryStub({
      data: [
        { job_part_id: 'jp-1', quantity: 3, shipment: { voided_at: null } },
      ],
      error: null,
    });
    queueBuilders([partsBuilder, shippedBuilder]);

    const rows = await getOpenJobPartsForCustomer('co-1', 'cust-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject<Partial<OpenJobPartRow>>({
      job_part_id: 'jp-1',
      job_number: 'J-101',
      customer_po_number: 'PO-A',
      qty_ordered: 10,
      qty_shipped: 3,
      qty_remaining: 7,
      production_status: 'completed',
    });
  });

  it('returns lines from two open jobs for the customer', async () => {
    const partsBuilder = buildQueryStub({
      data: [
        {
          id: 'jp-1',
          quantity: 10,
          production_status: 'completed',
          fulfillment_status: 'unshipped',
          part: { id: 'p-1', part_name: 'Bracket', description: null },
          job: {
            id: 'j-1',
            job_number: 'J-101',
            customer_po_number: 'PO-A',
            customer_id: 'cust-1',
            company_id: 'co-1',
          },
        },
        {
          id: 'jp-2',
          quantity: 5,
          production_status: 'in_progress',
          fulfillment_status: 'unshipped',
          part: { id: 'p-2', part_name: 'Flange', description: null },
          job: {
            id: 'j-2',
            job_number: 'J-102',
            customer_po_number: 'PO-B',
            customer_id: 'cust-1',
            company_id: 'co-1',
          },
        },
      ],
      error: null,
    });
    const shippedBuilder = buildQueryStub({ data: [], error: null });
    queueBuilders([partsBuilder, shippedBuilder]);

    const rows = await getOpenJobPartsForCustomer('co-1', 'cust-1');
    expect(rows).toHaveLength(2);
    const jobs = rows.map((r) => r.job_number).sort();
    expect(jobs).toEqual(['J-101', 'J-102']);
    expect(rows.every((r) => r.qty_shipped === 0)).toBe(true);
  });

  it('excludes fully_shipped lines by default; includes them when excludeFullyShipped is false', async () => {
    // Default filter (excludeFullyShipped: true) → server-side .neq applies,
    // so the parts query returns only the unshipped row.
    {
      const partsBuilder = buildQueryStub({
        data: [
          {
            id: 'jp-1',
            quantity: 10,
            production_status: 'completed',
            fulfillment_status: 'unshipped',
            part: { id: 'p-1', part_name: 'Bracket', description: null },
            job: {
              id: 'j-1',
              job_number: 'J-101',
              customer_po_number: null,
              customer_id: 'cust-1',
              company_id: 'co-1',
            },
          },
        ],
        error: null,
      });
      const shippedBuilder = buildQueryStub({ data: [], error: null });
      queueBuilders([partsBuilder, shippedBuilder]);
      const rows = await getOpenJobPartsForCustomer('co-1', 'cust-1');
      expect(rows.map((r) => r.job_part_id)).toEqual(['jp-1']);
      // Verify the server-side filter was applied.
      expect(partsBuilder.neq).toHaveBeenCalledWith(
        'fulfillment_status',
        'fully_shipped',
      );
    }

    // excludeFullyShipped: false → no neq for that column; both rows returned.
    {
      const partsBuilder = buildQueryStub({
        data: [
          {
            id: 'jp-1',
            quantity: 10,
            production_status: 'completed',
            fulfillment_status: 'unshipped',
            part: { id: 'p-1', part_name: 'Bracket', description: null },
            job: {
              id: 'j-1',
              job_number: 'J-101',
              customer_po_number: null,
              customer_id: 'cust-1',
              company_id: 'co-1',
            },
          },
          {
            id: 'jp-2',
            quantity: 4,
            production_status: 'completed',
            fulfillment_status: 'fully_shipped',
            part: { id: 'p-2', part_name: 'Cap', description: null },
            job: {
              id: 'j-1',
              job_number: 'J-101',
              customer_po_number: null,
              customer_id: 'cust-1',
              company_id: 'co-1',
            },
          },
        ],
        error: null,
      });
      const shippedBuilder = buildQueryStub({ data: [], error: null });
      queueBuilders([partsBuilder, shippedBuilder]);
      const rows = await getOpenJobPartsForCustomer('co-1', 'cust-1', {
        excludeFullyShipped: false,
      });
      expect(rows).toHaveLength(2);
      expect(partsBuilder.neq).not.toHaveBeenCalledWith(
        'fulfillment_status',
        'fully_shipped',
      );
    }
  });

  it('excludes cancelled lines by default; includes them when excludeCancelled is false', async () => {
    const partsBuilder = buildQueryStub({
      data: [
        {
          id: 'jp-1',
          quantity: 10,
          production_status: 'cancelled',
          fulfillment_status: 'unshipped',
          part: { id: 'p-1', part_name: 'Bracket', description: null },
          job: {
            id: 'j-1',
            job_number: 'J-101',
            customer_po_number: null,
            customer_id: 'cust-1',
            company_id: 'co-1',
          },
        },
      ],
      error: null,
    });
    const shippedBuilder = buildQueryStub({ data: [], error: null });
    queueBuilders([partsBuilder, shippedBuilder]);

    // Caller wants cancelled rows in the response too.
    const rows = await getOpenJobPartsForCustomer('co-1', 'cust-1', {
      excludeCancelled: false,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].production_status).toBe('cancelled');
    expect(partsBuilder.neq).not.toHaveBeenCalledWith(
      'production_status',
      'cancelled',
    );
  });

  it('clamps qty_remaining to zero on over-shipment (qty_shipped > qty_ordered)', async () => {
    // FR-4 allows over-shipment with a soft warning. The picker's math
    // needs a non-negative remaining; this protects the UI from showing
    // negatives or doing nonsense arithmetic when re-counting.
    const partsBuilder = buildQueryStub({
      data: [
        {
          id: 'jp-1',
          quantity: 5,
          production_status: 'completed',
          fulfillment_status: 'partially_shipped',
          part: { id: 'p-1', part_name: 'Bracket', description: null },
          job: {
            id: 'j-1',
            job_number: 'J-101',
            customer_po_number: null,
            customer_id: 'cust-1',
            company_id: 'co-1',
          },
        },
      ],
      error: null,
    });
    const shippedBuilder = buildQueryStub({
      data: [
        { job_part_id: 'jp-1', quantity: 7, shipment: { voided_at: null } },
      ],
      error: null,
    });
    queueBuilders([partsBuilder, shippedBuilder]);

    const rows = await getOpenJobPartsForCustomer('co-1', 'cust-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].qty_ordered).toBe(5);
    expect(rows[0].qty_shipped).toBe(7);
    expect(rows[0].qty_remaining).toBe(0);
  });

  it('ignores voided shipments when summing qty_shipped', async () => {
    const partsBuilder = buildQueryStub({
      data: [
        {
          id: 'jp-1',
          quantity: 10,
          production_status: 'completed',
          fulfillment_status: 'partially_shipped',
          part: { id: 'p-1', part_name: 'Bracket', description: null },
          job: {
            id: 'j-1',
            job_number: 'J-101',
            customer_po_number: null,
            customer_id: 'cust-1',
            company_id: 'co-1',
          },
        },
      ],
      error: null,
    });
    const shippedBuilder = buildQueryStub({
      data: [
        { job_part_id: 'jp-1', quantity: 3, shipment: { voided_at: null } },
        // The voided 4 should NOT contribute.
        {
          job_part_id: 'jp-1',
          quantity: 4,
          shipment: { voided_at: '2026-05-20T00:00:00Z' },
        },
      ],
      error: null,
    });
    queueBuilders([partsBuilder, shippedBuilder]);

    const rows = await getOpenJobPartsForCustomer('co-1', 'cust-1');
    expect(rows[0].qty_shipped).toBe(3);
    expect(rows[0].qty_remaining).toBe(7);
  });
});
