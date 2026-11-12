import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

import type { CompanyToolEnv } from '@/lib/mcp/defineTool';
import { getJob, getJobMaterialCheck, listJobs } from '@/lib/mcp/tools/jobs';
import type { JobWithRelations } from '@/types/job';

/**
 * The job tools, run directly (the wrapper's own guards are covered in defineTool.test.ts). What
 * matters here: the filters, the page, the deep links, and that no person is named against
 * shop-floor work.
 */

const mockGetAllJobs = vi.fn();
const mockGetJob = vi.fn();
vi.mock('@/utils/jobsAccess', () => ({
  getAllJobs: (...a: unknown[]) => mockGetAllJobs(...a),
  getJobWithRelations: (...a: unknown[]) => mockGetJob(...a),
}));

const mockMaterial = vi.fn();
vi.mock('@/utils/materialCheckAccess', () => ({
  getJobPartMaterialCheck: (...a: unknown[]) => mockMaterial(...a),
}));

const mockJobPoLines = vi.fn();
vi.mock('@/utils/vendorPoAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/vendorPoAccess')>()),
  listVendorPoLinesForJob: (...a: unknown[]) => mockJobPoLines(...a),
}));

let lookup: { id: string; deleted_at: string | null } | null = null;
vi.mock('@/lib/supabase', () => {
  const chain = {
    select: () => chain,
    eq: () => chain,
    is: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => ({ data: lookup, error: null }),
  };
  return { getSupabase: () => ({ from: () => chain }), registerScopedClientResolver: () => {} };
});

const env: CompanyToolEnv = {
  caller: { token: 't', clientId: 'c', userId: 'u', email: null, expiresAt: 0 },
  company: { id: 'co-1', name: 'Acme Machining', role: 'user', isDemo: false, governingCompanyId: 'co-1' },
  link: (path) => `https://jigged.app${path}`,
};

function job(overrides: Partial<JobWithRelations>): JobWithRelations {
  return {
    id: 'job-1',
    company_id: 'co-1',
    job_number: 'J-1001',
    quote_id: null,
    customer_id: 'cust-1',
    customer_po_number: 'PO-9',
    billing_address_id: null,
    shipping_address_id: null,
    contact_id: null,
    production_status: 'in_progress',
    fulfillment_status: 'unshipped',
    payment_terms: null,
    freight_terms: null,
    customer_carrier_account_id: null,
    ship_via: null,
    shipping_instructions: null,
    status_changed_at: null,
    started_at: null,
    completed_at: null,
    due_date: '2099-01-10',
    created_by: null,
    created_at: '2026-11-01T10:00:00Z',
    updated_at: '2026-11-01T10:00:00Z',
    customer_name: 'Boeing',
    bill_to_address: null,
    ship_to_address: null,
    contact_snapshot: null,
    customers: { id: 'cust-1', name: 'Boeing' },
    job_parts: [],
    ...overrides,
  };
}

describe('list_jobs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns open jobs only by default, soonest due first, with links', async () => {
    mockGetAllJobs.mockResolvedValue({
      jobs: [
        job({ id: 'late', job_number: 'J-2', due_date: '2099-03-01' }),
        job({ id: 'done', job_number: 'J-3', production_status: 'completed', fulfillment_status: 'fully_shipped' }),
        job({ id: 'soon', job_number: 'J-1', due_date: '2099-01-01' }),
        job({ id: 'undated', job_number: 'J-4', due_date: null }),
      ],
      total: 4,
      truncated: false,
    });
    const res = await listJobs.run({}, env);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.jobs.map((j) => j.job_number)).toEqual(['J-1', 'J-2', 'J-4']);
    expect(res.data.total).toBe(3);
    expect(res.data.next_cursor).toBeNull();
    expect(res.data.jobs[0].url).toBe('https://jigged.app/dashboard/co-1/jobs/soon');
    expect(mockGetAllJobs).toHaveBeenCalledWith('co-1', expect.objectContaining({ excludeClosed: false }), 'due_date', 'asc');
  });

  it('pages with a cursor and refuses one it did not issue', async () => {
    mockGetAllJobs.mockResolvedValue({
      jobs: Array.from({ length: 5 }, (_, i) => job({ id: `j${i}`, job_number: `J-${i}`, due_date: `2099-01-0${i + 1}` })),
      total: 5,
      truncated: false,
    });
    const first = await listJobs.run({ limit: 2 }, env);
    if (!first.ok) throw new Error('expected a page');
    expect(first.data.jobs.map((j) => j.job_number)).toEqual(['J-0', 'J-1']);
    expect(first.data.next_cursor).toBe('2');
    const last = await listJobs.run({ limit: 2, cursor: '4' }, env);
    if (!last.ok) throw new Error('expected a page');
    expect(last.data.jobs.map((j) => j.job_number)).toEqual(['J-4']);
    expect(last.data.next_cursor).toBeNull();
    expect(await listJobs.run({ cursor: 'abc' }, env)).toEqual({ ok: false, message: expect.stringMatching(/cursor/) });
  });

  it('narrows by stage and due window', async () => {
    mockGetAllJobs.mockResolvedValue({
      jobs: [
        job({ id: 'a', job_number: 'J-A', production_status: 'completed', due_date: '2026-11-05' }),
        job({ id: 'b', job_number: 'J-B', production_status: 'completed', due_date: '2026-12-05' }),
        job({ id: 'c', job_number: 'J-C', due_date: '2026-11-06' }),
      ],
      total: 3,
      truncated: false,
    });
    const res = await listJobs.run({ stages: ['ready_to_ship'], due_from: '2026-11-01', due_to: '2026-11-30' }, env);
    if (!res.ok) throw new Error('expected a page');
    expect(res.data.jobs.map((j) => j.job_number)).toEqual(['J-A']);
    expect(res.data.jobs[0].stage).toBe('ready_to_ship');
  });
});

describe('get_job', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lookup = { id: 'job-1', deleted_at: null };
    mockJobPoLines.mockResolvedValue([]);
  });

  const full = job({
    job_parts: [
      {
        id: 'jp-1',
        job_id: 'job-1',
        company_id: 'co-1',
        part_id: 'part-1',
        source_quote_line_item_id: null,
        sequence: 1,
        quantity: 10,
        unit_price: 12.5,
        total_price: 125,
        production_status: 'in_progress',
        fulfillment_status: 'unshipped',
        status_changed_at: null,
        started_at: null,
        completed_at: null,
        current_operation_sequence: 2,
        created_at: '',
        updated_at: '',
        parts: { id: 'part-1', part_name: 'BRKT-100', description: 'Bracket' },
        job_operations: [
          {
            id: 'op-1',
            job_id: 'job-1',
            job_part_id: 'jp-1',
            sequence: 1,
            operation_name: 'Mill',
            work_center_id: 'wc-1',
            routing_operation_id: null,
            estimated_setup_minutes: 30,
            estimated_run_minutes_per_unit: 4,
            status: 'completed',
            completed_at: '2026-11-02T15:00:00Z',
            completed_by: 'user-operator',
            completed_by_name: 'Dana Operator',
            sent_at: null,
            sent_by: null,
            notes: null,
            instructions: 'Deburr all edges',
            created_at: '',
            updated_at: '',
            work_center: { id: 'wc-1', name: 'Haas VF-2', labor_rate: 85 },
          },
        ],
      },
    ],
  });

  it('returns the job with parts, prices and steps, and names nobody', async () => {
    mockGetJob.mockResolvedValue(full);
    const res = await getJob.run({ job_id: 'job-1' }, env);
    if (!res.ok) throw new Error('expected the job');
    expect(res.data.parts[0]).toMatchObject({ part_name: 'BRKT-100', quantity: 10, unit_price: 12.5 });
    expect(res.data.parts[0].operations[0]).toMatchObject({ name: 'Mill', work_center: 'Haas VF-2', status: 'completed' });
    const text = JSON.stringify(res.data);
    expect(text).not.toContain('Dana Operator');
    expect(text).not.toContain('user-operator');
    expect(text).not.toMatch(/completed_by|sent_by/);
  });

  it("lists the job's lines on purchase orders to vendors, as its Vendor POs row does; customer_po_number stays the customer's", async () => {
    mockGetJob.mockResolvedValue(full);
    mockJobPoLines.mockResolvedValue([
      {
        lineId: 'pol-3',
        vendorPurchaseOrderId: 'po-1',
        poNumber: 'PO-1042',
        poStatus: 'partially_received',
        vendorId: 'v-1',
        vendorName: 'Valley Plating',
        lineNumber: 3,
        lineKind: 'outside_service',
        partId: 'part-1',
        partName: 'BRKT-100',
        description: 'Anodize — BRKT-100 — Job J-1001, Op 2',
        jobPartId: 'jp-1',
        jobOperationId: 'op-2',
        operationLabel: 'Op 2 Anodize',
        quantity: 10,
        unit: 'each',
        receivedQuantity: 4,
        openQuantity: 6,
        status: 'partially_received',
        expectedOn: '2026-11-15',
        isLate: true,
      },
    ]);
    const res = await getJob.run({ job_id: 'job-1' }, env);
    if (!res.ok) throw new Error('expected the job');
    expect(mockJobPoLines).toHaveBeenCalledWith('job-1', { today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(res.data.customer_po_number).toBe('PO-9');
    expect(res.data.vendor_po_lines).toEqual([
      {
        vendor_po_id: 'po-1',
        po_number: 'PO-1042',
        po_status: 'partially_received',
        vendor: { vendor_id: 'v-1', name: 'Valley Plating', url: 'https://jigged.app/dashboard/co-1/vendors/v-1' },
        line_number: 3,
        kind: 'outside_service',
        item: 'Anodize — BRKT-100 — Job J-1001, Op 2',
        job_part_id: 'jp-1',
        operation: 'Op 2 Anodize',
        quantity: 10,
        unit: 'each',
        received_quantity: 4,
        open_quantity: 6,
        status: 'partially_received',
        expected_on: '2026-11-15',
        overdue: true,
        url: 'https://jigged.app/dashboard/co-1/purchasing/orders/po-1',
      },
    ]);
    expect(() => z.object(getJob.output).parse(res.data)).not.toThrow();
  });

  it('finds a job by number', async () => {
    mockGetJob.mockResolvedValue(full);
    const res = await getJob.run({ job_number: 'J-1001' }, env);
    expect(res.ok && res.data.archived).toBe(false);
    expect(mockGetJob).toHaveBeenCalledWith('job-1', 'co-1');
  });

  it('finds an archived job by id and says it is archived', async () => {
    lookup = { id: 'job-1', deleted_at: '2026-11-01T00:00:00Z' };
    mockGetJob.mockResolvedValue(full);
    const res = await getJob.run({ job_id: 'job-1' }, env);
    expect(res.ok && res.data.archived).toBe(true);
  });

  it('says so when the job is not there, or none was named', async () => {
    lookup = null;
    expect(await getJob.run({ job_number: 'J-404' }, env)).toEqual({
      ok: false,
      message: 'There is no job J-404 in Acme Machining.',
    });
    expect(await getJob.run({}, env)).toEqual({ ok: false, message: 'Give a job_id or a job_number.' });
  });
});

describe('get_job_material_check', () => {
  beforeEach(() => {
    lookup = { id: 'job-1', deleted_at: null };
  });

  it('lists each part\'s material with what is short', async () => {
    mockGetJob.mockResolvedValue(
      job({
        job_parts: [
          {
            id: 'jp-1',
            job_id: 'job-1',
            company_id: 'co-1',
            part_id: 'part-1',
            source_quote_line_item_id: null,
            sequence: 1,
            quantity: 10,
            unit_price: null,
            total_price: null,
            production_status: 'not_started',
            fulfillment_status: 'unshipped',
            status_changed_at: null,
            started_at: null,
            completed_at: null,
            current_operation_sequence: null,
            created_at: '',
            updated_at: '',
            parts: { id: 'part-1', part_name: 'BRKT-100', description: null },
          },
        ],
      }),
    );
    mockMaterial.mockResolvedValue([
      {
        bomLineId: 'b1',
        partId: 'mat-1',
        partName: '6061 bar',
        bomUnit: 'in',
        requiredInBomUnit: 40,
        requiredInStockUnit: 40,
        stockUnit: 'in',
        onHand: 25,
        issued: 0,
        hasDiscrepancy: false,
        heatNumbers: [],
        remainingToIssue: 40,
        shortBy: 15,
        status: 'short',
        basis: { kind: 'same', unit: 'in' },
        onOrder: 288,
        onDraft: 0,
        onOrderRefs: [{ vendorPurchaseOrderId: 'po-1', poNumber: 'PO-1042', stockQuantity: 288, expectedOn: '2026-11-18', isDraft: false }],
      },
    ]);
    const res = await getJobMaterialCheck.run({ job_id: 'job-1' }, env);
    if (!res.ok) throw new Error('expected the check');
    expect(mockMaterial).toHaveBeenCalledWith({
      companyId: 'co-1',
      jobId: 'job-1',
      jobPartId: 'jp-1',
      madePartId: 'part-1',
      orderQuantity: 10,
    });
    expect(res.data.parts[0].materials[0]).toMatchObject({ part_name: '6061 bar', short_by: 15, status: 'short' });
    // What is coming rides alongside; "short by" is untouched by it (stock on a PO is not on the shelf).
    expect(res.data.parts[0].materials[0]).toMatchObject({
      on_order: 288,
      on_draft: 0,
      on_order_pos: [
        { vendor_po_id: 'po-1', po_number: 'PO-1042', quantity: 288, expected_on: '2026-11-18', draft: false, url: 'https://jigged.app/dashboard/co-1/purchasing/orders/po-1' },
      ],
    });
    expect(() => z.object(getJobMaterialCheck.output).parse(res.data)).not.toThrow();
  });
});
