/**
 * Material check — access layer.
 *
 * The test that earns its keep is the **N+1 guard**. Both entry points share one pipeline,
 * and its request count must be constant in the number of jobs. A comment saying "don't loop
 * over jobs here" is not a guarantee; counting `.from()` calls against a 20-job fixture is.
 * Issue #68 is the reason this is pinned rather than trusted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fromSpy = vi.fn();

/**
 * A chainable Supabase stub. Every builder method returns `this`, and the chain resolves to
 * whatever `tableData` holds for the table it was opened on — so a query's shape doesn't
 * matter here, only which table it hit and how many times.
 */
const tableData: Record<string, unknown[]> = {};

/** Every filter applied, per table — lets a test assert what was actually asked for. */
let filters: Array<{ table: string; method: string; args: unknown[] }> = [];

function makeBuilder(table: string) {
  const rows = tableData[table] ?? [];
  const result = { data: rows, error: null };
  const builder: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
  };
  for (const m of ['select', 'eq', 'in', 'is', 'gt', 'order', 'range', 'or', 'not']) {
    builder[m] = (...args: unknown[]) => {
      filters.push({ table, method: m, args });
      return builder;
    };
  }
  return builder;
}

const filterFor = (table: string, method: string) =>
  filters.filter((f) => f.table === table && f.method === method).map((f) => f.args);

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => ({ from: fromSpy }),
  getTypedSupabase: () => ({ from: fromSpy }),
}));

vi.mock('@/utils/inventoryLocationsAccess', () => ({
  getBalancesForParts: vi.fn(async () => new Map()),
  getLocations: vi.fn(async () => [{ id: 'loc-un', name: 'Unassigned' }]),
}));

import { getShopMaterialShortages, getJobPartMaterialCheck } from '@/utils/materialCheckAccess';
import { getBalancesForParts } from '@/utils/inventoryLocationsAccess';

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

/** N job parts, each on its own job, all making the same part. */
const jobPartRows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `jp${i}`,
    job_id: `job${i}`,
    part_id: 'made1',
    quantity: 2,
    production_status: 'not_started',
    part: { id: 'made1', part_name: 'Widget' },
    job: {
      id: `job${i}`,
      job_number: `J-${1000 + i}`,
      due_date: null,
      is_hot: false,
      production_status: 'not_started',
      company_id: 'co1',
      deleted_at: null,
    },
  }));

beforeEach(() => {
  vi.clearAllMocks();
  filters = [];
  fromSpy.mockImplementation((table: string) => makeBuilder(table));
  asMock(getBalancesForParts).mockResolvedValue(new Map());

  tableData.job_parts = jobPartRows(20);
  tableData.parts_bom = [
    { id: 'b1', parent_part_id: 'made1', child_part_id: 'steel', quantity: 3, unit: 'each', consume_whole_units: false },
    { id: 'b2', parent_part_id: 'made1', child_part_id: 'oring', quantity: 4, unit: 'each', consume_whole_units: false },
    { id: 'b3', parent_part_id: 'made1', child_part_id: 'bolt', quantity: 6, unit: 'each', consume_whole_units: false },
  ];
  tableData.parts = [
    { id: 'steel', part_name: 'Steel', primary_unit: 'each', quantity: 15, is_stocked: true, is_location_tracked: false, deleted_at: null },
    { id: 'oring', part_name: 'O-ring', primary_unit: 'each', quantity: 9000, is_stocked: true, is_location_tracked: false, deleted_at: null },
    { id: 'bolt', part_name: 'Bolt', primary_unit: 'each', quantity: 9000, is_stocked: true, is_location_tracked: false, deleted_at: null },
  ];
  tableData.parts_unit_conversions = [];
  tableData.inventory_transactions = [];
});

describe('getShopMaterialShortages — request budget', () => {
  /**
   * 20 jobs × 3 materials. A naive implementation issues at least one read per job (20+) or
   * per BOM line (60+). This pipeline issues one per TABLE.
   */
  it('does not scale its query count with the number of jobs', async () => {
    await getShopMaterialShortages('co1', 'all');

    const tables = fromSpy.mock.calls.map((c) => c[0]);
    expect(tables).toEqual([
      'job_parts',
      'parts_bom',
      'parts',
      'inventory_transactions',
      // parts_unit_conversions is skipped entirely — every BOM unit matches its stock unit.
    ]);
    expect(fromSpy).toHaveBeenCalledTimes(4);
  });

  it('holds that budget when the job count grows', async () => {
    tableData.job_parts = jobPartRows(200);
    await getShopMaterialShortages('co1', 'all');
    expect(fromSpy).toHaveBeenCalledTimes(4);
  });

  it('reads conversions only for lines whose BOM unit differs from the stock unit', async () => {
    tableData.parts_bom = [
      { id: 'b1', parent_part_id: 'made1', child_part_id: 'steel', quantity: 3, unit: 'feet', consume_whole_units: false },
    ];
    await getShopMaterialShortages('co1', 'all');
    expect(fromSpy.mock.calls.map((c) => c[0])).toContain('parts_unit_conversions');
  });

  // The job card and the shop-wide view don't render bin detail; loading it would cost an
  // extra query plus a whole-tree read for nothing.
  it('skips the bin read unless the caller asks for locations', async () => {
    await getShopMaterialShortages('co1', 'all');
    expect(getBalancesForParts).not.toHaveBeenCalled();

    await getJobPartMaterialCheck({
      companyId: 'co1', jobId: 'job1', jobPartId: 'jp1',
      madePartId: 'made1', orderQuantity: 2, withLocations: true,
    });
    expect(getBalancesForParts).toHaveBeenCalledTimes(1);
  });
});

describe('getShopMaterialShortages — aggregation', () => {
  it('aggregates one row per part across every job that needs it', async () => {
    const { shortages, jobCount } = await getShopMaterialShortages('co1', 'all');

    expect(jobCount).toBe(20);
    expect(shortages.map((s) => s.partId).sort()).toEqual(['bolt', 'oring', 'steel']);

    // 20 jobs × 2 each × 3 per unit = 120 required, against 15 on hand counted ONCE.
    const steel = shortages.find((s) => s.partId === 'steel')!;
    expect(steel.totalRequired).toBe(120);
    expect(steel.onHand).toBe(15);
    expect(steel.shortBy).toBe(105);
    expect(steel.contributions).toHaveLength(20);
  });

  it('subtracts what those jobs already took', async () => {
    tableData.inventory_transactions = [
      { job_id: 'job0', part_id: 'steel', converted_quantity: 6, has_discrepancy: false },
    ];
    const { shortages } = await getShopMaterialShortages('co1', 'all');
    const steel = shortages.find((s) => s.partId === 'steel')!;
    expect(steel.totalIssued).toBe(6);
    expect(steel.shortBy).toBe(99); // (120 − 6) − 15
  });

  // An 'addition' or 'adjustment' counted as consumption would understate every shortage.
  it('only counts depletions, never additions or adjustments', async () => {
    await getShopMaterialShortages('co1', 'all');
    expect(filterFor('inventory_transactions', 'eq')).toContainEqual(['type', 'depletion']);
    expect(filterFor('inventory_transactions', 'eq')).toContainEqual(['company_id', 'co1']);
  });

  // The classic soft-delete leak: an archived job still has live job_parts rows.
  it('excludes archived jobs and scopes to the company', async () => {
    await getShopMaterialShortages('co1', 'all');
    expect(filterFor('job_parts', 'is')).toContainEqual(['job.deleted_at', null]);
    expect(filterFor('job_parts', 'eq')).toContainEqual(['job.company_id', 'co1']);
    expect(filterFor('job_parts', 'in')).toContainEqual([
      'production_status', ['not_started', 'in_progress'],
    ]);
  });
});

describe('getShopMaterialShortages — window', () => {
  const HOT = { ...jobPartRows(1)[0], id: 'jp-hot', job_id: 'job-hot' };

  it('keeps a job due far in the future out of the week window', async () => {
    tableData.job_parts = [{
      ...HOT,
      job: { ...HOT.job, id: 'job-hot', job_number: 'J-FUTURE', due_date: '2099-01-01', is_hot: false },
    }];
    const { jobCount } = await getShopMaterialShortages('co1', 'week', new Date(2026, 6, 28));
    expect(jobCount).toBe(0);
  });

  // The window only ever ADDS jobs. Each of these would be a harmful omission.
  it.each([
    ['a hot job', { due_date: '2099-01-01', is_hot: true }],
    ['an overdue job', { due_date: '2020-01-01', is_hot: false }],
    ['an undated job', { due_date: null, is_hot: false }],
  ])('always includes %s, whatever the window', async (_label, over) => {
    tableData.job_parts = [{ ...HOT, job: { ...HOT.job, ...over } }];
    const { jobCount } = await getShopMaterialShortages('co1', 'week', new Date(2026, 6, 28));
    expect(jobCount).toBe(1);
  });

  it('reports the resolved range so "this week" is never ambiguous', async () => {
    const { rangeEnd } = await getShopMaterialShortages('co1', 'week', new Date(2026, 6, 28));
    expect(rangeEnd).toBe('2026-08-02');
    const all = await getShopMaterialShortages('co1', 'all', new Date(2026, 6, 28));
    expect(all.rangeEnd).toBeNull();
  });
});

describe('getJobPartMaterialCheck', () => {
  it('returns one requirement per BOM line for the job part', async () => {
    const rows = await getJobPartMaterialCheck({
      companyId: 'co1', jobId: 'job0', jobPartId: 'jp0',
      madePartId: 'made1', orderQuantity: 2,
    });
    expect(rows.map((r) => r.partId)).toEqual(['steel', 'oring', 'bolt']);
    expect(rows[0].requiredInStockUnit).toBe(6); // 2 × 3
    expect(rows[0].shortBy).toBe(0); // 15 on hand
  });

  it('returns nothing when the made part has no BOM', async () => {
    tableData.parts_bom = [];
    const rows = await getJobPartMaterialCheck({
      companyId: 'co1', jobId: 'job0', jobPartId: 'jp0',
      madePartId: 'made1', orderQuantity: 2,
    });
    expect(rows).toEqual([]);
  });

  // A child row that can't be read is dropped rather than rendered with invented facts.
  it('skips a BOM line whose child part cannot be resolved', async () => {
    tableData.parts = [];
    const rows = await getJobPartMaterialCheck({
      companyId: 'co1', jobId: 'job0', jobPartId: 'jp0',
      madePartId: 'made1', orderQuantity: 2,
    });
    expect(rows).toEqual([]);
  });
});
