import type { VendorContact } from './vendorContact';

/**
 * Vendor record from database.
 *
 * No capability flags. A vendor's role is derived from references:
 * - "Supplies materials" iff at least one part lists this vendor as
 *   `preferred_vendor_id`.
 * - "Performs outside operations" iff at least one work_center references
 *   this vendor via `vendor_id` (kind='external').
 *
 * Contact info lives in the separate `vendor_contacts` table (1 vendor → many
 * contacts, with at most one is_primary). The single embedded
 * contact_name/contact_email/contact_phone columns and the `notes` column
 * were dropped in the 20260504_vendor_contacts_and_drop_notes migration.
 */
export interface Vendor {
  id: string;
  company_id: string;
  name: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  legacy_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface VendorFormData {
  name: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
}

/**
 * Vendor + its joined primary contact (if any). `primary_contact` is hydrated
 * by `getAllVendorsWithPrimaryContact` via a lookup against vendor_contacts
 * WHERE is_primary=true. May be null when the vendor has no contacts yet
 * (a legitimate state — see the migration's NOTICE log for vendors that
 * arrived in this state from the backfill).
 */
export interface VendorWithPrimaryContact extends Vendor {
  primary_contact: VendorContact | null;
}

export interface VendorImportResult {
  imported: number;
  skipped: number;
  errors: { row: number; reason: string }[];
}

export const EMPTY_VENDOR_FORM: VendorFormData = {
  name: '',
  address_line1: '',
  address_line2: '',
  city: '',
  state: '',
  postal_code: '',
  country: 'USA',
};

export function vendorToFormData(vendor: Vendor): VendorFormData {
  return {
    name: vendor.name,
    address_line1: vendor.address_line1 || '',
    address_line2: vendor.address_line2 || '',
    city: vendor.city || '',
    state: vendor.state || '',
    postal_code: vendor.postal_code || '',
    country: vendor.country || 'USA',
  };
}
