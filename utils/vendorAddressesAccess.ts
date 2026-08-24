import { getSupabase } from '@/lib/supabase';
import { toFriendlyError } from '@/lib/supabaseErrors';
import type { VendorAddress, VendorAddressFormData } from '@/types/vendor';

/**
 * Access layer for a vendor's addresses. Mirrors `customerAddressesAccess`.
 *
 * These are HARD-deleted, not archived, and that is deliberate rather than an
 * oversight of the soft-delete standard: an address is a field of its parent,
 * not a document anything references by id. Nothing stores a
 * `vendor_address_id`, so there is no historical reference to keep resolving —
 * which is exactly the test [architecture.md §16](../docs/architecture.md) sets
 * for archive-vs-delete. `vendor_contacts` and `customer_addresses` are deleted
 * for the same reason.
 */

const VENDOR_ADDRESS_COLUMNS =
  'id, vendor_id, address_line1, address_line2, city, state, postal_code, country, attention_to, is_default, created_at, updated_at';

function trimmed(value: string): string | null {
  return value.trim() || null;
}

function toRow(formData: VendorAddressFormData) {
  return {
    address_line1: trimmed(formData.address_line1),
    address_line2: trimmed(formData.address_line2),
    city: trimmed(formData.city),
    state: trimmed(formData.state),
    postal_code: trimmed(formData.postal_code),
    country: trimmed(formData.country),
    attention_to: trimmed(formData.attention_to),
    is_default: formData.is_default,
  };
}

/** Default first, then oldest — a stable order the UI can rely on. */
export async function getAddressesForVendor(vendorId: string): Promise<VendorAddress[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('vendor_addresses')
    .select(VENDOR_ADDRESS_COLUMNS)
    .eq('vendor_id', vendorId)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Error fetching vendor addresses:', error);
    throw error;
  }

  return (data || []) as VendorAddress[];
}

/**
 * Clear whatever default this vendor currently has, except `keepId`.
 *
 * `idx_vendor_addresses_one_default` is a UNIQUE index, so setting a second
 * default without clearing the first is a 23505, not a silent second default.
 * Clearing first is what makes "make this the default" a single user action
 * instead of two, and it is the same thing the contacts access layer does for
 * `is_primary`.
 */
async function clearOtherDefaults(vendorId: string, keepId?: string): Promise<void> {
  const supabase = getSupabase();

  let query = supabase
    .from('vendor_addresses')
    .update({ is_default: false, updated_at: new Date().toISOString() })
    .eq('vendor_id', vendorId)
    .eq('is_default', true);

  if (keepId) query = query.neq('id', keepId);

  const { error } = await query;
  if (error) {
    console.error('Error clearing vendor default address:', error);
    throw error;
  }
}

/**
 * Create an address.
 *
 * The FIRST address a vendor gets is forced default even if the form did not
 * ask for it: a vendor with addresses and no default has nothing to offer a
 * caller that wants "the" address, and nobody would think to tick a box on the
 * only row there is.
 */
export async function createVendorAddress(
  vendorId: string,
  formData: VendorAddressFormData,
): Promise<VendorAddress> {
  const supabase = getSupabase();

  const existing = await getAddressesForVendor(vendorId);
  const isDefault = formData.is_default || existing.length === 0;

  if (isDefault) await clearOtherDefaults(vendorId);

  const { data, error } = await supabase
    .from('vendor_addresses')
    .insert({ vendor_id: vendorId, ...toRow(formData), is_default: isDefault })
    .select(VENDOR_ADDRESS_COLUMNS)
    .single();

  if (error) {
    console.error('Error creating vendor address:', error);
    throw toFriendlyError(error, { entity: 'address' });
  }

  return data as VendorAddress;
}

export async function updateVendorAddress(
  addressId: string,
  vendorId: string,
  formData: VendorAddressFormData,
): Promise<VendorAddress> {
  const supabase = getSupabase();

  if (formData.is_default) await clearOtherDefaults(vendorId, addressId);

  const { data, error } = await supabase
    .from('vendor_addresses')
    .update({ ...toRow(formData), updated_at: new Date().toISOString() })
    .eq('id', addressId)
    .select(VENDOR_ADDRESS_COLUMNS)
    .single();

  if (error) {
    console.error('Error updating vendor address:', error);
    throw toFriendlyError(error, { entity: 'address' });
  }

  return data as VendorAddress;
}

/**
 * Delete an address.
 *
 * If it was the default and others remain, the oldest survivor is promoted.
 * Leaving a vendor with addresses and no default would be a state the UI has
 * no sensible reading of, arrived at by deleting the wrong row.
 */
export async function deleteVendorAddress(addressId: string, vendorId: string): Promise<void> {
  const supabase = getSupabase();

  const before = await getAddressesForVendor(vendorId);
  const removed = before.find((a) => a.id === addressId);

  const { error } = await supabase.from('vendor_addresses').delete().eq('id', addressId);
  if (error) {
    console.error('Error deleting vendor address:', error);
    throw toFriendlyError(error, { entity: 'address' });
  }

  if (!removed?.is_default) return;

  const survivor = before.find((a) => a.id !== addressId);
  if (!survivor) return;

  const { error: promoteError } = await supabase
    .from('vendor_addresses')
    .update({ is_default: true, updated_at: new Date().toISOString() })
    .eq('id', survivor.id);

  if (promoteError) {
    console.error('Error promoting vendor default address:', promoteError);
    throw promoteError;
  }
}

/** Make one address the default, clearing whatever held it. */
export async function setDefaultVendorAddress(
  addressId: string,
  vendorId: string,
): Promise<void> {
  const supabase = getSupabase();

  await clearOtherDefaults(vendorId, addressId);

  const { error } = await supabase
    .from('vendor_addresses')
    .update({ is_default: true, updated_at: new Date().toISOString() })
    .eq('id', addressId);

  if (error) {
    console.error('Error setting default vendor address:', error);
    throw toFriendlyError(error, { entity: 'address' });
  }
}
