import { describe, it, expect, vi } from 'vitest';
import { buildImportPlan, runImportPlan, summarizeResults, type ImportProgress } from '@/lib/dataImportIngest';
import type { EditableRow, WorkingFile } from '@/lib/dataImportEditing';
import type { EntityType } from '@/types/data-import';

function wf(
  filename: string,
  entityType: EntityType,
  columnRoles: Record<string, string>,
  rows: Record<string, string>[],
): WorkingFile {
  return {
    filename,
    entityType,
    columnRoles,
    headers: Object.keys(rows[0] ?? {}),
    rows: rows.map((r, i) => ({ ...r, __rowId: `${filename}#${i}` }) as EditableRow),
  };
}

describe('buildImportPlan', () => {
  it('orders by dependency tier, inverts columnRoles, strips __rowId, skips unknown', () => {
    const working = [
      wf('bom.csv', 'bom', { parent_part_name: 'Parent', child_part_name: 'Child' }, [
        { Parent: 'A', Child: 'B' },
      ]),
      wf('parts.csv', 'parts', { part_name: 'PN' }, [{ PN: 'A' }]),
      wf('vendors.csv', 'vendors', { name: 'V' }, [{ V: 'Acme' }]),
      wf('mystery.csv', 'unknown', {}, [{ X: '1' }]),
    ];
    const plan = buildImportPlan(working);

    expect(plan.map((b) => b.entity)).toEqual(['vendors', 'parts', 'bom']); // ordered; unknown skipped

    const parts = plan.find((b) => b.entity === 'parts')!;
    expect(parts.endpoint).toBe('/api/parts/import/execute');
    expect(parts.mappings).toEqual({ PN: 'part_name' }); // canonical->raw inverted to raw->canonical
    expect(parts.rows).toEqual([{ PN: 'A' }]); // __rowId stripped
    expect(parts.extra).toEqual({ pricing_columns: [] }); // parts-only required extra
    expect(plan.find((b) => b.entity === 'vendors')!.extra).toEqual({});
  });

  it('splits into ≤500-row batches', () => {
    const rows = Array.from({ length: 501 }, (_, i) => ({ V: `v${i}` }));
    const plan = buildImportPlan([wf('vendors.csv', 'vendors', { name: 'V' }, rows)]);
    expect(plan).toHaveLength(2);
    expect(plan[0].rows).toHaveLength(500);
    expect(plan[1].rows).toHaveLength(1);
    expect(plan[0].batchCount).toBe(2);
    expect(plan[1].batchIndex).toBe(1);
  });
});

describe('summarizeResults', () => {
  it('aggregates created/updated/skipped/errors and flags failures', () => {
    const s = summarizeResults([
      { entity: 'vendors', response: { imported_count: 3, skipped_count: 1, errors: [] } },
      { entity: 'parts', response: { imported_count: 10, updated_count: 2, skipped_count: 0, errors: ['x'] } },
      { entity: 'routings', response: { imported_operations_count: 7, skipped_count: 0 } },
      { entity: 'bom', response: null }, // a batch threw
    ]);
    expect(s.totalCreated).toBe(20); // 3 + 10 + 7 (routings uses imported_operations_count)
    expect(s.totalUpdated).toBe(2);
    expect(s.totalSkipped).toBe(1);
    expect(s.totalErrors).toBe(2); // parts 1 error + bom null-batch 1
    expect(s.failed).toBe(true);
  });
});

describe('runImportPlan — progress', () => {
  const bundle = () => [
    wf('vendors.csv', 'vendors', { name: 'V' }, Array.from({ length: 3 }, (_, i) => ({ V: `v${i}` }))),
    wf('parts.csv', 'parts', { part_name: 'PN' }, Array.from({ length: 501 }, (_, i) => ({ PN: `p${i}` }))),
  ];

  it('emits a determinate, monotonic progress stream that ends at 100%', async () => {
    const plan = buildImportPlan(bundle()); // vendors(1 batch, 3) + parts(2 batches: 500 + 1)
    const seen: ImportProgress[] = [];
    const post = vi.fn().mockResolvedValue({ imported_count: 1 });

    await runImportPlan(plan, 'co', post, (p) => seen.push(structuredClone(p)));

    const last = seen[seen.length - 1];
    expect(last.rowsTotal).toBe(504);
    expect(last.rowsDone).toBe(504); // everything accounted for
    expect(last.batchesDone).toBe(3);
    expect(last.currentEntity).toBeNull(); // final tick signals done
    // rowsDone never goes backwards.
    const rows = seen.map((p) => p.rowsDone);
    expect(rows).toEqual([...rows].sort((a, b) => a - b));
  });

  it('tracks per-entity totals + completion for the stage checklist', async () => {
    const plan = buildImportPlan(bundle());
    const seen: ImportProgress[] = [];
    await runImportPlan(plan, 'co', vi.fn().mockResolvedValue({}), (p) => seen.push(structuredClone(p)));

    const final = seen[seen.length - 1].entities;
    expect(final).toEqual([
      { entity: 'vendors', rowsTotal: 3, rowsDone: 3, rowsFailed: 0 },
      { entity: 'parts', rowsTotal: 501, rowsDone: 501, rowsFailed: 0 },
    ]);
    // The stages complete in write order: vendors reaches 100% before parts finishes.
    const vendorsDoneAt = seen.findIndex((p) => p.entities[0].rowsDone === 3);
    const partsDoneAt = seen.findIndex((p) => (p.entities[1]?.rowsDone ?? 0) === 501);
    expect(vendorsDoneAt).toBeLessThan(partsDoneAt);
  });

  it('records rowsFailed per entity when a batch throws (surfaces a failed stage)', async () => {
    const plan = buildImportPlan(bundle());
    // Fail every parts batch; vendors succeed.
    const post = vi.fn().mockImplementation((endpoint: string) =>
      endpoint.includes('parts') ? Promise.reject(new Error('500')) : Promise.resolve({ imported_count: 1 }),
    );
    const seen: ImportProgress[] = [];
    await runImportPlan(plan, 'co', post, (p) => seen.push(structuredClone(p)));

    const final = seen[seen.length - 1].entities;
    expect(final.find((e) => e.entity === 'vendors')).toMatchObject({ rowsFailed: 0, rowsDone: 3 });
    expect(final.find((e) => e.entity === 'parts')).toMatchObject({ rowsFailed: 501, rowsDone: 501 });
    // The bar still advanced through the failed batches (attempted rows) — no stall.
    expect(seen[seen.length - 1].rowsDone).toBe(504);
  });
});
