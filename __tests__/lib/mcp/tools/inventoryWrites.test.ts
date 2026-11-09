import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

import type { CompanyToolEnv } from '@/lib/mcp/defineTool';
import {
  INVENTORY_WRITE_TOOLS,
  addStock,
  adjustStock,
  createStorageLocation,
  registerInventoryWriteTools,
  removeStock,
  transferStockTool,
} from '@/lib/mcp/tools/inventoryWrites';
import type { CountCandidate } from '@/types/inventoryCount';
import type { InventoryLocation } from '@/types/inventoryLocations';
import type { PlaceBalance } from '@/utils/inventoryCountAccess';

/**
 * The storage write tools, run directly (the wrapper's guards are covered in defineTool.test.ts).
 * What matters here: each calls the access function the Storage page calls, with the arguments
 * the page passes; it refuses before writing where the page would; and what comes back is the
 * stock read back from the database, with links, money for admins only and no person.
 */

const mockGetLocations = vi.fn();
const mockAdd = vi.fn();
const mockDeplete = vi.fn();
const mockAdjust = vi.fn();
const mockTransfer = vi.fn();
const mockCreate = vi.fn();
const mockMaterialize = vi.fn();
vi.mock('@/utils/inventoryLocationsAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/inventoryLocationsAccess')>();
  return {
    ...actual,
    getLocations: (...a: unknown[]) => mockGetLocations(...a),
    addStockAtLocation: (...a: unknown[]) => mockAdd(...a),
    depleteStockAtLocation: (...a: unknown[]) => mockDeplete(...a),
    adjustStockAtLocation: (...a: unknown[]) => mockAdjust(...a),
    transferStock: (...a: unknown[]) => mockTransfer(...a),
    createLocation: (...a: unknown[]) => mockCreate(...a),
    materializeLocationSpec: (...a: unknown[]) => mockMaterialize(...a),
  };
});

/** What each bin holds of each part, keyed by `${locationId}|${partId}`. A write mutates it. */
let shelves: Record<string, PlaceBalance[]> = {};
const mockCandidates = vi.fn();
vi.mock('@/utils/inventoryCountAccess', () => ({
  readPlaceBalances: async (locationId: string, partIds: string[]) =>
    new Map(
      partIds.flatMap((partId) =>
        (shelves[`${locationId}|${partId}`] ?? []).map((b) => [`${partId}::${b.lotId ?? 'none'}`, b] as const),
      ),
    ),
  loadPartAtLocationCandidates: (...a: unknown[]) => mockCandidates(...a),
}));

vi.mock('@/utils/inventoryOnHandAccess', () => ({ ON_HAND_ROW_CEILING: 5000, getStorageOnHand: vi.fn() }));
vi.mock('@/utils/partsAccess', () => ({ getPartTransactions: vi.fn() }));

/** Rows a list read of each table returns, and what each table's `.maybeSingle()` returns. */
let tables: Record<string, unknown[]> = {};
let singles: Record<string, unknown> = {};
const eqCalls: Array<[string, string, unknown]> = [];
vi.mock('@/lib/supabase', () => {
  const chainFor = (table: string) => {
    const chain = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        eqCalls.push([table, column, value]);
        return chain;
      },
      in: () => chain,
      is: () => chain,
      order: () => chain,
      range: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({ data: singles[table] ?? null, error: null }),
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
        resolve({ data: tables[table] ?? [], error: null }),
    };
    return chain;
  };
  return {
    getSupabase: () => ({ from: (table: string) => chainFor(table) }),
    registerScopedClientResolver: () => {},
  };
});

const company = { id: 'co-1', name: 'Acme Machining', isDemo: false, governingCompanyId: 'co-1' };
const userEnv: CompanyToolEnv = {
  caller: { token: 't', clientId: 'c', userId: 'u-1', email: null, expiresAt: 0 },
  origin: 'https://jigged.app',
  company: { ...company, role: 'user' },
  link: (path) => `https://jigged.app${path}`,
};
const adminEnv: CompanyToolEnv = { ...userEnv, company: { ...company, role: 'admin' } };

function loc(id: string, name: string, parent_id: string | null, sort_order = 0): InventoryLocation {
  return { id, company_id: 'co-1', parent_id, name, kind: null, sort_order, created_at: '', updated_at: '' };
}

// Rack A › Shelf 1 › {Left, Right}, and Cabinet 2 › Left.
const LOCATIONS = [
  loc('rack', 'Rack A', null, 0),
  loc('cab', 'Cabinet 2', null, 1),
  loc('shelf1', 'Shelf 1', 'rack'),
  loc('bin-l', 'Left', 'shelf1', 0),
  loc('bin-r', 'Right', 'shelf1', 1),
  loc('cab-l', 'Left', 'cab'),
];

const BRACKET = { id: 'part-a', part_name: 'BRKT-100', primary_unit: 'ea', deleted_at: null, quantity: 14 };
const BAR = { id: 'part-b', part_name: '6061-T6 BAR', primary_unit: 'in', deleted_at: null, quantity: 150 };

const untagged = (quantity: number): PlaceBalance => ({ quantity, lotId: null, lotCode: null, heatNumber: null });
const lot = (lotId: string, lotCode: string, heatNumber: string | null, quantity: number): PlaceBalance => ({
  quantity,
  lotId,
  lotCode,
  heatNumber,
});

const STORAGE_URL = 'https://jigged.app/dashboard/co-1/inventory/locations?view=places';

function reset() {
  vi.clearAllMocks();
  eqCalls.length = 0;
  tables = {};
  singles = { parts: BRACKET, user_company_access: { id: 'member-1' } };
  shelves = { 'bin-l|part-a': [untagged(10)], 'cab-l|part-a': [untagged(4)] };
  mockGetLocations.mockResolvedValue(LOCATIONS);
}

type Result<T> = { ok: true; data: T } | { ok: false; message: string };

function refusal<T>(res: Result<T>): string {
  if (res.ok) throw new Error('expected a refusal');
  return res.message;
}

function success<T>(res: Result<T>): T {
  if (!res.ok) throw new Error(`expected success, got: ${res.message}`);
  return res.data;
}

function noWrites() {
  for (const write of [mockAdd, mockDeplete, mockAdjust, mockTransfer, mockCreate, mockMaterialize]) {
    expect(write).not.toHaveBeenCalled();
  }
}

// ---------------------------------------------------------------------------------------------

describe('add_stock', () => {
  beforeEach(reset);

  it("adds through the Storage page's function with its arguments, and reads the bin back", async () => {
    mockAdd.mockImplementation(async () => {
      shelves['bin-l|part-a'] = [untagged(22)];
      return { location_balance: 22, part_quantity: 26, lot_id: null, started_tracking: false };
    });

    const out = success(
      await addStock.run(
        { part_name: 'BRKT-100', location: 'Rack A › Shelf 1 › Left', quantity: 12, notes: 'Delivery' },
        userEnv,
      ),
    );

    expect(mockAdd).toHaveBeenCalledWith('part-a', 'bin-l', 12, 'ea', {
      notes: 'Delivery',
      operatorId: 'member-1',
      heatNumber: undefined,
    });
    // The ledger's author is the caller's own membership in this company.
    expect(eqCalls).toContainEqual(['user_company_access', 'user_id', 'u-1']);
    expect(eqCalls).toContainEqual(['user_company_access', 'company_id', 'co-1']);
    expect(out).toEqual({
      part_id: 'part-a',
      part_name: 'BRKT-100',
      stock_unit: 'ea',
      part_on_hand: 26,
      url: 'https://jigged.app/dashboard/co-1/parts/part-a',
      quantity: 12,
      unit: 'ea',
      lot: null,
      started_lot_tracking: false,
      location: {
        location_id: 'bin-l',
        location: 'Rack A › Shelf 1 › Left',
        on_hand: 22,
        lots: [],
        inventory_value: null,
        url: `${STORAGE_URL}&unit=rack`,
      },
    });
  });

  it('takes a unit of the same kind, files a heat under its lot, and values the bin for an admin', async () => {
    singles.parts = BAR;
    tables.inventory_on_hand_cost = [
      { part_id: 'part-b', location_id: 'bin-r', lot_id: 'lot-1', on_hand_cost: 19.2 },
      { part_id: 'part-b', location_id: 'bin-r', lot_id: 'lot-2', on_hand_cost: 24 },
    ];
    mockAdd.mockImplementation(async () => {
      shelves['bin-r|part-b'] = [lot('lot-2', 'L2', 'H5000', 30), lot('lot-1', 'H4471', 'H4471', 24)];
      return { location_balance: 24, part_quantity: 54, lot_id: 'lot-1', started_tracking: true };
    });

    const out = success(
      await addStock.run(
        { part_id: 'part-b', location_id: 'bin-r', quantity: 2, unit: 'ft', heat_number: 'H4471' },
        adminEnv,
      ),
    );

    // `ft` is offered as `feet` beside a part kept in inches; the access layer converts it.
    expect(mockAdd).toHaveBeenCalledWith('part-b', 'bin-r', 2, 'feet', {
      notes: undefined,
      operatorId: 'member-1',
      heatNumber: 'H4471',
    });
    expect(out.lot).toEqual({ lot_code: 'H4471', heat_number: 'H4471' });
    expect(out.started_lot_tracking).toBe(true);
    expect(out.location.on_hand).toBe(54);
    expect(out.location.lots).toEqual([
      { lot_code: 'L2', heat_number: 'H5000', quantity: 30 },
      { lot_code: 'H4471', heat_number: 'H4471', quantity: 24 },
    ]);
    expect(out.location.inventory_value).toBe(43.2);
  });

  it('refuses a unit the Storage page does not offer for the part', async () => {
    const message = refusal(await addStock.run({ part_name: 'BRKT-100', location_id: 'bin-l', quantity: 3, unit: 'lbs' }, userEnv));
    expect(message).toContain('BRKT-100 is kept in ea');
    expect(message).toContain('ea, pieces, dozen');
    noWrites();
  });

  it('refuses a location that has locations inside it', async () => {
    const message = refusal(await addStock.run({ part_name: 'BRKT-100', location: 'Shelf 1', quantity: 3 }, userEnv));
    expect(message).toBe(
      'Rack A › Shelf 1 has locations inside it, and stock goes in one of those rather than in it ' +
        '(for example Rack A › Shelf 1 › Left).',
    );
    noWrites();
  });

  it('says when the part or the location is not there', async () => {
    singles.parts = null;
    expect(refusal(await addStock.run({ part_name: 'NOPE', location_id: 'bin-l', quantity: 1 }, userEnv))).toBe(
      'There is no part NOPE in Acme Machining.',
    );
    singles.parts = BRACKET;
    expect(refusal(await addStock.run({ part_name: 'BRKT-100', location: 'Mezzanine', quantity: 1 }, userEnv))).toBe(
      'There is no location called "Mezzanine" in Acme Machining.',
    );
    // "Left" names two places, so the path is needed.
    expect(refusal(await addStock.run({ part_name: 'BRKT-100', location: 'Left', quantity: 1 }, userEnv))).toContain(
      '2 locations in Acme Machining match "Left"',
    );
    noWrites();
  });

  it('refuses an archived part', async () => {
    singles.parts = { ...BRACKET, deleted_at: '2026-10-01T00:00:00Z' };
    expect(refusal(await addStock.run({ part_id: 'part-a', location_id: 'bin-l', quantity: 1 }, userEnv))).toBe(
      "BRKT-100 is archived in Acme Machining, so its stock can't be changed.",
    );
    noWrites();
  });
});

// ---------------------------------------------------------------------------------------------

describe('remove_stock', () => {
  beforeEach(() => {
    reset();
    singles.parts = BAR;
    shelves['bin-r|part-b'] = [lot('lot-1', 'L1', 'H4471', 120), lot('lot-2', 'L2', 'H5000', 30)];
    singles.jobs = { id: 'job-1', job_number: 'J-100', production_status: 'in_progress', deleted_at: null };
  });

  it('takes the named lot out, issued to the job, never gracefully', async () => {
    mockDeplete.mockImplementation(async () => {
      shelves['bin-r|part-b'] = [lot('lot-1', 'L1', 'H4471', 100), lot('lot-2', 'L2', 'H5000', 30)];
      return { location_balance: 100, part_quantity: 130, has_discrepancy: false, shortfall: 0, lot_id: 'lot-1' };
    });

    const out = success(
      await removeStock.run(
        { part_name: '6061-T6 BAR', location_id: 'bin-r', quantity: 20, lot: 'h4471', job_number: 'J-100' },
        userEnv,
      ),
    );

    expect(mockDeplete).toHaveBeenCalledWith('part-b', 'bin-r', 20, 'in', {
      graceful: false,
      notes: undefined,
      operatorId: 'member-1',
      jobId: 'job-1',
      lotId: 'lot-1',
    });
    expect(out.lot).toEqual({ lot_code: 'L1', heat_number: 'H4471' });
    expect(out.job).toEqual({ job_id: 'job-1', job_number: 'J-100', url: 'https://jigged.app/dashboard/co-1/jobs/job-1' });
    expect(out.part_on_hand).toBe(130);
    expect(out.location).toMatchObject({ location_id: 'bin-r', on_hand: 130, inventory_value: null, url: `${STORAGE_URL}&unit=rack` });
  });

  it('asks which lot when the part is held there in several', async () => {
    const message = refusal(await removeStock.run({ part_name: '6061-T6 BAR', location_id: 'bin-r', quantity: 5 }, userEnv));
    expect(message).toBe(
      '6061-T6 BAR is held at Rack A › Shelf 1 › Right in 2 lots: heat H4471: 120 in; heat H5000: 30 in. ' +
        'Give `lot` (the heat number or lot code) to say which.',
    );
    expect(
      refusal(await removeStock.run({ part_name: '6061-T6 BAR', location_id: 'bin-r', quantity: 5, lot: 'H9999' }, userEnv)),
    ).toContain('has no lot "H9999"');
    noWrites();
  });

  it('refuses more than the location holds, after converting the unit', async () => {
    // 3 ft is 36 in, and heat H5000 has 30 in here.
    const message = refusal(
      await removeStock.run({ part_name: '6061-T6 BAR', location_id: 'bin-r', quantity: 3, unit: 'feet', lot: 'H5000' }, userEnv),
    );
    expect(message).toBe(
      "Only 30 in of 6061-T6 BAR (heat H5000) is at Rack A › Shelf 1 › Right, so 3 feet can't be removed. Nothing was changed.",
    );
    noWrites();
  });

  it('says when there is none of the part at the location', async () => {
    expect(refusal(await removeStock.run({ part_name: '6061-T6 BAR', location_id: 'cab-l', quantity: 1 }, userEnv))).toBe(
      'There is no 6061-T6 BAR at Cabinet 2 › Left.',
    );
    noWrites();
  });

  it('refuses a job the Storage page would not offer', async () => {
    singles.jobs = { id: 'job-1', job_number: 'J-100', production_status: 'completed', deleted_at: null };
    expect(
      refusal(await removeStock.run({ part_name: '6061-T6 BAR', location_id: 'bin-r', quantity: 1, lot: 'L1', job_number: 'J-100' }, userEnv)),
    ).toBe('Job J-100 is completed. Stock can be issued only to a job that is not started or in progress.');
    singles.jobs = null;
    expect(
      refusal(await removeStock.run({ part_name: '6061-T6 BAR', location_id: 'bin-r', quantity: 1, lot: 'L1', job_number: 'J-404' }, userEnv)),
    ).toBe('There is no job J-404 in Acme Machining.');
    noWrites();
  });
});

// ---------------------------------------------------------------------------------------------

function candidate(overrides: Partial<CountCandidate>): CountCandidate {
  return {
    partId: 'part-a',
    partName: 'BRKT-100',
    description: null,
    unit: 'ea',
    systemQuantity: 10,
    lotId: null,
    lotCode: null,
    heatNumber: null,
    target: { locationId: 'bin-l', locationName: 'Left', locationPath: 'Left' },
    ...overrides,
  };
}

describe('adjust_stock', () => {
  beforeEach(reset);

  it("sets the count the way the Storage page's Adjust commits it", async () => {
    mockCandidates.mockResolvedValue([candidate({})]);
    mockAdjust.mockImplementation(async () => {
      shelves['bin-l|part-a'] = [untagged(7)];
      return { location_balance: 7, part_quantity: 11 };
    });

    const out = success(await adjustStock.run({ part_name: 'BRKT-100', location: 'Rack A › Shelf 1 › Left', quantity: 7 }, userEnv));

    expect(mockCandidates).toHaveBeenCalledWith('co-1', 'part-a', 'bin-l', 'Left');
    expect(mockAdjust).toHaveBeenCalledWith('part-a', 'bin-l', 7, 'ea', {
      notes: 'Inventory count at Left — counted 7 ea (recorded as 10 ea)',
      operatorId: 'member-1',
      lotId: undefined,
    });
    expect(out).toMatchObject({
      previous_quantity: 10,
      new_quantity: 7,
      change: -3,
      part_on_hand: 11,
      lot: null,
      url: 'https://jigged.app/dashboard/co-1/parts/part-a',
    });
    expect(out.location).toMatchObject({ on_hand: 7, url: `${STORAGE_URL}&unit=rack` });
  });

  it('refuses a count that matches what is recorded', async () => {
    mockCandidates.mockResolvedValue([candidate({})]);
    expect(refusal(await adjustStock.run({ part_name: 'BRKT-100', location_id: 'bin-l', quantity: 10 }, userEnv))).toBe(
      'BRKT-100 at Rack A › Shelf 1 › Left is already 10 ea. Nothing was changed.',
    );
    noWrites();
  });

  it('counts a named lot of a tracked part the location has no record of', async () => {
    singles.parts = BAR;
    const lots = [
      candidate({ partId: 'part-b', partName: '6061-T6 BAR', unit: 'in', systemQuantity: 0, lotId: 'lot-1', lotCode: 'L1', heatNumber: 'H4471' }),
      candidate({ partId: 'part-b', partName: '6061-T6 BAR', unit: 'in', systemQuantity: 0, lotId: 'lot-2', lotCode: 'L2', heatNumber: 'H5000' }),
    ];
    mockCandidates.mockResolvedValue(lots);
    expect(refusal(await adjustStock.run({ part_name: '6061-T6 BAR', location_id: 'cab-l', quantity: 12 }, userEnv))).toContain(
      'in 2 lots',
    );
    mockAdjust.mockResolvedValue({ location_balance: 12, part_quantity: 162, lot_id: 'lot-2' });

    const out = success(await adjustStock.run({ part_name: '6061-T6 BAR', location_id: 'cab-l', quantity: 12, lot: 'L2' }, userEnv));
    expect(mockAdjust).toHaveBeenCalledWith('part-b', 'cab-l', 12, 'in', {
      notes: 'Inventory count at Left (heat h5000) — counted 12 in (recorded as 0 in)',
      operatorId: 'member-1',
      lotId: 'lot-2',
    });
    expect(out.lot).toEqual({ lot_code: 'L2', heat_number: 'H5000' });
  });
});

// ---------------------------------------------------------------------------------------------

describe('transfer_stock', () => {
  beforeEach(reset);

  it('moves through transferStock and returns both places afterwards', async () => {
    mockTransfer.mockImplementation(async () => {
      shelves['bin-l|part-a'] = [untagged(6)];
      shelves['cab-l|part-a'] = [untagged(8)];
      return { transfer_group_id: 'tg-1', from_balance: 6, to_balance: 8 };
    });

    const out = success(
      await transferStockTool.run(
        { part_name: 'BRKT-100', from_location: 'Rack A › Shelf 1 › Left', to_location: 'Cabinet 2 › Left', quantity: 4, notes: 'Kitting' },
        userEnv,
      ),
    );

    expect(mockTransfer).toHaveBeenCalledWith('part-a', 'bin-l', 'cab-l', 4, 'ea', {
      notes: 'Kitting',
      operatorId: 'member-1',
      lotId: undefined,
    });
    expect(out.part_on_hand).toBe(14);
    expect(out.from).toMatchObject({ location_id: 'bin-l', on_hand: 6, url: `${STORAGE_URL}&unit=rack` });
    expect(out.to).toMatchObject({ location_id: 'cab-l', location: 'Cabinet 2 › Left', on_hand: 8, url: `${STORAGE_URL}&unit=cab` });
  });

  it('refuses a move to where it already is, to a container, or of more than is there', async () => {
    expect(
      refusal(await transferStockTool.run({ part_name: 'BRKT-100', from_location_id: 'bin-l', to_location_id: 'bin-l', quantity: 1 }, userEnv)),
    ).toBe('Rack A › Shelf 1 › Left is both the source and the destination. Nothing was moved.');
    expect(
      refusal(await transferStockTool.run({ part_name: 'BRKT-100', from_location_id: 'bin-l', to_location: 'Rack A', quantity: 1 }, userEnv)),
    ).toContain('Rack A has locations inside it');
    expect(
      refusal(await transferStockTool.run({ part_name: 'BRKT-100', from_location_id: 'bin-l', to_location_id: 'cab-l', quantity: 11 }, userEnv)),
    ).toBe("Only 10 ea of BRKT-100 is at Rack A › Shelf 1 › Left, so 11 ea can't be moved. Nothing was changed.");
    expect(refusal(await transferStockTool.run({ part_name: 'BRKT-100', to_location_id: 'cab-l', quantity: 1 }, userEnv))).toBe(
      'Give a from_location_id or a from_location name or path.',
    );
    noWrites();
  });
});

// ---------------------------------------------------------------------------------------------

describe('create_location', () => {
  beforeEach(reset);

  it("creates a top-level unit the way Add storage does, with no levels", async () => {
    mockMaterialize.mockResolvedValue([loc('new-unit', 'Cabinet 3', null)]);
    const out = success(await createStorageLocation.run({ name: 'Cabinet 3' }, userEnv));
    expect(mockMaterialize).toHaveBeenCalledWith('co-1', null, [{ key: 'unit', name: 'Cabinet 3', kind: null, children: [] }], 0);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(out).toEqual({
      location_id: 'new-unit',
      name: 'Cabinet 3',
      path: 'Cabinet 3',
      parent_id: null,
      url: `${STORAGE_URL}&unit=new-unit`,
    });
  });

  it('creates one inside a parent the way Add one inside does', async () => {
    mockCreate.mockResolvedValue(loc('new-bin', 'Bin 3', 'shelf1'));
    const out = success(await createStorageLocation.run({ name: 'Bin 3', parent: 'Rack A › Shelf 1' }, userEnv));
    expect(mockCreate).toHaveBeenCalledWith('co-1', { name: 'Bin 3', parent_id: 'shelf1' });
    expect(out).toMatchObject({ path: 'Rack A › Shelf 1 › Bin 3', parent_id: 'shelf1', url: `${STORAGE_URL}&unit=rack` });
  });

  it('refuses a name its siblings already use, and a parent that is not there', async () => {
    expect(refusal(await createStorageLocation.run({ name: 'left', parent_id: 'shelf1' }, userEnv))).toBe(
      'There\'s already a "Left" in Rack A › Shelf 1. Pick a different name.',
    );
    expect(refusal(await createStorageLocation.run({ name: 'RACK A' }, userEnv))).toBe(
      'There\'s already a "Rack A" in the top level of storage. Pick a different name.',
    );
    expect(refusal(await createStorageLocation.run({ name: 'Bin 9', parent: 'Mezzanine' }, userEnv))).toBe(
      'There is no location called "Mezzanine" in Acme Machining.',
    );
    noWrites();
  });
});

// ---------------------------------------------------------------------------------------------

/** Fields that would say who did the work: the catalogue test's list. */
const PERSON_FIELDS = [
  /^completed_by/,
  /^sent_by/,
  /^received_by/,
  /^created_by/,
  /^updated_by/,
  /^performed_by/,
  /^issued_by/,
  /^moved_by/,
  /^counted_by/,
  /^author/,
  /^operator/,
  /^user_id$/,
  /^user_name$/,
  /_by_name$/,
];

function propertyNames(schema: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) {
    for (const item of schema) propertyNames(item, into);
  } else if (schema && typeof schema === 'object') {
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'properties' && value && typeof value === 'object') {
        for (const name of Object.keys(value)) into.add(name);
      }
      propertyNames(value, into);
    }
  }
  return into;
}

describe('the storage write tools', () => {
  it('are writes, none destructive, and only the count is idempotent', () => {
    const hints = new Map<string, Record<string, unknown>>();
    const server = {
      registerTool: (name: string, config: { annotations?: Record<string, unknown> }) => {
        hints.set(name, config.annotations ?? {});
      },
    };
    registerInventoryWriteTools(server as unknown as Parameters<typeof registerInventoryWriteTools>[0]);

    expect([...hints.keys()]).toEqual(['add_stock', 'remove_stock', 'adjust_stock', 'transfer_stock', 'create_location']);
    for (const [name, h] of hints) {
      expect(h, name).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
      expect(h.idempotentHint, name).toBe(name === 'adjust_stock');
    }
  });

  it.each(INVENTORY_WRITE_TOOLS.map((t) => [t.name, t] as const))('%s returns a url and no person', (_name, tool) => {
    const names = propertyNames(z.toJSONSchema(z.object(tool.output), { io: 'output' }));
    expect(names.has('url')).toBe(true);
    expect([...names].filter((n) => PERSON_FIELDS.some((p) => p.test(n)))).toEqual([]);
  });
});
