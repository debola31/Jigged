import type { ShippingArrangement } from '@/types/shipment';

export interface Customer {
  id: string;
  company_id: string;
  name: string;
  website: string | null;
  /** Shipping defaults — populated via the customer-detail UI in PR 7. */
  default_shipping_arrangement: ShippingArrangement | null;
  default_carrier: string | null;
  default_coc_text: string | null;
  // created_at / updated_at have DEFAULT now() but no NOT NULL constraint —
  // mirror the DB shape. Consumers (e.g. the customer detail page) already
  // handle null via formatDate(string | null).
  created_at: string | null;
  updated_at: string | null;
}

/**
 * A single address for a customer. A customer can have multiple addresses;
 * at most one is the default billing address and at most one is the default
 * shipping address (the same row can be both — the common case). See
 * migration 20260515_customer_addresses.sql + the 20260516 relax follow-up,
 * and 20260519 for the rename from is_billing/is_shipping.
 *
 * Default flags are optional — a row with neither set is allowed (a saved
 * address that isn't currently the default for anything).
 *
 * attention_to is the optional "ATTN:" recipient line that prints above
 * the address on packing slips and on the quote PDF's Shipping Address
 * block. One column → one rendered line, no fallback chain.
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
  default_billing: boolean;
  default_shipping: boolean;
  attention_to: string | null;
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
  default_billing: boolean;
  default_shipping: boolean;
  attention_to: string;
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

/**
 * Slim contact shape carried alongside customer list/detail rows. The
 * full CustomerContact type lives in types/customerContact.ts; this slim
 * shape avoids a cross-module import in pages that only need name/role
 * for default-picking (QuoteForm) or for rendering the primary chip.
 */
export interface CustomerListContact {
  id: string;
  name: string;
  role: import('./customerContact').CustomerContactRole;
  email: string | null;
  phone: string | null;
  is_primary: boolean;
}

export interface CustomerWithRelations extends Customer {
  addresses: CustomerAddress[];
  /**
   * Full contacts list joined on the customer. Carries role so callers
   * can drive default-billing/shipping-contact pickers without a second
   * round trip. Empty array (not null) when the customer has none.
   */
  customer_contacts: CustomerListContact[];
  /** Primary contact only — convenience surface for the customers list. */
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
  default_billing: true,
  default_shipping: true,
  attention_to: '',
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
