/**
 * Access functions for customer_addresses.
 *
 * Mirrors utils/customerContactsAccess.ts. The "at most one billing, at most
 * one shipping per customer" invariant is enforced at the DB level by the
 * idx_customer_addresses_one_billing / idx_customer_addresses_one_shipping
 * partial unique indexes. Helpers below clear the relevant role on the
 * existing winner BEFORE flipping a new row to that role, so the UI never
 * trips the constraint.
 */

import { getSupabase } from '@/lib/supabase';
import type {
  CustomerAddress,
  CustomerAddressFormData,
} from '@/types/customer';

const CUSTOMER_ADDRESS_COLUMNS =
  'id, customer_id, address_line1, address_line2, city, state, postal_code, country, is_billing, is_shipping, created_at, updated_at';

function formDataToRow(formData: CustomerAddressFormData): Record<string, unknown> {
  const trimmed = (s: string) => (s.trim() === '' ? null : s.trim());
  return {
    address_line1: trimmed(formData.address_line1),
    address_line2: trimmed(formData.address_line2),
    city: trimmed(formData.city),
    state: trimmed(formData.state),
    postal_code: trimmed(formData.postal_code),
    country: formData.country.trim() || 'USA',
    is_billing: formData.is_billing,
    is_shipping: formData.is_shipping,
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
 * Clear is_billing on every address row for the customer EXCEPT the named
 * one. Used before flipping a new row to is_billing.
 */
async function clearBillingForCustomer(
  customerId: string,
  exceptId?: string,
): Promise<void> {
  const supabase = getSupabase();
  let query = supabase
    .from('customer_addresses')
    .update({ is_billing: false })
    .eq('customer_id', customerId)
    .eq('is_billing', true);
  if (exceptId) query = query.neq('id', exceptId);
  const { error } = await query;
  if (error) {
    console.error('Error clearing billing role:', error);
    throw error;
  }
}

async function clearShippingForCustomer(
  customerId: string,
  exceptId?: string,
): Promise<void> {
  const supabase = getSupabase();
  let query = supabase
    .from('customer_addresses')
    .update({ is_shipping: false })
    .eq('customer_id', customerId)
    .eq('is_shipping', true);
  if (exceptId) query = query.neq('id', exceptId);
  const { error } = await query;
  if (error) {
    console.error('Error clearing shipping role:', error);
    throw error;
  }
}

export async function createCustomerAddress(
  customerId: string,
  formData: CustomerAddressFormData,
): Promise<CustomerAddress> {
  const supabase = getSupabase();

  if (formData.is_billing) await clearBillingForCustomer(customerId);
  if (formData.is_shipping) await clearShippingForCustomer(customerId);

  const { data, error } = await supabase
    .from('customer_addresses')
    .insert({ customer_id: customerId, ...formDataToRow(formData) })
    .select(CUSTOMER_ADDRESS_COLUMNS)
    .single();

  if (error) {
    if (error.code === '23505') {
      throw new Error(
        'Another address on this customer was just marked billing or shipping. Refresh and try again.',
      );
    }
    console.error('Error creating customer address:', error);
    throw error;
  }
  return data as CustomerAddress;
}

export async function updateCustomerAddress(
  addressId: string,
  customerId: string,
  formData: CustomerAddressFormData,
): Promise<CustomerAddress> {
  const supabase = getSupabase();

  if (formData.is_billing) await clearBillingForCustomer(customerId, addressId);
  if (formData.is_shipping) await clearShippingForCustomer(customerId, addressId);

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
        'Another address on this customer was just marked billing or shipping. Refresh and try again.',
      );
    }
    console.error('Error updating customer address:', error);
    throw error;
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
    throw error;
  }
}
