import type { VendorContact } from './vendorContact';

/**
 * Vendor record from database.
 *
 * No capability flags. A vendor's role is derived from references:
 * - "Supplies materials" iff at least one part lists this vendor as
 *   `preferred_vendor_id`.
 * - "Performs outside operations" iff at least one `vendor_services` row
 *   belongs to it.
 *
 * A vendor row is now just identity. Contacts live in `vendor_contacts`,
 * addresses in `vendor_addresses`, services in `vendor_services` — each 1-to-many,
 * so none of them is limited to one. The embedded contact columns went in
 * 20260504; the six embedded address columns went in 20260824, for the same
 * reason: a shop with two plants had nowhere to say so.
 */
export interface Vendor {
  id: string;
  company_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

/** The vendor row itself — name only. Addresses are edited separately. */
export interface VendorFormData {
  name: string;
}

/**
 * One postal address for a vendor. Mirrors `CustomerAddress` minus the
 * billing/shipping split: nothing in the product yet distinguishes where parts
 * go from where payment goes, so there is one `is_default` rather than two
 * flags nobody would keep true.
 */
export interface VendorAddress {
  id: string;
  vendor_id: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  attention_to: string | null;
  is_default: boolean;
  created_at?: string;
  updated_at?: string;
}

/** What the address form edits — no row id, no timestamps, so create and
 *  update share one shape. */
export interface VendorAddressFormData {
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  attention_to: string;
  is_default: boolean;
}

export const EMPTY_VENDOR_ADDRESS_FORM: VendorAddressFormData = {
  address_line1: '',
  address_line2: '',
  city: '',
  state: '',
  postal_code: '',
  country: 'USA',
  attention_to: '',
  is_default: false,
};

export function vendorAddressToFormData(a: VendorAddress): VendorAddressFormData {
  return {
    address_line1: a.address_line1 || '',
    address_line2: a.address_line2 || '',
    city: a.city || '',
    state: a.state || '',
    postal_code: a.postal_code || '',
    country: a.country || 'USA',
    attention_to: a.attention_to || '',
    is_default: a.is_default,
  };
}

/** One line for a list cell or a header — "Detroit, MI". */
export function formatVendorLocation(a: VendorAddress | null | undefined): string {
  if (!a) return '—';
  const parts = [a.city, a.state].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : '—';
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
  /** The `is_default` address, or null — a vendor may have none. */
  default_address: VendorAddress | null;
}

export const EMPTY_VENDOR_FORM: VendorFormData = {
  name: '',
};

export function vendorToFormData(vendor: Vendor): VendorFormData {
  return { name: vendor.name };
}
