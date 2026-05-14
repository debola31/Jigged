export interface Customer {
  id: string;
  company_id: string;
  name: string;
  website: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A single address for a customer. A customer can have multiple addresses;
 * at most one is tagged as billing and at most one as shipping (the same
 * row can be both — the common case). See migration
 * 20260515_customer_addresses.sql + the 20260516 relax follow-up.
 *
 * Roles are optional — a row with neither flag set is allowed.
 */
export interface CustomerAddress {
  id: string;
  customer_id: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  is_billing: boolean;
  is_shipping: boolean;
  created_at?: string;
  updated_at?: string;
}

/**
 * Address fields the form/modal edits. Excludes server-managed identity and
 * timestamps so create and update can use the same shape.
 */
export interface CustomerAddressFormData {
  /** Present for existing addresses, absent for newly-added rows. */
  id?: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  is_billing: boolean;
  is_shipping: boolean;
}

/**
 * Form data captured on the create/edit Customer page. Contacts and
 * addresses are NOT included here — they're managed via dedicated modals
 * on the customer detail page (mirrors the vendor pattern). The create
 * flow optionally captures one initial contact, passed alongside this
 * form data to createCustomer().
 */
export interface CustomerFormData {
  name: string;
  website: string;
}

export type CustomerFilter = 'all' | 'active' | 'inactive';

export interface CustomerWithRelations extends Customer {
  addresses: CustomerAddress[];
  /** Primary contact only — list/detail pages fetch the full list separately. */
  primary_contact: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
  } | null;
  quotes_count: number;
  jobs_count: number;
}

export interface CustomerWithAddresses extends Customer {
  addresses: CustomerAddress[];
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: { row: number; reason: string }[];
}

export const EMPTY_CUSTOMER_ADDRESS: CustomerAddressFormData = {
  address_line1: '',
  address_line2: '',
  city: '',
  state: '',
  postal_code: '',
  country: 'USA',
  is_billing: true,
  is_shipping: true,
};

export const EMPTY_CUSTOMER_FORM: CustomerFormData = {
  name: '',
  website: '',
};

export function customerToFormData(customer: Customer): CustomerFormData {
  return {
    name: customer.name,
    website: customer.website || '',
  };
}
