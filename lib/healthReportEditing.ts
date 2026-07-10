/**
 * Working-dataset model for Phase 2 guided remediation (increment 1: edit + live re-analyze
 * + undo). The uploaded rows already live in the browser; edits mutate this in-memory model
 * and the client re-runs the analyzer, so readiness updates instantly with no server round
 * trip and no size limit — the same client-heavy property as Phase 1. Pure + testable; the
 * grid/wizard wire these together with analyzeBundle().
 */

import type { AnalyzedFile } from '@/lib/healthReportAnalyzer';
import type { EntityType, FileClassification, UploadedFilePayload } from '@/types/health-report';

/** A row with a stable id so edits/undo target the right row regardless of sort/filter. */
export type EditableRow = Record<string, string> & { __rowId: string };

export interface WorkingFile {
  filename: string;
  entityType: EntityType;
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
