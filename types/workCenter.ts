/**
 * Work Center — a unit of IN-HOUSE production capacity: a machine, cell or
 * station with an hourly labor rate. An operator "station" IS one of these rows.
 *
 * Outsourced processes are NOT here. They were once `kind='external'` rows in
 * this table pointing at a vendor; they are now `vendor_services`, owned by the
 * vendor that performs them — see `types/vendorService.ts`. A routing operation
 * targets exactly one of the two.
 */
export interface WorkCenter {
  id: string;
  company_id: string;
  name: string;
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
}

export const EMPTY_WORK_CENTER_FORM: WorkCenterFormData = {
  name: '',
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
    labor_rate: workCenter.labor_rate !== null ? String(workCenter.labor_rate) : '',
    description: workCenter.description || '',
    make: workCenter.make || '',
    model: workCenter.model || '',
    serial_number: workCenter.serial_number || '',
    year_built: workCenter.year_built !== null ? String(workCenter.year_built) : '',
    purchased_on: workCenter.purchased_on || '',
  };
}
