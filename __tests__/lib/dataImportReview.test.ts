import { describe, it, expect } from 'vitest';
import { summarize } from '@/lib/dataImportReview';
import type { EntityType, Finding, ImportReview } from '@/types/data-import';

function finding(partial: Partial<Finding> & Pick<Finding, 'id' | 'category' | 'severity' | 'title'>): Finding {
  return {
    entity_type: 'unknown',
    detail: '',
    count: 0,
    examples: [],
    source_files: [],
    verified: true,
    recommended_action: '',
    ...partial,
  };
}

function report(files: { filename: string; entity_type: EntityType; row_count: number }[], findings: Finding[]): ImportReview {
  return {
    schema_version: 1,
    erp_detection: {
      source: 'unknown', display_name: 'Unknown', confidence: 0, matched_headers: [],
      evidence: '', alternatives: [], header_signature: '', ai_provider: '', ai_model: '',
    },
    files: files.map((f) => ({ ...f, entity_confidence: 1, headers: [], column_roles: {} })),
    findings,
    summary: '',
    recommendations: [],
    narrative_available: true,
    ai_provider: '',
    ai_model: '',
    generated_at: '',
  };
}


describe('summarize — tasks', () => {
  it('ranks by consequence: blocking first, then by how many rows it costs', () => {
    const r = report(
      [{ filename: 'routings.csv', entity_type: 'routings', row_count: 18639 }],
      [
        finding({ id: 'count.routings.csv', category: 'record_count', severity: 'info', title: '18639 rows', count: 18639 }),
        finding({ id: 'name_variant.parts.x', category: 'name_variant', severity: 'warning', title: '13 variants', count: 13 }),
        finding({ id: 'orphan.routings.work_center_name', category: 'orphan_reference', severity: 'critical',
          title: '33 work centers missing', count: 6565, entity_type: 'routings' }),
        finding({ id: 'gap.parts.primary_unit', category: 'data_gap', severity: 'critical',
          title: '7672 parts have no unit', count: 7672, entity_type: 'parts' }),
      ],
    );
    const s = summarize(r);
    // Costliest blocking task first; the optional one sinks below both.
    expect(s.tasks.map((t) => t.finding.id)).toEqual([
      'gap.parts.primary_unit',
      'orphan.routings.work_center_name',
      'name_variant.parts.x',
    ]);
    expect(s.tasks.map((t) => t.blocking)).toEqual([true, true, false]);
  });

  it('is not a dumping ground for facts — a record count is never a task', () => {
    const r = report(
      [{ filename: 'vendors.csv', entity_type: 'vendors', row_count: 50 }],
      [finding({ id: 'count.vendors.csv', category: 'record_count', severity: 'info', title: '50 rows', count: 50 })],
    );
    const s = summarize(r);
    expect(s.tasks).toEqual([]);
    expect(s.noticed).toEqual([]); // record counts aren't "noticed" either — they're the outlook
  });

  it('a warning with nothing to DO drops to "noticed", not "What to sort out"', () => {
    // Regression: duplicates auto-collapse and "no cost" is optional — both are warnings, but
    // neither is blocking or has an in-app fix. Showing them under an action heading with no
    // control reads as a dead end. They belong in "things we noticed — nothing to do".
    const r = report(
      [{ filename: 'parts.csv', entity_type: 'parts', row_count: 8393 }],
      [
        finding({ id: 'duplicate.parts.part_name', category: 'duplicate', severity: 'warning',
          title: '13 duplicate part_name value(s)', detail: 'The repeats collapse into one record.', count: 13, entity_type: 'parts' }),
        finding({ id: 'cost_coverage.parts.csv', category: 'cost_coverage', severity: 'warning',
          title: '93% of parts have no cost/price', count: 7775, entity_type: 'parts' }),
        finding({ id: 'name_variant.parts.x', category: 'name_variant', severity: 'warning',
          title: '3 variants', count: 3, entity_type: 'parts' }),
      ],
    );
    const s = summarize(r);
    // Only the openable warning (name_variant) is a task; the two no-op warnings drop to noticed.
    expect(s.tasks.map((t) => t.finding.id)).toEqual(['name_variant.parts.x']);
    expect(s.noticed.map((f) => f.id).sort()).toEqual(['cost_coverage.parts.csv', 'duplicate.parts.part_name']);
  });

  it('info findings go to "noticed", never to tasks', () => {
    const r = report(
      [{ filename: 'parts.csv', entity_type: 'parts', row_count: 10 }],
      [
        finding({ id: 'inactive.parts.csv', category: 'inactive_flag', severity: 'info', title: '41 inactive', count: 41 }),
        finding({ id: 'gap.parts.primary_unit', category: 'data_gap', severity: 'critical', title: 'no unit', count: 4 }),
      ],
    );
    const s = summarize(r);
    expect(s.tasks.map((t) => t.finding.id)).toEqual(['gap.parts.primary_unit']);
    expect(s.noticed.map((f) => f.id)).toEqual(['inactive.parts.csv']);
  });
});

describe('summarize — the consequence line', () => {
  it('says nothing when nothing is at risk', () => {
    const r = report([{ filename: 'v.csv', entity_type: 'vendors', row_count: 5 }], []);
    expect(summarize(r, []).lossPhrase).toBe('');
  });

  it('reads as a sentence, costliest first, with thousands separators', () => {
    const s = summarize(report([], []), [
      { entityType: 'routings', label: 'routing steps', total: 18639, lost: 6565 },
      { entityType: 'parts', label: 'parts', total: 8393, lost: 7672 },
      { entityType: 'vendors', label: 'vendors', total: 214, lost: 0 },
    ]);
    expect(s.lossPhrase).toBe('7,672 parts and 6,565 routing steps');
    // Entities losing nothing never appear.
    expect(s.impact.map((i) => i.entityType)).toEqual(['parts', 'routings']);
    // The "what will come in" side sums across every entity (the progress signal).
    expect(s.totalRows).toBe(18639 + 8393 + 214);
    expect(s.willImport).toBe(18639 - 6565 + (8393 - 7672) + 214);
  });

  it('reports full import when nothing is lost (progress = 100%)', () => {
    const s = summarize(report([], []), [{ entityType: 'parts', label: 'parts', total: 8393, lost: 0 }]);
    expect(s.totalRows).toBe(8393);
    expect(s.willImport).toBe(8393);
  });

  it('joins three losses with commas and a final "and"', () => {
    const s = summarize(report([], []), [
      { entityType: 'parts', label: 'parts', total: 10, lost: 5 },
      { entityType: 'routings', label: 'routing steps', total: 10, lost: 3 },
      { entityType: 'bom', label: 'bill-of-materials lines', total: 10, lost: 2 },
    ]);
    expect(s.lossPhrase).toBe('5 parts, 3 routing steps and 2 bill-of-materials lines');
  });
});

describe('summarize — outlook', () => {
  it('still aggregates row counts per entity for the import step', () => {
    const r = report(
      [
        { filename: 'parts.csv', entity_type: 'parts', row_count: 8393 },
        { filename: 'more-parts.csv', entity_type: 'parts', row_count: 100 },
        { filename: 'vendors.csv', entity_type: 'vendors', row_count: 50 },
      ],
      [],
    );
    const s = summarize(r);
    expect(s.outlook.find((o) => o.entityType === 'parts')?.count).toBe(8493);
    expect(s.outlook.find((o) => o.entityType === 'parts')?.filenames).toEqual(['parts.csv', 'more-parts.csv']);
  });
});
