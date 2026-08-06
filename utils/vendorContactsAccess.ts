/**
 * Access functions for vendor_contacts.
 *
 * The is_primary invariant (at most one primary per vendor) is enforced at
 * the DB level by the vendor_contacts_one_primary partial unique index.
 * The helpers below clear any existing primary for the vendor BEFORE
 * inserting/updating a new primary, so the UI never trips the constraint.
 *
 * Note: there's a tiny race window between the UPDATE that clears existing
 * primaries and the INSERT/UPDATE that sets the new primary — two concurrent
 * "set primary" requests could in theory both succeed at the clear step and
 * then race the insert. In that case the partial unique index fires and one
 * of the two requests gets a 23505. We surface a friendly error there rather
 * than wrapping the two statements in a transaction (the supabase-js client
 * doesn't expose multi-statement transactions). In practice this is fine
 * because the UI is single-user-per-vendor at any given moment.
 */

import { getSupabase } from '@/lib/supabase';
import type { Database } from '@/types/database';
import type {
  VendorContact,
  VendorContactFormData,
} from '@/types/vendorContact';

const VENDOR_CONTACT_COLUMNS =
  'id, vendor_id, name, role, role_label, email, phone, is_primary, created_at, updated_at';

// Narrow the form-derived insert; vendor_id is added at the call site.
type VendorContactInsert = Database['public']['Tables']['vendor_contacts']['Insert'];

function formDataToInsert(
  formData: VendorContactFormData,
): Omit<VendorContactInsert, 'vendor_id'> {
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
 * Get all contacts for a vendor.
 * Ordered: primary first (is_primary DESC), then by creation order.
 */
export async function getContactsForVendor(
  vendorId: string,
): Promise<VendorContact[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('vendor_contacts')
    .select(VENDOR_CONTACT_COLUMNS)
    .eq('vendor_id', vendorId)
    .order('is_primary', { ascending: false })
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Error fetching vendor contacts:', error);
    throw error;
  }
  return (data || []) as VendorContact[];
}

/**
 * Clear is_primary on all contacts for a vendor (used before flipping a
 * different contact to primary). No-op if nothing was primary.
 */
async function clearPrimaryForVendor(vendorId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('vendor_contacts')
    .update({ is_primary: false })
    .eq('vendor_id', vendorId)
    .eq('is_primary', true);
  if (error) {
    console.error('Error clearing primary contact:', error);
    throw error;
  }
}

/**
 * Create a new contact for a vendor.
 *
 * If formData.is_primary=true, clears any existing primary contact for the
 * vendor first (see file header for the race-window note).
 */
export async function createVendorContact(
  vendorId: string,
  formData: VendorContactFormData,
): Promise<VendorContact> {
  const supabase = getSupabase();

  if (formData.is_primary) {
    await clearPrimaryForVendor(vendorId);
  }

  const { data, error } = await supabase
    .from('vendor_contacts')
    .insert({ vendor_id: vendorId, ...formDataToInsert(formData) })
    .select(VENDOR_CONTACT_COLUMNS)
    .single();

  if (error) {
    if (error.code === '23505') {
      throw new Error(
        'Another contact for this vendor was just marked primary. Refresh and try again.',
      );
    }
    console.error('Error creating vendor contact:', error);
    throw error;
  }
  return data as VendorContact;
}

/**
 * Update an existing contact.
 *
 * If formData.is_primary=true, clears any existing primary contact for the
 * same vendor first (excluding this row, so flipping the already-primary
 * row's other fields doesn't bounce its own is_primary off and back on).
 */
export async function updateVendorContact(
  contactId: string,
  formData: VendorContactFormData,
): Promise<VendorContact> {
  const supabase = getSupabase();

  if (formData.is_primary) {
    // Need vendor_id to scope the clear. Cheap single-row read.
    const { data: existing, error: fetchError } = await supabase
      .from('vendor_contacts')
      .select('vendor_id')
      .eq('id', contactId)
      .single();
    if (fetchError) {
      console.error('Error fetching vendor contact for update:', fetchError);
      throw fetchError;
    }
    const vendorId = (existing as { vendor_id: string }).vendor_id;

    const { error: clearError } = await supabase
      .from('vendor_contacts')
      .update({ is_primary: false })
      .eq('vendor_id', vendorId)
      .eq('is_primary', true)
      .neq('id', contactId);
    if (clearError) {
      console.error('Error clearing primary contact:', clearError);
      throw clearError;
    }
  }

  const { data, error } = await supabase
    .from('vendor_contacts')
    .update({
      ...formDataToInsert(formData),
      updated_at: new Date().toISOString(),
    })
    .eq('id', contactId)
    .select(VENDOR_CONTACT_COLUMNS)
    .single();

  if (error) {
    if (error.code === '23505') {
      throw new Error(
        'Another contact for this vendor was just marked primary. Refresh and try again.',
      );
    }
    console.error('Error updating vendor contact:', error);
    throw error;
  }
  return data as VendorContact;
}

export async function deleteVendorContact(contactId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('vendor_contacts')
    .delete()
    .eq('id', contactId);
  if (error) {
    console.error('Error deleting vendor contact:', error);
    throw error;
  }
}

/**
 * Convenience: clear all is_primary for the vendor, then flip the named
 * contact to primary. Used by the "Set as primary" affordance on a
 * non-primary contact row.
 */
export async function setPrimaryContact(
  vendorId: string,
  contactId: string,
): Promise<void> {
  const supabase = getSupabase();

  await clearPrimaryForVendor(vendorId);

  const { error } = await supabase
    .from('vendor_contacts')
    .update({ is_primary: true, updated_at: new Date().toISOString() })
    .eq('id', contactId);
  if (error) {
    if (error.code === '23505') {
      throw new Error(
        'Another contact for this vendor was just marked primary. Refresh and try again.',
      );
    }
    console.error('Error setting primary contact:', error);
    throw error;
  }
}
