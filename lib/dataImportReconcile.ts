/**
 * Non-empty-company reconciliation. Given the existing identity values already in Jigged
 * (fetched RLS-scoped — see dataImportExisting.ts), bucket each uploaded row as NEW or
 * MATCHED by its normalized identity, so the Import step can show "X new · Y already in
 * Jigged" and offer create/update modes. The modes are implemented purely by FILTERING rows
 * (no backend mode param needed): create-only keeps new rows, update-only keeps matched rows.
 *
 * Only name-like-identity entities reconcile (parts/vendors/work_centers/customers); rows
 * without a resolvable identity — and non-identity entities (bom/routings) — pass through
 * unchanged.
 */

import type { EntityType } from '@/types/data-import';
import type { WorkingFile } from '@/lib/dataImportEditing';
import { ENTITY_IDENTITY_FIELD } from '@/lib/dataImportSchema';

export type ExistingIdentities = Partial<Record<EntityType, Set<string>>>;
export type ImportMode = 'both' | 'create' | 'update';

const norm = (v: string): string => v.trim().toLowerCase();

function identityValue(wf: WorkingFile, row: Record<string, string>): string | null {
  const field = ENTITY_IDENTITY_FIELD[wf.entityType];
  if (!field) return null;
  const col = wf.columnRoles[field];
  if (!col) return null;
  return norm(row[col] ?? '') || null;
}

export interface EntityReconcile {
  entity: EntityType;
  newCount: number;
  matchedCount: number;
}

export interface ReconcileResult {
  byEntity: EntityReconcile[];
  totalNew: number;
  totalMatched: number;
  hasExisting: boolean; // any uploaded row already matches a record in Jigged
}

export function reconcile(working: WorkingFile[], existing: ExistingIdentities): ReconcileResult {
  const agg = new Map<EntityType, EntityReconcile>();
  for (const wf of working) {
    const field = ENTITY_IDENTITY_FIELD[wf.entityType];
    if (!field || !wf.columnRoles[field]) continue; // not reconcilable
    const set = existing[wf.entityType] ?? new Set<string>();
    const e = agg.get(wf.entityType) ?? { entity: wf.entityType, newCount: 0, matchedCount: 0 };
    for (const row of wf.rows) {
      const v = identityValue(wf, row);
      if (v === null) continue;
      if (set.has(v)) e.matchedCount += 1;
      else e.newCount += 1;
    }
    agg.set(wf.entityType, e);
  }
  const byEntity = [...agg.values()];
  const totalMatched = byEntity.reduce((s, e) => s + e.matchedCount, 0);
  return {
    byEntity,
    totalNew: byEntity.reduce((s, e) => s + e.newCount, 0),
    totalMatched,
    hasExisting: totalMatched > 0,
  };
}

/** Filter each file's rows to the chosen mode (before building the import plan). */
export function filterWorkingByMode(
  working: WorkingFile[],
  existing: ExistingIdentities,
  mode: ImportMode,
): WorkingFile[] {
  if (mode === 'both') return working;
  return working.map((wf) => {
    const field = ENTITY_IDENTITY_FIELD[wf.entityType];
    if (!field || !wf.columnRoles[field]) return wf; // not reconcilable → pass through
    const set = existing[wf.entityType] ?? new Set<string>();
    const rows = wf.rows.filter((row) => {
      const v = identityValue(wf, row);
      if (v === null) return true; // no identity value → keep; can't classify
      const isExisting = set.has(v);
      return mode === 'update' ? isExisting : !isExisting; // 'create' keeps new
    });
    return { ...wf, rows };
  });
}
