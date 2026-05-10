/**
 * VendorContact — one person at a vendor.
 *
 * Replaces the single embedded contact_name / contact_email / contact_phone
 * columns that vendors used to carry in iteration 1. Each vendor can have
 * many contacts; at most one is `is_primary` (enforced by the
 * vendor_contacts_one_primary partial unique index — the access layer's
 * transactional helpers clear any existing primary before flipping a new row
 * to primary, so the UI never trips the constraint).
 */

export type VendorContactRole =
  | 'sales'
  | 'accounts_payable'
  | 'quality'
  | 'engineering'
  | 'shipping_receiving'
  | 'customer_service'
  | 'other';

/**
 * Ordered list of valid roles, with display labels for the role <Select>.
 * The order here is the order they render in the dropdown — `sales` first
 * because it's the most common vendor contact role (and the default for
 * the importer's primary-contact backfill).
 */
export const VENDOR_CONTACT_ROLES: ReadonlyArray<{
  value: VendorContactRole;
  label: string;
}> = [
  { value: 'sales', label: 'Sales' },
  { value: 'accounts_payable', label: 'Accounts payable' },
  { value: 'quality', label: 'Quality' },
  { value: 'engineering', label: 'Engineering' },
  { value: 'shipping_receiving', label: 'Shipping & receiving' },
  { value: 'customer_service', label: 'Customer service' },
  { value: 'other', label: 'Other' },
];

export interface VendorContact {
  id: string;
  vendor_id: string;
  name: string;
  role: VendorContactRole;
  /** Free-text label used when role='other' (DB CHECK enforces non-null/non-empty). */
  role_label: string | null;
  email: string | null;
  phone: string | null;
  is_primary: boolean;
  created_at: string;
  updated_at: string;
}

export interface VendorContactFormData {
  name: string;
  role: VendorContactRole;
  /** Required (and only meaningful) when role='other'. */
  role_label: string;
  email: string;
  phone: string;
  is_primary: boolean;
}

export const EMPTY_VENDOR_CONTACT_FORM: VendorContactFormData = {
  name: '',
  role: 'sales',
  role_label: '',
  email: '',
  phone: '',
  is_primary: false,
};

export function vendorContactToFormData(
  contact: VendorContact,
): VendorContactFormData {
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
 * - For role='other', returns "Other (Foo Bar)" if role_label is set, or just
 *   "Other" as a fallback (the CHECK constraint should make the fallback
 *   unreachable in practice).
 * - For other roles, returns the matching display label from
 *   VENDOR_CONTACT_ROLES, falling back to the raw enum value if the role
 *   somehow isn't in the list (shouldn't happen — defense in depth).
 */
export function roleDisplayLabel(
  contact: Pick<VendorContact, 'role' | 'role_label'>,
): string {
  if (contact.role === 'other') {
    return contact.role_label ? `Other (${contact.role_label})` : 'Other';
  }
  const match = VENDOR_CONTACT_ROLES.find((r) => r.value === contact.role);
  return match ? match.label : contact.role;
}
