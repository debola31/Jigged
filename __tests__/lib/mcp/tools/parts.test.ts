import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

import type { CompanyToolEnv } from '@/lib/mcp/defineTool';
import { getPart, getPartCost, listParts } from '@/lib/mcp/tools/parts';
import type { Part, PartNote } from '@/types/part';

/**
 * The part tools, run directly (the wrapper's own guards are covered in defineTool.test.ts). What
 * matters here: the filters, the page, the deep links, the by-name lookup preferring a live part,
 * archived jobs and quotes kept out of the usage lists, and no author on a note.
 */

const mockGetAllParts = vi.fn();
const mockGetMadeParts = vi.fn();
const mockGetBoughtParts = vi.fn();
const mockGetPart = vi.fn();
const mockExplain = vi.fn();
const mockNotes = vi.fn();
vi.mock('@/utils/partsAccess', () => ({
  getAllParts: (...a: unknown[]) => mockGetAllParts(...a),
  getMadeParts: (...a: unknown[]) => mockGetMadeParts(...a),
  getBoughtParts: (...a: unknown[]) => mockGetBoughtParts(...a),
  getPart: (...a: unknown[]) => mockGetPart(...a),
  getPartCostExplain: (...a: unknown[]) => mockExplain(...a),
  getPartNotes: (...a: unknown[]) => mockNotes(...a),
}));

const mockBom = vi.fn();
vi.mock('@/utils/bomAccess', () => ({ getBomForPart: (...a: unknown[]) => mockBom(...a) }));

const mockRouting = vi.fn();
vi.mock('@/utils/routingsAccess', () => ({ getRoutingForPart: (...a: unknown[]) => mockRouting(...a) }));

const mockTiers = vi.fn();
const mockPricedTiers = vi.fn();
vi.mock('@/utils/partPricingTiersAccess', () => ({
  getTiersForPart: (...a: unknown[]) => mockTiers(...a),
  getTiersWithComputedPrices: (...a: unknown[]) => mockPricedTiers(...a),
}));

const mockReferences = vi.fn();
vi.mock('@/utils/partCustomerReferencesAccess', () => ({
  getReferencesForPart: (...a: unknown[]) => mockReferences(...a),
}));

const mockVendor = vi.fn();
vi.mock('@/utils/vendorsAccess', () => ({ getVendor: (...a: unknown[]) => mockVendor(...a) }));

const mockBreakdown = vi.fn();
vi.mock('@/utils/routingCostCalculation', () => ({
  calculateRoutingCost: (...a: unknown[]) => mockBreakdown(...a),
}));

const mockOnOrder = vi.fn();
vi.mock('@/utils/vendorPoAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/vendorPoAccess')>()),
  getOnOrderForParts: (...a: unknown[]) => mockOnOrder(...a),
}));

/** Every query-builder call, by table, so a test can see which filters a query carried. */
const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
/** What an awaited query on a table resolves to. */
let lists: Record<string, { data: unknown; error: null; count?: number | null }> = {};
/** What `.maybeSingle()` on a table resolves to. */
let singles: Record<string, unknown> = {};

vi.mock('@/lib/supabase', () => {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'is', 'in', 'ilike', 'order', 'limit']) {
      chain[method] = (...args: unknown[]) => {
        calls.push({ table, method, args });
        return chain;
      };
    }
    chain.maybeSingle = async () => ({ data: singles[table] ?? null, error: null });
    chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(lists[table] ?? { data: [], error: null, count: 0 }).then(resolve, reject);
    return chain;
  };
  return { getSupabase: () => ({ from }), registerScopedClientResolver: () => {} };
});

const callsOn = (table: string, method: string) => calls.filter((c) => c.table === table && c.method === method);

const env: CompanyToolEnv = {
  caller: { token: 't', clientId: 'c', userId: 'u', email: null, expiresAt: 0 },
  company: { id: 'co-1', name: 'Acme Machining', role: 'user', isDemo: false, governingCompanyId: 'co-1' },
  link: (path) => `https://jigged.app${path}`,
};

function part(overrides: Partial<Part>): Part {
  return {
    id: 'part-1',
    company_id: 'co-1',
    part_name: 'BRKT-100',
    description: 'Bracket',
    source: 'made',
    primary_unit: 'ea',
    quantity: 0,
    reorder_point: null,
    preferred_vendor_id: null,
    costing_batch_quantity: null,
    lot_tracked: false,
    created_at: '2026-11-01T10:00:00Z',
    updated_at: '2026-11-01T10:00:00Z',
    ...overrides,
  };
}

function reset(): void {
  vi.clearAllMocks();
  calls.length = 0;
  lists = {};
  singles = {};
}

describe('list_parts', () => {
  beforeEach(reset);

  it('lists live parts by name with their preferred vendor and a link', async () => {
    mockGetAllParts.mockResolvedValue([
      part({ id: 'p1', part_name: 'A-1', preferred_vendor_id: 'v-1', source: 'bought' }),
      part({ id: 'p2', part_name: 'B-2' }),
    ]);
    lists.vendors = { data: [{ id: 'v-1', name: 'McMaster-Carr' }], error: null };
    const res = await listParts.run({}, env);
    if (!res.ok) throw new Error('expected a page');
    expect(mockGetAllParts).toHaveBeenCalledWith('co-1', '', 'part_name', 'asc');
    expect(res.data.parts[0]).toEqual({
      part_id: 'p1',
      part_name: 'A-1',
      description: 'Bracket',
      source: 'bought',
      unit: 'ea',
      preferred_vendor_id: 'v-1',
      preferred_vendor_name: 'McMaster-Carr',
      url: 'https://jigged.app/dashboard/co-1/parts/p1',
    });
    expect(res.data.parts[1].preferred_vendor_name).toBeNull();
    expect(res.data.total).toBe(2);
    expect(res.data.next_cursor).toBeNull();
  });

  it('narrows to made or bought, passes the search, and sorts by recent update on request', async () => {
    mockGetMadeParts.mockResolvedValue([]);
    mockGetBoughtParts.mockResolvedValue([]);
    await listParts.run({ source: 'made', search: 'brkt' }, env);
    expect(mockGetMadeParts).toHaveBeenCalledWith('co-1', 'brkt', 'part_name', 'asc');
    await listParts.run({ source: 'bought', sort: 'recently_updated' }, env);
    expect(mockGetBoughtParts).toHaveBeenCalledWith('co-1', '', 'updated_at', 'desc');
    expect(mockGetAllParts).not.toHaveBeenCalled();
  });

  it('pages with a cursor and refuses one it did not issue', async () => {
    mockGetAllParts.mockResolvedValue(Array.from({ length: 5 }, (_, i) => part({ id: `p${i}`, part_name: `P-${i}` })));
    const first = await listParts.run({ limit: 2 }, env);
    if (!first.ok) throw new Error('expected a page');
    expect(first.data.parts.map((p) => p.part_name)).toEqual(['P-0', 'P-1']);
    expect(first.data.next_cursor).toBe('2');
    const last = await listParts.run({ limit: 2, cursor: '4' }, env);
    if (!last.ok) throw new Error('expected a page');
    expect(last.data.parts.map((p) => p.part_name)).toEqual(['P-4']);
    expect(last.data.next_cursor).toBeNull();
    expect(await listParts.run({ cursor: 'abc' }, env)).toEqual({ ok: false, message: expect.stringMatching(/cursor/) });
  });
});

const note = (overrides: Partial<PartNote>): PartNote => ({
  id: 'n1',
  part_id: 'part-1',
  body: 'Customer wants the radius checked on every lot.',
  created_at: '2026-11-03T09:00:00Z',
  edited_at: null,
  author_id: 'uca-dana',
  author_name: 'Dana Office',
  note_type: 'user',
  ...overrides,
});

function stubPartDetail(): void {
  mockOnOrder.mockResolvedValue(new Map());
  mockGetPart.mockResolvedValue(part({ preferred_vendor_id: 'v-1' }));
  mockVendor.mockResolvedValue({ id: 'v-1', company_id: 'co-1', name: 'Anodize Co', created_at: '', updated_at: '' });
  mockPricedTiers.mockResolvedValue([
    { id: 't1', part_id: 'part-1', company_id: 'co-1', sequence: 1, quantity: 10, cost_per_unit: null, markup_percent: 30, unit_price: 52, created_at: '', updated_at: '' },
  ]);
  mockBom.mockResolvedValue([
    {
      id: 'b1',
      parent_part_id: 'part-1',
      child_part_id: 'mat-1',
      quantity: 4,
      unit: 'in',
      sequence: 1,
      charge_basis: 'cost',
      created_at: '',
      updated_at: '',
      child_part: { id: 'mat-1', part_name: '6061 bar', description: null, primary_unit: 'in', source: 'bought', costing_batch_quantity: null },
    },
  ]);
  mockRouting.mockResolvedValue({
    id: 'r1',
    company_id: 'co-1',
    part_id: 'part-1',
    name: 'Routing',
    description: null,
    created_by: null,
    created_at: null,
    updated_at: null,
    part: null,
    operations: [
      {
        id: 'op1', routing_id: 'r1', work_center_id: 'wc-1', vendor_service_id: null, sequence: 10,
        setup_minutes: 30, cycle_minutes_per_unit: 4, labor_rate_override: null, external_unit_price: null,
        instructions: 'Deburr all edges', metadata: {}, created_at: '', updated_at: '',
        work_center: { id: 'wc-1', name: 'Haas VF-2', labor_rate: 85 }, vendor_service: null,
      },
      {
        id: 'op2', routing_id: 'r1', work_center_id: null, vendor_service_id: 'vs-1', sequence: 20,
        setup_minutes: 15, cycle_minutes_per_unit: 2, labor_rate_override: null, external_unit_price: 2.5,
        instructions: null, metadata: {}, created_at: '', updated_at: '',
        work_center: null,
        vendor_service: { id: 'vs-1', name: 'Anodize, black', unit_price: 3, vendor: { id: 'v-1', name: 'Anodize Co' } },
      },
    ],
  });
  mockReferences.mockResolvedValue([
    {
      id: 'ref-1', company_id: 'co-1', part_id: 'part-1', customer_id: 'cust-1',
      customer_part_number: '1003308', customer_revision: 'C', customer_drawing_number: null,
      created_at: '', updated_at: '',
    },
  ]);
  lists.customers = { data: [{ id: 'cust-1', name: 'Boeing' }], error: null };
  lists.jobs = {
    data: [
      {
        id: 'job-2', job_number: 'J-2', production_status: 'completed', fulfillment_status: 'unshipped',
        due_date: '2099-01-10', created_at: '2026-11-05T00:00:00Z', customer_name: 'Boeing (old)',
        customers: { name: 'Boeing' }, job_parts: [{ quantity: 10 }, { quantity: 5 }],
      },
    ],
    error: null,
    count: 14,
  };
  lists.quotes = {
    data: [
      {
        id: 'q-1', quote_number: 'Q-1', status: 'active', converted_at: '2026-11-02T00:00:00Z',
        expiration_date: null, created_at: '2026-11-01T00:00:00Z', customer_name: null,
        customers: { name: 'Boeing' }, quote_line_items: [{ quantity: 100 }, { quantity: 25 }],
      },
      {
        id: 'q-2', quote_number: 'Q-2', status: 'active', converted_at: null,
        expiration_date: '2020-01-01', created_at: '2026-10-01T00:00:00Z', customer_name: 'Airbus',
        customers: null, quote_line_items: [{ quantity: 5 }],
      },
      {
        id: 'q-3', quote_number: 'Q-3', status: 'active', converted_at: null,
        expiration_date: null, created_at: '2026-09-01T00:00:00Z', customer_name: null,
        customers: { name: 'Boeing' }, quote_line_items: [{ quantity: 1 }],
      },
    ],
    error: null,
    count: 3,
  };
  mockNotes.mockResolvedValue([
    note({}),
    note({ id: 'n2', body: 'Markup 25% → 30% on the 10 break', note_type: 'pricing', created_at: '2026-11-01T09:00:00Z' }),
  ]);
}

describe('get_part', () => {
  beforeEach(reset);

  it('returns the part in full, by id, with links', async () => {
    singles.parts = { id: 'part-1', deleted_at: null };
    stubPartDetail();
    const res = await getPart.run({ part_id: '7c1e7c7e-0000-4000-8000-000000000001' }, env);
    if (!res.ok) throw new Error('expected the part');
    const d = res.data;
    expect(d).toMatchObject({ part_name: 'BRKT-100', source: 'made', archived: false, url: 'https://jigged.app/dashboard/co-1/parts/part-1' });
    expect(d.preferred_vendor).toEqual({ vendor_id: 'v-1', name: 'Anodize Co', url: 'https://jigged.app/dashboard/co-1/vendors/v-1' });
    expect(d.pricing_tiers).toEqual([{ quantity: 10, unit_price: 52, markup_percent: 30, cost_per_unit: null }]);
    expect(d.bill_of_materials[0]).toMatchObject({ part_name: '6061 bar', quantity: 4, unit: 'in', url: 'https://jigged.app/dashboard/co-1/parts/mat-1' });
    expect(d.routing).toEqual([
      { sequence: 10, operation: 'Haas VF-2', kind: 'in_house', outside_vendor: null, setup_minutes: 30, run_minutes_per_unit: 4, instructions: 'Deburr all edges' },
      // An outside step is priced by the piece: its stored minutes are not estimates.
      { sequence: 20, operation: 'Anodize, black', kind: 'outside', outside_vendor: 'Anodize Co', setup_minutes: null, run_minutes_per_unit: null, instructions: null },
    ]);
    expect(d.customer_part_numbers).toEqual([
      { customer_id: 'cust-1', customer_name: 'Boeing', customer_part_number: '1003308', customer_revision: 'C', customer_drawing_number: null },
    ]);
    expect(d.jobs_total).toBe(14);
    expect(d.recent_jobs).toEqual([
      {
        job_id: 'job-2', job_number: 'J-2', stage: 'ready_to_ship', quantity: 15, customer_name: 'Boeing',
        due_date: '2099-01-10', created_at: '2026-11-05T00:00:00Z', url: 'https://jigged.app/dashboard/co-1/jobs/job-2',
      },
    ]);
    expect(d.quotes_total).toBe(3);
    expect(d.recent_quotes.map((q) => [q.quote_number, q.status, q.customer_name])).toEqual([
      ['Q-1', 'converted', 'Boeing'],
      ['Q-2', 'expired', 'Airbus'],
      ['Q-3', 'open', 'Boeing'],
    ]);
    expect(d.recent_quotes[0].quantities).toEqual([25, 100]);
    expect(d.recent_quotes[0].url).toBe('https://jigged.app/dashboard/co-1/quotes/q-1');
  });

  it('keeps archived jobs and quotes out of the usage lists, but reads the part itself unfiltered', async () => {
    singles.parts = { id: 'part-1', deleted_at: null };
    stubPartDetail();
    await getPart.run({ part_id: '7c1e7c7e-0000-4000-8000-000000000001' }, env);
    expect(callsOn('jobs', 'is')).toEqual([{ table: 'jobs', method: 'is', args: ['deleted_at', null] }]);
    expect(callsOn('quotes', 'is')).toEqual([{ table: 'quotes', method: 'is', args: ['deleted_at', null] }]);
    expect(callsOn('jobs', 'eq')).toContainEqual({ table: 'jobs', method: 'eq', args: ['job_parts.part_id', 'part-1'] });
    expect(callsOn('jobs', 'limit')).toEqual([{ table: 'jobs', method: 'limit', args: [10] }]);
    expect(callsOn('parts', 'is')).toEqual([]);
    expect(callsOn('parts', 'eq')).toContainEqual({ table: 'parts', method: 'eq', args: ['company_id', 'co-1'] });
  });

  it('returns notes as written, with the date and no author', async () => {
    singles.parts = { id: 'part-1', deleted_at: null };
    stubPartDetail();
    const res = await getPart.run({ part_id: '7c1e7c7e-0000-4000-8000-000000000001' }, env);
    if (!res.ok) throw new Error('expected the part');
    expect(res.data.notes_total).toBe(2);
    expect(res.data.notes[0]).toEqual({
      body: 'Customer wants the radius checked on every lot.',
      note_type: 'user',
      created_at: '2026-11-03T09:00:00Z',
      edited_at: null,
    });
    expect(res.data.notes[1].note_type).toBe('pricing');
    const text = JSON.stringify(res.data.notes);
    expect(text).not.toContain('Dana Office');
    expect(text).not.toContain('uca-dana');
    expect(text).not.toMatch(/author/);
  });

  it('finds a part by name, preferring the live one over an archived namesake', async () => {
    lists.parts = {
      data: [
        { id: 'old', part_name: 'BRKT-100', deleted_at: '2026-01-01T00:00:00Z' },
        { id: 'live', part_name: 'brkt-100', deleted_at: null },
      ],
      error: null,
    };
    stubPartDetail();
    const res = await getPart.run({ part_name: ' BRKT-100 ' }, env);
    expect(res.ok).toBe(true);
    expect(mockGetPart).toHaveBeenCalledWith('live');
    expect(callsOn('parts', 'ilike')).toEqual([{ table: 'parts', method: 'ilike', args: ['part_name', 'BRKT-100'] }]);
  });

  it('carries what is on order to vendors, the open PO lines and the Last PO price from each vendor, to a user too', async () => {
    singles.parts = { id: 'part-1', deleted_at: null };
    stubPartDetail();
    mockOnOrder.mockResolvedValue(
      new Map([
        [
          'part-1',
          {
            partId: 'part-1',
            stockUnit: 'ea',
            onOrder: 40,
            onDraft: 10,
            nextExpectedOn: '2026-11-20',
            openLineCount: 1,
            draftLineCount: 1,
            unitMismatchLineCount: 0,
            refs: [
              { vendorPurchaseOrderId: 'po-1', poNumber: 'PO-1042', vendorId: 'v-1', lineId: 'l-1', lineNumber: 1, stockQuantity: 40, expectedOn: '2026-11-20', isDraft: false, status: 'open' },
              { vendorPurchaseOrderId: 'po-2', poNumber: 'PO-1043', vendorId: 'v-1', lineId: 'l-2', lineNumber: 3, stockQuantity: 10, expectedOn: null, isDraft: true, status: 'draft' },
            ],
          },
        ],
      ]),
    );
    lists.part_vendor_last_purchase = {
      data: [
        { vendor_id: 'v-2', vendor_purchase_order_id: 'po-0', po_number: 'PO-1001', ordered_on: '2026-09-01', quantity: 100, unit: 'ea', unit_price: 2.75, unit_price_per_stock_unit: 2.75 },
        { vendor_id: 'v-1', vendor_purchase_order_id: 'po-1', po_number: 'PO-1042', ordered_on: '2026-11-02', quantity: 50, unit: 'ea', unit_price: 2.5, unit_price_per_stock_unit: 2.5 },
      ],
      error: null,
    };
    lists.vendors = { data: [{ id: 'v-1', name: 'Anodize Co' }, { id: 'v-2', name: 'Bay Steel' }], error: null };

    const res = await getPart.run({ part_id: '7c1e7c7e-0000-4000-8000-000000000001' }, env);
    if (!res.ok) throw new Error('expected the part');
    expect(mockOnOrder).toHaveBeenCalledWith('co-1', ['part-1']);
    expect(res.data.on_order).toEqual({
      quantity: 40,
      on_draft_quantity: 10,
      next_expected_on: '2026-11-20',
      open_line_count: 1,
      draft_line_count: 1,
      unit_mismatch_line_count: 0,
    });
    expect(res.data.open_vendor_po_lines).toEqual([
      { vendor_po_id: 'po-1', po_number: 'PO-1042', line_number: 1, quantity: 40, expected_on: '2026-11-20', draft: false, status: 'open', url: 'https://jigged.app/dashboard/co-1/purchasing/orders/po-1' },
      { vendor_po_id: 'po-2', po_number: 'PO-1043', line_number: 3, quantity: 10, expected_on: null, draft: true, status: 'draft', url: 'https://jigged.app/dashboard/co-1/purchasing/orders/po-2' },
    ]);
    // Newest first, one per vendor: the view's own definition of "Last PO price".
    expect(res.data.last_po_prices).toEqual([
      {
        vendor: { vendor_id: 'v-1', name: 'Anodize Co', url: 'https://jigged.app/dashboard/co-1/vendors/v-1' },
        vendor_po_id: 'po-1',
        po_number: 'PO-1042',
        ordered_on: '2026-11-02',
        quantity: 50,
        unit: 'ea',
        unit_price: 2.5,
        unit_price_per_stock_unit: 2.5,
        url: 'https://jigged.app/dashboard/co-1/purchasing/orders/po-1',
      },
      {
        vendor: { vendor_id: 'v-2', name: 'Bay Steel', url: 'https://jigged.app/dashboard/co-1/vendors/v-2' },
        vendor_po_id: 'po-0',
        po_number: 'PO-1001',
        ordered_on: '2026-09-01',
        quantity: 100,
        unit: 'ea',
        unit_price: 2.75,
        unit_price_per_stock_unit: 2.75,
        url: 'https://jigged.app/dashboard/co-1/purchasing/orders/po-0',
      },
    ]);
    expect(callsOn('part_vendor_last_purchase', 'eq')).toEqual(
      expect.arrayContaining([
        { table: 'part_vendor_last_purchase', method: 'eq', args: ['company_id', 'co-1'] },
        { table: 'part_vendor_last_purchase', method: 'eq', args: ['part_id', 'part-1'] },
      ]),
    );
    expect(() => z.object(getPart.output).parse(res.data)).not.toThrow();
  });

  it('reads nothing on order as zero, never as unknown', async () => {
    singles.parts = { id: 'part-1', deleted_at: null };
    stubPartDetail();
    const res = await getPart.run({ part_id: '7c1e7c7e-0000-4000-8000-000000000001' }, env);
    if (!res.ok) throw new Error('expected the part');
    expect(res.data.on_order).toEqual({
      quantity: 0,
      on_draft_quantity: 0,
      next_expected_on: null,
      open_line_count: 0,
      draft_line_count: 0,
      unit_mismatch_line_count: 0,
    });
    expect(res.data.open_vendor_po_lines).toEqual([]);
    expect(res.data.last_po_prices).toEqual([]);
  });

  it('opens an archived part by id and says it is archived', async () => {
    singles.parts = { id: 'part-1', deleted_at: '2026-01-01T00:00:00Z' };
    stubPartDetail();
    const res = await getPart.run({ part_id: '7c1e7c7e-0000-4000-8000-000000000001' }, env);
    if (!res.ok) throw new Error('expected the part');
    expect(res.data.archived).toBe(true);
  });

  it('says so when the part is not there, or none was named', async () => {
    expect(await getPart.run({ part_name: 'NOPE-1' }, env)).toEqual({
      ok: false,
      message: 'There is no part named NOPE-1 in Acme Machining.',
    });
    expect(await getPart.run({ part_id: '7c1e7c7e-0000-4000-8000-000000000001' }, env)).toEqual({
      ok: false,
      message: 'There is no part with that id in Acme Machining.',
    });
    expect(await getPart.run({}, env)).toEqual({ ok: false, message: 'Give a part_id or a part_name.' });
    expect(mockGetPart).not.toHaveBeenCalled();
  });
});

const explained = {
  unit_cost: 10.8,
  is_priceable: false,
  missing_leaves: [{ part_id: 'mat-2', part_name: 'Insert', depth: 1, qty_required: 50 }],
  missing_markups: [],
  missing_op_rates: [{ part_id: 'sub-1', part_name: 'Sub-assy', depth: 1 }],
};

describe('get_part_cost', () => {
  beforeEach(reset);

  it('breaks a made part\'s cost down at its saved batch size, with outside work split out', async () => {
    mockGetPart.mockResolvedValue(part({ costing_batch_quantity: 25 }));
    mockExplain.mockResolvedValue(explained);
    mockBreakdown.mockResolvedValue({
      labor_items: [
        { operation_name: 'Haas VF-2', outside: false, run_time_minutes: 4, setup_time_minutes: 30, labor_rate: 60, cost: 4, setup_cost: 30 },
        { operation_name: 'Anodize, black', outside: true, run_time_minutes: 0, setup_time_minutes: 0, labor_rate: 0, cost: 2.5, setup_cost: 0 },
      ],
      material_items: [
        { item_name: '6061 bar', quantity: 4, unit: 'in', cost_per_unit: 0.775, cost: 3.1, true_cost: 3.1, qty_in_primary: 4 },
      ],
      total_labor_cost: 6.5,
      total_setup_cost: 30,
      total_material_cost: 3.1,
      total_cost: 9.6,
      total_material_true_cost: 3.1,
      total_true_cost: 9.6,
      materials_complete: true,
      warnings: [{ type: 'missing_labor_rate', message: 'Deburr bench: missing labor rate (no override and work center has no default)' }],
    });
    lists.parts = { data: [{ id: 'part-1', part_name: 'BRKT-100', deleted_at: null }], error: null };
    const ok = await getPartCost.run({ part_name: 'BRKT-100' }, env);
    if (!ok.ok) throw new Error('expected the cost');
    expect(mockExplain).toHaveBeenCalledWith('part-1', 25);
    expect(mockBreakdown).toHaveBeenCalledWith('part-1', 25);
    expect(mockTiers).not.toHaveBeenCalled();
    expect(ok.data).toMatchObject({ quantity: 25, quantity_from: 'saved_batch_size', unit_cost: 10.8, can_be_quoted: false });
    expect(ok.data.breakdown).toMatchObject({
      run_labour_per_unit: 4,
      outside_processing_per_unit: 2.5,
      setup_total: 30,
      setup_per_unit: 1.2,
      materials_per_unit: 3.1,
      price_base_per_unit: 10.8,
    });
    expect(ok.data.breakdown?.operations).toEqual([
      { operation: 'Haas VF-2', kind: 'in_house', setup_minutes: 30, run_minutes_per_unit: 4, labour_rate_per_hour: 60, run_cost_per_unit: 4, setup_cost: 30 },
      { operation: 'Anodize, black', kind: 'outside', setup_minutes: 0, run_minutes_per_unit: 0, labour_rate_per_hour: null, run_cost_per_unit: 2.5, setup_cost: 0 },
    ]);
    expect(ok.data.breakdown?.materials).toEqual([
      { part_name: '6061 bar', quantity: 4, unit: 'in', cost_per_part: 3.1, charged_per_part: 3.1 },
    ]);
    expect(ok.data.gaps.missing_costs).toEqual([
      { part_id: 'mat-2', part_name: 'Insert', quantity_needed: 50, url: 'https://jigged.app/dashboard/co-1/parts/mat-2' },
    ]);
    expect(ok.data.gaps.missing_rates[0].url).toBe('https://jigged.app/dashboard/co-1/parts/sub-1');
    expect(ok.data.warnings).toEqual(['Deburr bench: missing labor rate (no override and work center has no default)']);
    expect(ok.data.url).toBe('https://jigged.app/dashboard/co-1/parts/part-1');
  });

  it('costs at a requested quantity instead of the saved one', async () => {
    singles.parts = { id: 'part-1', deleted_at: null };
    mockGetPart.mockResolvedValue(part({ costing_batch_quantity: 25 }));
    mockExplain.mockResolvedValue({ ...explained, missing_leaves: [], missing_op_rates: [] });
    mockBreakdown.mockResolvedValue(null);
    const res = await getPartCost.run({ part_id: '7c1e7c7e-0000-4000-8000-000000000001', quantity: 100 }, env);
    if (!res.ok) throw new Error('expected the cost');
    expect(mockExplain).toHaveBeenCalledWith('part-1', 100);
    expect(res.data).toMatchObject({ quantity: 100, quantity_from: 'requested', breakdown: null });
  });

  it('gives a bought part its purchase cost at each break, at 1 by default', async () => {
    singles.parts = { id: 'part-1', deleted_at: null };
    mockGetPart.mockResolvedValue(part({ source: 'bought', costing_batch_quantity: 40 }));
    mockExplain.mockResolvedValue({ unit_cost: 1.2, is_priceable: true, missing_leaves: [], missing_markups: [], missing_op_rates: [] });
    mockTiers.mockResolvedValue([
      { id: 't1', part_id: 'part-1', company_id: 'co-1', sequence: 1, quantity: 1, cost_per_unit: 1.2, markup_percent: 20, created_at: '', updated_at: '' },
      { id: 't2', part_id: 'part-1', company_id: 'co-1', sequence: 2, quantity: 100, cost_per_unit: 0.9, markup_percent: 20, created_at: '', updated_at: '' },
    ]);
    const res = await getPartCost.run({ part_id: '7c1e7c7e-0000-4000-8000-000000000001' }, env);
    if (!res.ok) throw new Error('expected the cost');
    expect(mockBreakdown).not.toHaveBeenCalled();
    expect(mockExplain).toHaveBeenCalledWith('part-1', 1);
    expect(res.data).toMatchObject({ source: 'bought', quantity: 1, quantity_from: 'default', unit_cost: 1.2, breakdown: null });
    expect(res.data.purchase_costs).toEqual([
      { quantity: 1, cost_per_unit: 1.2 },
      { quantity: 100, cost_per_unit: 0.9 },
    ]);
  });

  it('says so when the part is not there', async () => {
    expect(await getPartCost.run({ part_name: 'NOPE-1' }, env)).toEqual({
      ok: false,
      message: 'There is no part named NOPE-1 in Acme Machining.',
    });
    expect(mockExplain).not.toHaveBeenCalled();
  });
});
