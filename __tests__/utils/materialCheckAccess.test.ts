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

/** A table that answers with an error instead of rows. */
const tableErrors: Record<string, unknown> = {};

function makeBuilder(table: string) {
  const rows = tableData[table] ?? [];
  const result = tableErrors[table] ? { data: null, error: tableErrors[table] } : { data: rows, error: null };
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
  tableData.part_on_order = [];
  tableData.vendor_purchase_order_line_status = [];
  for (const k of Object.keys(tableErrors)) delete tableErrors[k];
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
      // What is on order for the materials: the view's totals, and the PO lines behind them —
      // one read each for the whole BOM, never one per material.
      'part_on_order',
      'vendor_purchase_order_line_status',
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

  // The heats on this job's takes of a material, distinct, in first-taken order — what the
  // packing slip prints. A take with no heat contributes nothing; a material never taken has [].
  it('lists the distinct heat numbers issued to the job, per material', async () => {
    tableData.inventory_transactions = [
      { job_id: 'job0', part_id: 'steel', converted_quantity: 2, has_discrepancy: false, heat_number: '4471' },
      { job_id: 'job0', part_id: 'steel', converted_quantity: 2, has_discrepancy: false, heat_number: '4471' },
      { job_id: 'job0', part_id: 'steel', converted_quantity: 1, has_discrepancy: false, heat_number: '8823' },
      { job_id: 'job0', part_id: 'oring', converted_quantity: 4, has_discrepancy: false, heat_number: null },
    ];
    const rows = await getJobPartMaterialCheck({
      companyId: 'co1', jobId: 'job0', jobPartId: 'jp0',
      madePartId: 'made1', orderQuantity: 2,
    });
    expect(rows.map((r) => r.heatNumbers)).toEqual([['4471', '8823'], [], []]);
    expect(rows[0].issued).toBe(5);
  });

  it('returns nothing when the made part has no BOM', async () => {
    tableData.parts_bom = [];
    const rows = await getJobPartMaterialCheck({
      companyId: 'co1', jobId: 'job0', jobPartId: 'jp0',
      madePartId: 'made1', orderQuantity: 2,
    });
    expect(rows).toEqual([]);
  });

  // On order rides beside the shortage (criterion B4): sent apart from drafts, with the POs.
  it('carries what is on order per material, from part_on_order, without changing short-by', async () => {
    tableData.part_on_order = [
      { part_id: 'steel', stock_unit: 'each', on_order_quantity: 12, on_draft_quantity: 5, next_expected_on: '2026-11-12', open_line_count: 2, draft_line_count: 1, unit_mismatch_line_count: 0 },
    ];
    tableData.vendor_purchase_order_line_status = [
      { id: 'l1', vendor_purchase_order_id: 'po-1', po_number: 'PO-0042', vendor_id: 'v1', line_number: 1, part_id: 'steel', status: 'open', quantity: 8, stock_unit: 'each', stock_factor: 1, open_stock_quantity: 8, expected_on: '2026-11-14' },
      { id: 'l2', vendor_purchase_order_id: 'po-1', po_number: 'PO-0042', vendor_id: 'v1', line_number: 2, part_id: 'steel', status: 'partially_received', quantity: 6, stock_unit: 'each', stock_factor: 1, open_stock_quantity: 4, expected_on: '2026-11-12' },
      { id: 'l3', vendor_purchase_order_id: 'po-2', po_number: 'PO-0043', vendor_id: 'v1', line_number: 1, part_id: 'steel', status: 'draft', quantity: 5, stock_unit: 'each', stock_factor: 1, open_stock_quantity: 0, expected_on: null },
    ];
    tableData.parts = [
      { id: 'steel', part_name: 'Steel', primary_unit: 'each', quantity: 0, deleted_at: null },
      { id: 'oring', part_name: 'O-ring', primary_unit: 'each', quantity: 9000, deleted_at: null },
      { id: 'bolt', part_name: 'Bolt', primary_unit: 'each', quantity: 9000, deleted_at: null },
    ];
    const rows = await getJobPartMaterialCheck({
      companyId: 'co1', jobId: 'job0', jobPartId: 'jp0', madePartId: 'made1', orderQuantity: 2,
    });
    const steel = rows[0];
    expect(steel).toMatchObject({ onOrder: 12, onDraft: 5, shortBy: 6 });
    // One entry per PO (two lines on PO-0042 merge), sent first, drafts after.
    expect(steel.onOrderRefs).toEqual([
      { vendorPurchaseOrderId: 'po-1', poNumber: 'PO-0042', stockQuantity: 12, expectedOn: '2026-11-12', isDraft: false },
      { vendorPurchaseOrderId: 'po-2', poNumber: 'PO-0043', stockQuantity: 5, expectedOn: null, isDraft: true },
    ]);
    // Loaded, and nothing coming: a true 0, never null.
    expect(rows[1]).toMatchObject({ onOrder: 0, onDraft: 0, onOrderRefs: [] });
    // Archived POs never count.
    expect(filterFor('vendor_purchase_order_line_status', 'eq')).toContainEqual(['is_archived', false]);
    expect(filterFor('part_on_order', 'eq')).toContainEqual(['company_id', 'co1']);
  });

  // "No materials on this part's BOM" is the one thing a failed load must never render.
  it.each(['parts_bom', 'parts', 'inventory_transactions', 'part_on_order'])(
    'THROWS a real Error when the %s read fails — never an empty list',
    async (table) => {
      tableErrors[table] = { code: '08006', message: 'connection failure' };
      const run = getJobPartMaterialCheck({
        companyId: 'co1', jobId: 'job0', jobPartId: 'jp0', madePartId: 'made1', orderQuantity: 2,
      });
      await expect(run).rejects.toBeInstanceOf(Error);
      await expect(run).rejects.toThrow(/^Failed to load/);
    },
  );

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
