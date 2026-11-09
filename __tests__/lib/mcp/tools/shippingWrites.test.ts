import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';

import type { CompanyToolEnv } from '@/lib/mcp/defineTool';
import {
  SHIPPING_WRITE_TOOLS,
  createShipmentTool,
  receiveOutside,
  sendOutside,
  voidOutsideShipmentTool,
  voidShipmentTool,
} from '@/lib/mcp/tools/shippingWrites';
import type { OutsideShipmentReceipt, OutsideShipmentWithRelations } from '@/types/outsideShipment';
import type { ShipmentWithRelations } from '@/types/shipment';

/**
 * The shipping write tools, run directly. What matters: each calls the access function the job
 * page calls with the arguments its dialog passes, refuses what the page would not offer, keeps
 * the page's warnings as warnings, links back to the job, and names nobody.
 */

const mockCreateShipment = vi.fn();
const mockSummaries = vi.fn();
const mockShipmentById = vi.fn();
const mockVoidShipment = vi.fn();
vi.mock('@/utils/shipmentsAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/shipmentsAccess')>()),
  createShipment: (...a: unknown[]) => mockCreateShipment(...a),
  getJobPartShipmentSummaries: (...a: unknown[]) => mockSummaries(...a),
  getShipmentById: (...a: unknown[]) => mockShipmentById(...a),
  voidShipment: (...a: unknown[]) => mockVoidShipment(...a),
}));

const mockCreateOutside = vi.fn();
const mockOpenSlips = vi.fn();
const mockOutsideById = vi.fn();
const mockOutsideSummaries = vi.fn();
const mockReceiveOperation = vi.fn();
const mockReceiveShipment = vi.fn();
const mockShipTo = vi.fn();
const mockVoidOutside = vi.fn();
vi.mock('@/utils/outsideShipmentsAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/outsideShipmentsAccess')>()),
  createOutsideShipment: (...a: unknown[]) => mockCreateOutside(...a),
  getOpenOutsideShipments: (...a: unknown[]) => mockOpenSlips(...a),
  getOutsideShipmentById: (...a: unknown[]) => mockOutsideById(...a),
  getOutsideSummariesForPart: (...a: unknown[]) => mockOutsideSummaries(...a),
  receiveOutsideOperation: (...a: unknown[]) => mockReceiveOperation(...a),
  receiveOutsideShipment: (...a: unknown[]) => mockReceiveShipment(...a),
  resolveVendorShipTo: (...a: unknown[]) => mockShipTo(...a),
  voidOutsideShipment: (...a: unknown[]) => mockVoidOutside(...a),
}));

/** What each table answers, and every query asked of it. */
const db = vi.hoisted(() => ({
  job: null as Record<string, unknown> | null,
  shipContext: null as Record<string, unknown> | null,
  jobParts: [] as unknown[],
  shipment: null as Record<string, unknown> | null,
  outside: null as Record<string, unknown> | null,
  queries: [] as Array<{ table: string; ops: Array<[string, unknown[]]> }>,
}));

vi.mock('@/lib/supabase', () => {
  function builder(table: string) {
    const ops: Array<[string, unknown[]]> = [];
    db.queries.push({ table, ops });
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'not', 'in', 'order', 'limit']) {
      chain[m] = (...args: unknown[]) => {
        ops.push([m, args]);
        return chain;
      };
    }
    chain.maybeSingle = async () => {
      if (table === 'shipments') return { data: db.shipment, error: null };
      if (table === 'outside_shipments') return { data: db.outside, error: null };
      return { data: db.job, error: null };
    };
    chain.single = async () => ({ data: db.shipContext, error: null });
    chain.then = (resolve: (v: unknown) => void) => resolve({ data: db.jobParts, error: null });
    return chain;
  }
  return { getSupabase: () => ({ from: builder }), registerScopedClientResolver: () => {} };
});

const env: CompanyToolEnv = {
  caller: { token: 't', clientId: 'c', userId: 'u', email: null, expiresAt: 0 },
  company: { id: 'co-1', name: 'Acme Machining', role: 'user', isDemo: false, governingCompanyId: 'co-1' },
  origin: 'https://jigged.app',
  link: (path) => `https://jigged.app${path}`,
};

const JP1 = '00000000-0000-4000-8000-0000000000a1';
const JP2 = '00000000-0000-4000-8000-0000000000a2';
const JOB_ID = '00000000-0000-4000-8000-000000000001';

function liveJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    job_number: 'J-0141',
    deleted_at: null,
    production_status: 'in_progress',
    fulfillment_status: 'partially_shipped',
    ...overrides,
  };
}

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: 'acct-1',
    company_id: 'co-1',
    customer_id: 'cust-1',
    carrier: 'ups',
    bill_to_party: 'recipient',
    account_number: '12345672W9',
    account_postal_code: '67202',
    account_country_code: 'US',
    notes: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    deleted_at: null,
    ...overrides,
  };
}

function shipContext(overrides: Record<string, unknown> = {}, customer: Record<string, unknown> = {}) {
  return {
    freight_terms: null,
    customer_carrier_account_id: null,
    customer: {
      id: 'cust-1',
      name: 'Boeing',
      credit_status: 'open',
      addresses: [
        { id: 'addr-bill', address_line1: '9 Bill Rd', address_line2: null, city: 'Seattle', state: 'WA', postal_code: '98101', default_billing: true, default_shipping: false },
        { id: 'addr-ship', address_line1: '1 Main St', address_line2: null, city: 'Wichita', state: 'KS', postal_code: '67202', default_billing: false, default_shipping: true },
      ],
      carrier_accounts: [account()],
      ...customer,
    },
    job_parts: [
      { id: JP1, sequence: 1, quantity: 10, parts: { part_name: 'BRKT-100' } },
      { id: JP2, sequence: 2, quantity: 5, parts: { part_name: 'PIN-7' } },
    ],
    ...overrides,
  };
}

function hydrated(overrides: Partial<ShipmentWithRelations> = {}): ShipmentWithRelations {
  return {
    id: 'ship-9',
    company_id: 'co-1',
    customer_id: 'cust-1',
    job_id: 'job-1',
    shipping_address_id: 'addr-ship',
    one_time_address: null,
    packing_slip_number: 'PS-0141-3',
    ship_date: '2026-11-09',
    carrier: 'UPS',
    shipping_method: 'shipment',
    created_by: 'user-shipper',
    created_at: '2026-11-09T15:00:00Z',
    voided_at: null,
    voided_by: null,
    customer_name: 'Boeing',
    bill_to_address: null,
    ship_to_address: {
      address_line1: '1 Main St',
      address_line2: null,
      city: 'Wichita',
      state: 'KS',
      postal_code: '67202',
      country: 'US',
      attention_to: 'Receiving',
    },
    freight_terms: 'collect',
    customer_carrier_account_id: 'acct-1',
    freight_account_snapshot: null,
    heat_numbers_snapshot: [],
    created_by_member: { user_id: 'user-shipper', name: 'Pat Packer', email: 'pat@acme.test' },
    shipment_line_items: [
      {
        id: 'li-2',
        shipment_id: 'ship-9',
        job_part_id: JP2,
        quantity: 7,
        created_at: '2026-11-09T15:00:01Z',
        job_part: { id: JP2, job_id: 'job-1', quantity: 5, part: { id: 'p-2', part_name: 'PIN-7', description: null }, job: { id: 'job-1', job_number: 'J-0141', customer_po_number: null, quote_id: null } },
      },
      {
        id: 'li-1',
        shipment_id: 'ship-9',
        job_part_id: JP1,
        quantity: 4,
        created_at: '2026-11-09T15:00:00Z',
        job_part: { id: JP1, job_id: 'job-1', quantity: 10, part: { id: 'p-1', part_name: 'BRKT-100', description: null }, job: { id: 'job-1', job_number: 'J-0141', customer_po_number: null, quote_id: null } },
      },
    ],
    ...overrides,
  };
}

/** No output may carry who did the work. */
function expectNobodyNamed(data: unknown) {
  const text = JSON.stringify(data);
  expect(text).not.toMatch(/user-shipper|user-receiver|Pat Packer|pat@acme/);
  expect(text).not.toMatch(/created_by|voided_by|received_by|closed_by|_member/);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-09T18:00:00Z'));
  db.job = null;
  db.shipContext = null;
  db.jobParts = [];
  db.shipment = null;
  db.outside = null;
  db.queries = [];
  mockSummaries.mockResolvedValue([
    { job_part_id: JP1, qty_ordered: 10, qty_shipped: 6, qty_remaining: 4, last_ship_date: null },
    { job_part_id: JP2, qty_ordered: 5, qty_shipped: 0, qty_remaining: 5, last_ship_date: null },
  ]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('create_shipment', () => {
  it('creates the slip the form would, freight and carrier resolved from the customer account', async () => {
    db.job = liveJob();
    db.shipContext = shipContext({}, { credit_status: 'hold' });
    mockCreateShipment.mockResolvedValue({ shipmentId: 'ship-9', packingSlipNumber: 'PS-0141-3' });
    mockShipmentById.mockResolvedValue(hydrated());

    const res = await createShipmentTool.run(
      {
        job_number: ' J-0141 ',
        lines: [
          { job_part_id: JP2, quantity: 7 },
          { job_part_id: JP1, quantity: 4 },
        ],
        shipping_method: 'shipment',
        ship_date: '2026-11-10',
      },
      env,
    );
    if (!res.ok) throw new Error(res.message);

    // The form's payload: lines in part order, the account's carrier seeded, the customer's
    // standing arrangement (one live account billed to the receiver) as the freight.
    expect(mockCreateShipment).toHaveBeenCalledWith('co-1', {
      customer_id: 'cust-1',
      shipping_address_id: 'addr-ship',
      one_time_address: null,
      ship_date: '2026-11-10',
      carrier: 'UPS',
      shipping_method: 'shipment',
      freight_terms: 'collect',
      customer_carrier_account_id: 'acct-1',
      line_items: [
        { job_part_id: JP1, quantity: 4 },
        { job_part_id: JP2, quantity: 7 },
      ],
    });
    expect(mockShipmentById).toHaveBeenCalledWith('ship-9');
    const lookup = db.queries.find((q) => q.table === 'jobs')?.ops ?? [];
    expect(lookup).toEqual(
      expect.arrayContaining([
        ['eq', ['company_id', 'co-1']],
        ['eq', ['job_number', 'J-0141']],
        ['is', ['deleted_at', null]],
      ]),
    );

    expect(res.data).toMatchObject({
      shipment_id: 'ship-9',
      packing_slip_number: 'PS-0141-3',
      job_number: 'J-0141',
      carrier: 'UPS',
      freight_terms: 'collect',
      voided: false,
      lines: [
        { part_id: 'p-1', part_name: 'BRKT-100', quantity: 4 },
        { part_id: 'p-2', part_name: 'PIN-7', quantity: 7 },
      ],
      url: 'https://jigged.app/dashboard/co-1/jobs/job-1',
    });
    expect(res.data.ship_to?.city).toBe('Wichita');
    // Warn, never block: the credit hold and the over-ship.
    expect(res.data.warnings).toEqual([
      'Boeing is on credit hold.',
      'PIN-7 (job J-0141): shipping 7 exceeds remaining 5.',
    ]);
    expect(() => z.object(createShipmentTool.output).parse(res.data)).not.toThrow();
    expectNobodyNamed(res.data);
  });

  it('records no carrier and no freight for a pickup, and refuses either one on it', async () => {
    db.job = liveJob();
    db.shipContext = shipContext();
    mockCreateShipment.mockResolvedValue({ shipmentId: 'ship-9', packingSlipNumber: 'PS-0141-3' });
    mockShipmentById.mockResolvedValue(hydrated({ shipping_method: 'customer_pickup', carrier: null, freight_terms: null }));

    const res = await createShipmentTool.run(
      { job_id: JOB_ID, lines: [{ job_part_id: JP1, quantity: 4 }], shipping_method: 'customer_pickup' },
      env,
    );
    expect(res.ok).toBe(true);
    expect(mockCreateShipment.mock.calls[0][1]).toMatchObject({
      carrier: null,
      freight_terms: null,
      customer_carrier_account_id: null,
      ship_date: '2026-11-09',
    });

    mockCreateShipment.mockClear();
    expect(
      await createShipmentTool.run(
        { job_id: JOB_ID, lines: [{ job_part_id: JP1, quantity: 4 }], shipping_method: 'customer_pickup', carrier: 'UPS' },
        env,
      ),
    ).toEqual({ ok: false, message: 'A carrier is recorded only when the shipping method is `shipment`.' });
    expect(
      await createShipmentTool.run(
        { job_id: JOB_ID, lines: [{ job_part_id: JP1, quantity: 4 }], shipping_method: 'restock', freight_terms: 'prepaid' },
        env,
      ),
    ).toEqual({ ok: false, message: expect.stringMatching(/^Freight terms apply only/) });
    expect(mockCreateShipment).not.toHaveBeenCalled();
  });

  it('keeps a typed carrier and terms, and asks for a carrier when nothing seeds one', async () => {
    db.job = liveJob();
    db.shipContext = shipContext({ freight_terms: 'prepaid' }, { carrier_accounts: [] });
    mockCreateShipment.mockResolvedValue({ shipmentId: 'ship-9', packingSlipNumber: 'PS-0141-3' });
    mockShipmentById.mockResolvedValue(hydrated());

    expect(
      await createShipmentTool.run(
        { job_id: JOB_ID, lines: [{ job_part_id: JP1, quantity: 4 }], shipping_method: 'shipment' },
        env,
      ),
    ).toEqual({ ok: false, message: expect.stringMatching(/^Name the carrier/) });

    await createShipmentTool.run(
      { job_id: JOB_ID, lines: [{ job_part_id: JP1, quantity: 4 }], shipping_method: 'shipment', carrier: ' fedex ' },
      env,
    );
    expect(mockCreateShipment.mock.calls[0][1]).toMatchObject({ carrier: 'FedEx', freight_terms: 'prepaid' });

    await createShipmentTool.run(
      {
        job_id: JOB_ID,
        lines: [{ job_part_id: JP1, quantity: 4 }],
        shipping_method: 'shipment',
        carrier: 'Estes Express',
        freight_terms: 'customer_arranged',
      },
      env,
    );
    expect(mockCreateShipment.mock.calls[1][1]).toMatchObject({ carrier: 'Estes Express', freight_terms: 'customer_arranged' });
  });

  it('refuses what the page would not offer', async () => {
    const lines = [{ job_part_id: JP1, quantity: 4 }];
    const ship = { job_id: JOB_ID, lines, shipping_method: 'customer_pickup' as const };

    db.job = liveJob({ production_status: 'cancelled' });
    expect(await createShipmentTool.run(ship, env)).toEqual({
      ok: false,
      message: 'Job J-0141 is cancelled, so nothing was shipped. It can be reopened in Jigged.',
    });
    db.job = liveJob({ deleted_at: '2026-11-01T00:00:00Z' });
    expect(await createShipmentTool.run(ship, env)).toEqual({
      ok: false,
      message: 'Job J-0141 is archived in Jigged, so nothing was shipped.',
    });
    db.job = liveJob({ fulfillment_status: 'fully_shipped' });
    expect(await createShipmentTool.run(ship, env)).toEqual({
      ok: false,
      message: 'Job J-0141 is already fully shipped, so nothing was shipped.',
    });

    db.job = liveJob();
    db.shipContext = shipContext();
    expect(
      await createShipmentTool.run({ ...ship, lines: [{ job_part_id: '00000000-0000-4000-8000-0000000000ff', quantity: 1 }] }, env),
    ).toEqual({ ok: false, message: expect.stringContaining(`BRKT-100 (job_part_id ${JP1})`) });
    expect(
      await createShipmentTool.run({ ...ship, lines: [lines[0], { job_part_id: JP1, quantity: 2 }] }, env),
    ).toEqual({ ok: false, message: 'List each part once: BRKT-100 appears twice.' });

    // No default address: the form blocks until one is picked, so the choices come back.
    db.shipContext = shipContext({}, {
      addresses: [
        { id: 'addr-a', address_line1: '1 A St', address_line2: null, city: 'Wichita', state: 'KS', postal_code: '67202', default_billing: false, default_shipping: false },
      ],
    });
    expect(await createShipmentTool.run(ship, env)).toEqual({
      ok: false,
      message: 'Boeing has no default shipping address. Choose one with shipping_address_id: 1 A St, Wichita KS 67202 (shipping_address_id addr-a).',
    });
    expect(mockCreateShipment).not.toHaveBeenCalled();
  });

  it('says so when the job is not there, or none was named', async () => {
    expect(
      await createShipmentTool.run({ job_number: 'J-404', lines: [{ job_part_id: JP1, quantity: 1 }], shipping_method: 'restock' }, env),
    ).toEqual({ ok: false, message: 'There is no job J-404 in Acme Machining.' });
    expect(
      await createShipmentTool.run({ lines: [{ job_part_id: JP1, quantity: 1 }], shipping_method: 'restock' }, env),
    ).toEqual({ ok: false, message: 'Give a job_id or a job_number.' });
  });

  it('rejects a zero quantity before anything runs', () => {
    const input = z.object(createShipmentTool.input);
    expect(input.safeParse({ job_number: 'J-1', lines: [{ job_part_id: JP1, quantity: 0 }], shipping_method: 'shipment' }).success).toBe(false);
    expect(input.safeParse({ job_number: 'J-1', lines: [], shipping_method: 'shipment' }).success).toBe(false);
    expect(input.safeParse({ job_number: 'J-1', lines: [{ job_part_id: JP1, quantity: 1 }], shipping_method: 'by_pigeon' }).success).toBe(false);
  });
});

describe('void_shipment', () => {
  it('voids a live slip found by number in this company, as the preview dialog does', async () => {
    db.shipment = { id: 'ship-9', packing_slip_number: 'PS-0141-3', voided_at: null };
    mockShipmentById.mockResolvedValue(hydrated({ voided_at: '2026-11-09T18:00:00Z', voided_by: 'user-shipper' }));

    const res = await voidShipmentTool.run({ packing_slip_number: ' PS-0141-3 ' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(mockVoidShipment).toHaveBeenCalledWith('ship-9');
    expect(db.queries[0].ops).toEqual(
      expect.arrayContaining([
        ['eq', ['company_id', 'co-1']],
        ['eq', ['packing_slip_number', 'PS-0141-3']],
      ]),
    );
    expect(res.data).toMatchObject({
      shipment_id: 'ship-9',
      voided: true,
      job_number: 'J-0141',
      url: 'https://jigged.app/dashboard/co-1/jobs/job-1',
    });
    expect(() => z.object(voidShipmentTool.output).parse(res.data)).not.toThrow();
    expectNobodyNamed(res.data);
  });

  it('refuses a slip already voided, one that is not there, or none named', async () => {
    db.shipment = { id: 'ship-9', packing_slip_number: 'PS-0141-3', voided_at: '2026-11-01T00:00:00Z' };
    expect(await voidShipmentTool.run({ packing_slip_number: 'PS-0141-3' }, env)).toEqual({
      ok: false,
      message: 'Packing slip PS-0141-3 is already voided.',
    });
    db.shipment = null;
    expect(await voidShipmentTool.run({ packing_slip_number: 'PS-9' }, env)).toEqual({
      ok: false,
      message: 'There is no packing slip PS-9 in Acme Machining.',
    });
    expect(await voidShipmentTool.run({}, env)).toEqual({ ok: false, message: 'Give a shipment_id or a packing_slip_number.' });
    expect(mockVoidShipment).not.toHaveBeenCalled();
  });
});

function receipt(overrides: Partial<OutsideShipmentReceipt> = {}): OutsideShipmentReceipt {
  return {
    id: 'r-1',
    company_id: 'co-1',
    outside_shipment_id: 'os-1',
    job_operation_id: 'op-20',
    job_part_id: JP1,
    quantity_good: 4,
    received_at: '2026-11-05T10:00:00Z',
    received_by: 'user-receiver',
    note: null,
    voided_at: null,
    voided_by: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function slip(overrides: Partial<OutsideShipmentWithRelations> = {}): OutsideShipmentWithRelations {
  return {
    id: 'os-1',
    company_id: 'co-1',
    job_id: 'job-1',
    job_part_id: JP1,
    job_operation_id: 'op-20',
    vendor_id: 'v-1',
    vendor_address_id: 'va-1',
    vendor_contact_id: null,
    vendor_name: 'Valley Plating',
    service_name: 'Anodize',
    ship_to_address: null,
    ship_to_contact: null,
    slip_number: 'VPS-0141-1',
    quantity: 10,
    shipped_at: '2026-11-01T09:00:00Z',
    due_back_on: '2026-11-20',
    carrier: null,
    notes: 'Type II black',
    closed_at: null,
    closed_by: null,
    created_by: 'user-shipper',
    voided_at: null,
    voided_by: null,
    created_at: '2026-11-01T09:00:00Z',
    updated_at: '',
    receipts: [],
    shipped_by_member: { id: 'user-shipper', name: 'Pat Packer' },
    job: { id: 'job-1', job_number: 'J-0141' },
    job_operation: { id: 'op-20', operation_name: 'Anodize', sequence: 20 },
    job_part: { id: JP1, quantity: 10, part: { id: 'p-1', part_name: 'BRKT-100' } },
    ...overrides,
  };
}

/** One part, an in-house step and an outside one. */
function routing(extraOps: unknown[] = []) {
  return [
    {
      id: JP1,
      sequence: 1,
      parts: { part_name: 'BRKT-100' },
      job_operations: [
        { id: 'op-10', sequence: 10, operation_name: 'Mill', vendor_service_id: null, instructions: null, vendor_service: null },
        {
          id: 'op-20',
          sequence: 20,
          operation_name: 'Anodize',
          vendor_service_id: 'vs-1',
          instructions: ' Type II black ',
          vendor_service: { name: 'Anodize', vendor: { id: 'v-1', name: 'Valley Plating' } },
        },
        ...extraOps,
      ],
    },
  ];
}

function opSummary(overrides: Record<string, unknown> = {}) {
  return {
    job_operation_id: 'op-20',
    qty_ordered: 10,
    qty_sent: 0,
    qty_good: 0,
    qty_at_vendor: 0,
    qty_to_send: 10,
    oldest_open_shipped_at: null,
    earliest_due_back_on: null,
    open_slip_count: 0,
    ...overrides,
  };
}

describe('send_outside', () => {
  it('sends with what the dialog passes: the step, quantity, due-back, resolved ship-to and the step\'s instructions', async () => {
    db.job = liveJob();
    db.jobParts = routing();
    mockOutsideSummaries.mockResolvedValue([opSummary()]);
    mockShipTo.mockResolvedValue({ address: { id: 'va-1', label: '5 Dock Rd, Wichita, KS' }, choices: [{ id: 'va-1', label: '5 Dock Rd, Wichita, KS' }], requiresChoice: false });
    mockCreateOutside.mockResolvedValue({ shipmentId: 'os-1', slipNumber: 'VPS-0141-1' });
    mockOutsideById.mockResolvedValue(slip({ quantity: 12 }));

    const res = await sendOutside.run({ job_number: 'J-0141', quantity: 12, due_back_on: '2026-11-20' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(mockOutsideSummaries).toHaveBeenCalledWith(JP1);
    expect(mockShipTo).toHaveBeenCalledWith('v-1');
    expect(mockCreateOutside).toHaveBeenCalledWith({
      jobOperationId: 'op-20',
      quantity: 12,
      dueBackOn: '2026-11-20',
      vendorAddressId: 'va-1',
      notes: 'Type II black',
    });
    expect(res.data).toMatchObject({
      outside_shipment_id: 'os-1',
      slip_number: 'VPS-0141-1',
      vendor_name: 'Valley Plating',
      job_number: 'J-0141',
      operation: 'Anodize',
      status: 'open',
      quantity_sent: 12,
      quantity_outstanding: 12,
      url: 'https://jigged.app/dashboard/co-1/jobs/job-1',
    });
    expect(res.data.warnings).toEqual([expect.stringMatching(/^That is 2 more than this step needs/)]);
    expect(() => z.object(sendOutside.output).parse(res.data)).not.toThrow();
    expectNobodyNamed(res.data);
  });

  it('defaults the quantity to what is left to send, and takes "" as no instructions', async () => {
    db.job = liveJob();
    db.jobParts = routing();
    mockOutsideSummaries.mockResolvedValue([opSummary({ qty_to_send: 6, qty_sent: 4, qty_at_vendor: 4 })]);
    mockShipTo.mockResolvedValue({ address: null, choices: [], requiresChoice: false });
    mockCreateOutside.mockResolvedValue({ shipmentId: 'os-2', slipNumber: 'VPS-0141-2' });
    mockOutsideById.mockResolvedValue(slip({ id: 'os-2', quantity: 6 }));

    const res = await sendOutside.run({ job_id: JOB_ID, operation_sequence: 20, instructions: '  ' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(mockCreateOutside).toHaveBeenCalledWith({
      jobOperationId: 'op-20',
      quantity: 6,
      dueBackOn: null,
      vendorAddressId: null,
      notes: null,
    });
    expect(res.data.warnings).toEqual(['No address on file for Valley Plating. The slip prints without a ship-to block.']);
  });

  it('refuses what the operation card would not offer', async () => {
    db.job = liveJob();
    db.jobParts = routing();

    expect(await sendOutside.run({ job_id: JOB_ID, operation_sequence: 10 }, env)).toEqual({
      ok: false,
      message: 'step 10 (Mill) is done in-house, so nothing goes to a vendor for it.',
    });

    mockOutsideSummaries.mockResolvedValue([opSummary({ qty_to_send: 0, qty_sent: 10, qty_at_vendor: 10 })]);
    expect(await sendOutside.run({ job_id: JOB_ID }, env)).toEqual({
      ok: false,
      message: 'Nothing is left to send for step 20 (Anodize) on BRKT-100: every piece is at Valley Plating or already back.',
    });

    mockOutsideSummaries.mockResolvedValue([opSummary()]);
    mockShipTo.mockResolvedValue({
      address: null,
      choices: [
        { id: 'va-1', label: '5 Dock Rd, Wichita, KS' },
        { id: 'va-2', label: 'PO Box 9, Wichita, KS' },
      ],
      requiresChoice: true,
    });
    expect(await sendOutside.run({ job_id: JOB_ID }, env)).toEqual({
      ok: false,
      message: expect.stringContaining('vendor_address_id: 5 Dock Rd, Wichita, KS (vendor_address_id va-1); PO Box 9'),
    });
    expect(await sendOutside.run({ job_id: JOB_ID, due_back_on: '2026-11-01' }, env)).toEqual({
      ok: false,
      message: 'The due-back date cannot be before the ship date.',
    });

    db.jobParts = routing([
      { id: 'op-30', sequence: 30, operation_name: 'Passivate', vendor_service_id: 'vs-2', instructions: null, vendor_service: null },
    ]);
    expect(await sendOutside.run({ job_id: JOB_ID }, env)).toEqual({
      ok: false,
      message: expect.stringMatching(/more than one outside step\. Name one with operation_sequence: step 20 \(Anodize\), step 30 \(Passivate\)/),
    });

    db.job = liveJob({ production_status: 'cancelled' });
    expect(await sendOutside.run({ job_id: JOB_ID }, env)).toEqual({
      ok: false,
      message: 'Job J-0141 is cancelled, so nothing was sent. It can be reopened in Jigged.',
    });
    expect(mockCreateOutside).not.toHaveBeenCalled();
  });
});

describe('receive_outside', () => {
  it('receives everything still out on a named slip, as the drawer does', async () => {
    db.outside = { id: 'os-1', slip_number: 'VPS-0141-1', voided_at: null };
    db.job = liveJob();
    mockOutsideById
      .mockResolvedValueOnce(slip({ receipts: [receipt()] }))
      .mockResolvedValueOnce(slip({ receipts: [receipt(), receipt({ id: 'r-2', quantity_good: 6 })] }));

    const res = await receiveOutside.run({ slip_number: 'VPS-0141-1' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(mockReceiveShipment).toHaveBeenCalledWith('os-1', { quantityGood: 6, closeShipment: false });
    expect(mockReceiveOperation).not.toHaveBeenCalled();
    expect(db.queries.find((q) => q.table === 'outside_shipments')?.ops).toEqual(
      expect.arrayContaining([
        ['eq', ['company_id', 'co-1']],
        ['eq', ['slip_number', 'VPS-0141-1']],
      ]),
    );
    expect(res.data).toMatchObject({
      outside_shipment_id: 'os-1',
      status: 'received',
      quantity_received: 10,
      quantity_outstanding: 0,
      received: 6,
      closed_short: false,
      send_recorded: false,
      warnings: [],
      url: 'https://jigged.app/dashboard/co-1/jobs/job-1',
    });
    expect(() => z.object(receiveOutside.output).parse(res.data)).not.toThrow();
    expectNobodyNamed(res.data);
  });

  it('closes short only when something is written off', async () => {
    db.outside = { id: 'os-1', slip_number: 'VPS-0141-1', voided_at: null };
    db.job = liveJob();
    mockOutsideById.mockResolvedValue(slip({ receipts: [receipt()] }));

    await receiveOutside.run({ outside_shipment_id: '00000000-0000-4000-8000-0000000000c1', quantity: 4, close_slip: true }, env);
    expect(mockReceiveShipment).toHaveBeenLastCalledWith('os-1', { quantityGood: 4, closeShipment: true });

    await receiveOutside.run({ outside_shipment_id: '00000000-0000-4000-8000-0000000000c1', quantity: 0, close_slip: true }, env);
    expect(mockReceiveShipment).toHaveBeenLastCalledWith('os-1', { quantityGood: 0, closeShipment: true });

    const full = await receiveOutside.run({ outside_shipment_id: '00000000-0000-4000-8000-0000000000c1', quantity: 6, close_slip: true }, env);
    expect(mockReceiveShipment).toHaveBeenLastCalledWith('os-1', { quantityGood: 6, closeShipment: false });
    expect(full).toMatchObject({ ok: true, data: { closed_short: false } });

    const over = await receiveOutside.run({ outside_shipment_id: '00000000-0000-4000-8000-0000000000c1', quantity: 8 }, env);
    expect(over).toMatchObject({ ok: true, data: { warnings: [expect.stringMatching(/^That is 2 more than went out/)] } });

    mockReceiveShipment.mockClear();
    expect(await receiveOutside.run({ outside_shipment_id: '00000000-0000-4000-8000-0000000000c1', quantity: 0 }, env)).toEqual({
      ok: false,
      message: 'Give how many came back, or close_slip with 0 to write off what is still out.',
    });
    expect(mockReceiveShipment).not.toHaveBeenCalled();
  });

  it('receives against the step\'s oldest open slip, or records the send when none was made', async () => {
    db.job = liveJob();
    db.jobParts = routing();
    mockOutsideSummaries.mockResolvedValue([opSummary({ qty_sent: 10, qty_at_vendor: 10, qty_to_send: 0 })]);
    mockOpenSlips.mockResolvedValue([{ ...slip({ id: 'os-old' }), outstanding: 10 }]);
    mockOutsideById.mockResolvedValue(slip({ id: 'os-old' }));
    const viaSlip = await receiveOutside.run({ job_number: 'J-0141', quantity: 10 }, env);
    expect(viaSlip.ok).toBe(true);
    expect(mockOpenSlips).toHaveBeenCalledWith('op-20');
    expect(mockReceiveShipment).toHaveBeenCalledWith('os-old', { quantityGood: 10, closeShipment: false });

    // Nothing ever sent: the dialog's after-the-fact case.
    mockOutsideSummaries.mockResolvedValue([opSummary()]);
    mockOpenSlips.mockResolvedValue([]);
    mockReceiveOperation.mockResolvedValue({ shipmentId: 'os-back', receiptId: 'r-9', wasBackfilled: true });
    mockOutsideById.mockResolvedValue(slip({ id: 'os-back', receipts: [receipt({ quantity_good: 10 })] }));
    expect(await receiveOutside.run({ job_number: 'J-0141' }, env)).toEqual({
      ok: false,
      message: 'No slip is open for that step, so give the quantity that came back.',
    });
    const backfilled = await receiveOutside.run({ job_number: 'J-0141', quantity: 10 }, env);
    expect(mockReceiveOperation).toHaveBeenCalledWith('op-20', { quantityGood: 10, closeShipment: false });
    expect(backfilled).toMatchObject({ ok: true, data: { outside_shipment_id: 'os-back', send_recorded: true, received: 10 } });
  });

  it('refuses a slip it cannot receive against, and a step with nothing out', async () => {
    db.job = liveJob();
    db.outside = { id: 'os-1', slip_number: 'VPS-0141-1', voided_at: null };
    mockOutsideById.mockResolvedValue(slip({ voided_at: '2026-11-02T00:00:00Z' }));
    expect(await receiveOutside.run({ slip_number: 'VPS-0141-1' }, env)).toEqual({
      ok: false,
      message: 'Slip VPS-0141-1 was voided, so nothing can be received against it.',
    });
    mockOutsideById.mockResolvedValue(slip({ closed_at: '2026-11-03T00:00:00Z' }));
    expect(await receiveOutside.run({ slip_number: 'VPS-0141-1' }, env)).toEqual({
      ok: false,
      message: 'Slip VPS-0141-1 was closed, so nothing more is expected back on it.',
    });
    mockOutsideById.mockResolvedValue(slip({ receipts: [receipt({ quantity_good: 10 })] }));
    expect(await receiveOutside.run({ slip_number: 'VPS-0141-1' }, env)).toEqual({
      ok: false,
      message: 'Everything sent on slip VPS-0141-1 is already back.',
    });

    db.outside = null;
    expect(await receiveOutside.run({ slip_number: 'VPS-9' }, env)).toEqual({
      ok: false,
      message: 'There is no vendor slip VPS-9 in Acme Machining.',
    });

    db.jobParts = routing();
    mockOutsideSummaries.mockResolvedValue([opSummary({ qty_sent: 10, qty_good: 10, qty_to_send: 0 })]);
    expect(await receiveOutside.run({ job_number: 'J-0141' }, env)).toEqual({
      ok: false,
      message: 'Nothing from step 20 (Anodize) on BRKT-100 is at Valley Plating.',
    });
    expect(await receiveOutside.run({}, env)).toEqual({
      ok: false,
      message: 'Give a slip (outside_shipment_id or slip_number), or a job_id or job_number.',
    });
    expect(mockReceiveShipment).not.toHaveBeenCalled();
    expect(mockReceiveOperation).not.toHaveBeenCalled();
  });
});

describe('void_outside_shipment', () => {
  it('voids the slip and what was received against it', async () => {
    db.outside = { id: 'os-1', slip_number: 'VPS-0141-1', voided_at: null };
    mockVoidOutside.mockResolvedValue({ receiptsVoided: 1 });
    mockOutsideById.mockResolvedValue(slip({ voided_at: '2026-11-09T18:00:00Z', receipts: [receipt({ voided_at: '2026-11-09T18:00:00Z' })] }));

    const res = await voidOutsideShipmentTool.run({ slip_number: 'VPS-0141-1' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(mockVoidOutside).toHaveBeenCalledWith('os-1');
    expect(res.data).toMatchObject({
      outside_shipment_id: 'os-1',
      receipts_voided: 1,
      quantity_outstanding: 0,
      quantity_received: 0,
      url: 'https://jigged.app/dashboard/co-1/jobs/job-1',
    });
    expect(() => z.object(voidOutsideShipmentTool.output).parse(res.data)).not.toThrow();
    expectNobodyNamed(res.data);
  });

  it('refuses a slip already voided, one that is not there, or none named', async () => {
    db.outside = { id: 'os-1', slip_number: 'VPS-0141-1', voided_at: '2026-11-02T00:00:00Z' };
    expect(await voidOutsideShipmentTool.run({ slip_number: 'VPS-0141-1' }, env)).toEqual({
      ok: false,
      message: 'Slip VPS-0141-1 is already voided.',
    });
    db.outside = null;
    expect(await voidOutsideShipmentTool.run({ outside_shipment_id: '00000000-0000-4000-8000-0000000000c1' }, env)).toEqual({
      ok: false,
      message: 'There is no vendor slip with that id in Acme Machining.',
    });
    expect(await voidOutsideShipmentTool.run({}, env)).toEqual({ ok: false, message: 'Give an outside_shipment_id or a slip_number.' });
    expect(mockVoidOutside).not.toHaveBeenCalled();
  });
});

describe('the shipping write catalogue', () => {
  it('declares the hints the brief sets', () => {
    const hints = Object.fromEntries(
      SHIPPING_WRITE_TOOLS.map((t) => [t.name, [t.access, Boolean(t.destructive), Boolean(t.idempotent), Boolean(t.openWorld)]]),
    );
    expect(hints).toEqual({
      create_shipment: ['write', false, false, false],
      void_shipment: ['write', true, true, false],
      send_outside: ['write', false, false, false],
      receive_outside: ['write', false, false, false],
      void_outside_shipment: ['write', true, true, false],
    });
  });
});
