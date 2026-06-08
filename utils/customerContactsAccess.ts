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

import { getTypedSupabase as getSupabase } from '@/lib/supabase';
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
  'id, customer_id, name, role, role_label, email, phone, is_primary, created_at, updated_at';

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
 * Get all contacts for a customer.
 * Ordered: primary first (is_primary DESC), then by creation order.
 */
export async function getContactsForCustomer(
  customerId: string,
): Promise<CustomerContact[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('customer_contacts')
    .select(CUSTOMER_CONTACT_COLUMNS)
    .eq('customer_id', customerId)
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
    throw error;
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
    throw error;
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
    throw error;
  }
  return data as CustomerContact;
}

export async function deleteCustomerContact(contactId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('customer_contacts')
    .delete()
    .eq('id', contactId);
  if (error) {
    console.error('Error deleting customer contact:', error);
    throw new Error(
      friendlyErrorMessage(error, {
        entity: 'contact',
        fallback: 'Failed to delete contact.',
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
    throw error;
  }
}
