import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

import type { CompanyToolEnv } from '@/lib/mcp/defineTool';
import {
  INVENTORY_TOOLS,
  getLocationContents,
  getPartStockHistory,
  listLocations,
  registerInventoryTools,
  searchInventory,
} from '@/lib/mcp/tools/inventory';
import type { InventoryLocation, LocationContent } from '@/types/inventoryLocations';
import type { InventoryTransactionWithRelations } from '@/types/partTransaction';
import type { OnHandRow } from '@/utils/inventoryOnHandAccess';

/**
 * The storage tools, run directly (the wrapper's own guards are covered in defineTool.test.ts).
 * What matters here: search and paging, the deep links, money for admins only, and that no
 * person is named against a stock movement — for admins too.
 */

const mockOnHand = vi.fn();
vi.mock('@/utils/inventoryOnHandAccess', () => ({
  ON_HAND_ROW_CEILING: 5000,
  getStorageOnHand: (...a: unknown[]) => mockOnHand(...a),
}));

const mockGetLocations = vi.fn();
const mockOccupancy = vi.fn();
const mockContents = vi.fn();
vi.mock('@/utils/inventoryLocationsAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/inventoryLocationsAccess')>();
  return {
    ...actual,
    getLocations: (...a: unknown[]) => mockGetLocations(...a),
    getLocationOccupancy: (...a: unknown[]) => mockOccupancy(...a),
    getContentsPageForLocations: (...a: unknown[]) => mockContents(...a),
  };
});

const mockTransactions = vi.fn();
vi.mock('@/utils/partsAccess', () => ({
  getPartTransactions: (...a: unknown[]) => mockTransactions(...a),
}));

const mockOnOrder = vi.fn();
vi.mock('@/utils/vendorPoAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/vendorPoAccess')>()),
  getOnOrderForParts: (...a: unknown[]) => mockOnOrder(...a),
}));

/** Rows a list read of each table returns, and what a `.maybeSingle()` returns. */
let tables: Record<string, unknown[]> = {};
let single: Record<string, unknown> | null = null;
const fromCalls: string[] = [];
vi.mock('@/lib/supabase', () => {
  const chainFor = (table: string) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      is: () => chain,
      order: () => chain,
      range: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({ data: single, error: null }),
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
        resolve({ data: tables[table] ?? [], error: null }),
    };
    return chain;
  };
  return {
    getSupabase: () => ({
      from: (table: string) => {
        fromCalls.push(table);
        return chainFor(table);
      },
    }),
    registerScopedClientResolver: () => {},
  };
});

const company = { id: 'co-1', name: 'Acme Machining', isDemo: false, governingCompanyId: 'co-1' };
const userEnv: CompanyToolEnv = {
  caller: { token: 't', clientId: 'c', userId: 'u', email: null, expiresAt: 0 },
  company: { ...company, role: 'user' },
  link: (path) => `https://jigged.app${path}`,
};
const adminEnv: CompanyToolEnv = { ...userEnv, company: { ...company, role: 'admin' } };

function loc(id: string, name: string, parent_id: string | null, sort_order = 0): InventoryLocation {
  return { id, company_id: 'co-1', parent_id, name, kind: null, sort_order, created_at: '', updated_at: '' };
}

// Rack A › Shelf 1 › {Left, Right}, and Cabinet 2 › Left. "Left" names two places.
const LOCATIONS = [
  loc('rack', 'Rack A', null, 0),
  loc('cab', 'Cabinet 2', null, 1),
  loc('shelf1', 'Shelf 1', 'rack'),
  loc('bin-l', 'Left', 'shelf1', 0),
  loc('bin-r', 'Right', 'shelf1', 1),
  loc('cab-l', 'Left', 'cab'),
];

function balance(overrides: Partial<OnHandRow>): OnHandRow {
  return {
    balanceId: 'bal',
    partId: 'part-a',
    partName: 'BRKT-100',
    primaryUnit: 'ea',
    source: 'bought',
    locationId: 'bin-l',
    locationName: 'Left',
    lotId: null,
    lotCode: null,
    heatNumber: null,
    quantity: 0,
    costPerUnit: null,
    costBelowMin: false,
    onHandCost: null,
    gap: null,
    lastMovedAt: '2026-11-01T10:00:00Z',
    ...overrides,
  };
}

// As the view returns them: by part name, then place.
const ON_HAND: OnHandRow[] = [
  balance({ balanceId: 'b1', partId: 'part-b', partName: '6061-T6 BAR', primaryUnit: 'in', locationId: 'bin-r', lotId: 'lot-1', lotCode: 'L1', heatNumber: 'H4471', quantity: 120, costPerUnit: 0.8, onHandCost: 96 }),
  balance({ balanceId: 'b2', partId: 'part-b', partName: '6061-T6 BAR', primaryUnit: 'in', locationId: 'bin-r', lotId: 'lot-2', lotCode: 'L2', heatNumber: 'H5000', quantity: 30, costPerUnit: 0.8, onHandCost: 24 }),
  balance({ balanceId: 'b3', locationId: 'cab-l', quantity: 4, costPerUnit: 2.5, onHandCost: 10 }),
  balance({ balanceId: 'b4', locationId: 'bin-l', quantity: 10, costPerUnit: 2.5, onHandCost: 25 }),
  balance({ balanceId: 'b5', partId: 'part-c', partName: 'WIDGET-9', source: 'made', locationId: 'cab-l', quantity: 3, gap: 'made' }),
];

const PART_DETAILS = [
  { id: 'part-a', description: 'Mounting bracket', lot_tracked: false },
  { id: 'part-b', description: 'Aluminium bar stock', lot_tracked: true },
  { id: 'part-c', description: null, lot_tracked: false },
];

function resetData() {
  vi.clearAllMocks();
  fromCalls.length = 0;
  single = null;
  tables = { parts: PART_DETAILS };
  mockGetLocations.mockResolvedValue(LOCATIONS);
  mockOnHand.mockResolvedValue({ rows: ON_HAND, truncated: false });
  mockOnOrder.mockResolvedValue(new Map());
}

describe('search_inventory', () => {
  beforeEach(resetData);

  it('lists each stocked part with its places and lots, and no money for a user', async () => {
    const res = await searchInventory.run({}, userEnv);
    if (!res.ok) throw new Error('expected a page');
    expect(res.data.parts.map((p) => p.part_name)).toEqual(['6061-T6 BAR', 'BRKT-100', 'WIDGET-9']);
    expect(res.data.total).toBe(3);
    expect(res.data.truncated).toBe(false);

    const bar = res.data.parts[0];
    expect(bar).toMatchObject({
      on_hand: 150,
      unit: 'in',
      description: 'Aluminium bar stock',
      lot_tracked: true,
      url: 'https://jigged.app/dashboard/co-1/parts/part-b',
    });
    expect(bar.locations).toEqual([
      {
        location_id: 'bin-r',
        location: 'Rack A › Shelf 1 › Right',
        quantity: 150,
        lots: [
          { lot_code: 'L1', heat_number: 'H4471', quantity: 120 },
          { lot_code: 'L2', heat_number: 'H5000', quantity: 30 },
        ],
      },
    ]);

    const bracket = res.data.parts[1];
    expect(bracket.on_hand).toBe(14);
    expect(bracket.locations.map((l) => [l.location, l.quantity, l.lots])).toEqual([
      ['Cabinet 2 › Left', 4, []],
      ['Rack A › Shelf 1 › Left', 10, []],
    ]);

    for (const part of res.data.parts) {
      expect(part.cost_per_unit).toBeNull();
      expect(part.inventory_value).toBeNull();
    }
    // The gap disclosure is not money; the Storage page shows it to everyone.
    expect(res.data.parts[2].cost_gap).toBe('made');
  });

  it('says what is on order to vendors for each part on the page, in its stock unit, with drafts apart', async () => {
    mockOnOrder.mockResolvedValue(
      new Map([
        [
          'part-b',
          {
            partId: 'part-b',
            stockUnit: 'in',
            onOrder: 288,
            onDraft: 144,
            nextExpectedOn: '2026-11-18',
            openLineCount: 1,
            draftLineCount: 1,
            unitMismatchLineCount: 0,
            refs: [],
          },
        ],
      ]),
    );
    const res = await searchInventory.run({}, userEnv);
    if (!res.ok) throw new Error('expected a page');
    expect(mockOnOrder).toHaveBeenCalledWith('co-1', ['part-b', 'part-a', 'part-c']);
    expect(res.data.parts.map((p) => [p.part_name, p.on_order, p.on_draft, p.next_expected_on])).toEqual([
      ['6061-T6 BAR', 288, 144, '2026-11-18'],
      ['BRKT-100', 0, 0, null],
      ['WIDGET-9', 0, 0, null],
    ]);
    // Prices on a PO go to every office user; the stock's own value still does not.
    expect(res.data.parts[0].inventory_value).toBeNull();
    expect(() => z.object(searchInventory.output).parse(res.data)).not.toThrow();
  });

  it('gives an admin the cost and the value, and null where no cost is on file', async () => {
    const res = await searchInventory.run({}, adminEnv);
    if (!res.ok) throw new Error('expected a page');
    const [bar, bracket, widget] = res.data.parts;
    expect(bar).toMatchObject({ cost_per_unit: 0.8, inventory_value: 120 });
    expect(bracket).toMatchObject({ cost_per_unit: 2.5, inventory_value: 35 });
    expect(widget).toMatchObject({ cost_per_unit: null, inventory_value: null, cost_gap: 'made' });
  });

  it('searches part number, description, heat and location', async () => {
    const names = async (search: string) => {
      const res = await searchInventory.run({ search }, userEnv);
      if (!res.ok) throw new Error('expected a page');
      return res.data.parts.map((p) => p.part_name);
    };
    expect(await names('brkt')).toEqual(['BRKT-100']);
    expect(await names('aluminium')).toEqual(['6061-T6 BAR']);
    expect(await names('h4471')).toEqual(['6061-T6 BAR']);
    expect(await names('Cabinet 2')).toEqual(['BRKT-100', 'WIDGET-9']);
    expect(await names('nothing like it')).toEqual([]);
  });

  it('pages with a cursor and refuses one it did not issue', async () => {
    const first = await searchInventory.run({ limit: 2 }, userEnv);
    if (!first.ok) throw new Error('expected a page');
    expect(first.data.parts).toHaveLength(2);
    expect(first.data.next_cursor).toBe('2');
    const last = await searchInventory.run({ limit: 2, cursor: '2' }, userEnv);
    if (!last.ok) throw new Error('expected a page');
    expect(last.data.parts.map((p) => p.part_name)).toEqual(['WIDGET-9']);
    expect(last.data.next_cursor).toBeNull();
    expect(await searchInventory.run({ cursor: 'abc' }, userEnv)).toEqual({ ok: false, message: expect.stringMatching(/cursor/) });
  });

  it('says when the shop holds more than one read covers', async () => {
    mockOnHand.mockResolvedValue({ rows: ON_HAND, truncated: true });
    const res = await searchInventory.run({}, userEnv);
    if (!res.ok) throw new Error('expected a page');
    expect(res.data.truncated).toBe(true);
  });
});

describe('list_locations', () => {
  beforeEach(() => {
    resetData();
    mockOccupancy.mockResolvedValue(new Map([['bin-l', 2], ['bin-r', 1], ['cab-l', 2]]));
  });

  it('lists the tree in order with paths, parents and placements rolled up', async () => {
    const res = await listLocations.run({}, userEnv);
    if (!res.ok) throw new Error('expected a page');
    expect(res.data.locations.map((l) => [l.path, l.sub_location_count, l.part_placements])).toEqual([
      ['Rack A', 1, 3],
      ['Rack A › Shelf 1', 2, 3],
      ['Rack A › Shelf 1 › Left', 0, 2],
      ['Rack A › Shelf 1 › Right', 0, 1],
      ['Cabinet 2', 1, 2],
      ['Cabinet 2 › Left', 0, 2],
    ]);
    expect(res.data.locations[2]).toMatchObject({
      location_id: 'bin-l',
      name: 'Left',
      parent_id: 'shelf1',
      url: 'https://jigged.app/dashboard/co-1/inventory/locations?view=places&unit=rack',
    });
  });

  it('filters on the path and pages', async () => {
    const res = await listLocations.run({ search: 'left', limit: 1 }, userEnv);
    if (!res.ok) throw new Error('expected a page');
    expect(res.data.total).toBe(2);
    expect(res.data.locations.map((l) => l.path)).toEqual(['Rack A › Shelf 1 › Left']);
    expect(res.data.next_cursor).toBe('1');
    const rack = await listLocations.run({ search: 'rack a' }, userEnv);
    if (!rack.ok) throw new Error('expected a page');
    expect(rack.data.total).toBe(4);
  });
});

describe('get_location_contents', () => {
  const content = (overrides: Partial<LocationContent>): LocationContent => ({
    part_id: 'part-a',
    part_name: 'BRKT-100',
    primary_unit: 'ea',
    quantity: 0,
    lot_id: null,
    lot_code: null,
    heat_number: null,
    location_id: 'bin-l',
    ...overrides,
  });
  const CONTENTS = [
    content({ location_id: 'bin-l', quantity: 10 }),
    content({ part_id: 'part-b', part_name: '6061-T6 BAR', primary_unit: 'in', location_id: 'bin-r', quantity: 120, lot_id: 'lot-1', lot_code: 'L1', heat_number: 'H4471' }),
    content({ part_id: 'part-b', part_name: '6061-T6 BAR', primary_unit: 'in', location_id: 'bin-r', quantity: 30, lot_id: 'lot-2', lot_code: 'L2', heat_number: 'H5000' }),
    content({ location_id: 'cab-l', quantity: 4 }),
  ];

  beforeEach(() => {
    resetData();
    mockContents.mockImplementation(async (ids: string[], q: { limit: number; offset: number }) => {
      const here = CONTENTS.filter((c) => ids.includes(c.location_id));
      return { contents: here.slice(q.offset, q.offset + q.limit), total: here.length };
    });
    tables.inventory_on_hand_cost = [
      { part_id: 'part-a', location_id: 'bin-l', lot_id: null, on_hand_cost: 25 },
      { part_id: 'part-b', location_id: 'bin-r', lot_id: 'lot-1', on_hand_cost: 96 },
      { part_id: 'part-b', location_id: 'bin-r', lot_id: 'lot-2', on_hand_cost: 24 },
    ];
  });

  it('finds a location by name and lists its parts with lots, no value for a user', async () => {
    const res = await getLocationContents.run({ location: 'right' }, userEnv);
    if (!res.ok) throw new Error('expected the contents');
    expect(mockContents).toHaveBeenCalledWith(['bin-r'], { limit: 1000, offset: 0 });
    expect(res.data).toMatchObject({
      location_id: 'bin-r',
      name: 'Right',
      path: 'Rack A › Shelf 1 › Right',
      total: 1,
      next_cursor: null,
      truncated: false,
      url: 'https://jigged.app/dashboard/co-1/inventory/locations?view=places&unit=rack',
    });
    expect(res.data.contents).toEqual([
      {
        part_id: 'part-b',
        part_name: '6061-T6 BAR',
        location_id: 'bin-r',
        location: 'Rack A › Shelf 1 › Right',
        quantity: 150,
        unit: 'in',
        lots: [
          { lot_code: 'L1', heat_number: 'H4471', quantity: 120 },
          { lot_code: 'L2', heat_number: 'H5000', quantity: 30 },
        ],
        inventory_value: null,
        url: 'https://jigged.app/dashboard/co-1/parts/part-b',
      },
    ]);
    // The cost view is not read at all for a user.
    expect(fromCalls).not.toContain('inventory_on_hand_cost');
  });

  it('finds one by path, and gives an admin the value', async () => {
    const res = await getLocationContents.run({ location: 'rack a / shelf 1 / right' }, adminEnv);
    if (!res.ok) throw new Error('expected the contents');
    expect(res.data.contents[0].inventory_value).toBe(120);
  });

  it('lists everything inside a container, each row naming its own location', async () => {
    const res = await getLocationContents.run({ location: 'Rack A' }, adminEnv);
    if (!res.ok) throw new Error('expected the contents');
    const [bins] = mockContents.mock.calls[0];
    expect([...bins].sort()).toEqual(['bin-l', 'bin-r']);
    expect(res.data.contents.map((c) => [c.location, c.part_name, c.quantity, c.inventory_value])).toEqual([
      ['Rack A › Shelf 1 › Left', 'BRKT-100', 10, 25],
      ['Rack A › Shelf 1 › Right', '6061-T6 BAR', 150, 120],
    ]);
  });

  it('asks which one when a name matches several, and says when none does', async () => {
    expect(await getLocationContents.run({ location: 'Left' }, userEnv)).toEqual({
      ok: false,
      message:
        '2 locations in Acme Machining match "Left": Cabinet 2 › Left; Rack A › Shelf 1 › Left. ' +
        'Give the full path or a location_id.',
    });
    expect(await getLocationContents.run({ location: 'Bin 99' }, userEnv)).toEqual({
      ok: false,
      message: 'There is no location called "Bin 99" in Acme Machining.',
    });
    expect(await getLocationContents.run({ location_id: '00000000-0000-4000-8000-000000000000' }, userEnv)).toEqual({
      ok: false,
      message: 'There is no location with that id in Acme Machining.',
    });
    expect(await getLocationContents.run({}, userEnv)).toEqual({
      ok: false,
      message: 'Give a location_id or a location name or path.',
    });
    expect(mockContents).not.toHaveBeenCalled();
  });

  it('pages the rows', async () => {
    const res = await getLocationContents.run({ location: 'Rack A', limit: 1 }, userEnv);
    if (!res.ok) throw new Error('expected the contents');
    expect(res.data.total).toBe(2);
    expect(res.data.next_cursor).toBe('1');
    expect(await getLocationContents.run({ location: 'Rack A', cursor: '-1' }, userEnv)).toEqual({
      ok: false,
      message: expect.stringMatching(/cursor/),
    });
  });
});

describe('get_part_stock_history', () => {
  function movement(overrides: Partial<InventoryTransactionWithRelations>): InventoryTransactionWithRelations {
    return {
      id: 'tx-1',
      company_id: 'co-1',
      part_id: 'part-b',
      item_name: '6061-T6 BAR',
      type: 'depletion',
      quantity: 12,
      unit: 'in',
      converted_quantity: 12,
      job_id: null,
      job_operation_id: null,
      operator_id: 'user-operator',
      notes: null,
      heat_number: null,
      has_discrepancy: false,
      location_id: 'bin-r',
      location_name: 'Right',
      transfer_group_id: null,
      photo_path: 'co-1/inventory-transactions/bin-r/abc_tag.jpg',
      created_at: '2026-11-05T09:00:00Z',
      created_by: 'auth-user-1',
      job: null,
      job_operation: null,
      operator: { id: 'user-operator', name: 'Dana Operator' },
      photo_url: 'https://storage.example/signed/abc_tag.jpg',
      ...overrides,
    };
  }

  const LEDGER = [
    movement({
      id: 'tx-2',
      job_id: 'job-1',
      job_operation_id: 'op-1',
      job: { id: 'job-1', job_number: 'J-1001' },
      job_operation: { id: 'op-1', operation_name: 'Saw', sequence: 10 },
      heat_number: 'H4471',
      notes: 'Cut for the first article',
    }),
    movement({
      id: 'tx-1',
      type: 'addition',
      quantity: 2,
      unit: 'ft',
      converted_quantity: 24,
      location_id: null,
      location_name: 'Old shelf',
      transfer_group_id: 'move-1',
      created_at: '2026-11-04T09:00:00Z',
    }),
  ];

  beforeEach(() => {
    resetData();
    single = { id: 'part-b', part_name: '6061-T6 BAR', primary_unit: 'in', deleted_at: null };
    mockTransactions.mockResolvedValue({ transactions: LEDGER, total: 30 });
  });

  it('returns the movements newest first with job, location and heat', async () => {
    const res = await getPartStockHistory.run({ part_name: '6061-T6 BAR', limit: 2 }, userEnv);
    if (!res.ok) throw new Error('expected the history');
    expect(mockTransactions).toHaveBeenCalledWith('part-b', 0, 2, { photos: false });
    expect(res.data).toMatchObject({
      part_id: 'part-b',
      part_name: '6061-T6 BAR',
      stock_unit: 'in',
      archived: false,
      total: 30,
      next_cursor: '2',
      url: 'https://jigged.app/dashboard/co-1/parts/part-b?tab=history',
    });
    expect(res.data.movements[0]).toMatchObject({
      movement_id: 'tx-2',
      type: 'depletion',
      quantity: 12,
      location: 'Rack A › Shelf 1 › Right',
      job: { job_id: 'job-1', job_number: 'J-1001', url: 'https://jigged.app/dashboard/co-1/jobs/job-1' },
      operation: { sequence: 10, name: 'Saw' },
      heat_number: 'H4471',
      notes: 'Cut for the first article',
    });
    // A deleted location keeps the name it had.
    expect(res.data.movements[1]).toMatchObject({
      type: 'addition',
      quantity: 2,
      unit: 'ft',
      stock_quantity: 24,
      location_id: null,
      location: 'Old shelf',
      transfer_group_id: 'move-1',
      job: null,
      operation: null,
    });
  });

  it.each([
    ['a user', userEnv],
    ['an admin', adminEnv],
  ])('names nobody to %s', async (_who, env) => {
    const res = await getPartStockHistory.run({ part_id: '11111111-1111-4111-8111-111111111111' }, env);
    if (!res.ok) throw new Error('expected the history');
    const text = JSON.stringify(res.data);
    expect(text).not.toContain('Dana Operator');
    expect(text).not.toContain('user-operator');
    expect(text).not.toContain('auth-user-1');
    expect(text).not.toContain('abc_tag');
    expect(text).not.toMatch(/"operator|created_by|performed_by|photo/);
  });

  it('continues from a cursor and stops on the last page', async () => {
    const res = await getPartStockHistory.run({ part_name: '6061-T6 BAR', limit: 2, cursor: '28' }, userEnv);
    if (!res.ok) throw new Error('expected the history');
    expect(mockTransactions).toHaveBeenCalledWith('part-b', 28, 2, { photos: false });
    expect(res.data.next_cursor).toBeNull();
    expect(await getPartStockHistory.run({ part_name: '6061-T6 BAR', cursor: 'next' }, userEnv)).toEqual({
      ok: false,
      message: expect.stringMatching(/cursor/),
    });
  });

  it('says so when the part is not there, or none was named', async () => {
    single = null;
    expect(await getPartStockHistory.run({ part_name: 'NOPE-1' }, userEnv)).toEqual({
      ok: false,
      message: 'There is no part NOPE-1 in Acme Machining.',
    });
    expect(await getPartStockHistory.run({ part_id: '11111111-1111-4111-8111-111111111111' }, userEnv)).toEqual({
      ok: false,
      message: 'There is no part with that id in Acme Machining.',
    });
    expect(await getPartStockHistory.run({}, userEnv)).toEqual({ ok: false, message: 'Give a part_id or a part_name.' });
    expect(mockTransactions).not.toHaveBeenCalled();
  });
});

describe('the inventory catalogue', () => {
  it('is four read-only tools', () => {
    expect(INVENTORY_TOOLS.map((t) => [t.name, t.access])).toEqual([
      ['search_inventory', 'read'],
      ['list_locations', 'read'],
      ['get_location_contents', 'read'],
      ['get_part_stock_history', 'read'],
    ]);
  });

  it('registers read-only, with no output field naming a person', () => {
    const registered: Array<{ name: string; annotations: Record<string, unknown>; output: z.ZodType }> = [];
    const server = {
      registerTool: (name: string, config: { annotations: Record<string, unknown>; outputSchema: z.ZodType }) => {
        registered.push({ name, annotations: config.annotations, output: config.outputSchema });
      },
    };
    registerInventoryTools(server as unknown as Parameters<typeof registerInventoryTools>[0]);
    expect(registered.map((r) => r.name)).toEqual(INVENTORY_TOOLS.map((t) => t.name));
    for (const tool of registered) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      const schema = JSON.stringify(z.toJSONSchema(tool.output, { io: 'output' }));
      expect(schema).not.toMatch(/"(operator\w*|created_by|performed_by|moved_by|counted_by|author\w*|user_id|user_name)"/);
    }
  });
});
