import { describe, it, expect } from 'vitest';
import {
  autoCreateLinkFor,
  createMissingParents,
  findMissingParents,
  guessKind,
  isAutoCreatable,
  REFERENTIAL_LINKS,
  type AutoCreateLink,
} from '@/lib/dataImportLinks';
import { applyOp, invertOp, type WorkingFile } from '@/lib/dataImportEditing';
import { analyzeBundle } from '@/lib/dataImportAnalyzer';
import { buildImportPlan } from '@/lib/dataImportIngest';
import { workingToAnalyzed } from '@/lib/dataImportEditing';

const wcLink = REFERENTIAL_LINKS.find(
  (l) => l.childEntity === 'routings' && l.parentEntity === 'work_centers',
) as AutoCreateLink;

/** routings name 3 work centers; the work-centers file only has one of them. */
function bundle(): WorkingFile[] {
  return [
    {
      filename: 'routings.csv',
      entityType: 'routings',
      columnRoles: { part_name: 'Part', work_center_name: 'WC' },
      headers: ['Part', 'WC'],
      rows: [
        { __rowId: 'r#0', Part: 'A', WC: 'HAAS VF2' },
        { __rowId: 'r#1', Part: 'A', WC: 'GRIND' },
        { __rowId: 'r#2', Part: 'B', WC: 'grind' }, // same as above, different case
        { __rowId: 'r#3', Part: 'B', WC: 'PerformCoat of Michigan LLC' },
        { __rowId: 'r#4', Part: 'C', WC: '' }, // blank is not a missing reference
      ],
    },
    {
      filename: 'resources.csv',
      entityType: 'work_centers',
      columnRoles: { name: 'Name' },
      headers: ['Name'],
      rows: [{ __rowId: 'w#0', Name: 'HAAS VF2' }],
    },
    {
      filename: 'vendors.csv',
      entityType: 'vendors',
      columnRoles: { name: 'VendName' },
      headers: ['VendName'],
      rows: [{ __rowId: 'v#0', VendName: 'Acme Steel' }],
    },
  ];
}

describe('findMissingParents', () => {
  it('lists distinct unmatched names with reference counts, most-used first', () => {
    expect(findMissingParents(bundle(), wcLink)).toEqual([
      { name: 'GRIND', refCount: 2, kind: 'internal' },
      { name: 'PerformCoat of Michigan LLC', refCount: 1, kind: 'external' },
    ]);
  });

  it('matches the orphan finding it fixes — same normalization, same names', () => {
    const finding = analyzeBundle(workingToAnalyzed(bundle())).find((f) => f.id === 'orphan.routings.work_center_name')!;
    // The finding counts ROWS (3: GRIND x2 + PerformCoat); the fix creates RECORDS (2).
    expect(finding.count).toBe(3);
    expect(findMissingParents(bundle(), wcLink)).toHaveLength(2);
    expect(finding.title).toContain('2 work centers');
    expect(autoCreateLinkFor(finding.id)).toEqual(wcLink);
  });

  it('returns nothing once every reference resolves', () => {
    const w = bundle();
    w[1].rows.push({ __rowId: 'w#1', Name: 'grind' }, { __rowId: 'w#2', Name: 'PerformCoat of Michigan LLC' });
    expect(findMissingParents(w, wcLink)).toEqual([]);
  });
});

describe('guessKind', () => {
  it('reads company-shaped and process-shaped names as outside shops', () => {
    expect(guessKind('PerformCoat of Michigan LLC')).toBe('external');
    expect(guessKind('Thermal One, Inc.')).toBe('external');
    expect(guessKind('Acme Plating')).toBe('external');
  });

  it('reads machine-shaped names as in-house', () => {
    expect(guessKind('HAAS VF2')).toBe('internal');
    expect(guessKind('GRIND')).toBe('internal');
    expect(guessKind('Deburr Bench')).toBe('internal');
  });
});

describe('createMissingParents', () => {
  it('does not auto-create parts — a part needs more than a name', () => {
    const partsLink = REFERENTIAL_LINKS.find((l) => l.childEntity === 'bom' && l.parentEntity === 'parts')!;
    expect(isAutoCreatable(partsLink.parentEntity)).toBe(false);
    expect(autoCreateLinkFor('orphan.bom.child_part_name')).toBeUndefined();
  });

  it('adds the confirmed rows to the owner\'s own work-centers file, and resolves the orphans', () => {
    const w = bundle();
    const op = createMissingParents(w, wcLink, [{ name: 'GRIND', kind: 'internal' }]);
    const next = applyOp(w, op);

    const wc = next.find((f) => f.filename === 'resources.csv')!;
    expect(wc.rows).toHaveLength(2);
    expect(wc.rows[1].Name).toBe('GRIND');
    expect(wc.rows[1].kind).toBe('internal');
    // Both GRIND rows now resolve; only PerformCoat is still missing.
    expect(findMissingParents(next, wcLink).map((m) => m.name)).toEqual(['PerformCoat of Michigan LLC']);
  });

  it('gives an internal work center an EMPTY vendor (the importer rejects one that has a vendor)', () => {
    const w = bundle();
    const next = applyOp(w, createMissingParents(w, wcLink, [{ name: 'GRIND', kind: 'internal' }]));
    const row = next.find((f) => f.filename === 'resources.csv')!.rows[1];
    expect(row.vendor_name ?? '').toBe('');
  });

  it('cascades an outside work center into a matching vendor (the importer requires one)', () => {
    const w = bundle();
    const op = createMissingParents(w, wcLink, [{ name: 'PerformCoat of Michigan LLC', kind: 'external' }]);
    const next = applyOp(w, op);

    const wcRow = next.find((f) => f.filename === 'resources.csv')!.rows[1];
    expect(wcRow.kind).toBe('external');
    expect(wcRow.vendor_name).toBe('PerformCoat of Michigan LLC');

    const vendors = next.find((f) => f.filename === 'vendors.csv')!;
    expect(vendors.rows.map((r) => r.VendName)).toEqual(['Acme Steel', 'PerformCoat of Michigan LLC']);
  });

  it('does not duplicate a vendor that is already there', () => {
    const w = bundle();
    w[2].rows.push({ __rowId: 'v#1', VendName: 'performcoat of michigan llc' }); // same name, different case
    const next = applyOp(w, createMissingParents(w, wcLink, [{ name: 'PerformCoat of Michigan LLC', kind: 'external' }]));
    expect(next.find((f) => f.filename === 'vendors.csv')!.rows).toHaveLength(2);
  });

  it('creates a file when the owner never uploaded one for that entity', () => {
    const w = bundle().filter((f) => f.entityType !== 'work_centers');
    const next = applyOp(w, createMissingParents(w, wcLink, [{ name: 'GRIND', kind: 'internal' }]));

    const created = next.find((f) => f.entityType === 'work_centers')!;
    expect(created.rows).toHaveLength(1);
    expect(created.columnRoles.name).toBeTruthy();
    expect(created.entityConfidence).toBe(1); // the owner asked for these by name
    // With no work-centers file at all, every name was missing; only GRIND was confirmed.
    expect(findMissingParents(next, wcLink).map((m) => m.name)).toEqual(['HAAS VF2', 'PerformCoat of Michigan LLC']);
  });

  it('undoes as one unit — rows, the added column, and a file we introduced', () => {
    const w = bundle();
    const op = createMissingParents(w, wcLink, [
      { name: 'GRIND', kind: 'internal' },
      { name: 'PerformCoat of Michigan LLC', kind: 'external' },
    ]);
    const undone = applyOp(applyOp(w, op), invertOp(op));
    expect(undone).toEqual(w);

    // …and a created file disappears entirely on undo.
    const w2 = bundle().filter((f) => f.entityType !== 'work_centers');
    const op2 = createMissingParents(w2, wcLink, [{ name: 'GRIND', kind: 'internal' }]);
    expect(applyOp(applyOp(w2, op2), invertOp(op2))).toEqual(w2);
  });

  it('redo re-applies the original op', () => {
    const w = bundle();
    const op = createMissingParents(w, wcLink, [{ name: 'GRIND', kind: 'internal' }]);
    const after = applyOp(w, op);
    expect(applyOp(applyOp(applyOp(w, op), invertOp(op)), op)).toEqual(after);
  });

  it('creating nothing is a no-op the wizard can ignore', () => {
    const op = createMissingParents(bundle(), wcLink, []);
    expect(op.edits).toEqual([]);
    expect(op.addRecords ?? []).toEqual([]);
  });
});

describe('created records reach the importer intact', () => {
  it('maps the columns it introduced, so kind/vendor_name arrive as db fields', () => {
    const w = bundle();
    const next = applyOp(
      w,
      createMissingParents(w, wcLink, [
        { name: 'GRIND', kind: 'internal' },
        { name: 'PerformCoat of Michigan LLC', kind: 'external' },
      ]),
    );
    const batch = buildImportPlan(next).find((b) => b.entity === 'work_centers')!;
    // mappings are csv_column -> db_field; the importer reads kind/vendor_name off these.
    expect(batch.mappings).toMatchObject({ Name: 'name', kind: 'kind', vendor_name: 'vendor_name' });

    const grind = batch.rows.find((r) => r.Name === 'GRIND')!;
    expect(grind).toMatchObject({ kind: 'internal', vendor_name: '' });
    expect(grind.__rowId).toBeUndefined(); // internal id never leaves the browser

    const coat = batch.rows.find((r) => r.Name === 'PerformCoat of Michigan LLC')!;
    expect(coat).toMatchObject({ kind: 'external', vendor_name: 'PerformCoat of Michigan LLC' });
  });

  it("writes the cascaded vendor BEFORE the outside work center that needs it", () => {
    const w = bundle();
    const next = applyOp(w, createMissingParents(w, wcLink, [{ name: 'PerformCoat of Michigan LLC', kind: 'external' }]));
    const plan = buildImportPlan(next);
    const vendorAt = plan.findIndex((b) => b.entity === 'vendors');
    const wcAt = plan.findIndex((b) => b.entity === 'work_centers');
    // The importer rejects kind=external unless the vendor already exists.
    expect(vendorAt).toBeGreaterThanOrEqual(0);
    expect(vendorAt).toBeLessThan(wcAt);
  });

  it('a work-centers file we invented still gets planned and written', () => {
    const w = bundle().filter((f) => f.entityType !== 'work_centers');
    const next = applyOp(w, createMissingParents(w, wcLink, [{ name: 'GRIND', kind: 'internal' }]));
    const batch = buildImportPlan(next).find((b) => b.entity === 'work_centers')!;
    // No outside shops among them, so no vendor column is invented either.
    expect(batch.rows).toEqual([{ name: 'GRIND', kind: 'internal' }]);
    expect(batch.mappings).toMatchObject({ name: 'name', kind: 'kind' });
  });
});
