import { describe, it, expect } from 'vitest';
import {
  applyEdit,
  buildWorkingFiles,
  invertEdit,
  setWorkingEntity,
  setWorkingRole,
  workingToAnalyzed,
  workingToClassification,
  type CellEdit,
} from '@/lib/dataImportEditing';
import { analyzeBundle } from '@/lib/dataImportAnalyzer';
import type { FileClassification, UploadedFilePayload } from '@/types/data-import';

const FILES: UploadedFilePayload[] = [
  {
    filename: 'parts.csv',
    headers: ['PartNo', 'Vendor'],
    rows: [
      { PartNo: 'A', Vendor: 'Acme' },
      { PartNo: 'B', Vendor: 'Ghost' },
    ],
  },
  { filename: 'vendors.csv', headers: ['VendName'], rows: [{ VendName: 'Acme' }] },
];

const STRUCTURE: FileClassification[] = [
  {
    filename: 'parts.csv',
    entity_type: 'parts',
    entity_confidence: 0.9,
    headers: ['PartNo', 'Vendor'],
    row_count: 2,
    column_roles: { part_name: 'PartNo', preferred_vendor_name: 'Vendor' },
  },
  {
    filename: 'vendors.csv',
    entity_type: 'vendors',
    entity_confidence: 0.9,
    headers: ['VendName'],
    row_count: 1,
    column_roles: { name: 'VendName' },
  },
];

describe('buildWorkingFiles', () => {
  it('attaches entity type, column roles, and stable row ids', () => {
    const working = buildWorkingFiles(FILES, STRUCTURE);
    expect(working[0].entityType).toBe('parts');
    expect(working[0].columnRoles.preferred_vendor_name).toBe('Vendor');
    expect(working[0].rows[0].__rowId).toBe('parts.csv#0');
    expect(working[0].rows[1].__rowId).toBe('parts.csv#1');
  });

  it('defaults to unknown entity when a file was not classified', () => {
    const working = buildWorkingFiles([FILES[0]], []);
    expect(working[0].entityType).toBe('unknown');
    expect(working[0].columnRoles).toEqual({});
  });
});

describe('applyEdit / invertEdit', () => {
  const working = buildWorkingFiles(FILES, STRUCTURE);
  const edit: CellEdit = { fileIndex: 0, rowId: 'parts.csv#1', colId: 'Vendor', oldValue: 'Ghost', newValue: 'Acme' };

  it('updates only the targeted cell and is immutable', () => {
    const next = applyEdit(working, edit);
    expect(next[0].rows[1].Vendor).toBe('Acme');
    expect(next[0].rows[0].Vendor).toBe('Acme'); // untouched row keeps its value
    expect(working[0].rows[1].Vendor).toBe('Ghost'); // original unchanged
    expect(next[1]).toBe(working[1]); // other files kept by reference
  });

  it('invertEdit swaps old/new for undo', () => {
    expect(invertEdit(edit)).toMatchObject({ oldValue: 'Acme', newValue: 'Ghost' });
  });
});

describe('the fix → re-analyze loop', () => {
  it('resolving an orphan by editing a cell clears the finding', () => {
    const working = buildWorkingFiles(FILES, STRUCTURE);

    const before = analyzeBundle(workingToAnalyzed(working));
    expect(before.some((f) => f.id === 'orphan.parts.preferred_vendor_name')).toBe(true);

    // Fix "Ghost" (which has no matching vendor) to "Acme" (which does).
    const next = applyEdit(working, {
      fileIndex: 0,
      rowId: 'parts.csv#1',
      colId: 'Vendor',
      oldValue: 'Ghost',
      newValue: 'Acme',
    });

    const after = analyzeBundle(workingToAnalyzed(next));
    expect(after.some((f) => f.id === 'orphan.parts.preferred_vendor_name')).toBe(false);
  });

  it('undo restores the finding', () => {
    const working = buildWorkingFiles(FILES, STRUCTURE);
    const edit: CellEdit = { fileIndex: 0, rowId: 'parts.csv#1', colId: 'Vendor', oldValue: 'Ghost', newValue: 'Acme' };
    const fixed = applyEdit(working, edit);
    const undone = applyEdit(fixed, invertEdit(edit));
    const findings = analyzeBundle(workingToAnalyzed(undone));
    expect(findings.some((f) => f.id === 'orphan.parts.preferred_vendor_name')).toBe(true);
  });
});

describe('Map stage helpers', () => {
  it('setWorkingEntity re-classifies one file immutably', () => {
    const working = buildWorkingFiles(FILES, STRUCTURE);
    const next = setWorkingEntity(working, 1, 'customers');
    expect(next[1].entityType).toBe('customers');
    expect(working[1].entityType).toBe('vendors'); // original unchanged
    expect(next[0]).toBe(working[0]); // other files kept by reference
  });

  it('setWorkingRole sets and clears a column mapping immutably', () => {
    const working = buildWorkingFiles(FILES, STRUCTURE);
    const set = setWorkingRole(working, 0, 'preferred_vendor_name', 'PartNo');
    expect(set[0].columnRoles.preferred_vendor_name).toBe('PartNo');
    expect(working[0].columnRoles.preferred_vendor_name).toBe('Vendor'); // original unchanged

    const cleared = setWorkingRole(working, 0, 'preferred_vendor_name', '');
    expect('preferred_vendor_name' in cleared[0].columnRoles).toBe(false);
  });

  it('workingToClassification snapshots the confirmed mapping (confidence = 1)', () => {
    const working = buildWorkingFiles(FILES, STRUCTURE);
    const fc = workingToClassification(working);
    expect(fc[0]).toMatchObject({
      filename: 'parts.csv',
      entity_type: 'parts',
      entity_confidence: 1,
      row_count: 2,
    });
    expect(fc[0].column_roles.part_name).toBe('PartNo');
  });
});

describe('the map → re-analyze loop', () => {
  it('clearing the vendor mapping stops the orphan check (a correction changes the review)', () => {
    const working = buildWorkingFiles(FILES, STRUCTURE);
    // "Ghost" has no matching vendor -> orphan finding present while the mapping stands.
    expect(
      analyzeBundle(workingToAnalyzed(working)).some((f) => f.id === 'orphan.parts.preferred_vendor_name'),
    ).toBe(true);

    // Owner: "that column isn't the vendor" -> clear the role; the orphan check can't run.
    const next = setWorkingRole(working, 0, 'preferred_vendor_name', '');
    expect(
      analyzeBundle(workingToAnalyzed(next)).some((f) => f.id === 'orphan.parts.preferred_vendor_name'),
    ).toBe(false);
  });

  it('re-classifying a file changes which entity checks run', () => {
    const working = buildWorkingFiles(FILES, STRUCTURE);
    const reclassified = setWorkingEntity(working, 0, 'unknown');
    // parts.csv is no longer "parts", so the parts orphan check no longer applies.
    expect(
      analyzeBundle(workingToAnalyzed(reclassified)).some(
        (f) => f.id === 'orphan.parts.preferred_vendor_name',
      ),
    ).toBe(false);
  });
});
