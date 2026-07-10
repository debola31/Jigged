/**
 * Derives the scannable, decision-first view-model for the import review from
 * the raw ImportReview. Research-backed structure (NN/G inverted pyramid; GX Cloud
 * severity buckets; Purview "no green noise"): a verdict that leads with the single most
 * important blocking issue, a prioritized fix-first action list, a plain "what you're
 * importing" outlook with cross-entity relationships, and a "to finish setup" list.
 */

import type { EntityType, Finding, ImportReview, Severity } from '@/types/data-import';

export interface SeverityCounts {
  critical: number;
  warning: number;
  info: number;
}

export interface EntityOutlook {
  entityType: EntityType;
  label: string; // e.g. "Parts", "Routing steps"
  count: number;
  filenames: string[];
}

export interface RelationshipHealth {
  label: string; // "Routing steps → Work centers"
  total: number; // references from the child side
  unmatched: number; // orphans
  status: 'ok' | 'broken' | 'unverified';
  note: string;
}

export interface ReviewSummary {
  verdict: {
    level: 'blocking' | 'review' | 'ready';
    headline: string;
    lead: string; // the single most important issue, plain language
    counts: SeverityCounts;
  };
  actions: Finding[]; // prioritized, excludes pure record-count facts
  outlook: EntityOutlook[];
  relationships: RelationshipHealth[];
  toFinish: Finding[]; // missing columns / gaps / not-checked / uncertain
}

const ENTITY_LABEL: Record<EntityType, string> = {
  parts: 'Parts',
  vendors: 'Vendors',
  work_centers: 'Work centers',
  routings: 'Routing steps',
  bom: 'BOM lines',
  customers: 'Customers',
  unknown: 'Unrecognized',
};

// Entity display order (facts read best grouped this way).
const ENTITY_ORDER: EntityType[] = ['parts', 'vendors', 'work_centers', 'routings', 'bom', 'customers', 'unknown'];

// The cross-entity references we surface in the "what you're importing" outlook.
const RELATIONSHIPS: { child: EntityType; field: string; parent: EntityType; label: string }[] = [
  { child: 'parts', field: 'preferred_vendor_name', parent: 'vendors', label: 'Parts → Vendors' },
  { child: 'routings', field: 'work_center_name', parent: 'work_centers', label: 'Routing steps → Work centers' },
  { child: 'routings', field: 'part_name', parent: 'parts', label: 'Routing steps → Parts' },
  { child: 'bom', field: 'parent_part_name', parent: 'parts', label: 'BOM assemblies → Parts' },
  { child: 'bom', field: 'child_part_name', parent: 'parts', label: 'BOM components → Parts' },
  { child: 'work_centers', field: 'vendor_name', parent: 'vendors', label: 'Outside work centers → Vendors' },
];

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

/** A "fact" finding (record_count) is not an action item. */
const isActionable = (f: Finding) => f.category !== 'record_count';

const TO_FINISH_CATEGORIES = new Set(['missing_column', 'data_gap', 'not_checked']);

export function summarize(report: ImportReview): ReviewSummary {
  const findings = report.findings;

  const counts: SeverityCounts = { critical: 0, warning: 0, info: 0 };
  for (const f of findings) {
    if (!isActionable(f)) continue; // don't count neutral facts toward the verdict
    counts[f.severity] += 1;
  }

  const actions = findings
    .filter(isActionable)
    .slice()
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.count - a.count || a.id.localeCompare(b.id));

  // Verdict — lead with the single most important issue (highest severity, then highest count).
  const topCritical = actions.find((f) => f.severity === 'critical');
  const topWarning = actions.find((f) => f.severity === 'warning');
  let level: 'blocking' | 'review' | 'ready';
  let headline: string;
  let lead: string;
  if (counts.critical > 0) {
    level = 'blocking';
    headline =
      counts.critical === 1 ? 'Not ready to import — 1 blocking issue' : `Not ready to import — ${counts.critical} blocking issues`;
    lead = topCritical ? topCritical.title : 'A blocking issue needs fixing before import.';
  } else if (counts.warning > 0) {
    level = 'review';
    headline = counts.warning === 1 ? 'Almost ready — 1 thing to review' : `Almost ready — ${counts.warning} things to review`;
    lead = topWarning ? topWarning.title : 'A few things are worth cleaning up before import.';
  } else {
    level = 'ready';
    headline = 'Ready to import';
    lead = 'No blocking issues found in your files.';
  }

  // Outlook — record counts per entity from the classified files.
  const byEntity = new Map<EntityType, { count: number; filenames: string[] }>();
  for (const fc of report.files) {
    const cur = byEntity.get(fc.entity_type) ?? { count: 0, filenames: [] };
    cur.count += fc.row_count;
    cur.filenames.push(fc.filename);
    byEntity.set(fc.entity_type, cur);
  }
  const outlook: EntityOutlook[] = ENTITY_ORDER.filter((e) => byEntity.has(e)).map((e) => ({
    entityType: e,
    label: ENTITY_LABEL[e],
    count: byEntity.get(e)!.count,
    filenames: byEntity.get(e)!.filenames,
  }));

  // Relationships — only for links whose child entity was uploaded.
  const presentEntities = new Set(report.files.map((f) => f.entity_type));
  const childTotals = (child: EntityType) =>
    report.files.filter((f) => f.entity_type === child).reduce((s, f) => s + f.row_count, 0);
  const relationships: RelationshipHealth[] = [];
  for (const rel of RELATIONSHIPS) {
    if (!presentEntities.has(rel.child)) continue;
    const orphan = findings.find((f) => f.id === `orphan.${rel.child}.${rel.field}`);
    const notChecked = findings.find((f) => f.id === `not_checked.${rel.child}.${rel.field}`);
    const total = childTotals(rel.child);
    if (orphan) {
      relationships.push({
        label: rel.label,
        total,
        unmatched: orphan.count,
        status: 'broken',
        note: `${orphan.count.toLocaleString()} of ${total.toLocaleString()} point to a ${ENTITY_LABEL[rel.parent].toLowerCase()} that isn't in your files`,
      });
    } else if (notChecked) {
      relationships.push({
        label: rel.label,
        total,
        unmatched: 0,
        status: 'unverified',
        note: notChecked.title,
      });
    } else if (presentEntities.has(rel.parent)) {
      relationships.push({
        label: rel.label,
        total,
        unmatched: 0,
        status: 'ok',
        note: `All ${total.toLocaleString()} match`,
      });
    }
  }

  const toFinish = findings.filter(
    (f) => TO_FINISH_CATEGORIES.has(f.category) || f.id.startsWith('classification_uncertain.'),
  );

  return { verdict: { level, headline, lead, counts }, actions, outlook, relationships, toFinish };
}

export { ENTITY_LABEL };
