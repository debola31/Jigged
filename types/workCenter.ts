/**
 * Work Center — a capacity bucket where routing operations run.
 *
 * Replaces the old `operation_types` table. Adds `kind` ('internal' | 'external')
 * so external vendor work (heat treat, coating) lives in the same table as
 * in-house machines, and the routing operation can reference either kind by
 * a single `work_center_id` column.
 */
export type WorkCenterKind = 'internal' | 'external';

export interface WorkCenter {
  id: string;
  company_id: string;
  name: string;
  kind: WorkCenterKind;
  vendor_id: string | null;
  labor_rate: number | null;
  description: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface WorkCenterFormData {
  name: string;
  kind: WorkCenterKind;
  vendor_id: string | null;
  labor_rate: string;
  description: string;
}

export interface WorkCenterWithRelations extends WorkCenter {
  routing_operations_count: number;
  vendor: { id: string; name: string } | null;
}

export interface WorkCenterImportResult {
  imported: number;
  skipped: number;
  errors: { row: number; reason: string }[];
}

export const EMPTY_WORK_CENTER_FORM: WorkCenterFormData = {
  name: '',
  kind: 'internal',
  vendor_id: null,
  labor_rate: '',
  description: '',
};

export function workCenterToFormData(workCenter: WorkCenter): WorkCenterFormData {
  return {
    name: workCenter.name,
    kind: workCenter.kind,
    vendor_id: workCenter.vendor_id,
    labor_rate: workCenter.labor_rate !== null ? String(workCenter.labor_rate) : '',
    description: workCenter.description || '',
  };
}
