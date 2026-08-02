/**
 * Manual credit standing. Two states on purpose — E2 carried three and the
 * pilot shop's quoter could not explain the third, and a state nobody can
 * define is a state nobody sets correctly.
 */
export type CustomerCreditStatus = 'open' | 'hold';

/**
 * Narrow the DB's `credit_status` to the union above.
 *
 * The column is enum-via-CHECK rather than a Postgres enum type, so the
 * generated `types/database.ts` types it as plain `string` and the typed client
 * hands us a widened value. This is the boundary where it becomes the union
 * again — done explicitly rather than with `as`, because a cast would compile
 * just as happily on a column that had genuinely drifted.
 *
 * `customers_credit_status_check` makes any other value unreachable, so the
 * fallback branch exists only to be honest about the type. It resolves to
 * 'open' deliberately: if the impossible ever happened, inventing a credit hold
 * that nobody set is worse than showing none.
 */
export function toCreditStatus(value: string | null | undefined): CustomerCreditStatus {
  return value === 'hold' ? 'hold' : 'open';
}

export interface Customer {
  id: string;
  company_id: string;
  name: string;
  website: string | null;
  /**
   * Standing terms — the customer's commercial defaults, copied onto a NEW
   * quote at create time and editable there. They are never read by an
   * existing quote at render time: a quote owns its own payment_terms /
   * lead_time_text / fob_point from the moment it is created, so editing a
   * customer here can't rewrite a document already sent. Drift between the
   * two is surfaced as a chip, never applied (mirrors PricingBasisSnapshot).
   *
   * null means "no standing agreement recorded" — the quote field is left
   * empty rather than guessed.
   */
  default_payment_terms: string | null;
  default_lead_time_text: string | null;
  /**
   * Where title and risk transfer, as free text naming a place ("FOB
   * Cleveland, OH"). Deliberately NOT an origin/destination enum, and
   * deliberately separate from who *pays* the freight — that axis lives on
   * jobs/shipments as freight_terms. Keep them apart in the UI too.
   */
  default_fob_point: string | null;
  /**
   * Manual credit standing, set by the office when a customer is past due.
   * Never computed, never synced from QuickBooks, never derived from a balance.
   *
   * WARN-ONLY. No code path may block on this: a held customer's quote, job and
   * shipment all proceed, showing a banner. Distinct from the deliberately-
   * refused numeric credit limit — if this ever grows a threshold, it has
   * become that feature.
   */
  credit_status: CustomerCreditStatus;
  /** Why they're on hold. Kept after a hold is lifted, as history for next time. */
  credit_hold_note: string | null;
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
 * Address fields the form/modal edits. Excludes server-managed identity (the
 * row id — passed separately to updateCustomerAddress) and timestamps so
 * create and update can use the same shape.
 */
export interface CustomerAddressFormData {
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
  /**
   * Standing terms. Empty string means "not set" at the form layer and is
   * normalised to NULL on write, so a cleared field genuinely clears the
   * default rather than storing '' and prefilling blanks onto every quote.
   */
  default_payment_terms: string;
  default_lead_time_text: string;
  default_fob_point: string;
  credit_status: CustomerCreditStatus;
  /** Empty string means "no reason given"; normalised to NULL on write. */
  credit_hold_note: string;
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
  is_billing_default: boolean;
  /**
   * Carried so a picker can drop archived people while keeping the one a
   * document already names — blanking a job's contact because that person left
   * would lose who the work was actually agreed with.
   */
  deleted_at: string | null;
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
  default_payment_terms: '',
  default_lead_time_text: '',
  default_fob_point: '',
  credit_status: 'open',
  credit_hold_note: '',
};

export function customerToFormData(customer: Customer): CustomerFormData {
  return {
    name: customer.name,
    website: customer.website || '',
    default_payment_terms: customer.default_payment_terms || '',
    default_lead_time_text: customer.default_lead_time_text || '',
    default_fob_point: customer.default_fob_point || '',
    credit_status: customer.credit_status,
    credit_hold_note: customer.credit_hold_note || '',
  };
}
