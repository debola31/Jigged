import { getSupabase } from '@/lib/supabase';
import type {
  Customer,
  CustomerAddress,
  CustomerAddressFormData,
  CustomerFormData,
  CustomerFilter,
  CustomerWithRelations,
  CustomerWithAddresses,
  ImportResult,
} from '@/types/customer';

/**
 * Get paginated list of customers for a company
 */
export async function getCustomers(
  companyId: string,
  _filter: CustomerFilter = 'all',
  search: string = '',
  page: number = 1,
  limit: number = 25,
  sortField: string = 'name',
  sortDirection: 'asc' | 'desc' = 'asc'
): Promise<{ data: CustomerWithAddresses[]; total: number }> {
  const supabase = getSupabase();
  const offset = (page - 1) * limit;

  let query = supabase
    .from('customers')
    .select('*, addresses:customer_addresses(*)', { count: 'exact' })
    .eq('company_id', companyId)
    .order(sortField, { ascending: sortDirection === 'asc' })
    .range(offset, offset + limit - 1);

  if (search.trim()) {
    query = query.or(`name.ilike.%${search}%`);
  }

  const { data, error, count } = await query;

  if (error) {
    console.error('Error fetching customers:', error);
    throw error;
  }

  return { data: data || [], total: count || 0 };
}

/**
 * Get all customers for a company (no pagination).
 * Fetches in batches of 1000 to bypass Supabase's default row limit.
 * Use this for client-side pagination in AG Grid.
 */
export async function getAllCustomers(
  companyId: string,
  _filter: CustomerFilter = 'all',
  search: string = '',
  sortField: string = 'name',
  sortDirection: 'asc' | 'desc' = 'asc'
): Promise<CustomerWithAddresses[]> {
  const supabase = getSupabase();
  const BATCH_SIZE = 1000;
  let allData: CustomerWithAddresses[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    let query = supabase
      .from('customers')
      .select('*, addresses:customer_addresses(*)')
      .eq('company_id', companyId)
      .order(sortField, { ascending: sortDirection === 'asc' })
      .range(offset, offset + BATCH_SIZE - 1);

    if (search.trim()) {
      query = query.or(`name.ilike.%${search}%`);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching customers batch:', error);
      throw error;
    }

    allData = [...allData, ...(data || [])];

    hasMore = (data?.length || 0) === BATCH_SIZE;
    offset += BATCH_SIZE;
  }

  return allData;
}

/**
 * Get a single customer by ID, with their addresses joined.
 */
export async function getCustomer(
  customerId: string,
): Promise<CustomerWithAddresses | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('customers')
    .select('*, addresses:customer_addresses(*)')
    .eq('id', customerId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching customer:', error);
    throw error;
  }

  if (!data) return null;

  return {
    ...data,
    addresses: (data.addresses ?? []) as CustomerAddress[],
  };
}

/**
 * Get a customer with addresses + related quotes and jobs counts
 */
export async function getCustomerWithRelations(
  customerId: string
): Promise<CustomerWithRelations | null> {
  const supabase = getSupabase();

  const { data: customer, error: customerError } = await supabase
    .from('customers')
    .select('*, addresses:customer_addresses(*)')
    .eq('id', customerId)
    .single();

  if (customerError && customerError.code !== 'PGRST116') {
    console.error('Error fetching customer:', customerError);
    throw customerError;
  }

  if (!customer) {
    return null;
  }

  const { count: quotesCount, error: quotesError } = await supabase
    .from('quotes')
    .select('*', { count: 'exact', head: true })
    .eq('customer_id', customerId);

  if (quotesError) {
    console.error('Error fetching quotes count:', quotesError);
  }

  const { count: jobsCount, error: jobsError } = await supabase
    .from('jobs')
    .select('*', { count: 'exact', head: true })
    .eq('customer_id', customerId);

  if (jobsError) {
    console.error('Error fetching jobs count:', jobsError);
  }

  return {
    ...customer,
    addresses: (customer.addresses ?? []) as CustomerAddress[],
    quotes_count: quotesCount || 0,
    jobs_count: jobsCount || 0,
  };
}

/**
 * Check if a customer name already exists for a company
 */
export async function checkCustomerNameExists(
  companyId: string,
  name: string,
  excludeId?: string
): Promise<boolean> {
  const supabase = getSupabase();

  let query = supabase
    .from('customers')
    .select('id')
    .eq('company_id', companyId)
    .ilike('name', name);

  if (excludeId) {
    query = query.neq('id', excludeId);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error checking customer name:', error);
    throw error;
  }

  return (data?.length || 0) > 0;
}

/**
 * Normalize an address form row for insert/update against the
 * customer_addresses table. Empty strings become NULL so the DB doesn't
 * store filler whitespace.
 */
function addressRowFor(
  customerId: string,
  addr: CustomerAddressFormData,
): Record<string, unknown> {
  return {
    customer_id: customerId,
    label: addr.label.trim() || null,
    address_line1: addr.address_line1.trim() || null,
    address_line2: addr.address_line2.trim() || null,
    city: addr.city.trim() || null,
    state: addr.state.trim() || null,
    postal_code: addr.postal_code.trim() || null,
    country: addr.country.trim() || 'USA',
    is_billing: addr.is_billing,
    is_shipping: addr.is_shipping,
    is_default_billing: addr.is_default_billing,
    is_default_shipping: addr.is_default_shipping,
  };
}

/**
 * Create a new customer along with its addresses.
 *
 * Supabase doesn't support client-side multi-table transactions. We insert
 * the parent customer first, then the address rows. If the address insert
 * fails, the orphan customer remains — the caller is expected to surface
 * the error and let the user retry (or delete and recreate).
 */
export async function createCustomer(
  companyId: string,
  formData: CustomerFormData
): Promise<Customer> {
  const supabase = getSupabase();

  const { data: customer, error } = await supabase
    .from('customers')
    .insert({
      company_id: companyId,
      name: formData.name.trim(),
      website: formData.website.trim() || null,
      contact_name: formData.contact_name.trim() || null,
      contact_phone: formData.contact_phone.trim() || null,
      contact_email: formData.contact_email.trim() || null,
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating customer:', error);
    throw error;
  }

  if (formData.addresses.length > 0) {
    const rows = formData.addresses.map((a) => addressRowFor(customer.id, a));
    const { error: addrError } = await supabase
      .from('customer_addresses')
      .insert(rows);
    if (addrError) {
      console.error('Error creating customer addresses:', addrError);
      throw addrError;
    }
  }

  return customer;
}

/**
 * Update an existing customer and replace its address set. We delete the
 * old addresses and re-insert from the form to avoid the ordering
 * complexity of diffing the two sets — the table is small per customer
 * (typically 1–3 rows) so the rewrite is cheap.
 */
export async function updateCustomer(
  customerId: string,
  formData: CustomerFormData
): Promise<Customer> {
  const supabase = getSupabase();

  const { data: customer, error } = await supabase
    .from('customers')
    .update({
      name: formData.name.trim(),
      website: formData.website.trim() || null,
      contact_name: formData.contact_name.trim() || null,
      contact_phone: formData.contact_phone.trim() || null,
      contact_email: formData.contact_email.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', customerId)
    .select()
    .single();

  if (error) {
    console.error('Error updating customer:', error);
    throw error;
  }

  const { error: delError } = await supabase
    .from('customer_addresses')
    .delete()
    .eq('customer_id', customerId);
  if (delError) {
    console.error('Error clearing customer addresses:', delError);
    throw delError;
  }

  if (formData.addresses.length > 0) {
    const rows = formData.addresses.map((a) => addressRowFor(customerId, a));
    const { error: addrError } = await supabase
      .from('customer_addresses')
      .insert(rows);
    if (addrError) {
      console.error('Error inserting customer addresses:', addrError);
      throw addrError;
    }
  }

  return customer;
}

/**
 * Delete a customer permanently. Addresses cascade via FK.
 */
export async function softDeleteCustomer(customerId: string): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase
    .from('customers')
    .delete()
    .eq('id', customerId);

  if (error) {
    console.error('Error deleting customer:', error);
    throw error;
  }
}

/**
 * Bulk delete customers permanently.
 * Deletes in batches to avoid URL length limits.
 * CRITICAL: Catches FK constraint error and throws user-friendly message.
 */
export async function bulkSoftDeleteCustomers(customerIds: string[]): Promise<void> {
  if (customerIds.length === 0) return;

  const validIds = customerIds.filter((id) => id && typeof id === 'string');
  if (validIds.length === 0) return;

  const supabase = getSupabase();
  const BATCH_SIZE = 100;

  for (let i = 0; i < validIds.length; i += BATCH_SIZE) {
    const batch = validIds.slice(i, i + BATCH_SIZE);

    const { error } = await supabase
      .from('customers')
      .delete()
      .in('id', batch);

    if (error) {
      if (error.code === '23503') {
        throw new Error(
          'Cannot delete some customers because they have associated parts, quotes, or jobs. Remove those references first.'
        );
      }
      if (error.code === '42501' || error.message?.includes('policy')) {
        throw new Error(
          'Permission denied. You may not have permission to delete these customers.'
        );
      }
      console.error('Error bulk deleting customers:', error);
      throw new Error(error.message || 'Failed to delete customers');
    }
  }
}

/**
 * Bulk import customers from CSV data.
 *
 * Each row produces one customer row plus one customer_addresses row
 * (tagged billing+shipping, default for both, label 'Primary') when any
 * address field is populated. Customers with no address fields produce no
 * address row.
 */
export async function bulkImportCustomers(
  companyId: string,
  rows: CustomerFormData[]
): Promise<ImportResult> {
  const supabase = getSupabase();
  const results: ImportResult = { imported: 0, skipped: 0, errors: [] };

  const { data: existing } = await supabase
    .from('customers')
    .select('name')
    .eq('company_id', companyId);

  const existingNames = new Set(
    (existing || []).map((c: { name: string }) => c.name.toLowerCase())
  );

  const importedNames = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;

    if (!row.name?.trim()) {
      results.errors.push({ row: rowNum, reason: 'Missing name' });
      results.skipped++;
      continue;
    }

    const nameKey = row.name.trim().toLowerCase();

    if (existingNames.has(nameKey)) {
      results.errors.push({
        row: rowNum,
        reason: `Customer name "${row.name}" already exists`,
      });
      results.skipped++;
      continue;
    }

    if (importedNames.has(nameKey)) {
      results.errors.push({
        row: rowNum,
        reason: `Duplicate customer name "${row.name}" in file`,
      });
      results.skipped++;
      continue;
    }

    const { data: created, error } = await supabase
      .from('customers')
      .insert({
        company_id: companyId,
        name: row.name.trim(),
        website: row.website?.trim() || null,
        contact_name: row.contact_name?.trim() || null,
        contact_phone: row.contact_phone?.trim() || null,
        contact_email: row.contact_email?.trim() || null,
      })
      .select()
      .single();

    if (error || !created) {
      results.errors.push({ row: rowNum, reason: error?.message ?? 'insert failed' });
      results.skipped++;
      continue;
    }

    if (row.addresses && row.addresses.length > 0) {
      const addressRows = row.addresses.map((a) => addressRowFor(created.id, a));
      const { error: addrError } = await supabase
        .from('customer_addresses')
        .insert(addressRows);
      if (addrError) {
        // Customer row was created but address insert failed. Surface the
        // error with the customer name so the operator can fix in-app.
        results.errors.push({
          row: rowNum,
          reason: `Customer created but address insert failed: ${addrError.message}`,
        });
      }
    }

    results.imported++;
    importedNames.add(nameKey);
    existingNames.add(nameKey);
  }

  return results;
}

/**
 * Return the customer's default billing address, or any billing address
 * as fallback. Returns null when the customer has no billing address.
 */
export function pickDefaultBilling(
  customer: { addresses: CustomerAddress[] },
): CustomerAddress | null {
  return (
    customer.addresses.find((a) => a.is_default_billing) ??
    customer.addresses.find((a) => a.is_billing) ??
    null
  );
}

/**
 * Return the customer's default shipping address. Falls back to any
 * shipping address, and finally to the billing address — documented
 * product behavior: "if no ship-to is set, ship to where we bill".
 */
export function pickDefaultShipping(
  customer: { addresses: CustomerAddress[] },
): CustomerAddress | null {
  return (
    customer.addresses.find((a) => a.is_default_shipping) ??
    customer.addresses.find((a) => a.is_shipping) ??
    pickDefaultBilling(customer)
  );
}
