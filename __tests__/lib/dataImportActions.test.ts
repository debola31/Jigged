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

describe('mergeVariants cascades a rename into referencing files', () => {
  // parts + bom + routings, where bom/routings reference parts by name. Two part-name spellings
  // ("BRKT-100" / "BRKT100") should merge into one WITHOUT orphaning the rows that used the old
  // spelling — the "optional cleanup manufactures blocking errors" regression.
  const bundle = () =>
    buildWorkingFiles(
      [
        { filename: 'parts.csv', headers: ['Part', 'UoM'], rows: [
          { Part: 'BRKT-100', UoM: 'each' },
          { Part: 'BRKT100', UoM: 'each' },
          { Part: 'SPCR-22', UoM: 'each' },
        ] },
        { filename: 'bom.csv', headers: ['Parent', 'Child', 'Qty', 'U'], rows: [
          { Parent: 'BRKT100', Child: 'SPCR-22', Qty: '2', U: 'each' }, // parent uses the merged-away spelling
        ] },
        { filename: 'routings.csv', headers: ['Part', 'WC'], rows: [
          { Part: 'BRKT100', WC: 'MILL' }, // routing uses the merged-away spelling
        ] },
      ],
      [
        { filename: 'parts.csv', entity_type: 'parts', entity_confidence: 1, headers: ['Part', 'UoM'], row_count: 3,
          column_roles: { part_name: 'Part', primary_unit: 'UoM' } },
        { filename: 'bom.csv', entity_type: 'bom', entity_confidence: 1, headers: ['Parent', 'Child', 'Qty', 'U'], row_count: 1,
          column_roles: { parent_part_name: 'Parent', child_part_name: 'Child', quantity: 'Qty', unit: 'U' } },
        { filename: 'routings.csv', entity_type: 'routings', entity_confidence: 1, headers: ['Part', 'WC'], row_count: 1,
          column_roles: { part_name: 'Part', work_center_name: 'WC' } },
      ],
    );

  it('rewrites the BOM and routing references to the canonical part name', () => {
    const w = bundle();
    const next = applyOp(w, mergeVariants(w, 0, 'Part', 'BRKT-100', ['BRKT100']));
    expect(next[0].rows.map((r) => r.Part)).toEqual(['BRKT-100', 'BRKT-100', 'SPCR-22']);
    expect(next[1].rows[0].Parent).toBe('BRKT-100'); // bom parent followed the rename
    expect(next[2].rows[0].Part).toBe('BRKT-100'); // routing part followed the rename
  });

  it('does not manufacture a new orphan finding (the whole point)', () => {
    const w = bundle();
    const before = analyzeBundle(workingToAnalyzed(w)).filter((f) => f.category === 'orphan_reference');
    expect(before).toHaveLength(0); // clean to start
    const next = applyOp(w, mergeVariants(w, 0, 'Part', 'BRKT-100', ['BRKT100']));
    const after = analyzeBundle(workingToAnalyzed(next)).filter((f) => f.category === 'orphan_reference');
    expect(after).toHaveLength(0); // still clean — the merge didn't break references
  });

  it('undoes the cascade as one unit', () => {
    const w = bundle();
    const op = mergeVariants(w, 0, 'Part', 'BRKT-100', ['BRKT100']);
    const restored = applyOp(applyOp(w, op), invertOp(op));
    expect(restored[1].rows[0].Parent).toBe('BRKT100');
    expect(restored[2].rows[0].Part).toBe('BRKT100');
  });
});
