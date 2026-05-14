export interface Customer {
  id: string;
  company_id: string;
  name: string;
  website: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A single address for a customer. A customer can have multiple addresses;
 * each one is tagged as billing, shipping, or both, with one default per
 * role. See migration 20260515_customer_addresses.sql.
 */
export interface CustomerAddress {
  id: string;
  customer_id: string;
  label: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  is_billing: boolean;
  is_shipping: boolean;
  is_default_billing: boolean;
  is_default_shipping: boolean;
  created_at?: string;
  updated_at?: string;
}

/**
 * Address fields the form edits. Excludes server-managed identity and
 * timestamps so the form can build new addresses and patch existing ones
 * through the same shape.
 */
export interface CustomerAddressFormData {
  /** Present for existing addresses, absent for newly-added rows. */
  id?: string;
  label: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  is_billing: boolean;
  is_shipping: boolean;
  is_default_billing: boolean;
  is_default_shipping: boolean;
}

export interface CustomerFormData {
  name: string;
  website: string;
  contact_name: string;
  contact_phone: string;
  contact_email: string;
  addresses: CustomerAddressFormData[];
}

export type CustomerFilter = 'all' | 'active' | 'inactive';

export interface CustomerWithRelations extends Customer {
  addresses: CustomerAddress[];
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
  label: '',
  address_line1: '',
  address_line2: '',
  city: '',
  state: '',
  postal_code: '',
  country: 'USA',
  is_billing: true,
  is_shipping: true,
  is_default_billing: true,
  is_default_shipping: true,
};

export const EMPTY_CUSTOMER_FORM: CustomerFormData = {
  name: '',
  website: '',
  contact_name: '',
  contact_phone: '',
  contact_email: '',
  addresses: [{ ...EMPTY_CUSTOMER_ADDRESS }],
};

export function customerToFormData(
  customer: Customer,
  addresses: CustomerAddress[],
): CustomerFormData {
  return {
    name: customer.name,
    website: customer.website || '',
    contact_name: customer.contact_name || '',
    contact_phone: customer.contact_phone || '',
    contact_email: customer.contact_email || '',
    addresses: addresses.map((a) => ({
      id: a.id,
      label: a.label ?? '',
      address_line1: a.address_line1 ?? '',
      address_line2: a.address_line2 ?? '',
      city: a.city ?? '',
      state: a.state ?? '',
      postal_code: a.postal_code ?? '',
      country: a.country ?? 'USA',
      is_billing: a.is_billing,
      is_shipping: a.is_shipping,
      is_default_billing: a.is_default_billing,
      is_default_shipping: a.is_default_shipping,
    })),
  };
}
