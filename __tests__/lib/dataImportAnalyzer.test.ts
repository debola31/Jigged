import { describe, it, expect } from 'vitest';
import { analyzeBundle, type AnalyzedFile } from '@/lib/dataImportAnalyzer';
import type { EntityType, Finding } from '@/types/data-import';

function af(
  filename: string,
  entityType: EntityType,
  columnRoles: Record<string, string>,
  rows: Record<string, string>[],
  headers?: string[],
): AnalyzedFile {
  return {
    filename,
    entityType,
    columnRoles,
    rows,
    headers: headers ?? (rows[0] ? Object.keys(rows[0]) : []),
  };
}

const byCat = (findings: Finding[], category: string) => findings.filter((f) => f.category === category);
const ids = (findings: Finding[]) => new Set(findings.map((f) => f.id));

describe('record counts', () => {
  it('one per file with row count', () => {
    const parts = af('parts.csv', 'parts', { part_name: 'PartNo' }, [{ PartNo: 'A' }, { PartNo: 'B' }]);
    const counts = byCat(analyzeBundle([parts]), 'record_count');
    expect(counts).toHaveLength(1);
    expect(counts[0].count).toBe(2);
    expect(counts[0].severity).toBe('info');
  });
});

describe('within-file duplicates', () => {
  it('is case- and space-insensitive', () => {
    const parts = af('parts.csv', 'parts', { part_name: 'PartNo' }, [
      { PartNo: 'Widget' }, { PartNo: ' widget ' }, { PartNo: 'Bolt' },
    ]);
    const dups = byCat(analyzeBundle([parts]), 'duplicate');
    expect(dups).toHaveLength(1);
    expect(dups[0].count).toBe(2);
  });

  it('vendors key on name, not vendor_name', () => {
    const vendors = af('v.csv', 'vendors', { name: 'VendName' }, [{ VendName: 'Acme' }, { VendName: 'acme' }]);
    const dups = byCat(analyzeBundle([vendors]), 'duplicate');
    expect(dups[0].id).toBe('duplicate.vendors.name');
  });

  it('no finding when unique', () => {
    const parts = af('parts.csv', 'parts', { part_name: 'PartNo' }, [{ PartNo: 'A' }, { PartNo: 'B' }]);
    expect(byCat(analyzeBundle([parts]), 'duplicate')).toHaveLength(0);
  });
});

describe('cross-file orphans (asymmetric keys)', () => {
  it('parts -> vendors.name', () => {
    const parts = af('parts.csv', 'parts', { part_name: 'PartNo', preferred_vendor_name: 'Vendor' }, [
      { PartNo: 'A', Vendor: 'Acme' }, { PartNo: 'B', Vendor: 'Ghost Co' },
    ]);
    const vendors = af('vendors.csv', 'vendors', { name: 'VendName' }, [{ VendName: 'Acme' }]);
    const orphans = byCat(analyzeBundle([parts, vendors]), 'orphan_reference');
    expect(orphans).toHaveLength(1);
    expect(orphans[0].id).toBe('orphan.parts.preferred_vendor_name');
    expect(orphans[0].count).toBe(1);
    expect(orphans[0].severity).toBe('critical');
    expect(orphans[0].examples.some((e) => e.includes('Ghost'))).toBe(true);
  });

  it('normalized join produces no phantom orphan', () => {
    const parts = af('parts.csv', 'parts', { part_name: 'PartNo', preferred_vendor_name: 'Vendor' }, [
      { PartNo: 'A', Vendor: 'ACME' },
    ]);
    const vendors = af('vendors.csv', 'vendors', { name: 'VendName' }, [{ VendName: 'Acme' }]);
    expect(byCat(analyzeBundle([parts, vendors]), 'orphan_reference')).toHaveLength(0);
  });

  it('routing -> work_center and part', () => {
    const routings = af('rout.csv', 'routings', { part_name: 'Part', work_center_name: 'WC' }, [
      { Part: 'P1', WC: 'Mill' }, { Part: 'P1', WC: 'Laser' },
    ]);
    const wc = af('wc.csv', 'work_centers', { name: 'Name' }, [{ Name: 'Mill' }]);
    const parts = af('parts.csv', 'parts', { part_name: 'PartNo' }, [{ PartNo: 'P1' }]);
    const orphanIds = ids(byCat(analyzeBundle([routings, wc, parts]), 'orphan_reference'));
    expect(orphanIds.has('orphan.routings.work_center_name')).toBe(true);
    expect(orphanIds.has('orphan.routings.part_name')).toBe(false);
  });

  it('bom child/parent join on part_name', () => {
    const bom = af('bom.csv', 'bom',
      { parent_part_name: 'Parent', child_part_name: 'Child', quantity: 'Qty', unit: 'U' },
      [{ Parent: 'ASM', Child: 'BOLT', Qty: '2', U: 'pcs' }]);
    const parts = af('parts.csv', 'parts', { part_name: 'PartNo' }, [{ PartNo: 'ASM' }]);
    const orphanIds = ids(byCat(analyzeBundle([bom, parts]), 'orphan_reference'));
    expect(orphanIds.has('orphan.bom.child_part_name')).toBe(true);
    expect(orphanIds.has('orphan.bom.parent_part_name')).toBe(false);
  });

  it('referenced file absent -> single not_checked, never phantom', () => {
    const parts = af('parts.csv', 'parts', { part_name: 'PartNo', preferred_vendor_name: 'Vendor' }, [
      { PartNo: 'A', Vendor: 'Acme' }, { PartNo: 'B', Vendor: 'Beta' },
    ]);
    const findings = analyzeBundle([parts]);
    const nc = byCat(findings, 'not_checked').filter((f) => f.id === 'not_checked.parts.preferred_vendor_name');
    expect(nc).toHaveLength(1);
    expect(byCat(findings, 'orphan_reference')).toHaveLength(0);
  });

  it('child column unidentified -> no orphan and no noise', () => {
    const parts = af('parts.csv', 'parts', { part_name: 'PartNo' }, [{ PartNo: 'A' }]);
    const vendors = af('vendors.csv', 'vendors', { name: 'VendName' }, [{ VendName: 'Acme' }]);
    const findings = analyzeBundle([parts, vendors]);
    expect(byCat(findings, 'orphan_reference')).toHaveLength(0);
    expect(ids(findings).has('not_checked.parts.preferred_vendor_name')).toBe(false);
  });
});

describe('required columns', () => {
  it('none identified -> single classification_uncertain, no missing spam', () => {
    const vendors = af('v.csv', 'vendors', { legacy_id: 'ID' }, [{ ID: '1' }]);
    const findings = analyzeBundle([vendors]);
    expect(ids(findings).has('classification_uncertain.v.csv')).toBe(true);
    expect(byCat(findings, 'missing_column')).toHaveLength(0);
  });

  it('partial blank required -> data_gap', () => {
    const parts = af('parts.csv', 'parts', { part_name: 'PartNo' }, [
      { PartNo: 'A' }, { PartNo: '' }, { PartNo: 'C' },
    ]);
    const gaps = byCat(analyzeBundle([parts]), 'data_gap');
    expect(gaps).toHaveLength(1);
    expect(gaps[0].count).toBe(1);
    expect(gaps[0].severity).toBe('warning');
  });

  it('bom missing one required among several', () => {
    const bom = af('bom.csv', 'bom', { parent_part_name: 'P', child_part_name: 'C', unit: 'U' }, [
      { P: 'ASM', C: 'BOLT', U: 'pcs' },
    ]);
    const missing = byCat(analyzeBundle([bom]), 'missing_column');
    expect(missing.some((f) => f.id === 'missing.bom.quantity')).toBe(true);
  });

  it('misclassified file -> single uncertain finding', () => {
    const bogus = af('junk.csv', 'parts', {}, [{ Foo: '1', Bar: '2' }]);
    const findings = analyzeBundle([bogus]);
    expect(ids(findings).has('classification_uncertain.junk.csv')).toBe(true);
    expect(byCat(findings, 'missing_column')).toHaveLength(0);
  });
});

describe('cost coverage', () => {
  it('reports percentage of parts with no cost', () => {
    const parts = af('parts.csv', 'parts', { part_name: 'PartNo', cost_per_unit: 'Cost' }, [
      { PartNo: 'A', Cost: '1.50' }, { PartNo: 'B', Cost: '' }, { PartNo: 'C', Cost: '' }, { PartNo: 'D', Cost: '9' },
    ]);
    const cov = byCat(analyzeBundle([parts]), 'cost_coverage');
    expect(cov).toHaveLength(1);
    expect(cov[0].count).toBe(2);
    expect(cov[0].title).toContain('50%');
  });
});

describe('name variants', () => {
  it('groups spelling differences', () => {
    const vendors = af('v.csv', 'vendors', { name: 'VendName' }, [
      { VendName: 'Acme Inc.' }, { VendName: 'ACME' }, { VendName: 'Beta LLC' },
    ]);
    const variants = byCat(analyzeBundle([vendors]), 'name_variant');
    expect(variants).toHaveLength(1);
    expect(variants[0].count).toBe(1);
  });
});

describe('inactive flags', () => {
  it('status column', () => {
    const parts = af('parts.csv', 'parts', { part_name: 'PartNo' }, [
      { PartNo: 'A', Status: 'active' }, { PartNo: 'B', Status: 'obsolete' },
    ], ['PartNo', 'Status']);
    const inactive = byCat(analyzeBundle([parts]), 'inactive_flag');
    expect(inactive).toHaveLength(1);
    expect(inactive[0].count).toBe(1);
  });

  it('boolean active column', () => {
    const parts = af('parts.csv', 'parts', { part_name: 'PartNo' }, [
      { PartNo: 'A', Active: 'yes' }, { PartNo: 'B', Active: 'no' }, { PartNo: 'C', Active: 'false' },
    ], ['PartNo', 'Active']);
    const inactive = byCat(analyzeBundle([parts]), 'inactive_flag');
    expect(inactive[0].count).toBe(2);
  });
});

describe('edges', () => {
  it('empty bundle -> no findings', () => {
    expect(analyzeBundle([])).toEqual([]);
  });

  it('headers-only file -> count 0, no crash', () => {
    const parts = af('parts.csv', 'parts', { part_name: 'PartNo' }, [], ['PartNo']);
    const counts = byCat(analyzeBundle([parts]), 'record_count');
    expect(counts[0].count).toBe(0);
  });

  it('findings sorted critical first', () => {
    const parts = af('parts.csv', 'parts', { part_name: 'PartNo', preferred_vendor_name: 'Vendor' }, [
      { PartNo: 'A', Vendor: 'Ghost' },
    ]);
    const vendors = af('vendors.csv', 'vendors', { name: 'VendName' }, [{ VendName: 'Acme' }]);
    const findings = analyzeBundle([parts, vendors]);
    expect(findings[0].severity).toBe('critical');
  });
});
