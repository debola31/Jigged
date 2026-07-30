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
  // Optional machine attributes (Machine Maintenance). Never required, never
  // prompted for, and no surface may render a machine as less ready than another
  // because these are filled in — docs/modules/machine-maintenance.md §4.5.
  make: string | null;
  model: string | null;
  serial_number: string | null;
  year_built: number | null;
  purchased_on: string | null;
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
  make: string;
  model: string;
  serial_number: string;
  year_built: string;
  purchased_on: string;
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
  make: '',
  model: '',
  serial_number: '',
  year_built: '',
  purchased_on: '',
};

export function workCenterToFormData(workCenter: WorkCenter): WorkCenterFormData {
  return {
    name: workCenter.name,
    kind: workCenter.kind,
    vendor_id: workCenter.vendor_id,
    labor_rate: workCenter.labor_rate !== null ? String(workCenter.labor_rate) : '',
    description: workCenter.description || '',
    make: workCenter.make || '',
    model: workCenter.model || '',
    serial_number: workCenter.serial_number || '',
    year_built: workCenter.year_built !== null ? String(workCenter.year_built) : '',
    purchased_on: workCenter.purchased_on || '',
  };
}
