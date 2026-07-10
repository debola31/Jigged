import { describe, it, expect } from 'vitest';
import { bulkReplace, fillBlanks, findVariantGroups, mergeVariants } from '@/lib/dataImportActions';
import { applyOp, buildWorkingFiles, invertOp, workingToAnalyzed } from '@/lib/dataImportEditing';
import { analyzeBundle } from '@/lib/dataImportAnalyzer';
import type { FileClassification, UploadedFilePayload } from '@/types/data-import';

const FILES: UploadedFilePayload[] = [
  {
    filename: 'vendors.csv',
    headers: ['Name', 'Terms'],
    rows: [
      { Name: 'Acme', Terms: 'Net 30' },
      { Name: 'ACME', Terms: '' },
      { Name: 'Acme Inc', Terms: '' },
      { Name: 'Beta LLC', Terms: 'Net 45' },
    ],
  },
];

const STRUCTURE: FileClassification[] = [
  {
    filename: 'vendors.csv',
    entity_type: 'vendors',
    entity_confidence: 0.9,
    headers: ['Name', 'Terms'],
    row_count: 4,
    column_roles: { name: 'Name' },
  },
];

const build = () => buildWorkingFiles(FILES, STRUCTURE);

describe('bulkReplace', () => {
  it('substring-replaces across a column and only touches changed cells', () => {
    const op = bulkReplace(build(), 0, 'Terms', 'Net', 'NET');
    expect(op.edits).toHaveLength(2); // the two "Net …" rows; blanks untouched
    const next = applyOp(build(), op);
    expect(next[0].rows.map((r) => r.Terms)).toEqual(['NET 30', '', '', 'NET 45']);
  });

  it('whole-cell mode replaces only exact matches', () => {
    const op = bulkReplace(build(), 0, 'Terms', 'Net 30', 'NET30', { wholeCell: true });
    expect(op.edits).toHaveLength(1);
    expect(applyOp(build(), op)[0].rows[0].Terms).toBe('NET30');
  });
});

describe('fillBlanks', () => {
  it('fills only blank cells', () => {
    const op = fillBlanks(build(), 0, 'Terms', 'Net 30');
    expect(op.edits).toHaveLength(2); // the two blank Terms rows
    expect(applyOp(build(), op)[0].rows.map((r) => r.Terms)).toEqual([
      'Net 30',
      'Net 30',
      'Net 30',
      'Net 45',
    ]);
  });

  it('is a no-op when the fill value is empty', () => {
    expect(fillBlanks(build(), 0, 'Terms', '').edits).toHaveLength(0);
  });
});

describe('findVariantGroups', () => {
  it('clusters spellings that normalize together, ignoring singletons', () => {
    const groups = findVariantGroups(build()[0], 'Name');
    expect(groups).toHaveLength(1); // acme cluster; "Beta LLC" is alone
    expect(groups[0].variants.map((v) => v.value).sort()).toEqual(['ACME', 'Acme', 'Acme Inc']);
  });
});

describe('mergeVariants', () => {
  it('rewrites variant spellings to the canonical value and collapses the group', () => {
    const op = mergeVariants(build(), 0, 'Name', 'Acme', ['ACME', 'Acme Inc', 'Acme']);
    expect(op.edits).toHaveLength(2); // ACME + Acme Inc change; Acme already canonical
    const merged = applyOp(build(), op);
    expect(merged[0].rows.map((r) => r.Name)).toEqual(['Acme', 'Acme', 'Acme', 'Beta LLC']);
    expect(findVariantGroups(merged[0], 'Name')).toHaveLength(0); // collapsed
  });

  it('clears the name-variant finding (a merge changes the review)', () => {
    const before = analyzeBundle(workingToAnalyzed(build()));
    expect(before.some((f) => f.category === 'name_variant')).toBe(true);

    const op = mergeVariants(build(), 0, 'Name', 'Acme', ['ACME', 'Acme Inc']);
    const after = analyzeBundle(workingToAnalyzed(applyOp(build(), op)));
    expect(after.some((f) => f.category === 'name_variant')).toBe(false);
  });
});

describe('EditOp is reversible as a unit', () => {
  it('apply → invert → apply restores the original', () => {
    const working = build();
    const op = mergeVariants(working, 0, 'Name', 'Acme', ['ACME', 'Acme Inc']);
    const merged = applyOp(working, op);
    const restored = applyOp(merged, invertOp(op));
    expect(restored[0].rows.map((r) => r.Name)).toEqual(working[0].rows.map((r) => r.Name));
  });
});
