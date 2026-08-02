/**
 * CustomerContact — one person at a customer.
 *
 * Mirrors VendorContact (see types/vendorContact.ts). Replaces the single
 * embedded contact_name / contact_email / contact_phone columns that
 * customers used to carry — each customer can now have many contacts; at
 * most one is `is_primary` (enforced by the customer_contacts_one_primary
 * partial unique index — the access layer's helpers clear any existing
 * primary before flipping a new row to primary, so the UI never trips the
 * constraint).
 */

export type CustomerContactRole =
  | 'buyer'
  | 'accounts_payable'
  | 'engineering'
  | 'quality'
  | 'shipping_receiving'
  | 'other';

/**
 * Ordered list of valid roles, with display labels for the role <Select>.
 * 'buyer' comes first because it's the most common customer contact role
 * (the relationship inverts from vendors — we sell TO customers, so their
 * primary contact is usually a buyer/purchasing manager).
 */
export const CUSTOMER_CONTACT_ROLES: ReadonlyArray<{
  value: CustomerContactRole;
  label: string;
}> = [
  { value: 'buyer', label: 'Buyer / Purchasing' },
  { value: 'accounts_payable', label: 'Accounts payable' },
  { value: 'engineering', label: 'Engineering' },
  { value: 'quality', label: 'Quality' },
  { value: 'shipping_receiving', label: 'Shipping & receiving' },
  { value: 'other', label: 'Other' },
];

export interface CustomerContact {
  id: string;
  customer_id: string;
  name: string;
  role: CustomerContactRole;
  /** Free-text label used when role='other' (DB CHECK enforces non-null/non-empty). */
  role_label: string | null;
  email: string | null;
  phone: string | null;
  /** Who we call about the work. */
  is_primary: boolean;
  /**
   * Who invoices go to. Separate from `is_primary` on purpose — at most shops
   * the buyer and the AP clerk are two different people, and one flag forces
   * the shop to lose one of them. Nothing falls back to the primary when this
   * is unset; a customer is allowed to have no billing contact.
   */
  is_billing_default: boolean;
  /** Archive marker. A contact who left the company stops being offered. */
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CustomerContactFormData {
  name: string;
  role: CustomerContactRole;
  /** Required (and only meaningful) when role='other'. */
  role_label: string;
  email: string;
  phone: string;
  is_primary: boolean;
}

export const EMPTY_CUSTOMER_CONTACT_FORM: CustomerContactFormData = {
  name: '',
  role: 'buyer',
  role_label: '',
  email: '',
  phone: '',
  is_primary: false,
};

export function customerContactToFormData(
  contact: CustomerContact,
): CustomerContactFormData {
  return {
    name: contact.name,
    role: contact.role,
    role_label: contact.role_label || '',
    email: contact.email || '',
    phone: contact.phone || '',
    is_primary: contact.is_primary,
  };
}

/**
 * Friendly label for a contact's role.
 *
 * - For role='other', returns "Other (Foo Bar)" if role_label is set, or
 *   just "Other" as a fallback (the CHECK constraint should make the
 *   fallback unreachable in practice).
 * - For other roles, returns the matching display label, falling back to
 *   the raw enum value if the role somehow isn't in the list.
 */
export function roleDisplayLabel(
  contact: Pick<CustomerContact, 'role' | 'role_label'>,
): string {
  if (contact.role === 'other') {
    return contact.role_label ? `Other (${contact.role_label})` : 'Other';
  }
  const match = CUSTOMER_CONTACT_ROLES.find((r) => r.value === contact.role);
  return match ? match.label : contact.role;
}
