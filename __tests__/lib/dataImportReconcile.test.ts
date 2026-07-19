import { describe, it, expect } from 'vitest';
import { reconcile, filterWorkingByMode, type ExistingIdentities } from '@/lib/dataImportReconcile';
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

const working = [
  wf('vendors.csv', 'vendors', { name: 'Name' }, [{ Name: 'Acme' }, { Name: 'Beta' }, { Name: 'Gamma' }]),
];
const existing: ExistingIdentities = { vendors: new Set(['acme']) }; // normalized

describe('reconcile', () => {
  it('buckets rows as new vs already-in-Jigged by normalized identity', () => {
    const r = reconcile(working, existing);
    expect(r.byEntity[0]).toMatchObject({ entity: 'vendors', newCount: 2, matchedCount: 1 });
    expect(r.totalNew).toBe(2);
    expect(r.totalMatched).toBe(1);
    expect(r.hasExisting).toBe(true);
  });

  it('empty existing → everything new, hasExisting false', () => {
    const r = reconcile(working, {});
    expect(r.totalNew).toBe(3);
    expect(r.totalMatched).toBe(0);
    expect(r.hasExisting).toBe(false);
  });
});

describe('filterWorkingByMode', () => {
  it('create keeps only new rows', () => {
    expect(filterWorkingByMode(working, existing, 'create')[0].rows.map((r) => r.Name)).toEqual([
      'Beta',
      'Gamma',
    ]);
  });

  it('update keeps only rows that already exist', () => {
    expect(filterWorkingByMode(working, existing, 'update')[0].rows.map((r) => r.Name)).toEqual(['Acme']);
  });

  it('both returns the working set unchanged', () => {
    expect(filterWorkingByMode(working, existing, 'both')).toBe(working);
  });

  it('passes non-reconcilable entities (bom/routings) through untouched', () => {
    const bom = [wf('bom.csv', 'bom', { parent_part_name: 'P', child_part_name: 'C' }, [{ P: 'A', C: 'B' }])];
    expect(filterWorkingByMode(bom, {}, 'create')[0].rows).toHaveLength(1);
  });
});
