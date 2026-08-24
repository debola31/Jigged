/**
 * Vendor Service — a process an outside vendor performs on your parts
 * (anodize, heat treat, wire EDM).
 *
 * These were `work_centers` rows carrying `kind='external'` until the split.
 * They are not work centres: a work centre is a place in YOUR shop, and no shop
 * owner cares which cell inside the plater's building does the work. A service
 * is owned by the vendor that performs it, and `name` is the PROCESS —
 * "Anodize", not "PerformCoat of Michigan LLC". The vendor is the parent.
 *
 * `UNIQUE (vendor_id, name)`, so two vendors may both offer "Anodize" while one
 * vendor may not list it twice.
 */
export interface VendorService {
  id: string;
  company_id: string;
  vendor_id: string;
  name: string;
  description: string | null;
  /**
   * Price per piece the vendor charges. INHERITED by routing operations: cost
   * reads `COALESCE(routing_operations.external_unit_price, unit_price)`,
   * exactly as an internal op reads
   * `COALESCE(labor_rate_override, work_centers.labor_rate)`. Raising it moves
   * every step that has not overridden it.
   *
   * NULL means "not set", which makes a part unpriceable rather than free.
   */
  unit_price: number | null;
  created_at: string;
  updated_at: string;
}

export interface VendorServiceFormData {
  name: string;
  unit_price: string;
  description: string;
}

export const EMPTY_VENDOR_SERVICE_FORM: VendorServiceFormData = {
  name: '',
  unit_price: '',
  description: '',
};

export function vendorServiceToFormData(service: VendorService): VendorServiceFormData {
  return {
    name: service.name,
    unit_price: service.unit_price !== null ? String(service.unit_price) : '',
    description: service.description || '',
  };
}
