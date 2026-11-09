import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

import type { CompanyToolEnv } from '@/lib/mcp/defineTool';
import { listOutsideShipments, listShipments } from '@/lib/mcp/tools/shipping';
import type { OutsideShipmentReceipt, OutsideShipmentWithRelations } from '@/types/outsideShipment';
import type { Shipment } from '@/types/shipment';

/**
 * The shipping tools, run directly. What matters: the filters reach the access layer, an
 * archived job's shipments stay out of the list, the page and the deep links, and that nobody is
 * named against packing, shipping or receiving.
 */

const mockList = vi.fn();
const mockForJob = vi.fn();
vi.mock('@/utils/shipmentsAccess', () => ({
  listShipmentsForCompany: (...a: unknown[]) => mockList(...a),
  getShipmentsForJob: (...a: unknown[]) => mockForJob(...a),
}));

const mockOutsideList = vi.fn();
const mockOutsideForJob = vi.fn();
vi.mock('@/utils/outsideShipmentsAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/outsideShipmentsAccess')>()),
  listOutsideShipmentsForCompany: (...a: unknown[]) => mockOutsideList(...a),
  getOutsideShipmentsForJob: (...a: unknown[]) => mockOutsideForJob(...a),
}));

/** What each table answers, by the shape of the query asked of it. */
const db = vi.hoisted(() => ({
  jobLookup: null as { id: string; job_number: string } | null,
  archived: [] as Array<{ id: string }>,
  jobNumbers: [] as Array<{ id: string; job_number: string }>,
  lines: [] as Array<{ shipment_id: string; quantity: number; job_part: { part: { id: string; part_name: string } | null } | null }>,
  lookups: [] as Array<Array<[string, unknown[]]>>,
}));

vi.mock('@/lib/supabase', () => {
  function builder(table: string) {
    const ops: Array<[string, unknown[]]> = [];
    const answer = () => {
      if (table === 'shipment_line_items') return db.lines;
      if (ops.some(([m]) => m === 'not')) return db.archived;
      return db.jobNumbers;
    };
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'not', 'in', 'order', 'range', 'limit']) {
      chain[m] = (...args: unknown[]) => {
        ops.push([m, args]);
        return chain;
      };
    }
    chain.maybeSingle = async () => {
      db.lookups.push(ops);
      return { data: db.jobLookup, error: null };
    };
    chain.then = (resolve: (v: unknown) => void) => resolve({ data: answer(), error: null });
    return chain;
  }
  return { getSupabase: () => ({ from: builder }), registerScopedClientResolver: () => {} };
});

const env: CompanyToolEnv = {
  caller: { token: 't', clientId: 'c', userId: 'u', email: null, expiresAt: 0 },
  company: { id: 'co-1', name: 'Acme Machining', role: 'user', isDemo: false, governingCompanyId: 'co-1' },
  link: (path) => `https://jigged.app${path}`,
};

function shipment(overrides: Partial<Shipment>): Shipment {
  return {
    id: 'ship-1',
    company_id: 'co-1',
    customer_id: 'cust-1',
    job_id: 'job-1',
    shipping_address_id: null,
    one_time_address: null,
    packing_slip_number: 'PS-1001-1',
    ship_date: '2026-11-02',
    carrier: 'UPS',
    shipping_method: 'shipment',
    created_by: 'user-shipper',
    created_at: '2026-11-02T15:00:00Z',
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
    freight_terms: 'prepaid',
    customer_carrier_account_id: null,
    freight_account_snapshot: null,
    heat_numbers_snapshot: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.jobLookup = null;
  db.archived = [];
  db.jobNumbers = [];
  db.lines = [];
  db.lookups = [];
});

describe('list_shipments', () => {
  it('lists live shipments with job number, lines and a link, and leaves archived jobs out', async () => {
    mockList.mockResolvedValue([
      shipment({ id: 's-new', job_id: 'job-1', packing_slip_number: 'PS-1001-2', ship_date: '2026-11-05' }),
      shipment({ id: 's-archived', job_id: 'job-gone' }),
      shipment({ id: 's-old', job_id: 'job-1', packing_slip_number: 'PS-1001-1' }),
    ]);
    db.archived = [{ id: 'job-gone' }];
    db.jobNumbers = [{ id: 'job-1', job_number: 'J-1001' }];
    db.lines = [
      { shipment_id: 's-new', quantity: 4, job_part: { part: { id: 'p-1', part_name: 'BRKT-100' } } },
      { shipment_id: 's-new', quantity: 2, job_part: { part: { id: 'p-2', part_name: 'PIN-7' } } },
    ];

    const res = await listShipments.run({}, env);
    if (!res.ok) throw new Error(res.message);
    expect(mockList).toHaveBeenCalledWith('co-1', {
      customerId: undefined,
      startDate: undefined,
      endDate: undefined,
      voided: false,
    });
    expect(res.data.total).toBe(2);
    expect(res.data.shipments.map((s) => s.shipment_id)).toEqual(['s-new', 's-old']);
    expect(res.data.shipments[0]).toMatchObject({
      packing_slip_number: 'PS-1001-2',
      job_number: 'J-1001',
      customer_name: 'Boeing',
      shipping_method: 'shipment',
      carrier: 'UPS',
      freight_terms: 'prepaid',
      voided: false,
      lines: [
        { part_id: 'p-1', part_name: 'BRKT-100', quantity: 4 },
        { part_id: 'p-2', part_name: 'PIN-7', quantity: 2 },
      ],
      url: 'https://jigged.app/dashboard/co-1/jobs/job-1',
    });
    expect(res.data.shipments[0].ship_to?.city).toBe('Wichita');
    expect(res.data.shipments[1].lines).toEqual([]);
    expect(() => z.object(listShipments.output).parse(res.data)).not.toThrow();
    const text = JSON.stringify(res.data);
    expect(text).not.toContain('user-shipper');
    expect(text).not.toMatch(/created_by|voided_by/);
  });

  it('passes the customer, date window and voided choice to the access layer', async () => {
    mockList.mockResolvedValue([]);
    await listShipments.run(
      { customer_id: '00000000-0000-4000-8000-000000000001', shipped_from: '2026-10-01', shipped_to: '2026-10-31', include_voided: true },
      env,
    );
    expect(mockList).toHaveBeenCalledWith('co-1', {
      customerId: '00000000-0000-4000-8000-000000000001',
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      voided: undefined,
    });
  });

  it('narrows to one job by number, reading that job\'s slips, and hides voided ones unless asked', async () => {
    db.jobLookup = { id: 'job-7', job_number: 'J-7' };
    db.jobNumbers = [{ id: 'job-7', job_number: 'J-7' }];
    mockForJob.mockResolvedValue([
      shipment({ id: 'a', job_id: 'job-7', ship_date: '2026-11-03' }),
      shipment({ id: 'b', job_id: 'job-7', ship_date: '2026-09-01' }),
      shipment({ id: 'c', job_id: 'job-7', voided_at: '2026-11-04T10:00:00Z', voided_by: 'user-x' }),
    ]);

    const res = await listShipments.run({ job_number: ' J-7 ', shipped_from: '2026-10-01' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(mockForJob).toHaveBeenCalledWith('job-7');
    expect(mockList).not.toHaveBeenCalled();
    expect(res.data.shipments.map((s) => s.shipment_id)).toEqual(['a']);
    expect(db.lookups[0]).toEqual(
      expect.arrayContaining([
        ['eq', ['company_id', 'co-1']],
        ['is', ['deleted_at', null]],
        ['eq', ['job_number', 'J-7']],
      ]),
    );

    const withVoided = await listShipments.run({ job_id: '00000000-0000-4000-8000-000000000007', include_voided: true }, env);
    if (!withVoided.ok) throw new Error(withVoided.message);
    expect(withVoided.data.shipments.map((s) => [s.shipment_id, s.voided])).toEqual([
      ['a', false],
      ['b', false],
      ['c', true],
    ]);
  });

  it('says so when the job is not there', async () => {
    expect(await listShipments.run({ job_number: 'J-404' }, env)).toEqual({
      ok: false,
      message: 'There is no job J-404 in Acme Machining.',
    });
    expect(mockList).not.toHaveBeenCalled();
  });

  it('pages with a cursor and refuses one it did not issue', async () => {
    mockList.mockResolvedValue(Array.from({ length: 5 }, (_, i) => shipment({ id: `s${i}` })));
    const first = await listShipments.run({ limit: 2 }, env);
    if (!first.ok) throw new Error(first.message);
    expect(first.data.shipments.map((s) => s.shipment_id)).toEqual(['s0', 's1']);
    expect(first.data.next_cursor).toBe('2');
    expect(first.data.total).toBe(5);
    const last = await listShipments.run({ limit: 2, cursor: '4' }, env);
    if (!last.ok) throw new Error(last.message);
    expect(last.data.shipments.map((s) => s.shipment_id)).toEqual(['s4']);
    expect(last.data.next_cursor).toBeNull();
    expect(await listShipments.run({ cursor: 'x' }, env)).toEqual({ ok: false, message: expect.stringMatching(/cursor/) });
  });
});

function receipt(overrides: Partial<OutsideShipmentReceipt>): OutsideShipmentReceipt {
  return {
    id: 'r-1',
    company_id: 'co-1',
    outside_shipment_id: 'os-1',
    job_operation_id: 'op-1',
    job_part_id: 'jp-1',
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

function outside(overrides: Partial<OutsideShipmentWithRelations>): OutsideShipmentWithRelations {
  return {
    id: 'os-1',
    company_id: 'co-1',
    job_id: 'job-1',
    job_part_id: 'jp-1',
    job_operation_id: 'op-1',
    vendor_id: 'v-1',
    vendor_address_id: null,
    vendor_contact_id: null,
    vendor_name: 'Valley Plating',
    service_name: 'Anodize',
    ship_to_address: null,
    ship_to_contact: null,
    slip_number: 'VPS-1001-1',
    quantity: 10,
    shipped_at: '2026-11-01T09:00:00Z',
    due_back_on: '2026-11-08',
    carrier: null,
    notes: 'Type II black, mask the bore',
    closed_at: null,
    closed_by: null,
    created_by: 'user-shipper',
    voided_at: null,
    voided_by: null,
    created_at: '2026-11-01T09:00:00Z',
    updated_at: '',
    receipts: [],
    job: { id: 'job-1', job_number: 'J-1001' },
    job_operation: { id: 'op-1', operation_name: 'Anodize', sequence: 3 },
    job_part: { id: 'jp-1', quantity: 10, part: { id: 'p-1', part_name: 'BRKT-100' } },
    ...overrides,
  };
}

describe('list_outside_shipments', () => {
  it('returns open sends by default, with what is still out, and names nobody', async () => {
    mockOutsideList.mockResolvedValue([
      outside({ receipts: [receipt({}), receipt({ id: 'r-2', quantity_good: 2, voided_at: '2026-11-06T00:00:00Z' })] }),
    ]);
    const res = await listOutsideShipments.run({ vendor_id: '00000000-0000-4000-8000-0000000000aa' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(mockOutsideList).toHaveBeenCalledWith('co-1', {
      vendorId: '00000000-0000-4000-8000-0000000000aa',
      openOnly: true,
    });
    expect(res.data.outside_shipments[0]).toEqual({
      outside_shipment_id: 'os-1',
      slip_number: 'VPS-1001-1',
      vendor_id: 'v-1',
      vendor_name: 'Valley Plating',
      service: 'Anodize',
      job_id: 'job-1',
      job_number: 'J-1001',
      part_id: 'p-1',
      part_name: 'BRKT-100',
      operation: 'Anodize',
      status: 'open',
      quantity_sent: 10,
      quantity_received: 4,
      quantity_outstanding: 6,
      sent_at: '2026-11-01T09:00:00Z',
      expected_back: '2026-11-08',
      carrier: null,
      notes: 'Type II black, mask the bore',
      url: 'https://jigged.app/dashboard/co-1/jobs/job-1',
    });
    expect(() => z.object(listOutsideShipments.output).parse(res.data)).not.toThrow();
    const text = JSON.stringify(res.data);
    expect(text).not.toContain('user-receiver');
    expect(text).not.toContain('user-shipper');
    expect(text).not.toMatch(/received_by|created_by|closed_by/);
  });

  it('includes finished sends when open_only is false, marking received and closed', async () => {
    mockOutsideList.mockResolvedValue([
      outside({ id: 'done', receipts: [receipt({ quantity_good: 10 })] }),
      outside({ id: 'short', closed_at: '2026-11-07T00:00:00Z', receipts: [receipt({ quantity_good: 8 })] }),
    ]);
    const res = await listOutsideShipments.run({ open_only: false }, env);
    if (!res.ok) throw new Error(res.message);
    expect(mockOutsideList).toHaveBeenCalledWith('co-1', { vendorId: undefined, openOnly: false });
    expect(res.data.outside_shipments.map((s) => [s.outside_shipment_id, s.status, s.quantity_outstanding])).toEqual([
      ['done', 'received', 0],
      ['short', 'closed', 0],
    ]);
  });

  it('narrows to one job, dropping voided and returned sends', async () => {
    db.jobLookup = { id: 'job-9', job_number: 'J-9' };
    mockOutsideForJob.mockResolvedValue([
      outside({ id: 'out', job_id: 'job-9', job: null }),
      outside({ id: 'back', job_id: 'job-9', job: null, receipts: [receipt({ quantity_good: 10 })] }),
      outside({ id: 'void', job_id: 'job-9', job: null, voided_at: '2026-11-02T00:00:00Z' }),
      outside({ id: 'other-vendor', job_id: 'job-9', job: null, vendor_id: 'v-2' }),
    ]);
    const res = await listOutsideShipments.run({ job_number: 'J-9', vendor_id: '00000000-0000-4000-8000-0000000000aa' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(mockOutsideForJob).toHaveBeenCalledWith('job-9');
    expect(mockOutsideList).not.toHaveBeenCalled();
    expect(res.data.outside_shipments).toEqual([]);

    const all = await listOutsideShipments.run({ job_number: 'J-9' }, env);
    if (!all.ok) throw new Error(all.message);
    expect(all.data.outside_shipments.map((s) => [s.outside_shipment_id, s.job_number])).toEqual([
      ['out', 'J-9'],
      ['other-vendor', 'J-9'],
    ]);
  });

  it('says so when the job is not there', async () => {
    expect(await listOutsideShipments.run({ job_number: 'J-404' }, env)).toEqual({
      ok: false,
      message: 'There is no job J-404 in Acme Machining.',
    });
  });
});
