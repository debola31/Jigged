import { describe, it, expect } from 'vitest';
import { rowsAtRisk, losses, lossPhrase } from '@/lib/dataImportImpact';
import type { WorkingFile } from '@/lib/dataImportEditing';

const partsFile = (rows: Record<string, string>[]): WorkingFile => ({
  filename: 'parts.csv',
  entityType: 'parts',
  columnRoles: { part_name: 'Part', primary_unit: 'UoM', preferred_vendor_name: 'Vend' },
  headers: ['Part', 'UoM', 'Vend'],
  rows: rows.map((r, i) => ({ ...r, __rowId: `parts.csv#${i}` })),
});

const vendorsFile = (names: string[]): WorkingFile => ({
  filename: 'vendors.csv',
  entityType: 'vendors',
  columnRoles: { name: 'Name' },
  headers: ['Name'],
  rows: names.map((n, i) => ({ Name: n, __rowId: `vendors.csv#${i}` })),
});

const at = (impact: ReturnType<typeof rowsAtRisk>, e: string) => impact.find((i) => i.entityType === e)!;

describe('rowsAtRisk — a blank required field costs the row', () => {
  it('counts rows with no unit of measure (the DB rejects them outright)', () => {
    const w = [
      partsFile([
        { Part: 'A', UoM: 'EA', Vend: '' },
        { Part: 'B', UoM: '', Vend: '' }, // no unit
        { Part: 'C', UoM: '   ', Vend: '' }, // whitespace is still blank
      ]),
    ];
    expect(at(rowsAtRisk(w), 'parts')).toMatchObject({ total: 3, lost: 2 });
  });

  it('counts every row when the required column was never mapped at all', () => {
    const w: WorkingFile[] = [
      {
        filename: 'parts.csv',
        entityType: 'parts',
        columnRoles: { part_name: 'Part' }, // no unit column
        headers: ['Part'],
        rows: [
          { Part: 'A', __rowId: 'p#0' },
          { Part: 'B', __rowId: 'p#1' },
        ],
      },
    ];
    expect(at(rowsAtRisk(w), 'parts')).toMatchObject({ total: 2, lost: 2 });
  });
});

describe('rowsAtRisk — an unresolvable reference costs the row', () => {
  it('counts parts naming a vendor that was never uploaded', () => {
    const w = [
      partsFile([
        { Part: 'A', UoM: 'EA', Vend: 'Acme Steel' },
        { Part: 'B', UoM: 'EA', Vend: 'Ghost Supply' }, // no such vendor
      ]),
      vendorsFile(['Acme Steel']),
    ];
    expect(at(rowsAtRisk(w), 'parts')).toMatchObject({ total: 2, lost: 1 });
  });

  it('matches vendors the way the importer does — case and spacing insensitive', () => {
    const w = [
      partsFile([{ Part: 'A', UoM: 'EA', Vend: '  acme steel ' }]),
      vendorsFile(['Acme Steel']),
    ];
    expect(at(rowsAtRisk(w), 'parts').lost).toBe(0);
  });

  it('a blank reference is not a broken one', () => {
    const w = [partsFile([{ Part: 'A', UoM: 'EA', Vend: '' }]), vendorsFile(['Acme Steel'])];
    expect(at(rowsAtRisk(w), 'parts').lost).toBe(0);
  });

  it('claims no loss when the parent file was never uploaded — we cannot judge', () => {
    // The analyzer raises `not_checked` for this; inventing a loss here would put a
    // number on the screen we can't stand behind.
    const w = [partsFile([{ Part: 'A', UoM: 'EA', Vend: 'Some Vendor' }])];
    expect(at(rowsAtRisk(w), 'parts').lost).toBe(0);
  });
});

describe('rowsAtRisk — one row lost is one row', () => {
  it('does not double-count a row that fails for two reasons at once', () => {
    const w = [
      partsFile([
        { Part: 'A', UoM: '', Vend: 'Ghost Supply' }, // no unit AND unknown vendor
        { Part: 'B', UoM: 'EA', Vend: 'Acme Steel' },
      ]),
      vendorsFile(['Acme Steel']),
    ];
    // Summing finding counts would say 2 lost. It's 1 row.
    expect(at(rowsAtRisk(w), 'parts')).toMatchObject({ total: 2, lost: 1 });
  });

  it('ignores files we could not identify', () => {
    const w: WorkingFile[] = [
      { filename: 'mystery.csv', entityType: 'unknown', columnRoles: {}, headers: ['X'], rows: [{ X: '1', __rowId: 'm#0' }] },
    ];
    expect(rowsAtRisk(w)).toEqual([]);
  });
});

describe('losses / lossPhrase', () => {
  it('drops entities that lose nothing and orders by the biggest loss', () => {
    const impact = [
      { entityType: 'routings' as const, label: 'routing steps', total: 18639, lost: 6565 },
      { entityType: 'vendors' as const, label: 'vendors', total: 214, lost: 0 },
      { entityType: 'parts' as const, label: 'parts', total: 8393, lost: 7672 },
    ];
    expect(losses(impact).map((i) => i.entityType)).toEqual(['parts', 'routings']);
    expect(lossPhrase(impact)).toBe('7,672 parts and 6,565 routing steps');
  });

  it('is empty when nothing is lost, so the view can say "everything will come in"', () => {
    expect(lossPhrase([{ entityType: 'parts', label: 'parts', total: 10, lost: 0 }])).toBe('');
  });
});
