import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { CompanyToolEnv } from '@/lib/mcp/defineTool';
import {
  addPartNoteTool,
  createPart,
  savePartRouting,
  setPartPricingTiers,
  updatePart,
  updatePartBom,
} from '@/lib/mcp/tools/partsWrites';
import { getSuggestedConversionFactor } from '@/lib/unitPresets';
import type { BomLineWithChildPart } from '@/types/bom';
import type { Part } from '@/types/part';
import type { RoutingOperationWithWorkCenter, RoutingWithGraph } from '@/types/routings';

/**
 * The part write tools, run directly (the wrapper's guards are covered in defineTool.test.ts).
 * What matters here: each calls the access function the part workspace calls, with the arguments
 * the workspace passes; the workspace's checks refuse first, in sentences; the starter pricing
 * tier follows a first cost as it does in the app; and nothing names a person.
 */

// ─── access-layer mocks ───────────────────────────────────────────────────────────────────────

const parts = {
  getPart: vi.fn(),
  checkPartNameExists: vi.fn(),
  createPart: vi.fn(),
  updatePart: vi.fn(),
  getPartCostExplain: vi.fn(),
  getPartNamesByIds: vi.fn(),
  getPartUnitConversions: vi.fn(),
  ensurePartUnitConversion: vi.fn(),
  addPartNote: vi.fn(),
  addPartPricingNote: vi.fn(),
};
vi.mock('@/utils/partsAccess', () => ({
  getPart: (...a: unknown[]) => parts.getPart(...a),
  checkPartNameExists: (...a: unknown[]) => parts.checkPartNameExists(...a),
  createPart: (...a: unknown[]) => parts.createPart(...a),
  updatePart: (...a: unknown[]) => parts.updatePart(...a),
  getPartCostExplain: (...a: unknown[]) => parts.getPartCostExplain(...a),
  getPartNamesByIds: (...a: unknown[]) => parts.getPartNamesByIds(...a),
  getPartUnitConversions: (...a: unknown[]) => parts.getPartUnitConversions(...a),
  ensurePartUnitConversion: (...a: unknown[]) => parts.ensurePartUnitConversion(...a),
  addPartNote: (...a: unknown[]) => parts.addPartNote(...a),
  addPartPricingNote: (...a: unknown[]) => parts.addPartPricingNote(...a),
  // Imported by the read tools; unused here.
  getAllParts: vi.fn(),
  getMadeParts: vi.fn(),
  getBoughtParts: vi.fn(),
  getPartNotes: vi.fn(),
}));

const bom = {
  getBomForPart: vi.fn(),
  addBomLine: vi.fn(),
  updateBomLine: vi.fn(),
  deleteBomLine: vi.fn(),
  checkBomCycle: vi.fn(),
};
vi.mock('@/utils/bomAccess', () => ({
  getBomForPart: (...a: unknown[]) => bom.getBomForPart(...a),
  addBomLine: (...a: unknown[]) => bom.addBomLine(...a),
  updateBomLine: (...a: unknown[]) => bom.updateBomLine(...a),
  deleteBomLine: (...a: unknown[]) => bom.deleteBomLine(...a),
  checkBomCycle: (...a: unknown[]) => bom.checkBomCycle(...a),
}));

const tiers = {
  getTiersForPart: vi.fn(),
  getTiersWithComputedPrices: vi.fn(),
  replaceTiersForPart: vi.fn(),
  ensureStarterPricingTier: vi.fn(),
};
vi.mock('@/utils/partPricingTiersAccess', () => ({
  getTiersForPart: (...a: unknown[]) => tiers.getTiersForPart(...a),
  getTiersWithComputedPrices: (...a: unknown[]) => tiers.getTiersWithComputedPrices(...a),
  replaceTiersForPart: (...a: unknown[]) => tiers.replaceTiersForPart(...a),
  ensureStarterPricingTier: (...a: unknown[]) => tiers.ensureStarterPricingTier(...a),
}));

const routings = { getRoutingForPart: vi.fn(), saveRoutingWithOperations: vi.fn() };
vi.mock('@/utils/routingsAccess', () => ({
  getRoutingForPart: (...a: unknown[]) => routings.getRoutingForPart(...a),
  saveRoutingWithOperations: (...a: unknown[]) => routings.saveRoutingWithOperations(...a),
}));

const units = { getCompanyCustomUnits: vi.fn(), addCompanyCustomUnit: vi.fn() };
vi.mock('@/utils/unitsAccess', () => ({
  getCompanyCustomUnits: (...a: unknown[]) => units.getCompanyCustomUnits(...a),
  addCompanyCustomUnit: (...a: unknown[]) => units.addCompanyCustomUnit(...a),
}));

const mockStations = vi.fn();
vi.mock('@/utils/workCentersAccess', () => ({ getWorkCentersForRouting: (...a: unknown[]) => mockStations(...a) }));

const mockServices = vi.fn();
vi.mock('@/utils/vendorServicesAccess', () => ({
  getVendorServicesForRouting: (...a: unknown[]) => mockServices(...a),
}));

const mockGetCompany = vi.fn();
vi.mock('@/utils/companyAccess', () => ({
  getCompany: (...a: unknown[]) => mockGetCompany(...a),
  readCompanyMaterialChargeBasis: (c: { default_material_charge_basis?: 'cost' | 'price' } | null) =>
    c?.default_material_charge_basis ?? 'cost',
}));

const mockCapture = vi.fn();
vi.mock('@sentry/nextjs', () => ({ captureException: (...a: unknown[]) => mockCapture(...a) }));

// The read tools' other imports, unused by the write tools.
vi.mock('@/utils/partCustomerReferencesAccess', () => ({ getReferencesForPart: vi.fn() }));
vi.mock('@/utils/vendorsAccess', () => ({ getVendor: vi.fn() }));
vi.mock('@/utils/routingCostCalculation', () => ({ calculateRoutingCost: vi.fn() }));

// ─── a small in-memory table store behind getSupabase() ───────────────────────────────────────

type Row = Record<string, unknown>;
let db: Record<string, Row[]> = {};

vi.mock('@/lib/supabase', () => {
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let cap = Number.POSITIVE_INFINITY;
    const rows = () => (db[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, cap);
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return chain;
      },
      ilike: (col: string, pattern: string) => {
        const wanted = pattern.replace(/\\([%_\\])/g, '$1').toLowerCase();
        filters.push((r) => String(r[col]).toLowerCase() === wanted);
        return chain;
      },
      limit: (n: number) => {
        cap = n;
        return chain;
      },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve({ data: rows(), error: null }).then(resolve, reject),
    };
    return chain;
  };
  return { getSupabase: () => ({ from }), registerScopedClientResolver: () => {} };
});

// ─── fixtures ─────────────────────────────────────────────────────────────────────────────────

const env: CompanyToolEnv = {
  caller: { token: 't', clientId: 'c', userId: 'u-1', email: null, expiresAt: 0 },
  company: { id: 'co-1', name: 'Acme Machining', role: 'user', isDemo: false, governingCompanyId: 'co-1' },
  origin: 'https://jigged.app',
  link: (path) => `https://jigged.app${path}`,
};

function part(overrides: Partial<Part>): Part {
  return {
    id: 'part-1',
    company_id: 'co-1',
    part_name: 'BRKT-100',
    description: 'Bracket',
    source: 'made',
    primary_unit: 'each',
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

let catalogue: Record<string, { part: Part; deleted_at: string | null }> = {};

function seed(...entries: Array<{ part: Part; deleted_at?: string | null }>): void {
  catalogue = Object.fromEntries(entries.map((e) => [e.part.id, { part: e.part, deleted_at: e.deleted_at ?? null }]));
  db.parts = entries.map((e) => ({
    id: e.part.id,
    company_id: e.part.company_id,
    part_name: e.part.part_name,
    deleted_at: e.deleted_at ?? null,
  }));
}

function bomLine(overrides: Partial<BomLineWithChildPart> & { child: Part }): BomLineWithChildPart {
  const { child, ...rest } = overrides;
  return {
    id: 'line-1',
    parent_part_id: 'part-1',
    child_part_id: child.id,
    quantity: 2,
    unit: child.primary_unit ?? 'each',
    sequence: 10,
    charge_basis: 'cost',
    created_at: '',
    updated_at: '',
    child_part: {
      id: child.id,
      part_name: child.part_name,
      description: child.description,
      primary_unit: child.primary_unit,
      source: child.source,
      costing_batch_quantity: null,
    },
    ...rest,
  };
}

function op(overrides: Partial<RoutingOperationWithWorkCenter>): RoutingOperationWithWorkCenter {
  return {
    id: 'op-1',
    routing_id: 'r-1',
    work_center_id: 'wc-1',
    vendor_service_id: null,
    sequence: 10,
    setup_minutes: 30,
    cycle_minutes_per_unit: 5,
    labor_rate_override: null,
    external_unit_price: null,
    instructions: null,
    metadata: {},
    created_at: '',
    updated_at: '',
    work_center: { id: 'wc-1', name: 'Haas VF-2', labor_rate: 85 },
    vendor_service: null,
    ...overrides,
  };
}

function routing(operations: RoutingOperationWithWorkCenter[]): RoutingWithGraph {
  return {
    id: 'r-1',
    company_id: 'co-1',
    part_id: 'part-1',
    name: 'Routing - BRKT-100',
    description: null,
    created_by: null,
    created_at: null,
    updated_at: null,
    part: null,
    operations,
  };
}

/** Every key anywhere in a value. */
function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, into));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      keysOf(v, into);
    }
  }
  return into;
}

function expectNoPerson(data: unknown): void {
  const people = [...keysOf(data)].filter((k) => /(_by|_by_name|author.*|operator.*|^user_id|^user_name)$/.test(k));
  expect(people).toEqual([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  db = {
    user_company_access: [{ id: 'm-1', user_id: 'u-1', company_id: 'co-1' }],
    vendors: [
      { id: 'v-1', company_id: 'co-1', name: 'McMaster-Carr', deleted_at: null },
      { id: 'v-2', company_id: 'co-1', name: 'Old Supply', deleted_at: '2026-01-01T00:00:00Z' },
    ],
  };
  seed({ part: part({}) });
  parts.getPart.mockImplementation(async (id: string) => catalogue[id]?.part ?? null);
  parts.checkPartNameExists.mockResolvedValue(false);
  parts.getPartCostExplain.mockResolvedValue({ is_priceable: true, unit_cost: 1, missing_leaves: [], missing_markups: [], missing_op_rates: [] });
  parts.getPartUnitConversions.mockResolvedValue([]);
  parts.getPartNamesByIds.mockResolvedValue(new Map());
  units.getCompanyCustomUnits.mockResolvedValue([]);
  tiers.getTiersForPart.mockResolvedValue([]);
  tiers.getTiersWithComputedPrices.mockResolvedValue([]);
  tiers.ensureStarterPricingTier.mockResolvedValue(false);
  bom.getBomForPart.mockResolvedValue([]);
  bom.checkBomCycle.mockResolvedValue({ would_create_cycle: false });
  mockGetCompany.mockResolvedValue({ default_material_charge_basis: 'cost' });
  mockStations.mockResolvedValue([]);
  mockServices.mockResolvedValue([]);
});

// ─── create_part ──────────────────────────────────────────────────────────────────────────────

describe('create_part', () => {
  it('creates through createPart with what New Part passes, the unit and vendor resolved', async () => {
    parts.createPart.mockImplementation(async (_co: string, form: { part_name: string }) =>
      part({ id: 'part-9', part_name: form.part_name, source: 'bought', reorder_point: 5, preferred_vendor_id: 'v-1' }),
    );
    const res = await createPart.run(
      {
        part_name: '  BRKT-200 ',
        source: 'bought',
        unit: 'ea',
        description: 'Bracket',
        reorder_point: 5,
        preferred_vendor_name: 'mcmaster-carr',
      },
      env,
    );
    if (!res.ok) throw new Error(res.message);
    expect(parts.checkPartNameExists).toHaveBeenCalledWith('co-1', 'BRKT-200');
    expect(parts.createPart).toHaveBeenCalledWith('co-1', {
      part_name: 'BRKT-200',
      description: 'Bracket',
      source: 'bought',
      primary_unit: 'each',
      quantity: 0,
      reorder_point: 5,
      preferred_vendor_id: 'v-1',
    });
    expect(res.data).toMatchObject({
      part_id: 'part-9',
      part_name: 'BRKT-200',
      source: 'bought',
      preferred_vendor: { vendor_id: 'v-1', name: 'McMaster-Carr', url: 'https://jigged.app/dashboard/co-1/vendors/v-1' },
      custom_unit_added: false,
      url: 'https://jigged.app/dashboard/co-1/parts/part-9',
    });
    expectNoPerson(res.data);
  });

  it('defaults to a made part', async () => {
    parts.createPart.mockResolvedValue(part({ id: 'part-9' }));
    await createPart.run({ part_name: 'X-1', unit: 'each' }, env);
    expect(parts.createPart).toHaveBeenCalledWith('co-1', expect.objectContaining({ source: 'made', preferred_vendor_id: null }));
  });

  it('refuses a live duplicate name before writing', async () => {
    parts.checkPartNameExists.mockResolvedValue(true);
    const res = await createPart.run({ part_name: 'BRKT-100', unit: 'each' }, env);
    expect(res).toEqual({ ok: false, message: 'Acme Machining already has a part named BRKT-100.' });
    expect(parts.createPart).not.toHaveBeenCalled();
  });

  it('refuses a unit the company does not have, and adds it only when asked', async () => {
    const refused = await createPart.run({ part_name: 'BAR-1', unit: 'billet' }, env);
    expect(refused).toEqual({ ok: false, message: expect.stringMatching(/billet isn't one of Acme Machining's units/) });
    expect(units.addCompanyCustomUnit).not.toHaveBeenCalled();
    expect(parts.createPart).not.toHaveBeenCalled();

    units.addCompanyCustomUnit.mockResolvedValue({ id: 'cu-1', company_id: 'co-1', unit_name: 'billet' });
    parts.createPart.mockResolvedValue(part({ id: 'part-9', primary_unit: 'billet' }));
    const res = await createPart.run({ part_name: 'BAR-1', unit: 'billet', add_custom_unit: true }, env);
    if (!res.ok) throw new Error(res.message);
    expect(units.addCompanyCustomUnit).toHaveBeenCalledWith('co-1', 'billet');
    expect(parts.createPart).toHaveBeenCalledWith('co-1', expect.objectContaining({ primary_unit: 'billet' }));
    expect(res.data.custom_unit_added).toBe(true);
  });

  it('uses a company unit already added, as the picker does', async () => {
    units.getCompanyCustomUnits.mockResolvedValue([{ id: 'cu-1', company_id: 'co-1', unit_name: 'Billet' }]);
    parts.createPart.mockResolvedValue(part({ id: 'part-9' }));
    await createPart.run({ part_name: 'BAR-1', unit: 'billet' }, env);
    expect(parts.createPart).toHaveBeenCalledWith('co-1', expect.objectContaining({ primary_unit: 'Billet' }));
  });

  it('refuses a preferred vendor on a made part, and an archived vendor', async () => {
    expect(await createPart.run({ part_name: 'X-1', unit: 'each', preferred_vendor_id: '11111111-1111-1111-1111-111111111111' }, env)).toEqual({
      ok: false,
      message: expect.stringMatching(/Only a bought part has a preferred vendor/),
    });
    expect(
      await createPart.run({ part_name: 'X-1', unit: 'each', source: 'bought', preferred_vendor_name: 'Old Supply' }, env),
    ).toEqual({ ok: false, message: "Old Supply is archived, so it can't be a part's preferred vendor." });
    expect(parts.createPart).not.toHaveBeenCalled();
  });
});

// ─── update_part ──────────────────────────────────────────────────────────────────────────────

describe('update_part', () => {
  it('writes the whole identity form through updatePart, found by name', async () => {
    parts.updatePart.mockImplementation(async (id: string, form: { part_name: string; description: string }) =>
      part({ id, part_name: form.part_name, description: form.description, reorder_point: 4 }),
    );
    const res = await updatePart.run({ part_name: 'brkt-100', new_part_name: 'BRKT-100A', reorder_point: 4 }, env);
    if (!res.ok) throw new Error(res.message);
    expect(parts.checkPartNameExists).toHaveBeenCalledWith('co-1', 'BRKT-100A', 'part-1');
    expect(parts.updatePart).toHaveBeenCalledWith('part-1', {
      part_name: 'BRKT-100A',
      description: 'Bracket',
      source: 'made',
      primary_unit: 'each',
      quantity: 0,
      reorder_point: 4,
      preferred_vendor_id: null,
    });
    expect(res.data).toMatchObject({
      part_id: 'part-1',
      part_name: 'BRKT-100A',
      archived: false,
      changed: ['part_name', 'reorder_point'],
      url: 'https://jigged.app/dashboard/co-1/parts/part-1',
    });
    expectNoPerson(res.data);
  });

  it('clears the preferred vendor when a bought part becomes made, as the toggle does', async () => {
    seed({ part: part({ source: 'bought', preferred_vendor_id: 'v-1' }) });
    parts.updatePart.mockImplementation(async (id: string) => part({ id }));
    const res = await updatePart.run({ part_id: '22222222-2222-2222-2222-222222222222', source: 'made' }, env);
    // That id is not in the company.
    expect(res).toEqual({ ok: false, message: 'There is no part with that id in Acme Machining.' });

    const ok = await updatePart.run({ part_name: 'BRKT-100', source: 'made' }, env);
    if (!ok.ok) throw new Error(ok.message);
    expect(parts.updatePart).toHaveBeenCalledWith('part-1', expect.objectContaining({ source: 'made', preferred_vendor_id: null }));
    expect(ok.data.changed).toEqual(['source', 'preferred_vendor']);
  });

  it('gives a part that became costable its starter tier, as the workspace does after a save', async () => {
    parts.getPartCostExplain.mockResolvedValue({ is_priceable: false, unit_cost: null, missing_leaves: [], missing_markups: [], missing_op_rates: [] });
    tiers.ensureStarterPricingTier.mockResolvedValue(true);
    parts.updatePart.mockImplementation(async (id: string) => part({ id, description: 'New' }));
    const res = await updatePart.run({ part_name: 'BRKT-100', description: 'New' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(tiers.ensureStarterPricingTier).toHaveBeenCalledWith('co-1', 'part-1', 'made');
    expect(res.data.starter_pricing_added).toBe(true);
  });

  it('refuses a call that changes nothing, and writes nothing when every value is already so', async () => {
    expect(await updatePart.run({ part_name: 'BRKT-100' }, env)).toEqual({
      ok: false,
      message: expect.stringMatching(/^Give at least one field to change/),
    });
    const same = await updatePart.run({ part_name: 'BRKT-100', description: 'Bracket', unit: 'ea' }, env);
    if (!same.ok) throw new Error(same.message);
    expect(same.data.changed).toEqual([]);
    expect(parts.updatePart).not.toHaveBeenCalled();
  });

  it('refuses a name another live part has, and a part that is not there', async () => {
    parts.checkPartNameExists.mockResolvedValue(true);
    expect(await updatePart.run({ part_name: 'BRKT-100', new_part_name: 'BRKT-200' }, env)).toEqual({
      ok: false,
      message: 'Acme Machining already has another part named BRKT-200.',
    });
    expect(await updatePart.run({ part_name: 'NOPE-1', description: 'x' }, env)).toEqual({
      ok: false,
      message: 'There is no part named NOPE-1 in Acme Machining.',
    });
    expect(parts.updatePart).not.toHaveBeenCalled();
  });
});

// ─── set_part_pricing_tiers ───────────────────────────────────────────────────────────────────

describe('set_part_pricing_tiers', () => {
  const saved = (o: Partial<{ id: string; sequence: number; quantity: number; markup_percent: number | null; cost_per_unit: number | null }>) => ({
    id: 't-1',
    part_id: 'part-1',
    company_id: 'co-1',
    sequence: 10,
    quantity: 1,
    cost_per_unit: null,
    markup_percent: 30,
    created_at: '',
    updated_at: '',
    ...o,
  });

  it('saves the ladder as the Pricing card does: sorted, same-quantity rows kept, and a pricing note', async () => {
    tiers.getTiersForPart.mockResolvedValue([saved({ id: 't-1', sequence: 10, quantity: 1 }), saved({ id: 't-2', sequence: 20, quantity: 5 })]);
    tiers.getTiersWithComputedPrices.mockResolvedValue([
      { ...saved({ quantity: 1, markup_percent: 25 }), unit_price: 12.5 },
      { ...saved({ id: 't-3', quantity: 10, markup_percent: 20 }), unit_price: 11 },
    ]);
    const res = await setPartPricingTiers.run(
      { part_name: 'BRKT-100', tiers: [{ quantity: 10, markup_percent: 20 }, { quantity: 1, markup_percent: 25 }] },
      env,
    );
    if (!res.ok) throw new Error(res.message);
    expect(tiers.replaceTiersForPart).toHaveBeenCalledWith('co-1', 'part-1', [
      { id: 't-1', sequence: 10, quantity: 1, cost_per_unit: null, markup_percent: 25 },
      { id: undefined, sequence: 30, quantity: 10, cost_per_unit: null, markup_percent: 20 },
    ]);
    expect(parts.addPartPricingNote).toHaveBeenCalledWith(
      'part-1',
      'co-1',
      'm-1',
      'Pricing updated — 2 tiers: @1 → 25%, @10 → 20%',
    );
    expect(res.data).toEqual({
      part_id: 'part-1',
      part_name: 'BRKT-100',
      source: 'made',
      pricing_tiers: [
        { quantity: 1, unit_price: 12.5, markup_percent: 25, cost_per_unit: null },
        { quantity: 10, unit_price: 11, markup_percent: 20, cost_per_unit: null },
      ],
      changed: true,
      starter_pricing_added: false,
      url: 'https://jigged.app/dashboard/co-1/parts/part-1',
    });
    expectNoPerson(res.data);
  });

  it('keeps a bought part\'s cost on its rows', async () => {
    seed({ part: part({ source: 'bought' }) });
    await setPartPricingTiers.run({ part_name: 'BRKT-100', tiers: [{ quantity: 1, cost_per_unit: 4.2, markup_percent: 40 }] }, env);
    expect(tiers.replaceTiersForPart).toHaveBeenCalledWith('co-1', 'part-1', [
      { id: undefined, sequence: 10, quantity: 1, cost_per_unit: 4.2, markup_percent: 40 },
    ]);
  });

  it('refuses what the card refuses: a duplicate break, too many decimals, a cost on a made part', async () => {
    expect(await setPartPricingTiers.run({ part_name: 'BRKT-100', tiers: [{ quantity: 5 }, { quantity: 5 }] }, env)).toEqual({
      ok: false,
      message: expect.stringMatching(/^Two tiers share the same quantity \(5\)/),
    });
    expect(await setPartPricingTiers.run({ part_name: 'BRKT-100', tiers: [{ quantity: 0.12345 }] }, env)).toEqual({
      ok: false,
      message: expect.stringMatching(/at most 4 decimal places; 0.12345 is not/),
    });
    expect(await setPartPricingTiers.run({ part_name: 'BRKT-100', tiers: [{ quantity: 1, cost_per_unit: 3 }] }, env)).toEqual({
      ok: false,
      message: expect.stringMatching(/cost_per_unit is for bought parts/),
    });
    expect(tiers.replaceTiersForPart).not.toHaveBeenCalled();
  });

  it('writes nothing, and logs nothing, when the ladder is already so', async () => {
    tiers.getTiersForPart.mockResolvedValue([saved({ quantity: 1, markup_percent: 30 })]);
    const res = await setPartPricingTiers.run({ part_name: 'BRKT-100', tiers: [{ quantity: 1, markup_percent: 30 }] }, env);
    if (!res.ok) throw new Error(res.message);
    expect(res.data.changed).toBe(false);
    expect(tiers.replaceTiersForPart).not.toHaveBeenCalled();
    expect(parts.addPartPricingNote).not.toHaveBeenCalled();
  });

  it('says when the part is not there', async () => {
    expect(await setPartPricingTiers.run({ part_name: 'NOPE-1', tiers: [{ quantity: 1 }] }, env)).toEqual({
      ok: false,
      message: 'There is no part named NOPE-1 in Acme Machining.',
    });
  });
});

// ─── update_part_bom ──────────────────────────────────────────────────────────────────────────

describe('update_part_bom', () => {
  const rod = part({ id: 'part-2', part_name: 'ROD-1', primary_unit: 'inches', source: 'bought', description: 'Rod' });

  it('adds a line through addBomLine, charged like the part\'s other materials, with the unit converted', async () => {
    const screw = part({ id: 'part-3', part_name: 'SCREW-1', source: 'bought' });
    seed({ part: part({}) }, { part: rod }, { part: screw });
    bom.getBomForPart
      .mockResolvedValueOnce([bomLine({ id: 'line-0', child: screw, charge_basis: 'price' })])
      .mockResolvedValueOnce([
        bomLine({ id: 'line-0', child: screw, charge_basis: 'price' }),
        bomLine({ id: 'line-1', child: rod, quantity: 0.5, unit: 'feet', charge_basis: 'price' }),
      ]);
    parts.getPartCostExplain.mockResolvedValue({ is_priceable: false, unit_cost: null, missing_leaves: [], missing_markups: [], missing_op_rates: [] });
    tiers.ensureStarterPricingTier.mockResolvedValue(true);

    const res = await updatePartBom.run(
      { part_name: 'BRKT-100', action: 'add', child_part_name: 'rod-1', quantity: 0.5, unit: 'ft' },
      env,
    );
    if (!res.ok) throw new Error(res.message);
    expect(bom.checkBomCycle).toHaveBeenCalledWith('part-1', 'part-2');
    expect(parts.ensurePartUnitConversion).toHaveBeenCalledWith('part-2', 'feet', getSuggestedConversionFactor('feet', 'inches'));
    expect(bom.addBomLine).toHaveBeenCalledWith('part-1', {
      child_part_id: 'part-2',
      quantity: '0.5',
      unit: 'feet',
      charge_basis: 'price',
    });
    expect(tiers.ensureStarterPricingTier).toHaveBeenCalledWith('co-1', 'part-1', 'made');
    expect(res.data.starter_pricing_added).toBe(true);
    expect(res.data.bill_of_materials[1]).toEqual({
      part_id: 'part-2',
      part_name: 'ROD-1',
      description: 'Rod',
      source: 'bought',
      quantity: 0.5,
      unit: 'feet',
      charge_basis: 'price',
      url: 'https://jigged.app/dashboard/co-1/parts/part-2',
    });
    expectNoPerson(res.data);
  });

  it('charges a first line at the shop default and in the child\'s own unit', async () => {
    seed({ part: part({}) }, { part: rod });
    mockGetCompany.mockResolvedValue({ default_material_charge_basis: 'price' });
    await updatePartBom.run({ part_name: 'BRKT-100', action: 'add', child_part_name: 'ROD-1', quantity: 3 }, env);
    expect(parts.ensurePartUnitConversion).not.toHaveBeenCalled();
    expect(bom.addBomLine).toHaveBeenCalledWith('part-1', { child_part_id: 'part-2', quantity: '3', unit: 'inches', charge_basis: 'price' });
  });

  it('refuses a loop, naming the parts in it', async () => {
    seed({ part: part({}) }, { part: rod });
    bom.checkBomCycle.mockResolvedValue({ would_create_cycle: true, cycle_path: ['part-2', 'part-1', 'part-2'] });
    parts.getPartNamesByIds.mockResolvedValue(new Map([['part-1', 'BRKT-100'], ['part-2', 'ROD-1']]));
    expect(await updatePartBom.run({ part_name: 'BRKT-100', action: 'add', child_part_name: 'ROD-1', quantity: 1 }, env)).toEqual({
      ok: false,
      message: 'Adding ROD-1 to BRKT-100 would make a loop: ROD-1 → BRKT-100 → ROD-1.',
    });
    expect(bom.addBomLine).not.toHaveBeenCalled();
  });

  it('refuses an archived child, one already on the list, a unit it cannot be measured in, and a bought parent', async () => {
    seed({ part: part({}) }, { part: rod, deleted_at: '2026-10-01T00:00:00Z' });
    expect(await updatePartBom.run({ part_name: 'BRKT-100', action: 'add', child_part_name: 'ROD-1', quantity: 1 }, env)).toEqual({
      ok: false,
      message: "ROD-1 is archived, so it can't be added as a material.",
    });

    seed({ part: part({}) }, { part: rod });
    bom.getBomForPart.mockResolvedValue([bomLine({ child: rod })]);
    expect(await updatePartBom.run({ part_name: 'BRKT-100', action: 'add', child_part_name: 'ROD-1', quantity: 1 }, env)).toEqual({
      ok: false,
      message: expect.stringMatching(/already in BRKT-100's bill of materials/),
    });

    bom.getBomForPart.mockResolvedValue([]);
    expect(
      await updatePartBom.run({ part_name: 'BRKT-100', action: 'add', child_part_name: 'ROD-1', quantity: 1, unit: 'pounds' }, env),
    ).toEqual({ ok: false, message: expect.stringMatching(/^ROD-1 can't be measured in pounds here/) });

    seed({ part: part({ source: 'bought' }) }, { part: rod });
    expect(await updatePartBom.run({ part_name: 'BRKT-100', action: 'add', child_part_name: 'ROD-1', quantity: 1 }, env)).toEqual({
      ok: false,
      message: 'BRKT-100 is bought, so it has no bill of materials.',
    });
    expect(bom.addBomLine).not.toHaveBeenCalled();
  });

  it('updates a line through updateBomLine, keeping its charge basis', async () => {
    seed({ part: part({}) }, { part: rod });
    bom.getBomForPart.mockResolvedValue([bomLine({ id: 'line-7', child: rod, quantity: 2, unit: 'inches', charge_basis: 'price' })]);
    const res = await updatePartBom.run({ part_name: 'BRKT-100', action: 'update', child_part_id: undefined, child_part_name: 'ROD-1', quantity: 3 }, env);
    if (!res.ok) throw new Error(res.message);
    expect(bom.updateBomLine).toHaveBeenCalledWith('line-7', {
      child_part_id: 'part-2',
      quantity: '3',
      unit: 'inches',
      charge_basis: 'price',
    });
  });

  it('removes a line through deleteBomLine, and says when the child is not on it', async () => {
    seed({ part: part({}) }, { part: rod });
    bom.getBomForPart.mockResolvedValue([bomLine({ id: 'line-7', child: rod })]);
    await updatePartBom.run({ part_name: 'BRKT-100', action: 'remove', child_part_name: 'ROD-1' }, env);
    expect(bom.deleteBomLine).toHaveBeenCalledWith('line-7');

    bom.getBomForPart.mockResolvedValue([]);
    expect(await updatePartBom.run({ part_name: 'BRKT-100', action: 'remove', child_part_name: 'ROD-1' }, env)).toEqual({
      ok: false,
      message: "ROD-1 is not in BRKT-100's bill of materials.",
    });
  });
});

// ─── save_part_routing ────────────────────────────────────────────────────────────────────────

describe('save_part_routing', () => {
  beforeEach(() => {
    mockStations.mockResolvedValue([
      { id: 'wc-1', name: 'Haas VF-2', labor_rate: 85 },
      { id: 'wc-2', name: 'Deburr bench', labor_rate: 40 },
    ]);
    mockServices.mockResolvedValue([
      { id: 'vs-1', name: 'Anodize', unit_price: 3, vendor_id: 'v-1', vendor_name: 'Coatings Inc' },
      { id: 'vs-2', name: 'Anodize', unit_price: 4, vendor_id: 'v-3', vendor_name: 'Finishers LLC' },
      { id: 'vs-3', name: 'Heat treat', unit_price: null, vendor_id: 'v-1', vendor_name: 'Coatings Inc' },
    ]);
  });

  it('saves the steps through saveRoutingWithOperations, keeping a step that is already there', async () => {
    const saved = routing([
      op({ id: 'op-1', instructions: 'Use fixture A' }),
      op({
        id: 'op-2',
        sequence: 20,
        work_center_id: null,
        vendor_service_id: 'vs-1',
        work_center: null,
        vendor_service: { id: 'vs-1', name: 'Anodize', unit_price: 3, vendor: { id: 'v-1', name: 'Coatings Inc' } },
      }),
    ]);
    routings.getRoutingForPart.mockResolvedValueOnce(saved).mockResolvedValueOnce(
      routing([
        op({ id: 'op-9', work_center_id: 'wc-2', work_center: { id: 'wc-2', name: 'Deburr bench', labor_rate: 40 }, setup_minutes: null, cycle_minutes_per_unit: 2, labor_rate_override: 45 }),
        op({ id: 'op-1', sequence: 20, cycle_minutes_per_unit: 6, instructions: 'Use fixture A' }),
      ]),
    );
    const res = await savePartRouting.run(
      {
        part_name: 'BRKT-100',
        steps: [
          { work_center_name: 'deburr bench', run_minutes_per_unit: 2, labor_rate_per_hour: 45 },
          { work_center_name: 'Haas VF-2', run_minutes_per_unit: 6, labor_rate_per_hour: 85 },
        ],
      },
      env,
    );
    if (!res.ok) throw new Error(res.message);
    expect(routings.saveRoutingWithOperations).toHaveBeenCalledWith(
      'co-1',
      'part-1',
      'r-1',
      [
        {
          tempId: 'new-step-1',
          workCenterId: 'wc-2',
          vendorServiceId: null,
          workCenterName: 'Deburr bench',
          vendorName: null,
          setupMinutes: null,
          cycleMinutesPerUnit: 2,
          laborRateOverride: 45,
          externalUnitPrice: null,
          instructions: null,
        },
        {
          // The saved step: its setup and instructions kept, and a rate equal to the centre's
          // stored as no override.
          tempId: 'op-1',
          workCenterId: 'wc-1',
          vendorServiceId: null,
          workCenterName: 'Haas VF-2',
          vendorName: null,
          setupMinutes: 30,
          cycleMinutesPerUnit: 6,
          laborRateOverride: null,
          externalUnitPrice: null,
          instructions: 'Use fixture A',
        },
      ],
      new Set(['op-1', 'op-2']),
    );
    expect(res.data.routing).toEqual([
      {
        sequence: 10,
        operation: 'Deburr bench',
        kind: 'in_house',
        outside_vendor: null,
        setup_minutes: null,
        run_minutes_per_unit: 2,
        labor_rate_per_hour: 45,
        price_per_piece: null,
        instructions: null,
      },
      {
        sequence: 20,
        operation: 'Haas VF-2',
        kind: 'in_house',
        outside_vendor: null,
        setup_minutes: 30,
        run_minutes_per_unit: 6,
        labor_rate_per_hour: 85,
        price_per_piece: null,
        instructions: 'Use fixture A',
      },
    ]);
    expect(res.data.url).toBe('https://jigged.app/dashboard/co-1/parts/part-1');
    expectNoPerson(res.data);
  });

  it('creates the routing on a part with none, with an outside step at its vendor\'s price', async () => {
    routings.getRoutingForPart.mockResolvedValue(null);
    await savePartRouting.run(
      { part_name: 'BRKT-100', steps: [{ outside_service_name: 'Anodize', outside_vendor_name: 'Finishers LLC', price_per_piece: 4 }] },
      env,
    );
    expect(routings.saveRoutingWithOperations).toHaveBeenCalledWith(
      'co-1',
      'part-1',
      null,
      [expect.objectContaining({ vendorServiceId: 'vs-2', workCenterId: null, externalUnitPrice: null, vendorName: 'Finishers LLC' })],
      new Set(),
    );
  });

  it('refuses what the step editor refuses', async () => {
    routings.getRoutingForPart.mockResolvedValue(null);
    const run = (steps: Parameters<typeof savePartRouting.run>[0]['steps']) => savePartRouting.run({ part_name: 'BRKT-100', steps }, env);
    expect(await run([{ work_center_name: 'Haas VF-2' }])).toEqual({
      ok: false,
      message: 'Step 1 at Haas VF-2 needs setup minutes or run minutes greater than zero.',
    });
    expect(await run([{ outside_service_name: 'Anodize', price_per_piece: 3 }])).toEqual({
      ok: false,
      message: expect.stringMatching(/^Step 1: more than one vendor offers Anodize \(Coatings Inc, Finishers LLC\)/),
    });
    expect(await run([{ outside_service_name: 'Heat treat' }])).toEqual({
      ok: false,
      message: 'Step 1: Heat treat from Coatings Inc has no price per piece; give price_per_piece.',
    });
    expect(await run([{ outside_service_id: undefined, outside_service_name: 'Heat treat', setup_minutes: 10 }])).toEqual({
      ok: false,
      message: expect.stringMatching(/is an outside service, priced by the piece/),
    });
    expect(await run([{ work_center_name: 'Lathe', run_minutes_per_unit: 1 }])).toEqual({
      ok: false,
      message: 'Step 1: there is no work center named Lathe in Acme Machining.',
    });
    expect(await run([{ work_center_name: 'Haas VF-2', outside_service_name: 'Anodize', run_minutes_per_unit: 1 }])).toEqual({
      ok: false,
      message: 'Step 1: give a work center or an outside service, not both.',
    });
    expect(routings.saveRoutingWithOperations).not.toHaveBeenCalled();
  });

  it('refuses a bought part, which has no routing in the app', async () => {
    seed({ part: part({ source: 'bought' }) });
    expect(await savePartRouting.run({ part_name: 'BRKT-100', steps: [] }, env)).toEqual({
      ok: false,
      message: 'BRKT-100 is bought, so it has no routing. Only parts made in the shop do.',
    });
  });
});

// ─── add_part_note ────────────────────────────────────────────────────────────────────────────

describe('add_part_note', () => {
  it('adds the note through addPartNote as the caller, and returns it with no author', async () => {
    parts.addPartNote.mockResolvedValue({
      id: 'n-1',
      part_id: 'part-1',
      body: 'Check the drawing rev',
      created_at: '2026-11-09T10:00:00Z',
      edited_at: null,
      author_id: 'm-1',
      author_name: 'Dana',
      note_type: 'user',
    });
    const res = await addPartNoteTool.run({ part_name: 'BRKT-100', body: 'Check the drawing rev' }, env);
    if (!res.ok) throw new Error(res.message);
    expect(parts.addPartNote).toHaveBeenCalledWith('part-1', 'co-1', 'm-1', 'Check the drawing rev');
    expect(res.data).toEqual({
      part_id: 'part-1',
      part_name: 'BRKT-100',
      note: { body: 'Check the drawing rev', note_type: 'user', created_at: '2026-11-09T10:00:00Z' },
      url: 'https://jigged.app/dashboard/co-1/parts/part-1?tab=history',
    });
    expectNoPerson(res.data);
  });

  it('refuses an empty note and a part that is not there', async () => {
    expect(await addPartNoteTool.run({ part_name: 'BRKT-100', body: '   ' }, env)).toEqual({ ok: false, message: 'A note cannot be empty.' });
    expect(await addPartNoteTool.run({ part_name: 'NOPE-1', body: 'x' }, env)).toEqual({
      ok: false,
      message: 'There is no part named NOPE-1 in Acme Machining.',
    });
    expect(parts.addPartNote).not.toHaveBeenCalled();
  });
});

// Nothing in these tools is admin-only: every run above is as a `user`, not an admin, because the
// part workspace has no admin guard on any of these actions.
