/**
 * Access functions for customer_addresses.
 *
 * Mirrors utils/customerContactsAccess.ts. The "at most one default billing,
 * at most one default shipping per customer" invariant is enforced at the DB
 * level by the idx_customer_addresses_one_default_billing /
 * idx_customer_addresses_one_default_shipping partial unique indexes.
 * Helpers below clear the relevant flag on the existing winner BEFORE
 * flipping a new row, so the UI never trips the constraint.
 *
 * Column-name history: prior to migration 20260519 these flags were named
 * is_billing / is_shipping. Renamed for clarity — they mark which row is
 * the DEFAULT, not a type assertion on the address.
 */

import { getSupabase } from '@/lib/supabase';
import { toFriendlyError } from '@/lib/supabaseErrors';
import { friendlyErrorMessage } from '@/lib/supabaseErrors';
import type {
  CustomerAddress,
  CustomerAddressFormData,
} from '@/types/customer';

const CUSTOMER_ADDRESS_COLUMNS =
  'id, customer_id, address_line1, address_line2, city, state, postal_code, country, default_billing, default_shipping, attention_to, created_at, updated_at';

function formDataToRow(formData: CustomerAddressFormData): Record<string, unknown> {
  const trimmed = (s: string) => (s.trim() === '' ? null : s.trim());
  return {
    address_line1: trimmed(formData.address_line1),
    address_line2: trimmed(formData.address_line2),
    city: trimmed(formData.city),
    state: trimmed(formData.state),
    postal_code: trimmed(formData.postal_code),
    country: formData.country.trim() || 'USA',
    default_billing: formData.default_billing,
    default_shipping: formData.default_shipping,
    attention_to: trimmed(formData.attention_to),
  };
}

export async function getAddressesForCustomer(
  customerId: string,
): Promise<CustomerAddress[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('customer_addresses')
    .select(CUSTOMER_ADDRESS_COLUMNS)
    .eq('customer_id', customerId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Error fetching customer addresses:', error);
    throw error;
  }
  return (data || []) as CustomerAddress[];
}

/**
 * Clear default_billing on every address row for the customer EXCEPT the
 * named one. Used before flipping a new row to default_billing.
 */
async function clearDefaultBillingForCustomer(
  customerId: string,
  exceptId?: string,
): Promise<void> {
  const supabase = getSupabase();
  let query = supabase
    .from('customer_addresses')
    .update({ default_billing: false })
    .eq('customer_id', customerId)
    .eq('default_billing', true);
  if (exceptId) query = query.neq('id', exceptId);
  const { error } = await query;
  if (error) {
    console.error('Error clearing default_billing flag:', error);
    throw toFriendlyError(error, { entity: 'address' });
  }
}

async function clearDefaultShippingForCustomer(
  customerId: string,
  exceptId?: string,
): Promise<void> {
  const supabase = getSupabase();
  let query = supabase
    .from('customer_addresses')
    .update({ default_shipping: false })
    .eq('customer_id', customerId)
    .eq('default_shipping', true);
  if (exceptId) query = query.neq('id', exceptId);
  const { error } = await query;
  if (error) {
    console.error('Error clearing default_shipping flag:', error);
    throw toFriendlyError(error, { entity: 'address' });
  }
}

export async function createCustomerAddress(
  customerId: string,
  formData: CustomerAddressFormData,
): Promise<CustomerAddress> {
  const supabase = getSupabase();

  if (formData.default_billing) await clearDefaultBillingForCustomer(customerId);
  if (formData.default_shipping) await clearDefaultShippingForCustomer(customerId);

  const { data, error } = await supabase
    .from('customer_addresses')
    .insert({ customer_id: customerId, ...formDataToRow(formData) })
    .select(CUSTOMER_ADDRESS_COLUMNS)
    .single();

  if (error) {
    if (error.code === '23505') {
      throw new Error(
        'Another address on this customer was just marked default billing or default shipping. Refresh and try again.',
      );
    }
    console.error('Error creating customer address:', error);
    throw toFriendlyError(error, { entity: 'address' });
  }
  return data as CustomerAddress;
}

export async function updateCustomerAddress(
  addressId: string,
  customerId: string,
  formData: CustomerAddressFormData,
): Promise<CustomerAddress> {
  const supabase = getSupabase();

  if (formData.default_billing) await clearDefaultBillingForCustomer(customerId, addressId);
  if (formData.default_shipping) await clearDefaultShippingForCustomer(customerId, addressId);

  const { data, error } = await supabase
    .from('customer_addresses')
    .update({
      ...formDataToRow(formData),
      updated_at: new Date().toISOString(),
    })
    .eq('id', addressId)
    .select(CUSTOMER_ADDRESS_COLUMNS)
    .single();

  if (error) {
    if (error.code === '23505') {
      throw new Error(
        'Another address on this customer was just marked default billing or default shipping. Refresh and try again.',
      );
    }
    console.error('Error updating customer address:', error);
    throw toFriendlyError(error, { entity: 'address' });
  }
  return data as CustomerAddress;
}

export async function deleteCustomerAddress(addressId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('customer_addresses')
    .delete()
    .eq('id', addressId);
  if (error) {
    console.error('Error deleting customer address:', error);
    throw new Error(
      friendlyErrorMessage(error, {
        entity: 'address',
        fallback: 'Failed to delete address.',
      }),
    );
  }
}
