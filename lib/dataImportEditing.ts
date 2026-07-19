/**
 * Working-dataset model for Phase 2 guided remediation (increment 1: edit + live re-analyze
 * + undo). The uploaded rows already live in the browser; edits mutate this in-memory model
 * and the client re-runs the analyzer, so the review updates instantly with no server round
 * trip and no size limit — the same client-heavy property as Phase 1. Pure + testable; the
 * grid/wizard wire these together with analyzeBundle().
 */

import type { AnalyzedFile } from '@/lib/dataImportAnalyzer';
import type { EntityType, FileClassification, UploadedFilePayload } from '@/types/data-import';

/** A row with a stable id so edits/undo target the right row regardless of sort/filter. */
export type EditableRow = Record<string, string> & { __rowId: string };

export interface WorkingFile {
  filename: string;
  entityType: EntityType;
  entityConfidence?: number; // 0-1 from the AI structure step; 1 once the owner confirms
  columnRoles: Record<string, string>; // canonical_field -> raw_header (from the AI structure step)
  headers: string[];
  rows: EditableRow[];
}

export interface CellEdit {
  fileIndex: number;
  rowId: string;
  colId: string;
  oldValue: string;
  newValue: string;
}

/**
 * Records the owner creates *inside* Jigged rather than going back to their source system —
 * e.g. the work centers their routings mention that never made it into the work-centers
 * export. Self-describing so {@link invertOp} can undo it without a snapshot: the builder
 * reads the current working set and records exactly what it had to introduce (a whole file,
 * some new headers, the rows), and undo removes precisely that much.
 */
export interface AddRecordsOp {
  filename: string; // target file — existing, or created when `createFile`
  entityType: EntityType;
  createFile: boolean; // no file held this entity, so the op introduces one
  addHeaders: string[]; // headers absent from the target file today
  addRoles: Record<string, string>; // canonical_field -> raw_header, only the NEW roles
  rows: EditableRow[];
}

/** The inverse of an {@link AddRecordsOp} — only ever produced by {@link invertOp}. */
export interface RemoveRecordsOp {
  filename: string;
  removeFile: boolean;
  removeHeaders: string[];
  removeRoleKeys: string[];
  rowIds: string[];
}

/**
 * One undoable remediation step = a labeled batch of cell edits, plus (optionally) records
 * created in-app. A single grid edit is a batch of one; a bulk find-replace / fill / merge /
 * create-missing is a batch of many that undoes as a unit. The label is the "we changed this
 * for you" audit line. This is the shape the (future) agent proposes and the UI applies —
 * one action layer.
 */
export interface EditOp {
  label: string;
  edits: CellEdit[];
  addRecords?: AddRecordsOp[];
  removeRecords?: RemoveRecordsOp[];
}

/** Apply a batch of edits, then any structural add/remove, in order. */
export function applyOp(working: WorkingFile[], op: EditOp): WorkingFile[] {
  let w = op.edits.reduce((acc, e) => applyEdit(acc, e), working);
  for (const a of op.addRecords ?? []) w = applyAddRecords(w, a);
  for (const r of op.removeRecords ?? []) w = applyRemoveRecords(w, r);
  return w;
}

/**
 * Invert a batch for undo/redo (reverse order, each edit inverted; adds become removes).
 * Redo re-applies the ORIGINAL op, so a `removeRecords` never needs inverting.
 */
export function invertOp(op: EditOp): EditOp {
  return {
    label: op.label,
    edits: [...op.edits].reverse().map(invertEdit),
    removeRecords: (op.addRecords ?? []).map((a) => ({
      filename: a.filename,
      removeFile: a.createFile,
      removeHeaders: a.addHeaders,
      removeRoleKeys: Object.keys(a.addRoles),
      rowIds: a.rows.map((r) => r.__rowId),
    })),
  };
}

function applyAddRecords(working: WorkingFile[], a: AddRecordsOp): WorkingFile[] {
  const idx = working.findIndex((wf) => wf.filename === a.filename);
  if (idx === -1) {
    return [
      ...working,
      {
        filename: a.filename,
        entityType: a.entityType,
        entityConfidence: 1, // the owner explicitly asked for these records
        columnRoles: { ...a.addRoles },
        headers: [...a.addHeaders],
        rows: [...a.rows],
      },
    ];
  }
  return working.map((wf, i) =>
    i !== idx
      ? wf
      : {
          ...wf,
          headers: [...wf.headers, ...a.addHeaders.filter((h) => !wf.headers.includes(h))],
          columnRoles: { ...wf.columnRoles, ...a.addRoles },
          rows: [...wf.rows, ...a.rows],
        },
  );
}

function applyRemoveRecords(working: WorkingFile[], r: RemoveRecordsOp): WorkingFile[] {
  if (r.removeFile) return working.filter((wf) => wf.filename !== r.filename);
  const ids = new Set(r.rowIds);
  const heads = new Set(r.removeHeaders);
  return working.map((wf) => {
    if (wf.filename !== r.filename) return wf;
    const columnRoles = { ...wf.columnRoles };
    for (const k of r.removeRoleKeys) delete columnRoles[k];
    return {
      ...wf,
      headers: wf.headers.filter((h) => !heads.has(h)),
      columnRoles,
      rows: wf.rows.filter((row) => !ids.has(row.__rowId)),
    };
  });
}

/** Build the editable working set from the uploaded files + the AI structure classification. */
export function buildWorkingFiles(
  files: UploadedFilePayload[],
  structureFiles: FileClassification[],
): WorkingFile[] {
  const byName = new Map(structureFiles.map((f) => [f.filename, f]));
  return files.map((f) => {
    const fc = byName.get(f.filename);
    return {
      filename: f.filename,
      entityType: (fc?.entity_type ?? 'unknown') as EntityType,
      entityConfidence: fc?.entity_confidence ?? 0,
      columnRoles: fc?.column_roles ?? {},
      headers: f.headers,
      // Stable id = filename + original row index; deterministic (no random).
      rows: f.rows.map((r, i) => ({ ...r, __rowId: `${f.filename}#${i}` })),
    };
  });
}

/** Apply one cell edit immutably (new array + new row object for the edited row only). */
export function applyEdit(working: WorkingFile[], edit: CellEdit): WorkingFile[] {
  return working.map((wf, fi) => {
    if (fi !== edit.fileIndex) return wf;
    return {
      ...wf,
      rows: wf.rows.map((row) => (row.__rowId === edit.rowId ? { ...row, [edit.colId]: edit.newValue } : row)),
    };
  });
}

/** Invert an edit (for undo/redo). */
export function invertEdit(edit: CellEdit): CellEdit {
  return { ...edit, oldValue: edit.newValue, newValue: edit.oldValue };
}

/** Feed the working set to the deterministic analyzer. */
export function workingToAnalyzed(working: WorkingFile[]): AnalyzedFile[] {
  return working.map((wf) => ({
    filename: wf.filename,
    entityType: wf.entityType,
    columnRoles: wf.columnRoles,
    rows: wf.rows,
    headers: wf.headers,
  }));
}

// --- Map stage: confirm/correct entity + column mapping (immutable) ---------

/** Re-classify a file (Map stage "this file is…" picker). */
export function setWorkingEntity(
  working: WorkingFile[],
  fileIndex: number,
  entityType: EntityType,
): WorkingFile[] {
  // The owner just told us what it is → treat as confirmed.
  return working.map((wf, i) => (i === fileIndex ? { ...wf, entityType, entityConfidence: 1 } : wf));
}

/** Point a canonical field at a raw header, or clear it when `rawHeader` is empty. */
export function setWorkingRole(
  working: WorkingFile[],
  fileIndex: number,
  field: string,
  rawHeader: string,
): WorkingFile[] {
  return working.map((wf, i) => {
    if (i !== fileIndex) return wf;
    const columnRoles = { ...wf.columnRoles };
    if (rawHeader) columnRoles[field] = rawHeader;
    else delete columnRoles[field];
    return { ...wf, columnRoles };
  });
}

/** Snapshot the confirmed working set back into FileClassification[] for the review model.
 *  entity_confidence is 1 — the owner confirmed it in the Map stage. */
export function workingToClassification(working: WorkingFile[]): FileClassification[] {
  return working.map((wf) => ({
    filename: wf.filename,
    entity_type: wf.entityType,
    entity_confidence: 1,
    headers: wf.headers,
    row_count: wf.rows.length,
    column_roles: wf.columnRoles,
  }));
}
