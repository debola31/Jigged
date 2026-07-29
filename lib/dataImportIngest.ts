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

/** Synthetic column we inject a file-order sequence into (see numberRoutingOpsInFileOrder). */
export const SYNTHETIC_SEQ_COLUMN = '__jigged_seq';

/**
 * Give routing operations a stable step number when the CSV has no sequence column.
 *
 * Without this, the server auto-numbers each part's operations PER 500-row batch, resetting the
 * counter every batch — so a part whose steps straddle a batch boundary gets renumbered and the
 * re-import upsert (keyed on routing_id, sequence) either collides or overwrites the wrong row.
 * We have the whole file here, so we number each part's ops by their order across the ENTIRE
 * file, up front, and hand the server an explicit `sequence` — the same thing it was trying to
 * derive, done once instead of per batch. File order = operation order for essentially every
 * routing export; if it isn't, the user maps their real step-order column at the Map step (which
 * takes precedence — this only fires when `sequence` is unmapped). Mutates `rows` + `mappings`.
 */
function numberRoutingOpsInFileOrder(
  rows: Record<string, string>[],
  wf: WorkingFile,
  mappings: Record<string, string>,
): void {
  const partCol = wf.columnRoles['part_name'];
  if (!partCol) return; // can't group without a part; server falls back to per-batch numbering
  const nextSeq = new Map<string, number>();
  for (const row of rows) {
    const key = (row[partCol] ?? '').trim().toLowerCase();
    if (!key) continue;
    const n = (nextSeq.get(key) ?? 0) + 1;
    nextSeq.set(key, n);
    row[SYNTHETIC_SEQ_COLUMN] = String(n);
  }
  mappings[SYNTHETIC_SEQ_COLUMN] = 'sequence';
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
        // Must run BEFORE chunk() — the whole file is needed to number across batch boundaries.
        if (entity === 'routings' && !wf.columnRoles['sequence']) {
          numberRoutingOpsInFileOrder(rows, wf, mappings);
        }
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
  /** Parts whose mapped quantity was not written because the part is location-tracked — its
   *  balance is a rollup of part_location_stock and is set by a count or at a location. The
   *  rest of the row imported fine, so this is a notice, not an error. */
  location_tracked_skipped?: string[];
}

/** One class of failure, grouped so "38 errors" becomes "38 rows — part not found (e.g. …)".
 *  `reason` has the row-specific bits stripped out so many rows collapse under one heading;
 *  `examples` keeps a few of the specific values back for recognition. */
export interface ImportErrorGroup {
  reason: string;
  count: number;
  examples: string[];
}

export interface EntityResult {
  entity: EntityType;
  created: number;
  updated: number;
  skipped: number;
  errorCount: number; // rows that failed to import (row-level rejections + failed-batch rows)
  errorGroups: ImportErrorGroup[];
  /** Part names whose quantity didn't land because they're location-tracked. Not an error —
   *  the parts imported, only the balance was left to a count. Surfaced so a mapped column
   *  quietly not applying never goes unreported. */
  locationTrackedSkipped: string[];
}

/** Recorded when a whole batch throws (network / 500) — carries the server's message and how
 *  many rows went down with it, so the summary can say what happened and to how many rows. */
export interface BatchFailure {
  message: string;
  rows: number;
}

type BatchOutcome = { entity: EntityType; response: ExecuteResponseShape | null; failure?: BatchFailure };

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : null;

/** The human reason a route gave for rejecting a row — every importer uses `reason`, some
 *  `message`. */
function rowErrorReason(e: unknown): string {
  const o = asRecord(e);
  const r = o && (o.reason ?? o.message);
  return typeof r === 'string' && r.trim() ? r.trim() : 'Could not be imported';
}

/** Strip the row-specific bits so many rows group under one heading:
 *  "Part 'ABC-123' not found at execute time" and "Part 'DEF' not found …" → "Part not found". */
function reasonHeading(reason: string): string {
  return reason
    .replace(/\s*'[^']*'/g, '') // drop quoted values: "Part 'ABC' not found" → "Part not found"
    .replace(/\s*\((?:parent|child)=[^)]*\)/gi, '') // drop "(parent=…, child=…)"
    .replace(/\s+at execute time/gi, '') // internal jargon
    .replace(/\s+for row\b/gi, '')
    .replace(/\.\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A specific value to show back — the quoted value in the reason (the failing part name),
 *  else the first non-empty field of the row's data. */
function reasonExample(e: unknown, reason: string): string | null {
  const q = reason.match(/'([^']+)'/);
  if (q) return q[1];
  const data = asRecord(asRecord(e)?.data);
  if (data) {
    for (const v of Object.values(data)) {
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return null;
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

/** Aggregate per-batch responses (each paired with its entity) into one summary — including
 *  a grouped, human-readable breakdown of WHY rows failed, so the summary never shows a bare
 *  error count with no cause or next step. */
export function summarizeResults(results: BatchOutcome[]): ImportSummary {
  const byEntity = new Map<EntityType, EntityResult>();
  // entity -> reasonHeading -> { count, examples }
  const groups = new Map<EntityType, Map<string, { count: number; examples: string[] }>>();
  let failed = false;

  const addGroup = (entity: EntityType, reason: string, count: number, example: string | null) => {
    let g = groups.get(entity);
    if (!g) {
      g = new Map();
      groups.set(entity, g);
    }
    const cur = g.get(reason) ?? { count: 0, examples: [] };
    cur.count += count;
    if (example && cur.examples.length < 6 && !cur.examples.includes(example)) cur.examples.push(example);
    g.set(reason, cur);
  };

  for (const { entity, response, failure } of results) {
    const e =
      byEntity.get(entity) ??
      {
        entity,
        created: 0,
        updated: 0,
        skipped: 0,
        errorCount: 0,
        errorGroups: [],
        locationTrackedSkipped: [],
      };
    if (response === null) {
      failed = true;
      if (failure) {
        // A whole batch went down — every row in it failed.
        e.errorCount += failure.rows;
        addGroup(entity, reasonHeading(failure.message), failure.rows, null);
      } else {
        e.errorCount += 1;
        addGroup(entity, 'A batch could not be sent to the server', 1, null);
      }
    } else {
      e.created += createdOf(response);
      e.updated += response.updated_count ?? 0;
      e.skipped += response.skipped_count ?? 0;
      for (const name of response.location_tracked_skipped ?? []) {
        if (!e.locationTrackedSkipped.includes(name)) e.locationTrackedSkipped.push(name);
      }
      const errs = response.errors ?? [];
      e.errorCount += errs.length;
      for (const er of errs) {
        const reason = rowErrorReason(er);
        addGroup(entity, reasonHeading(reason), 1, reasonExample(er, reason));
      }
    }
    byEntity.set(entity, e);
  }

  for (const [entity, g] of groups) {
    const e = byEntity.get(entity);
    if (e) {
      e.errorGroups = [...g.entries()]
        .map(([reason, v]) => ({ reason, count: v.count, examples: v.examples }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
    }
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

  const results: BatchOutcome[] = [];
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
    } catch (err) {
      failed = true;
      // Keep the server's reason (postJson throws Error(detail)) and the row count, so the
      // summary can say what failed and to how many rows — not just "N errors".
      const message = err instanceof Error && err.message ? err.message : 'The import could not reach the server';
      results.push({ entity: batch.entity, response: null, failure: { message, rows: batch.rows.length } });
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
