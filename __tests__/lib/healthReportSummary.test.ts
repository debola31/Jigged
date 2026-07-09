import { describe, it, expect } from 'vitest';
import { summarize } from '@/lib/healthReportSummary';
import type { EntityType, Finding, HealthReport } from '@/types/health-report';

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

function report(files: { filename: string; entity_type: EntityType; row_count: number }[], findings: Finding[]): HealthReport {
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

describe('summarize — verdict', () => {
  it('is blocking and leads with the top critical when a critical exists', () => {
    const r = report(
      [{ filename: 'routings.csv', entity_type: 'routings', row_count: 18639 }],
      [
        finding({ id: 'count.routings.csv', category: 'record_count', severity: 'info', title: '18639 rows', count: 18639 }),
        finding({ id: 'orphan.routings.work_center_name', category: 'orphan_reference', severity: 'critical',
          title: '6565 routing steps reference a work center not in the upload', count: 6565, entity_type: 'routings' }),
        finding({ id: 'name_variant.parts.x', category: 'name_variant', severity: 'warning', title: '13 variants', count: 13 }),
      ],
    );
    const s = summarize(r);
    expect(s.verdict.level).toBe('blocking');
    expect(s.verdict.counts.critical).toBe(1);
    expect(s.verdict.counts.warning).toBe(1);
    expect(s.verdict.lead).toContain('6565');
    // record_count facts are NOT actions
    expect(s.actions.some((f) => f.category === 'record_count')).toBe(false);
    // actions sorted critical first
    expect(s.actions[0].severity).toBe('critical');
  });

  it('is ready when there are only info/record-count findings', () => {
    const r = report(
      [{ filename: 'vendors.csv', entity_type: 'vendors', row_count: 50 }],
      [finding({ id: 'count.vendors.csv', category: 'record_count', severity: 'info', title: '50 rows', count: 50 })],
    );
    const s = summarize(r);
    expect(s.verdict.level).toBe('ready');
    expect(s.verdict.counts.critical).toBe(0);
  });
});

describe('summarize — outlook & relationships', () => {
  it('aggregates entity counts and marks a broken relationship', () => {
    const r = report(
      [
        { filename: 'parts.csv', entity_type: 'parts', row_count: 8393 },
        { filename: 'vendors.csv', entity_type: 'vendors', row_count: 50 },
      ],
      [
        finding({ id: 'orphan.parts.preferred_vendor_name', category: 'orphan_reference', severity: 'critical',
          title: 'orphans', count: 20, entity_type: 'parts' }),
      ],
    );
    const s = summarize(r);
    expect(s.outlook.find((o) => o.entityType === 'parts')?.count).toBe(8393);
    const rel = s.relationships.find((x) => x.label === 'Parts → Vendors');
    expect(rel?.status).toBe('broken');
    expect(rel?.unmatched).toBe(20);
  });

  it('marks a relationship ok when both sides present and no orphans', () => {
    const r = report(
      [
        { filename: 'parts.csv', entity_type: 'parts', row_count: 10 },
        { filename: 'vendors.csv', entity_type: 'vendors', row_count: 5 },
      ],
      [],
    );
    const s = summarize(r);
    expect(s.relationships.find((x) => x.label === 'Parts → Vendors')?.status).toBe('ok');
  });
});

describe('summarize — toFinish', () => {
  it('collects missing/gap/not-checked findings', () => {
    const r = report(
      [{ filename: 'parts.csv', entity_type: 'parts', row_count: 10 }],
      [
        finding({ id: 'missing.parts.part_name', category: 'missing_column', severity: 'critical', title: 'missing part_name' }),
        finding({ id: 'not_checked.parts.preferred_vendor_name', category: 'not_checked', severity: 'warning', title: 'no vendors file' }),
      ],
    );
    const s = summarize(r);
    expect(s.toFinish).toHaveLength(2);
  });
});
