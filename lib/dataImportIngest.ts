/**
 * Dependency-ordered ingestion: turn the confirmed working set into batched calls to the
 * EXISTING per-entity import `execute` routes, in an order where parents commit before
 * children (so each importer resolves references against already-written rows). No new write
 * logic — we reuse the routes that already validate + conflict-detect + upsert by natural
 * identity (part_name / vendor name / work-center name).
 *
 * Split by concern: buildImportPlan + summarizeResults are PURE (unit-tested); runImportPlan
 * is the thin network driver.
 */

import type { EntityType } from '@/types/data-import';
import type { WorkingFile } from '@/lib/dataImportEditing';

export const ENTITY_ENDPOINT: Partial<Record<EntityType, string>> = {
  vendors: '/api/vendors/import/execute',
  work_centers: '/api/work-centers/import/execute',
  customers: '/api/customers/import/execute',
  parts: '/api/parts/import/execute',
  bom: '/api/bom/import/execute',
  routings: '/api/routings/import/execute',
};

/** Parents before children: vendors/work-centers/customers → parts → bom/routings. */
export const WRITE_TIERS: EntityType[][] = [
  ['vendors', 'work_centers', 'customers'],
  ['parts'],
  ['bom', 'routings'],
];

const BATCH_SIZE = 500; // every execute route caps at 500 rows/request

export interface ImportBatch {
  entity: EntityType;
  endpoint: string;
  filename: string;
  mappings: Record<string, string>; // csv_column -> db_field (what the routes expect)
  rows: Record<string, string>[];
  extra: Record<string, unknown>; // per-entity required extras (parts: pricing_columns)
  batchIndex: number; // 0-based within its file
  batchCount: number;
}

// columnRoles is canonical->raw; the importer wants csv_column(raw) -> db_field(canonical).
function mappingsFor(wf: WorkingFile): Record<string, string> {
  return Object.fromEntries(Object.entries(wf.columnRoles).map(([canonical, raw]) => [raw, canonical]));
}

function stripRowId(row: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(row).filter(([k]) => k !== '__rowId'));
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Dependency-ordered, ≤500-row batches. Files classified 'unknown' (or empty) are skipped. */
export function buildImportPlan(working: WorkingFile[]): ImportBatch[] {
  const plan: ImportBatch[] = [];
  for (const tier of WRITE_TIERS) {
    for (const entity of tier) {
      const endpoint = ENTITY_ENDPOINT[entity];
      if (!endpoint) continue;
      for (const wf of working.filter((w) => w.entityType === entity)) {
        if (wf.rows.length === 0) continue;
        const mappings = mappingsFor(wf);
        const rows = wf.rows.map(stripRowId);
        const chunks = chunk(rows, BATCH_SIZE);
        chunks.forEach((c, i) =>
          plan.push({
            entity,
            endpoint,
            filename: wf.filename,
            mappings,
            rows: c,
            extra: entity === 'parts' ? { pricing_columns: [] } : {},
            batchIndex: i,
            batchCount: chunks.length,
          }),
        );
      }
    }
  }
  return plan;
}

export interface ExecuteResponseShape {
  success?: boolean;
  imported_count?: number;
  updated_count?: number;
  skipped_count?: number;
  imported_operations_count?: number; // routings
  imported_routings_count?: number; // routings
  errors?: unknown[];
}

export interface EntityResult {
  entity: EntityType;
  created: number;
  updated: number;
  skipped: number;
  errorCount: number;
}

export interface ImportSummary {
  byEntity: EntityResult[];
  totalCreated: number;
  totalUpdated: number;
  totalSkipped: number;
  totalErrors: number;
  failed: boolean; // at least one batch threw (network / 500)
}

/** Per-entity progress, in write order (vendors → … → routings). */
export interface EntityProgress {
  entity: EntityType;
  rowsTotal: number;
  rowsDone: number; // rows ATTEMPTED (so the bar keeps moving even through a bad batch)
  rowsFailed: number; // rows whose batch threw — surfaces a failed stage in the checklist
}

/** A live snapshot of an in-flight import, emitted after every batch so the UI can show a
 *  determinate bar + a stage checklist instead of an opaque "Importing…". */
export interface ImportProgress {
  batchesDone: number;
  batchesTotal: number;
  rowsDone: number;
  rowsTotal: number;
  currentEntity: EntityType | null; // the entity whose batch is in flight (null once done)
  entities: EntityProgress[];
}

const createdOf = (r: ExecuteResponseShape): number =>
  r.imported_count ?? r.imported_operations_count ?? r.imported_routings_count ?? 0;

/** Aggregate per-batch responses (each paired with its entity) into one summary. */
export function summarizeResults(
  results: { entity: EntityType; response: ExecuteResponseShape | null }[],
): ImportSummary {
  const byEntity = new Map<EntityType, EntityResult>();
  let failed = false;
  for (const { entity, response } of results) {
    const e = byEntity.get(entity) ?? { entity, created: 0, updated: 0, skipped: 0, errorCount: 0 };
    if (response === null) {
      failed = true;
      e.errorCount += 1;
    } else {
      e.created += createdOf(response);
      e.updated += response.updated_count ?? 0;
      e.skipped += response.skipped_count ?? 0;
      e.errorCount += response.errors?.length ?? 0;
    }
    byEntity.set(entity, e);
  }
  const list = [...byEntity.values()];
  return {
    byEntity: list,
    totalCreated: list.reduce((s, e) => s + e.created, 0),
    totalUpdated: list.reduce((s, e) => s + e.updated, 0),
    totalSkipped: list.reduce((s, e) => s + e.skipped, 0),
    totalErrors: list.reduce((s, e) => s + e.errorCount, 0),
    failed,
  };
}

/**
 * Execute the plan against the backend, one batch at a time in dependency order (so parents
 * commit before children resolve their references). `post` performs one authed POST and
 * returns the parsed response; a throw is recorded and the run continues (resumable — a
 * re-run fills the rest idempotently via ON CONFLICT on the natural-identity key).
 */
export async function runImportPlan(
  plan: ImportBatch[],
  companyId: string,
  post: (endpoint: string, body: unknown) => Promise<ExecuteResponseShape>,
  onProgress?: (p: ImportProgress) => void,
): Promise<ImportSummary> {
  // Per-entity row totals, in the plan's write order — the spine of the progress checklist.
  const entities: EntityProgress[] = [];
  const entityIndex = new Map<EntityType, number>();
  for (const b of plan) {
    if (!entityIndex.has(b.entity)) {
      entityIndex.set(b.entity, entities.length);
      entities.push({ entity: b.entity, rowsTotal: 0, rowsDone: 0, rowsFailed: 0 });
    }
    entities[entityIndex.get(b.entity)!].rowsTotal += b.rows.length;
  }
  const rowsTotal = entities.reduce((s, e) => s + e.rowsTotal, 0);
  const batchesTotal = plan.length;
  let batchesDone = 0;
  let rowsDone = 0;

  const emit = (currentEntity: EntityType | null) =>
    onProgress?.({
      batchesDone,
      batchesTotal,
      rowsDone,
      rowsTotal,
      currentEntity,
      entities: entities.map((e) => ({ ...e })),
    });

  const results: { entity: EntityType; response: ExecuteResponseShape | null }[] = [];
  for (const batch of plan) {
    emit(batch.entity); // show which stage is in flight before we await it
    let failed = false;
    try {
      const response = await post(batch.endpoint, {
        company_id: companyId,
        mappings: batch.mappings,
        rows: batch.rows,
        skip_conflicts: true,
        ...batch.extra,
      });
      results.push({ entity: batch.entity, response });
    } catch {
      failed = true;
      results.push({ entity: batch.entity, response: null });
    }
    batchesDone += 1;
    rowsDone += batch.rows.length;
    const ep = entities[entityIndex.get(batch.entity)!];
    ep.rowsDone += batch.rows.length;
    if (failed) ep.rowsFailed += batch.rows.length;
    emit(batch.entity);
  }
  emit(null);
  return summarizeResults(results);
}
