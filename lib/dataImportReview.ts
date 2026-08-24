/**
 * The decision-first view-model for the Review step.
 *
 * Shape (research-backed, see docs/modules/data-import.md "Review step"):
 *  - ONE consequence line — what you lose if you import right now — instead of a verdict
 *    banner. No import product surveyed ships a ready/not-ready verdict, and "Not ready to
 *    import" is a dead end a shop owner can't act on. Xero's framing instead: "you can
 *    still confirm the import, but these won't import."
 *  - A task list ranked BY CONSEQUENCE (rows lost), not by check category. Blocking work
 *    first, optional work tagged as such — GOV.UK's "complete multiple tasks" pattern.
 *  - Everything with nothing to do collapses into "noticed". No count chips: GOV.UK's error
 *    summary lists the items, never a tally, because a count isn't actionable.
 */

import type { EntityType, Finding, ImportReview, Severity } from '@/types/data-import';
import type { EntityImpact } from '@/lib/dataImportImpact';
import { losses, lossPhrase } from '@/lib/dataImportImpact';
import { autoCreateLinkFor } from '@/lib/dataImportLinks';

/**
 * Does this finding have a focused, one-click fix in the Review step today? Drives the
 * task-vs-notice split below AND the card-vs-plain-row treatment in the view — one source
 * of truth so they can't disagree.
 */
export function isOpenable(finding: Finding): boolean {
  if (autoCreateLinkFor(finding.id)) return true; // "Add the missing vendors/work centers"
  if (finding.category === 'data_gap') return true; // "Fill in / Set units"
  if (finding.category === 'name_variant') return true; // "Review variants"
  return false;
}

export interface EntityOutlook {
  entityType: EntityType;
  label: string;
  count: number;
  filenames: string[];
}

export interface ReviewTask {
  finding: Finding;
  /** Costs the owner records if left alone. Drives order + whether it's tagged Optional. */
  blocking: boolean;
}

export interface ReviewSummary {
  /** '' when nothing is at risk — the view says "everything will come in". */
  lossPhrase: string;
  impact: EntityImpact[];
  /** The positive side + the progress signal: how many rows will actually come in, of the
   *  total. `willImport` grows toward `total` as the owner fixes things. */
  willImport: number;
  totalRows: number;
  tasks: ReviewTask[];
  noticed: Finding[];
  outlook: EntityOutlook[];
}

const ENTITY_LABEL: Record<EntityType, string> = {
  parts: 'Parts',
  vendors: 'Vendors',
  vendor_services: 'Vendor services',
  work_centers: 'Work centers',
  routings: 'Routing steps',
  bom: 'BOM lines',
  customers: 'Customers',
  unknown: 'Unrecognized',
};

const ENTITY_ORDER: EntityType[] = ['parts', 'vendors', 'work_centers', 'routings', 'bom', 'customers', 'unknown'];

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

/** A record-count fact is not a task. */
const isFact = (f: Finding) => f.category === 'record_count';

/**
 * @param report  the analyzed review
 * @param impact  rows-at-risk per entity, from rowsAtRisk(working). Optional so callers
 *                without the working set still get a usable (task-only) summary.
 */
export function summarize(report: ImportReview, impact: EntityImpact[] = []): ReviewSummary {
  const findings = report.findings.filter((f) => !isFact(f));

  // "What to sort out" is for things with something to DO — not everything non-info.
  // A finding is a task only if it's BLOCKING (critical = these rows can't come in, so the
  // owner must see it) OR ACTIONABLE (has a one-click in-app fix). A non-blocking finding
  // with no fix — "13 duplicate names collapse into one", "93% have no cost, add later",
  // "couldn't check this reference" — is a no-op under an action heading, which reads as a
  // dead end. Those drop to "noticed" regardless of warning-vs-info severity.
  const isTask = (f: Finding) => f.severity === 'critical' || isOpenable(f);

  const tasks: ReviewTask[] = findings
    .filter(isTask)
    .map((f) => ({ finding: f, blocking: f.severity === 'critical' }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] ||
        b.finding.count - a.finding.count ||
        a.finding.id.localeCompare(b.finding.id),
    );

  const noticed = findings.filter((f) => !isTask(f));

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

  // The "what will come in" side, summed across every entity — grows as fixes land.
  const totalRows = impact.reduce((s, e) => s + e.total, 0);
  const willImport = impact.reduce((s, e) => s + (e.total - e.lost), 0);

  return { lossPhrase: lossPhrase(impact), impact: losses(impact), willImport, totalRows, tasks, noticed, outlook };
}

export { ENTITY_LABEL };
