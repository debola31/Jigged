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
}));

import { getJobPartMaterialCheck } from '@/utils/materialCheckAccess';

beforeEach(() => {
  vi.clearAllMocks();
  filters = [];
  fromSpy.mockImplementation((table: string) => makeBuilder(table));

  tableData.parts_bom = [
    { id: 'b1', parent_part_id: 'made1', child_part_id: 'steel', quantity: 3, unit: 'each' },
    { id: 'b2', parent_part_id: 'made1', child_part_id: 'oring', quantity: 4, unit: 'each' },
    { id: 'b3', parent_part_id: 'made1', child_part_id: 'bolt', quantity: 6, unit: 'each' },
  ];
  tableData.parts = [
    { id: 'steel', part_name: 'Steel', primary_unit: 'each', quantity: 15, is_stocked: true, deleted_at: null },
    { id: 'oring', part_name: 'O-ring', primary_unit: 'each', quantity: 9000, is_stocked: true, deleted_at: null },
    { id: 'bolt', part_name: 'Bolt', primary_unit: 'each', quantity: 9000, is_stocked: true, deleted_at: null },
  ];
  tableData.parts_unit_conversions = [];
  tableData.inventory_transactions = [];
});

describe('getJobPartMaterialCheck — request budget', () => {
  /**
   * One request per TABLE, not per BOM line. The shape earns its keep even for a single job
   * part: a naive version would look up each child's stock and conversions individually.
   */
  it('reads one query per table regardless of BOM size', async () => {
    await getJobPartMaterialCheck({
      companyId: 'co1', jobId: 'job0', jobPartId: 'jp0', madePartId: 'made1', orderQuantity: 2,
    });
    expect(fromSpy.mock.calls.map((c) => c[0])).toEqual([
      'parts_bom',
      'parts',
      'inventory_transactions',
      // parts_unit_conversions is skipped — every BOM unit matches its stock unit.
    ]);
  });

  it('reads conversions only for lines whose BOM unit differs from the stock unit', async () => {
    tableData.parts_bom = [
      { id: 'b1', parent_part_id: 'made1', child_part_id: 'steel', quantity: 3, unit: 'feet' },
    ];
    await getJobPartMaterialCheck({
      companyId: 'co1', jobId: 'job0', jobPartId: 'jp0', madePartId: 'made1', orderQuantity: 2,
    });
    expect(fromSpy.mock.calls.map((c) => c[0])).toContain('parts_unit_conversions');
  });

  // An 'addition' or 'adjustment' counted as consumption would understate every shortage.
  it('only counts depletions, never additions or adjustments', async () => {
    await getJobPartMaterialCheck({
      companyId: 'co1', jobId: 'job0', jobPartId: 'jp0', madePartId: 'made1', orderQuantity: 2,
    });
    expect(filterFor('inventory_transactions', 'eq')).toContainEqual(['type', 'depletion']);
    expect(filterFor('inventory_transactions', 'eq')).toContainEqual(['company_id', 'co1']);
  });

  // Neither surface renders where stock sits, so bin balances and the location tree are never
  // read — see docs/modules/inventory.md J7 for why the operator take action went away.
  it('never reads bin balances or the location tree', async () => {
    await getJobPartMaterialCheck({
      companyId: 'co1', jobId: 'job0', jobPartId: 'jp0', madePartId: 'made1', orderQuantity: 2,
    });
    const tables = fromSpy.mock.calls.map((c) => c[0]);
    expect(tables).not.toContain('part_location_stock');
    expect(tables).not.toContain('inventory_locations');
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
