import { getSupabase } from '@/lib/supabase';
import type {
  Customer,
  CustomerFormData,
  CustomerFilter,
  CustomerWithRelations,
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
): Promise<{ data: Customer[]; total: number }> {
  const supabase = getSupabase();
  const offset = (page - 1) * limit;

  let query = supabase
    .from('customers')
    .select('*', { count: 'exact' })
    .eq('company_id', companyId)
    .order(sortField, { ascending: sortDirection === 'asc' })
    .range(offset, offset + limit - 1);

  // Apply search (name)
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
): Promise<Customer[]> {
  const supabase = getSupabase();
  const BATCH_SIZE = 1000;
  let allData: Customer[] = [];
  let offset = 0;
  let hasMore = true;

  // Fetch in batches until we get all data
  while (hasMore) {
    let query = supabase
      .from('customers')
      .select('*')
      .eq('company_id', companyId)
      .order(sortField, { ascending: sortDirection === 'asc' })
      .range(offset, offset + BATCH_SIZE - 1);

    // Apply search (name)
    if (search.trim()) {
      query = query.or(`name.ilike.%${search}%`);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching customers batch:', error);
      throw error;
    }

    allData = [...allData, ...(data || [])];

    // If we got fewer than BATCH_SIZE, we've reached the end
    hasMore = (data?.length || 0) === BATCH_SIZE;
    offset += BATCH_SIZE;
  }

  return allData;
}

/**
 * Get a single customer by ID
 */
export async function getCustomer(customerId: string): Promise<Customer | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('id', customerId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching customer:', error);
    throw error;
  }

  return data;
}

/**
 * Get a customer with related quotes and jobs counts
 */
export async function getCustomerWithRelations(
  customerId: string
): Promise<CustomerWithRelations | null> {
  const supabase = getSupabase();

  // Get customer
  const { data: customer, error: customerError } = await supabase
    .from('customers')
    .select('*')
    .eq('id', customerId)
    .single();

  if (customerError && customerError.code !== 'PGRST116') {
    console.error('Error fetching customer:', customerError);
    throw customerError;
  }

  if (!customer) {
    return null;
  }

  // Get quotes count
  const { count: quotesCount, error: quotesError } = await supabase
    .from('quotes')
    .select('*', { count: 'exact', head: true })
    .eq('customer_id', customerId);

  if (quotesError) {
    console.error('Error fetching quotes count:', quotesError);
  }

  // Get jobs count
  const { count: jobsCount, error: jobsError } = await supabase
    .from('jobs')
    .select('*', { count: 'exact', head: true })
    .eq('customer_id', customerId);

  if (jobsError) {
    console.error('Error fetching jobs count:', jobsError);
  }

  return {
    ...customer,
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
 * Create a new customer
 */
export async function createCustomer(
  companyId: string,
  formData: CustomerFormData
): Promise<Customer> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('customers')
    .insert({
      company_id: companyId,
      name: formData.name.trim(),
      website: formData.website.trim() || null,
      contact_name: formData.contact_name.trim() || null,
      contact_phone: formData.contact_phone.trim() || null,
      contact_email: formData.contact_email.trim() || null,
      address_line1: formData.address_line1.trim() || null,
      address_line2: formData.address_line2.trim() || null,
      city: formData.city.trim() || null,
      state: formData.state.trim() || null,
      postal_code: formData.postal_code.trim() || null,
      country: formData.country.trim() || 'USA',
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating customer:', error);
    throw error;
  }

  return data;
}

/**
 * Update an existing customer
 */
export async function updateCustomer(
  customerId: string,
  formData: CustomerFormData
): Promise<Customer> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('customers')
    .update({
      name: formData.name.trim(),
      website: formData.website.trim() || null,
      contact_name: formData.contact_name.trim() || null,
      contact_phone: formData.contact_phone.trim() || null,
      contact_email: formData.contact_email.trim() || null,
      address_line1: formData.address_line1.trim() || null,
      address_line2: formData.address_line2.trim() || null,
      city: formData.city.trim() || null,
      state: formData.state.trim() || null,
      postal_code: formData.postal_code.trim() || null,
      country: formData.country.trim() || 'USA',
      updated_at: new Date().toISOString(),
    })
    .eq('id', customerId)
    .select()
    .single();

  if (error) {
    console.error('Error updating customer:', error);
    throw error;
  }

  return data;
}

/**
 * Delete a customer permanently
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

  // Filter out any undefined/null values
  const validIds = customerIds.filter((id) => id && typeof id === 'string');
  if (validIds.length === 0) return;

  const supabase = getSupabase();
  const BATCH_SIZE = 100; // Delete in batches to avoid URL length limits

  // Process in batches
  for (let i = 0; i < validIds.length; i += BATCH_SIZE) {
    const batch = validIds.slice(i, i + BATCH_SIZE);

    const { error } = await supabase
      .from('customers')
      .delete()
      .in('id', batch);

    if (error) {
      // FK constraint violation
      if (error.code === '23503') {
        throw new Error(
          'Cannot delete some customers because they have associated parts, quotes, or jobs. Remove those references first.'
        );
      }
      // RLS policy violation
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
 * Bulk import customers from CSV data
 */
export async function bulkImportCustomers(
  companyId: string,
  rows: CustomerFormData[]
): Promise<ImportResult> {
  const supabase = getSupabase();
  const results: ImportResult = { imported: 0, skipped: 0, errors: [] };

  // Pre-fetch existing names for efficiency
  const { data: existing } = await supabase
    .from('customers')
    .select('name')
    .eq('company_id', companyId);

  const existingNames = new Set(
    (existing || []).map((c: { name: string }) => c.name.toLowerCase())
  );

  // Track names added during this import to detect duplicates within the file
  const importedNames = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2; // +2 for 1-indexed and header row

    // Validation: name required
    if (!row.name?.trim()) {
      results.errors.push({ row: rowNum, reason: 'Missing name' });
      results.skipped++;
      continue;
    }

    const nameKey = row.name.trim().toLowerCase();

    // Check for existing name in database
    if (existingNames.has(nameKey)) {
      results.errors.push({
        row: rowNum,
        reason: `Customer name "${row.name}" already exists`,
      });
      results.skipped++;
      continue;
    }

    // Check for duplicate within the import file
    if (importedNames.has(nameKey)) {
      results.errors.push({
        row: rowNum,
        reason: `Duplicate customer name "${row.name}" in file`,
      });
      results.skipped++;
      continue;
    }

    // Insert
    const { error } = await supabase.from('customers').insert({
      company_id: companyId,
      name: row.name.trim(),
      website: row.website?.trim() || null,
      contact_name: row.contact_name?.trim() || null,
      contact_phone: row.contact_phone?.trim() || null,
      contact_email: row.contact_email?.trim() || null,
      address_line1: row.address_line1?.trim() || null,
      address_line2: row.address_line2?.trim() || null,
      city: row.city?.trim() || null,
      state: row.state?.trim() || null,
      postal_code: row.postal_code?.trim() || null,
      country: row.country?.trim() || 'USA',
    });

    if (error) {
      results.errors.push({ row: rowNum, reason: error.message });
      results.skipped++;
    } else {
      results.imported++;
      importedNames.add(nameKey);
      existingNames.add(nameKey);
    }
  }

  return results;
}
