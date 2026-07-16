/**
 * "If you import now, N of your parts won't come in."
 *
 * That sentence is the spine of the Review step, so it has to be TRUE — which means
 * counting the rows the importer will actually refuse, not summing finding counts (a row
 * with no unit AND an unknown vendor is one lost row, not two).
 *
 * What costs a row, verified against the running importers rather than inferred:
 *  - a blank REQUIRED field — e.g. parts.primary_unit. `parts` has an unconditional
 *    CHECK (primary_unit IS NOT NULL); validate reports missing_primary_unit and execute
 *    skips the row.
 *  - an unresolvable REFERENCE — a part naming a vendor that doesn't exist is a conflict,
 *    and execute skips every conflict row (confirmed live: the part does not land). Same
 *    for a routing naming an unknown work center.
 *
 * Known limit: references are resolved against the UPLOAD only, matching the analyzer. For
 * a shop that already has data in Jigged, a "missing" vendor may already exist there, so
 * this can over-report on a top-up import. Correct for onboarding, which is the flow this
 * serves; revisit if top-up imports become common.
 */

import type { WorkingFile } from '@/lib/dataImportEditing';
import { REFERENTIAL_LINKS } from '@/lib/dataImportLinks';
import { ENTITY_FIELDS, ENTITY_LABELS, norm } from '@/lib/dataImportSchema';
import type { EntityType } from '@/types/data-import';

export interface EntityImpact {
  entityType: EntityType;
  label: string; // "parts", "routing steps" — reads inside a sentence
  total: number;
  lost: number; // distinct rows the importer would refuse as things stand
}

/** Plain words that read inside "…7,672 parts won't come in". */
const IMPACT_LABEL: Partial<Record<EntityType, string>> = {
  routings: 'routing steps',
  bom: 'bill-of-materials lines',
};

const impactLabel = (e: EntityType) => IMPACT_LABEL[e] ?? ENTITY_LABELS[e].toLowerCase();

/** Every value present on the parent side of a link, normalized. */
function parentValues(working: WorkingFile[], entity: EntityType, field: string): Set<string> {
  const out = new Set<string>();
  for (const wf of working) {
    if (wf.entityType !== entity) continue;
    const col = wf.columnRoles[field];
    if (!col) continue;
    for (const row of wf.rows) {
      const v = norm(row[col]);
      if (v) out.add(v);
    }
  }
  return out;
}

/** Per entity: how many rows are here, and how many of them can't be created yet. */
export function rowsAtRisk(working: WorkingFile[]): EntityImpact[] {
  const parents = new Map<string, Set<string>>();
  for (const link of REFERENTIAL_LINKS) {
    const key = `${link.parentEntity}.${link.parentField}`;
    if (!parents.has(key)) parents.set(key, parentValues(working, link.parentEntity, link.parentField));
  }

  const agg = new Map<EntityType, EntityImpact>();
  for (const wf of working) {
    if (wf.entityType === 'unknown') continue;
    const required = (ENTITY_FIELDS[wf.entityType] ?? []).filter((f) => f.required);
    const links = REFERENTIAL_LINKS.filter((l) => l.childEntity === wf.entityType);

    const cur = agg.get(wf.entityType) ?? {
      entityType: wf.entityType,
      label: impactLabel(wf.entityType),
      total: 0,
      lost: 0,
    };

    for (const row of wf.rows) {
      cur.total += 1;
      const missingRequired = required.some((f) => {
        const col = wf.columnRoles[f.key];
        return !col || !norm(row[col]);
      });
      const brokenRef =
        !missingRequired &&
        links.some((l) => {
          const col = wf.columnRoles[l.childField];
          if (!col) return false;
          const v = norm(row[col]);
          if (!v) return false; // blank isn't a broken reference
          const known = parents.get(`${l.parentEntity}.${l.parentField}`);
          // No parent file uploaded at all → we genuinely can't judge. The analyzer
          // raises `not_checked` for that; don't invent a loss here.
          if (!known || known.size === 0) return false;
          return !known.has(v);
        });
      if (missingRequired || brokenRef) cur.lost += 1;
    }
    agg.set(wf.entityType, cur);
  }

  return [...agg.values()];
}

/** Only what the owner is about to lose — the consequence line's input. */
export const losses = (impact: EntityImpact[]): EntityImpact[] =>
  impact.filter((i) => i.lost > 0).sort((a, b) => b.lost - a.lost);

/** "7,672 parts and 6,565 routing steps" — the loss list as one plain phrase. */
export function lossPhrase(impact: EntityImpact[]): string {
  const parts = losses(impact).map((i) => `${i.lost.toLocaleString()} ${i.label}`);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
