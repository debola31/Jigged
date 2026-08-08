/**
 * Access functions for customer_contacts.
 *
 * Mirrors utils/vendorContactsAccess.ts. The is_primary invariant (at most
 * one primary per customer) is enforced at the DB level by the
 * customer_contacts_one_primary partial unique index. The helpers below
 * clear any existing primary BEFORE inserting/updating a new primary, so
 * the UI never trips the constraint.
 *
 * Note: there's a tiny race window between the UPDATE that clears existing
 * primaries and the INSERT/UPDATE that sets the new primary — two concurrent
 * "set primary" requests could in theory both succeed at the clear step and
 * then race the insert. In that case the partial unique index fires and one
 * of the two requests gets a 23505. We surface a friendly error rather than
 * wrapping the two statements in a transaction (the supabase-js client
 * doesn't expose multi-statement transactions). In practice this is fine
 * because the UI is single-user-per-customer at any given moment.
 */

import { getSupabase } from '@/lib/supabase';
import { toFriendlyError } from '@/lib/supabaseErrors';
import { friendlyErrorMessage } from '@/lib/supabaseErrors';
import type { Database } from '@/types/database';
import type {
  CustomerContact,
  CustomerContactFormData,
} from '@/types/customerContact';

// Narrow the form-derived insert so the typed .insert() can validate
// column names. customer_id is added at the call site.
type CustomerContactInsert = Database['public']['Tables']['customer_contacts']['Insert'];

const CUSTOMER_CONTACT_COLUMNS =
  'id, customer_id, name, role, role_label, email, phone, is_primary, is_billing_default, deleted_at, created_at, updated_at';

function formDataToInsert(
  formData: CustomerContactFormData,
): Omit<CustomerContactInsert, 'customer_id'> {
  const trimmed = (s: string) => (s.trim() === '' ? null : s.trim());
  return {
    name: formData.name.trim(),
    role: formData.role,
    // role_label is only meaningful when role='other'. Drop it for the other
    // roles so the column stays NULL (matches the DB CHECK semantics).
    role_label: formData.role === 'other' ? trimmed(formData.role_label) : null,
    email: trimmed(formData.email),
    phone: trimmed(formData.phone),
    is_primary: formData.is_primary,
  };
}

/**
 * Get a customer's LIVE contacts.
 * Ordered: primary first (is_primary DESC), then by creation order.
 *
 * Filters archived rows: this feeds the Contacts card and every picker that
 * offers a person to choose, and someone who left the company must stop being
 * offered. A document that already names an archived contact resolves it by id
 * instead — see the `deleted_at` selected in the embeds on quotesAccess /
 * jobsAccess, which the pickers use to keep a currently-selected archived row
 * visible rather than silently blanking it.
 */
export async function getContactsForCustomer(
  customerId: string,
): Promise<CustomerContact[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('customer_contacts')
    .select(CUSTOMER_CONTACT_COLUMNS)
    .eq('customer_id', customerId)
    .is('deleted_at', null)
    .order('is_primary', { ascending: false })
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Error fetching customer contacts:', error);
    throw error;
  }
  return (data || []) as CustomerContact[];
}

/**
 * Clear is_primary on all contacts for a customer (used before flipping a
 * different contact to primary). No-op if nothing was primary.
 */
async function clearPrimaryForCustomer(customerId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('customer_contacts')
    .update({ is_primary: false })
    .eq('customer_id', customerId)
    .eq('is_primary', true);
  if (error) {
    console.error('Error clearing primary contact:', error);
    throw toFriendlyError(error, { entity: 'contact' });
  }
}

/**
 * Create a new contact for a customer.
 *
 * If formData.is_primary=true, clears any existing primary contact for the
 * customer first (see file header for the race-window note).
 */
export async function createCustomerContact(
  customerId: string,
  formData: CustomerContactFormData,
): Promise<CustomerContact> {
  const supabase = getSupabase();

  if (formData.is_primary) {
    await clearPrimaryForCustomer(customerId);
  }

  const { data, error } = await supabase
    .from('customer_contacts')
    .insert({ customer_id: customerId, ...formDataToInsert(formData) })
    .select(CUSTOMER_CONTACT_COLUMNS)
    .single();

  if (error) {
    if (error.code === '23505') {
      throw new Error(
        'Another contact for this customer was just marked primary. Refresh and try again.',
      );
    }
    console.error('Error creating customer contact:', error);
    throw toFriendlyError(error, { entity: 'contact' });
  }
  return data as CustomerContact;
}

/**
 * Update an existing contact.
 */
export async function updateCustomerContact(
  contactId: string,
  formData: CustomerContactFormData,
): Promise<CustomerContact> {
  const supabase = getSupabase();

  if (formData.is_primary) {
    const { data: existing, error: fetchError } = await supabase
      .from('customer_contacts')
      .select('customer_id')
      .eq('id', contactId)
      .single();
    if (fetchError) {
      console.error('Error fetching customer contact for update:', fetchError);
      throw fetchError;
    }
    const customerId = (existing as { customer_id: string }).customer_id;

    const { error: clearError } = await supabase
      .from('customer_contacts')
      .update({ is_primary: false })
      .eq('customer_id', customerId)
      .eq('is_primary', true)
      .neq('id', contactId);
    if (clearError) {
      console.error('Error clearing primary contact:', clearError);
      throw clearError;
    }
  }

  const { data, error } = await supabase
    .from('customer_contacts')
    .update({
      ...formDataToInsert(formData),
      updated_at: new Date().toISOString(),
    })
    .eq('id', contactId)
    .select(CUSTOMER_CONTACT_COLUMNS)
    .single();

  if (error) {
    if (error.code === '23505') {
      throw new Error(
        'Another contact for this customer was just marked primary. Refresh and try again.',
      );
    }
    console.error('Error updating customer contact:', error);
    throw toFriendlyError(error, { entity: 'contact' });
  }
  return data as CustomerContact;
}

/**
 * Archive a contact. Stamps `deleted_at` — never a SQL DELETE.
 *
 * The row survives because a quote or job that named this person keeps a
 * `contact_id` pointing at it, and because "who did we deal with on this job"
 * is a question shops ask about work that finished years ago. Both documents
 * also freeze a `contact_snapshot`, so the printed block was never at risk —
 * what archiving preserves is the live link and the ability to un-archive.
 *
 * Also clears both default flags in the same write. An archived contact that
 * kept `is_primary` would hold the slot against the live partial unique index
 * and the customer could never name a new primary; the same for the billing
 * default. Archiving a person has to hand back whatever roles they held.
 */
export async function archiveCustomerContact(contactId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('customer_contacts')
    .update({
      deleted_at: new Date().toISOString(),
      is_primary: false,
      is_billing_default: false,
      updated_at: new Date().toISOString(),
    })
    .eq('id', contactId);
  if (error) {
    console.error('Error archiving customer contact:', error);
    throw new Error(
      friendlyErrorMessage(error, {
        entity: 'contact',
        fallback: 'Failed to remove contact.',
      }),
    );
  }
}

/**
 * Convenience: clear all is_primary for the customer, then flip the named
 * contact to primary. Used by the "Set as primary" affordance on a
 * non-primary contact row.
 */
export async function setPrimaryContact(
  customerId: string,
  contactId: string,
): Promise<void> {
  const supabase = getSupabase();

  await clearPrimaryForCustomer(customerId);

  const { error } = await supabase
    .from('customer_contacts')
    .update({ is_primary: true, updated_at: new Date().toISOString() })
    .eq('id', contactId);
  if (error) {
    if (error.code === '23505') {
      throw new Error(
        'Another contact for this customer was just marked primary. Refresh and try again.',
      );
    }
    console.error('Error setting primary contact:', error);
    throw toFriendlyError(error, { entity: 'contact' });
  }
}

/**
 * Clear is_billing_default across a customer's contacts, then flip the named one.
 *
 * Mirrors setPrimaryContact, including its race window (see the file header):
 * the DB index is the real guarantee, the clear-first is what keeps the UI from
 * tripping it. Passing `null` clears the billing default without naming a new
 * one — a customer is allowed to have none, and nothing falls back to the
 * primary in its absence.
 */
export async function setBillingDefaultContact(
  customerId: string,
  contactId: string | null,
): Promise<void> {
  const supabase = getSupabase();

  const { error: clearError } = await supabase
    .from('customer_contacts')
    .update({ is_billing_default: false })
    .eq('customer_id', customerId)
    .eq('is_billing_default', true);
  if (clearError) {
    console.error('Error clearing billing-default contact:', clearError);
    throw clearError;
  }

  if (!contactId) return;

  const { error } = await supabase
    .from('customer_contacts')
    .update({ is_billing_default: true, updated_at: new Date().toISOString() })
    .eq('id', contactId);
  if (error) {
    if (error.code === '23505') {
      throw new Error(
        'Another contact for this customer was just marked for billing. Refresh and try again.',
      );
    }
    console.error('Error setting billing-default contact:', error);
    throw toFriendlyError(error, { entity: 'contact' });
  }
}
