/**
 * Vendor record from database.
 *
 * No capability flags. A vendor's role is derived from references:
 * - "Supplies materials" iff at least one part lists this vendor as
 *   `preferred_vendor_id`.
 * - "Performs outside operations" iff at least one work_center references
 *   this vendor via `vendor_id` (kind='external').
 */
export interface Vendor {
  id: string;
  company_id: string;
  name: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  notes: string | null;
  legacy_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface VendorFormData {
  name: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  notes: string;
}

export interface VendorWithDerivedRoles extends Vendor {
  supplies_materials_count: number;
  performs_outside_ops_count: number;
}

export interface VendorImportResult {
  imported: number;
  skipped: number;
  errors: { row: number; reason: string }[];
}

export const EMPTY_VENDOR_FORM: VendorFormData = {
  name: '',
  contact_name: '',
  contact_email: '',
  contact_phone: '',
  address_line1: '',
  address_line2: '',
  city: '',
  state: '',
  postal_code: '',
  country: 'USA',
  notes: '',
};

export function vendorToFormData(vendor: Vendor): VendorFormData {
  return {
    name: vendor.name,
    contact_name: vendor.contact_name || '',
    contact_email: vendor.contact_email || '',
    contact_phone: vendor.contact_phone || '',
    address_line1: vendor.address_line1 || '',
    address_line2: vendor.address_line2 || '',
    city: vendor.city || '',
    state: vendor.state || '',
    postal_code: vendor.postal_code || '',
    country: vendor.country || 'USA',
    notes: vendor.notes || '',
  };
}
