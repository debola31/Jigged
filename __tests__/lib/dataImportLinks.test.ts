import { describe, it, expect } from 'vitest';
import {
  autoCreateLinkFor,
  createMissingParents,
  findMissingParents,
  isAutoCreatable,
  REFERENTIAL_LINKS,
  type AutoCreateLink,
} from '@/lib/dataImportLinks';
import { applyOp, invertOp, type WorkingFile } from '@/lib/dataImportEditing';
import { analyzeBundle } from '@/lib/dataImportAnalyzer';
import { buildImportPlan, WRITE_TIERS } from '@/lib/dataImportIngest';
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
      { name: 'GRIND', refCount: 2 },
      { name: 'PerformCoat of Michigan LLC', refCount: 1 },
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

/*
 * `guessKind` had two tests here, and they passed: the regex really did read
 * "PerformCoat of Michigan LLC" as an outside shop. What it could not do was
 * tell a PROCESS from a SUPPLIER — it guessed the entity from the string and
 * then created a vendor of the same name to hang the work centre on, which is
 * precisely how production ended up with 32 of 38 outsourced rows named after
 * their own vendor. The heuristic is deleted; a vendor service names its vendor
 * explicitly, so there is nothing left to guess.
 */

describe('createMissingParents', () => {
  it('does not auto-create parts — a part needs more than a name', () => {
    const partsLink = REFERENTIAL_LINKS.find((l) => l.childEntity === 'bom' && l.parentEntity === 'parts')!;
    expect(isAutoCreatable(partsLink.parentEntity)).toBe(false);
    expect(autoCreateLinkFor('orphan.bom.child_part_name')).toBeUndefined();
  });

  it('adds the confirmed rows to the owner\'s own work-centers file, and resolves the orphans', () => {
    const w = bundle();
    const op = createMissingParents(w, wcLink, [{ name: 'GRIND' }]);
    const next = applyOp(w, op);

    const wc = next.find((f) => f.filename === 'resources.csv')!;
    expect(wc.rows).toHaveLength(2);
    expect(wc.rows[1].Name).toBe('GRIND');
    // Both GRIND rows now resolve; only PerformCoat is still missing.
    expect(findMissingParents(next, wcLink).map((m) => m.name)).toEqual(['PerformCoat of Michigan LLC']);
  });

  it('creates a work center and NOTHING else — no vendor cascade', () => {
    // Confirming a missing work centre used to mint a same-named vendor too,
    // because the old importer rejected kind='external' without one. One
    // confirmation now creates one kind of thing; an outsourced process is
    // imported as a vendor service, naming its vendor.
    const w = bundle();
    const op = createMissingParents(w, wcLink, [{ name: 'PerformCoat of Michigan LLC' }]);
    const next = applyOp(w, op);

    const wcRow = next.find((f) => f.filename === 'resources.csv')!.rows[1];
    expect(wcRow.Name).toBe('PerformCoat of Michigan LLC');
    expect(wcRow.kind).toBeUndefined();
    expect(wcRow.vendor_name).toBeUndefined();

    const vendors = next.find((f) => f.filename === 'vendors.csv')!;
    expect(vendors.rows.map((r) => r.VendName)).toEqual(['Acme Steel']);
  });

  it('creates a file when the owner never uploaded one for that entity', () => {
    const w = bundle().filter((f) => f.entityType !== 'work_centers');
    const next = applyOp(w, createMissingParents(w, wcLink, [{ name: 'GRIND' }]));

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
      { name: 'GRIND' },
      { name: 'PerformCoat of Michigan LLC' },
    ]);
    const undone = applyOp(applyOp(w, op), invertOp(op));
    expect(undone).toEqual(w);

    // …and a created file disappears entirely on undo.
    const w2 = bundle().filter((f) => f.entityType !== 'work_centers');
    const op2 = createMissingParents(w2, wcLink, [{ name: 'GRIND' }]);
    expect(applyOp(applyOp(w2, op2), invertOp(op2))).toEqual(w2);
  });

  it('redo re-applies the original op', () => {
    const w = bundle();
    const op = createMissingParents(w, wcLink, [{ name: 'GRIND' }]);
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
  it('maps only the name — there is no kind or vendor column to introduce', () => {
    const w = bundle();
    const next = applyOp(
      w,
      createMissingParents(w, wcLink, [
        { name: 'GRIND' },
        { name: 'PerformCoat of Michigan LLC' },
      ]),
    );
    const batch = buildImportPlan(next).find((b) => b.entity === 'work_centers')!;
    // mappings are csv_column -> db_field.
    expect(batch.mappings).toMatchObject({ Name: 'name' });
    expect(batch.mappings).not.toHaveProperty('kind');
    expect(batch.mappings).not.toHaveProperty('vendor_name');

    const grind = batch.rows.find((r) => r.Name === 'GRIND')!;
    expect(grind.kind).toBeUndefined();
    expect(grind.vendor_name).toBeUndefined();
    expect(grind.__rowId).toBeUndefined(); // internal id never leaves the browser
  });

  it('plans vendor services after vendors, because each one names a vendor', () => {
    // The vendor cascade is gone, but the ORDERING constraint moved rather than
    // disappeared: a vendor service references a vendor that must already exist,
    // so it sits in its own tier behind vendors.
    const tiers = WRITE_TIERS;
    const vendorTier = tiers.findIndex((t) => t.includes('vendors'));
    const serviceTier = tiers.findIndex((t) => t.includes('vendor_services'));
    expect(vendorTier).toBeGreaterThanOrEqual(0);
    expect(serviceTier).toBeGreaterThan(vendorTier);
  });

  it('a work-centers file we invented still gets planned and written', () => {
    const w = bundle().filter((f) => f.entityType !== 'work_centers');
    const next = applyOp(w, createMissingParents(w, wcLink, [{ name: 'GRIND' }]));
    const batch = buildImportPlan(next).find((b) => b.entity === 'work_centers')!;
    expect(batch.rows).toEqual([{ name: 'GRIND' }]);
    expect(batch.mappings).toMatchObject({ name: 'name' });
  });
});
