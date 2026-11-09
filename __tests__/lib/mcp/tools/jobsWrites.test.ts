import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { CompanyToolEnv } from '@/lib/mcp/defineTool';
import {
  addJobNoteTool,
  cancelJobTool,
  completeJobOperationTool,
  createJob,
  reopenJobTool,
  undoJobOperationTool,
  updateJob,
} from '@/lib/mcp/tools/jobsWrites';
import type { JobOperation, JobPartWithRelations, JobWithRelations } from '@/types/job';
import { CompletionConflictError } from '@/utils/operationCompletionsAccess';

/**
 * The job write tools, run directly (the wrapper's guards live in defineTool.test.ts). What
 * matters here: each tool calls the access function the job page calls, with the arguments that
 * page passes; it refuses, before writing, what the page would not let a person submit; and its
 * output links back into the app and names nobody.
 */

const mockGetJob = vi.fn();
const mockCancel = vi.fn();
const mockReopen = vi.fn();
const mockDetails = vi.fn();
const mockAddress = vi.fn();
const mockQty = vi.fn();
const mockPrice = vi.fn();
const mockComplete = vi.fn();
const mockUndo = vi.fn();
const mockCreate = vi.fn();
vi.mock('@/utils/jobsAccess', () => ({
  getAllJobs: vi.fn(),
  getJobWithRelations: (...a: unknown[]) => mockGetJob(...a),
  cancelJob: (...a: unknown[]) => mockCancel(...a),
  reopenJob: (...a: unknown[]) => mockReopen(...a),
  updateJobDetails: (...a: unknown[]) => mockDetails(...a),
  updateJobAddressContact: (...a: unknown[]) => mockAddress(...a),
  updateJobPartQuantity: (...a: unknown[]) => mockQty(...a),
  updateJobPartPrice: (...a: unknown[]) => mockPrice(...a),
  completeJobOperation: (...a: unknown[]) => mockComplete(...a),
  undoJobOperation: (...a: unknown[]) => mockUndo(...a),
  createJobFromPurchaseOrder: (...a: unknown[]) => mockCreate(...a),
}));

vi.mock('@/utils/materialCheckAccess', () => ({ getJobPartMaterialCheck: vi.fn() }));

const mockSummaries = vi.fn();
vi.mock('@/utils/operationCompletionsAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/operationCompletionsAccess')>()),
  getOperationCompletionSummaries: (...a: unknown[]) => mockSummaries(...a),
}));

const mockActuals = vi.fn();
vi.mock('@/utils/operationIntervalsAccess', () => ({
  getOperationActuals: (...a: unknown[]) => mockActuals(...a),
}));

const mockAddNote = vi.fn();
vi.mock('@/utils/operatorAccess', () => ({
  addJobNote: (...a: unknown[]) => mockAddNote(...a),
}));

const mockShipped = vi.fn();
vi.mock('@/utils/shipmentsAccess', () => ({
  getJobPartShipmentSummaries: (...a: unknown[]) => mockShipped(...a),
}));
const mockInvoiced = vi.fn();
vi.mock('@/utils/quickbooksAccess', () => ({
  getJobPartInvoiceSummaries: (...a: unknown[]) => mockInvoiced(...a),
}));

/** Rows each table answers with: `maybeSingle` takes the first, an awaited query takes them all. */
let db: Record<string, Array<Record<string, unknown>>> = {};
vi.mock('@/lib/supabase', () => {
  const chainFor = (table: string) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      ilike: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({ data: db[table]?.[0] ?? null, error: null }),
      then: (resolve: (v: { data: unknown; error: null }) => unknown) => resolve({ data: db[table] ?? [], error: null }),
    };
    return chain;
  };
  return { getSupabase: () => ({ from: chainFor }), registerScopedClientResolver: () => {} };
});

const env: CompanyToolEnv = {
  caller: { token: 't', clientId: 'c', userId: 'u', email: null, expiresAt: 0 },
  origin: 'https://jigged.app',
  company: { id: 'co-1', name: 'Acme Machining', role: 'user', isDemo: false, governingCompanyId: 'co-1' },
  link: (path) => `https://jigged.app${path}`,
};

function op(overrides: Partial<JobOperation>): JobOperation {
  return {
    id: 'op-1',
    job_id: 'job-1',
    job_part_id: 'jp-1',
    sequence: 10,
    operation_name: 'Mill',
    work_center_id: 'wc-1',
    routing_operation_id: null,
    estimated_setup_minutes: 30,
    estimated_run_minutes_per_unit: 4,
    status: 'in_progress',
    completed_at: null,
    completed_by: 'user-operator',
    completed_by_name: 'Dana Operator',
    sent_at: null,
    sent_by: null,
    notes: null,
    created_at: '',
    updated_at: '',
    vendor_service_id: null,
    ...overrides,
  };
}

function jobPart(overrides: Partial<JobPartWithRelations>): JobPartWithRelations {
  return {
    id: 'jp-1',
    job_id: 'job-1',
    company_id: 'co-1',
    part_id: 'part-1',
    source_quote_line_item_id: null,
    sequence: 10,
    quantity: 10,
    unit_price: 12.5,
    total_price: 125,
    production_status: 'in_progress',
    fulfillment_status: 'unshipped',
    status_changed_at: null,
    started_at: null,
    completed_at: null,
    current_operation_sequence: 10,
    created_at: '',
    updated_at: '',
    parts: { id: 'part-1', part_name: 'BRKT-100', description: 'Bracket' },
    job_operations: [
      op({}),
      op({
        id: 'op-2',
        sequence: 20,
        operation_name: 'Anodize',
        work_center_id: null,
        status: 'pending',
        vendor_service_id: 'vs-1',
        vendor_service: { id: 'vs-1', name: 'Type II anodize', unit_price: 2, vendor: { id: 'v-1', name: 'Plating Co' } },
      }),
    ],
    ...overrides,
  };
}

function job(overrides: Partial<JobWithRelations>): JobWithRelations {
  return {
    id: 'job-1',
    company_id: 'co-1',
    job_number: 'J-1001',
    quote_id: null,
    customer_id: 'cust-1',
    customer_po_number: 'PO-9',
    billing_address_id: 'addr-1',
    shipping_address_id: 'addr-1',
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
    created_by: 'user-office',
    created_at: '2026-11-01T10:00:00Z',
    updated_at: '2026-11-01T10:00:00Z',
    customer_name: 'Boeing',
    bill_to_address: null,
    ship_to_address: null,
    contact_snapshot: null,
    customers: {
      id: 'cust-1',
      name: 'Boeing',
      addresses: [
        {
          id: 'addr-1',
          address_line1: '1 Main St',
          address_line2: null,
          city: 'Seattle',
          state: 'WA',
          postal_code: '98101',
          country: 'US',
          default_billing: true,
          default_shipping: true,
          attention_to: null,
        },
        {
          id: 'addr-2',
          address_line1: '1200 Industrial Pkwy',
          address_line2: null,
          city: 'Wichita',
          state: 'KS',
          postal_code: '67201',
          country: 'US',
          default_billing: false,
          default_shipping: false,
          attention_to: 'Receiving',
        },
      ],
      customer_contacts: [
        {
          id: 'ct-1',
          name: 'Pat Buyer',
          role: 'purchasing',
          email: 'pat@boeing.test',
          phone: null,
          is_primary: true,
          is_billing_default: false,
          deleted_at: null,
        },
        {
          id: 'ct-2',
          name: 'Gone Person',
          role: 'other',
          email: null,
          phone: null,
          is_primary: false,
          is_billing_default: false,
          deleted_at: '2026-10-01T00:00:00Z',
        },
      ],
      carrier_accounts: [
        {
          id: 'ca-1',
          carrier: 'UPS',
          bill_to_party: 'recipient',
          account_number: '1Z999',
          account_postal_code: null,
          account_country_code: 'US',
          notes: null,
          deleted_at: null,
        },
      ],
    },
    job_parts: [jobPart({})],
    ...overrides,
  };
}

const PERSON = /completed_by|sent_by|author|operator|user_id|created_by|Dana Operator|user-operator|user-office/;

function reset(current: JobWithRelations = job({})) {
  vi.clearAllMocks();
  db = { jobs: [{ id: 'job-1', deleted_at: null }] };
  mockGetJob.mockResolvedValue(current);
  mockShipped.mockResolvedValue([]);
  mockInvoiced.mockResolvedValue([]);
  mockActuals.mockResolvedValue(new Map());
}

describe('create_job', () => {
  beforeEach(() => {
    reset();
    db.customers = [{ id: 'cust-1', name: 'Boeing', deleted_at: null }];
    db.parts = [{ id: 'part-1', part_name: 'BRKT-100', deleted_at: null }];
    mockCreate.mockResolvedValue({ job_id: 'job-1', job_number: 'J-1001' });
  });

  const order = {
    customer_name: 'boeing',
    customer_po_number: ' PO-77 ',
    due_date: '2099-02-01',
    lines: [{ part_name: 'BRKT-100', quantity: 10, unit_price: 12.5 }],
  };

  it('creates the job the Accept Purchase Order modal creates, and returns it with a link', async () => {
    const res = await createJob.run(order, env);
    expect(mockCreate).toHaveBeenCalledWith('co-1', {
      customer_id: 'cust-1',
      customer_po_number: 'PO-77',
      due_date: '2099-02-01',
      lines: [{ part_id: 'part-1', quantity: 10, unit_price: 12.5 }],
    });
    if (!res.ok) throw new Error(res.message);
    expect(res.data).toMatchObject({ job_id: 'job-1', job_number: 'J-1001', url: 'https://jigged.app/dashboard/co-1/jobs/job-1' });
    expect(JSON.stringify(res.data)).not.toMatch(PERSON);
  });

  it('refuses a due date in the past, a blank PO and a repeated part, before writing', async () => {
    expect(await createJob.run({ ...order, due_date: '2020-01-01' }, env)).toEqual({
      ok: false,
      message: expect.stringMatching(/in the past/),
    });
    expect(await createJob.run({ ...order, customer_po_number: '  ' }, env)).toEqual({
      ok: false,
      message: 'A customer PO number is required to create a job.',
    });
    expect(
      await createJob.run({ ...order, lines: [order.lines[0], { part_id: 'part-1', quantity: 2, unit_price: 1 }] }, env),
    ).toEqual({ ok: false, message: expect.stringMatching(/only once/) });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('refuses an archived part or customer, and one that is not there', async () => {
    db.parts = [{ id: 'part-1', part_name: 'BRKT-100', deleted_at: '2026-10-01T00:00:00Z' }];
    expect(await createJob.run(order, env)).toEqual({
      ok: false,
      message: 'BRKT-100 is archived in Acme Machining, so it can\'t go on a new job.',
    });
    db.customers = [{ id: 'cust-1', name: 'Boeing', deleted_at: '2026-10-01T00:00:00Z' }];
    expect(await createJob.run(order, env)).toEqual({ ok: false, message: expect.stringMatching(/Boeing is archived/) });
    db.customers = [];
    expect(await createJob.run(order, env)).toEqual({
      ok: false,
      message: 'There is no customer named boeing in Acme Machining.',
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('update_job', () => {
  beforeEach(() => reset());

  it('saves what the Edit screen saves, in its order, and lists what changed', async () => {
    const res = await updateJob.run(
      {
        job_number: 'J-1001',
        due_date: '2099-02-01',
        customer_po_number: 'PO-10',
        ship_to: { address_line1: '1200 industrial pkwy' },
        contact: { name: 'Pat Buyer' },
        freight_terms: 'collect',
        carrier_account: { carrier: 'ups' },
        parts: [{ quantity: 12, unit_price: 11 }],
      },
      env,
    );
    expect(mockDetails).toHaveBeenCalledWith('job-1', 'co-1', { due_date: '2099-02-01', customer_po_number: 'PO-10' });
    expect(mockAddress).toHaveBeenCalledWith('job-1', 'co-1', {
      freight_terms: 'collect',
      customer_carrier_account_id: 'ca-1',
      shipping_address_id: 'addr-2',
      contact_id: 'ct-1',
    });
    expect(mockQty).toHaveBeenCalledWith('jp-1', 12);
    expect(mockPrice).toHaveBeenCalledWith('jp-1', 11);
    expect(mockQty.mock.invocationCallOrder[0]).toBeLessThan(mockPrice.mock.invocationCallOrder[0]);
    if (!res.ok) throw new Error(res.message);
    expect(res.data.changed).toEqual([
      'due_date',
      'customer_po_number',
      'freight_terms',
      'carrier_account',
      'ship_to',
      'contact',
      'BRKT-100 quantity',
      'BRKT-100 unit_price',
    ]);
    expect(res.data.url).toBe('https://jigged.app/dashboard/co-1/jobs/job-1');
    expect(JSON.stringify(res.data)).not.toMatch(PERSON);
  });

  it('clears a field with null, and writes only the call that field needs', async () => {
    mockGetJob.mockResolvedValue(job({ ship_via: 'UPS Ground' }));
    const res = await updateJob.run({ job_id: 'job-1', ship_via: null }, env);
    expect(res.ok).toBe(true);
    expect(mockAddress).toHaveBeenCalledWith('job-1', 'co-1', { ship_via: null });
    expect(mockDetails).not.toHaveBeenCalled();
    expect(mockQty).not.toHaveBeenCalled();
  });

  it('refuses a quantity below what shipped, and a price change on an invoiced part', async () => {
    mockShipped.mockResolvedValue([{ job_part_id: 'jp-1', qty_shipped: 6 }]);
    expect(await updateJob.run({ job_id: 'job-1', parts: [{ quantity: 4 }] }, env)).toEqual({
      ok: false,
      message: expect.stringMatching(/^BRKT-100: 6 have already shipped/),
    });
    mockInvoiced.mockResolvedValue([{ job_part_id: 'jp-1', qty_invoiced: 3 }]);
    expect(await updateJob.run({ job_id: 'job-1', parts: [{ part_name: 'brkt-100', unit_price: 9 }] }, env)).toEqual({
      ok: false,
      message: expect.stringMatching(/price is locked/),
    });
    expect(mockQty).not.toHaveBeenCalled();
    expect(mockPrice).not.toHaveBeenCalled();
  });

  it('refuses a cancelled part, an unknown address, and a call that changes nothing', async () => {
    mockGetJob.mockResolvedValue(job({ job_parts: [jobPart({ production_status: 'cancelled' })] }));
    expect(await updateJob.run({ job_id: 'job-1', parts: [{ quantity: 20 }] }, env)).toEqual({
      ok: false,
      message: 'BRKT-100 is cancelled on J-1001, so its quantity and price can\'t be changed.',
    });
    expect(await updateJob.run({ job_id: 'job-1', ship_to: { address_line1: '9 Nowhere Rd' } }, env)).toEqual({
      ok: false,
      message: expect.stringMatching(/^Boeing has no saved address matching 9 Nowhere Rd/),
    });
    expect(await updateJob.run({ job_id: 'job-1', contact: { name: 'Gone Person' } }, env)).toEqual({
      ok: false,
      message: expect.stringMatching(/no contact named Gone Person/),
    });
    expect(await updateJob.run({ job_id: 'job-1', customer_po_number: 'PO-9' }, env)).toEqual({
      ok: false,
      message: 'J-1001 already has those values, so nothing was changed.',
    });
    expect(await updateJob.run({ job_id: 'job-1' }, env)).toEqual({ ok: false, message: expect.stringMatching(/^Name something/) });
    expect(mockDetails).not.toHaveBeenCalled();
    expect(mockAddress).not.toHaveBeenCalled();
  });

  it('says so when the job is not there', async () => {
    db.jobs = [];
    expect(await updateJob.run({ job_number: 'J-404', due_date: null }, env)).toEqual({
      ok: false,
      message: 'There is no job J-404 in Acme Machining.',
    });
  });
});

describe('cancel_job and reopen_job', () => {
  beforeEach(() => reset());

  it('cancels an open job and returns it', async () => {
    const res = await cancelJobTool.run({ job_number: 'J-1001' }, env);
    expect(mockCancel).toHaveBeenCalledWith('job-1');
    expect(res.ok && res.data.url).toBe('https://jigged.app/dashboard/co-1/jobs/job-1');
  });

  it('refuses a job that is complete or already cancelled, as the page hides Cancel there', async () => {
    mockGetJob.mockResolvedValue(job({ production_status: 'completed' }));
    expect(await cancelJobTool.run({ job_id: 'job-1' }, env)).toEqual({
      ok: false,
      message: 'J-1001 is complete, so it can\'t be cancelled.',
    });
    mockGetJob.mockResolvedValue(job({ production_status: 'cancelled' }));
    expect(await cancelJobTool.run({ job_id: 'job-1' }, env)).toEqual({ ok: false, message: 'J-1001 is already cancelled.' });
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it('reopens only a cancelled job', async () => {
    expect(await reopenJobTool.run({ job_id: 'job-1' }, env)).toEqual({
      ok: false,
      message: 'J-1001 isn\'t cancelled, so there is nothing to reopen.',
    });
    expect(mockReopen).not.toHaveBeenCalled();
    mockGetJob.mockResolvedValue(job({ production_status: 'cancelled' }));
    const res = await reopenJobTool.run({ job_id: 'job-1' }, env);
    expect(mockReopen).toHaveBeenCalledWith('job-1');
    expect(res.ok).toBe(true);
  });
});

describe('complete_job_operation', () => {
  beforeEach(() => {
    reset();
    mockSummaries.mockResolvedValue([
      { job_operation_id: 'op-1', target: 10, qty_good: 4, qty_remaining: 6 },
      { job_operation_id: 'op-2', target: 10, qty_good: 0, qty_remaining: 10 },
    ]);
    mockComplete.mockResolvedValue({ operation: op({}), jobPartStatusChanged: false, jobStatusChanged: false, discardedRunningTimers: 0 });
  });

  it('records the remaining balance as Mark Complete does, and names nobody', async () => {
    const res = await completeJobOperationTool.run({ job_number: 'J-1001', sequence: 10 }, env);
    expect(mockComplete).toHaveBeenCalledWith('op-1', 'job-1', { quantityGood: 6, expectedQtyGood: 4 });
    if (!res.ok) throw new Error(res.message);
    expect(res.data).toMatchObject({
      recorded: 6,
      discarded_running_timers: 0,
      step: { sequence: 10, name: 'Mill' },
      url: 'https://jigged.app/dashboard/co-1/jobs/job-1?op=op-1',
    });
    expect(JSON.stringify(res.data)).not.toMatch(PERSON);
  });

  it('records a partial by name', async () => {
    await completeJobOperationTool.run({ job_id: 'job-1', operation_name: 'mill', quantity_good: 2 }, env);
    expect(mockComplete).toHaveBeenCalledWith('op-1', 'job-1', { quantityGood: 2, expectedQtyGood: 4 });
  });

  it('refuses while a timer is running, until told to discard it', async () => {
    mockActuals.mockResolvedValue(new Map([['op-1', { job_operation_id: 'op-1', open_count: 1 }]]));
    expect(await completeJobOperationTool.run({ job_id: 'job-1', sequence: 10 }, env)).toEqual({
      ok: false,
      message: expect.stringMatching(/^Someone is timing Op 10 · Mill right now\. .*Nothing was recorded/),
    });
    expect(mockComplete).not.toHaveBeenCalled();
    mockComplete.mockResolvedValue({ operation: op({}), jobPartStatusChanged: false, jobStatusChanged: false, discardedRunningTimers: 1 });
    const res = await completeJobOperationTool.run({ job_id: 'job-1', sequence: 10, discard_running_timer: true }, env);
    expect(res.ok && res.data.discarded_running_timers).toBe(1);
  });

  it('refuses an outside step, a finished step and a cancelled job', async () => {
    expect(await completeJobOperationTool.run({ job_id: 'job-1', sequence: 20 }, env)).toEqual({
      ok: false,
      message: 'Op 20 · Anodize is outside work at Plating Co. It is sent to the vendor and received back rather than completed.',
    });
    mockGetJob.mockResolvedValue(job({ job_parts: [jobPart({ job_operations: [op({ status: 'completed' })] })] }));
    expect(await completeJobOperationTool.run({ job_id: 'job-1', sequence: 10 }, env)).toEqual({
      ok: false,
      message: 'Op 10 · Mill is already complete on J-1001.',
    });
    mockGetJob.mockResolvedValue(job({ production_status: 'cancelled' }));
    expect(await completeJobOperationTool.run({ job_id: 'job-1', sequence: 10 }, env)).toEqual({
      ok: false,
      message: 'J-1001 is cancelled, so its steps can\'t be changed. Reopen it first.',
    });
    expect(await completeJobOperationTool.run({ job_id: 'job-1', sequence: 99 }, env)).toEqual({
      ok: false,
      message: 'BRKT-100 on J-1001 has no step 99.',
    });
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('turns a first-write-wins conflict into a refusal, not an error', async () => {
    mockComplete.mockRejectedValue(new CompletionConflictError(10));
    expect(await completeJobOperationTool.run({ job_id: 'job-1', sequence: 10 }, env)).toEqual({
      ok: false,
      message: 'Someone recorded work on Op 10 · Mill a moment ago, so nothing was recorded. It now has 10 of 10 good.',
    });
  });
});

describe('undo_job_operation', () => {
  beforeEach(() => reset());

  it('voids what is recorded on the step', async () => {
    mockSummaries.mockResolvedValue([{ job_operation_id: 'op-1', target: 10, qty_good: 4, qty_remaining: 6 }]);
    mockUndo.mockResolvedValue(op({ status: 'pending' }));
    const res = await undoJobOperationTool.run({ job_id: 'job-1', sequence: 10 }, env);
    expect(mockUndo).toHaveBeenCalledWith('op-1');
    expect(res.ok && res.data.undone).toBe(4);
  });

  it('refuses when nothing is recorded', async () => {
    mockSummaries.mockResolvedValue([{ job_operation_id: 'op-1', target: 10, qty_good: 0, qty_remaining: 10 }]);
    expect(await undoJobOperationTool.run({ job_id: 'job-1', sequence: 10 }, env)).toEqual({
      ok: false,
      message: 'Nothing is recorded on Op 10 · Mill, so there is nothing to undo.',
    });
    expect(mockUndo).not.toHaveBeenCalled();
  });
});

describe('add_job_note', () => {
  beforeEach(() => reset());

  it('posts the note as the caller, as the activity composer does, and returns no author', async () => {
    db.user_company_access = [{ id: 'member-1' }];
    mockAddNote.mockResolvedValue({
      id: 'note-1',
      job_id: 'job-1',
      body: 'Hold for QC',
      created_at: '2026-11-09T12:00:00Z',
      author_id: 'member-1',
      author_name: 'Sam Office',
    });
    const res = await addJobNoteTool.run({ job_number: 'J-1001', body: '  Hold for QC ' }, env);
    expect(mockAddNote).toHaveBeenCalledWith('job-1', 'co-1', 'member-1', 'Hold for QC');
    if (!res.ok) throw new Error(res.message);
    expect(res.data).toEqual({
      note_id: 'note-1',
      job_id: 'job-1',
      job_number: 'J-1001',
      body: 'Hold for QC',
      created_at: '2026-11-09T12:00:00Z',
      url: 'https://jigged.app/dashboard/co-1/jobs/job-1',
    });
    expect(JSON.stringify(res.data)).not.toMatch(/Sam Office|member-1|author/);
  });

  it('refuses an empty note', async () => {
    expect(await addJobNoteTool.run({ job_id: 'job-1', body: '   ' }, env)).toEqual({ ok: false, message: 'A note needs some text.' });
    expect(mockAddNote).not.toHaveBeenCalled();
  });
});
