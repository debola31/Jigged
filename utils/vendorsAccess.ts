import { getSupabase } from '@/lib/supabase';
import type {
  Vendor,
  VendorFormData,
  VendorWithDerivedRoles,
  VendorImportResult,
} from '@/types/vendor';

const VENDOR_COLUMNS =
  'id, company_id, name, contact_name, contact_email, contact_phone, address_line1, address_line2, city, state, postal_code, country, notes, legacy_id, created_at, updated_at';

/**
 * Get all vendors for a company.
 */
export async function getAllVendors(
  companyId: string,
  search: string = '',
  sortField: string = 'name',
  sortDirection: 'asc' | 'desc' = 'asc',
): Promise<Vendor[]> {
  const supabase = getSupabase();

  let query = supabase
    .from('vendors')
    .select(VENDOR_COLUMNS)
    .eq('company_id', companyId)
    .order(sortField, { ascending: sortDirection === 'asc' });

  if (search.trim()) {
    query = query.or(
      `name.ilike.%${search}%,contact_name.ilike.%${search}%,city.ilike.%${search}%`,
    );
  }

  const { data, error } = await query;
  if (error) {
    console.error('Error fetching vendors:', error);
    throw error;
  }
  return (data || []) as Vendor[];
}

/**
 * Get a single vendor by ID.
 */
export async function getVendor(vendorId: string): Promise<Vendor | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('vendors')
    .select(VENDOR_COLUMNS)
    .eq('id', vendorId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching vendor:', error);
    throw error;
  }

  return data as Vendor | null;
}

/**
 * Hydrate a single vendor with its derived role counts:
 * supplies materials = parts where preferred_vendor_id = vendor.id;
 * performs outside ops = work_centers where vendor_id = vendor.id.
 */
export async function getVendorWithDerivedRoles(
  vendorId: string,
): Promise<VendorWithDerivedRoles | null> {
  const supabase = getSupabase();

  const vendor = await getVendor(vendorId);
  if (!vendor) return null;

  const [{ count: suppliesCount, error: supError }, { count: opsCount, error: opError }] =
    await Promise.all([
      supabase
        .from('parts')
        .select('*', { count: 'exact', head: true })
        .eq('preferred_vendor_id', vendorId),
      supabase
        .from('work_centers')
        .select('*', { count: 'exact', head: true })
        .eq('vendor_id', vendorId),
    ]);

  if (supError) throw supError;
  if (opError) throw opError;

  return {
    ...vendor,
    supplies_materials_count: suppliesCount || 0,
    performs_outside_ops_count: opsCount || 0,
  };
}

/**
 * List all vendors with their derived role counts in a single round trip.
 * The role counts come from two aggregate queries fanned across the company,
 * not row-by-row.
 */
export async function getAllVendorsWithDerivedRoles(
  companyId: string,
  search: string = '',
  sortField: string = 'name',
  sortDirection: 'asc' | 'desc' = 'asc',
): Promise<VendorWithDerivedRoles[]> {
  const supabase = getSupabase();

  const vendors = await getAllVendors(companyId, search, sortField, sortDirection);
  if (vendors.length === 0) return [];

  const [{ data: partRows, error: partError }, { data: wcRows, error: wcError }] =
    await Promise.all([
      supabase
        .from('parts')
        .select('preferred_vendor_id')
        .eq('company_id', companyId)
        .not('preferred_vendor_id', 'is', null),
      supabase
        .from('work_centers')
        .select('vendor_id')
        .eq('company_id', companyId)
        .not('vendor_id', 'is', null),
    ]);

  if (partError) throw partError;
  if (wcError) throw wcError;

  const suppliesByVendor = new Map<string, number>();
  for (const r of (partRows || []) as Array<{ preferred_vendor_id: string }>) {
    suppliesByVendor.set(
      r.preferred_vendor_id,
      (suppliesByVendor.get(r.preferred_vendor_id) || 0) + 1,
    );
  }

  const opsByVendor = new Map<string, number>();
  for (const r of (wcRows || []) as Array<{ vendor_id: string }>) {
    opsByVendor.set(r.vendor_id, (opsByVendor.get(r.vendor_id) || 0) + 1);
  }

  return vendors.map((v) => ({
    ...v,
    supplies_materials_count: suppliesByVendor.get(v.id) || 0,
    performs_outside_ops_count: opsByVendor.get(v.id) || 0,
  }));
}

/**
 * Check if a vendor name already exists for a company.
 */
export async function checkVendorNameExists(
  companyId: string,
  name: string,
  excludeId?: string,
): Promise<boolean> {
  const supabase = getSupabase();

  let query = supabase
    .from('vendors')
    .select('id')
    .eq('company_id', companyId)
    .ilike('name', name);

  if (excludeId) {
    query = query.neq('id', excludeId);
  }

  const { data, error } = await query.limit(1);
  if (error) {
    console.error('Error checking vendor name:', error);
    throw error;
  }
  return (data?.length || 0) > 0;
}

function formDataToInsert(formData: VendorFormData): Record<string, unknown> {
  const trimmed = (s: string) => (s.trim() === '' ? null : s.trim());
  return {
    name: formData.name.trim(),
    contact_name: trimmed(formData.contact_name),
    contact_email: trimmed(formData.contact_email),
    contact_phone: trimmed(formData.contact_phone),
    address_line1: trimmed(formData.address_line1),
    address_line2: trimmed(formData.address_line2),
    city: trimmed(formData.city),
    state: trimmed(formData.state),
    postal_code: trimmed(formData.postal_code),
    country: trimmed(formData.country) || 'USA',
    notes: trimmed(formData.notes),
  };
}

export async function createVendor(
  companyId: string,
  formData: VendorFormData,
): Promise<Vendor> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('vendors')
    .insert({ company_id: companyId, ...formDataToInsert(formData) })
    .select(VENDOR_COLUMNS)
    .single();

  if (error) {
    console.error('Error creating vendor:', error);
    throw error;
  }
  return data as Vendor;
}

export async function updateVendor(
  vendorId: string,
  formData: VendorFormData,
): Promise<Vendor> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('vendors')
    .update({
      ...formDataToInsert(formData),
      updated_at: new Date().toISOString(),
    })
    .eq('id', vendorId)
    .select(VENDOR_COLUMNS)
    .single();

  if (error) {
    console.error('Error updating vendor:', error);
    throw error;
  }
  return data as Vendor;
}

export async function deleteVendor(vendorId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from('vendors').delete().eq('id', vendorId);

  if (error) {
    if (error.code === '23503') {
      throw new Error(
        'Cannot delete this vendor because it is referenced by a part (preferred vendor) or work center. Remove those references first.',
      );
    }
    console.error('Error deleting vendor:', error);
    throw error;
  }
}

export async function bulkDeleteVendors(vendorIds: string[]): Promise<void> {
  if (vendorIds.length === 0) return;

  const validIds = vendorIds.filter((id) => id && typeof id === 'string');
  if (validIds.length === 0) return;

  const supabase = getSupabase();
  const BATCH_SIZE = 100;

  for (let i = 0; i < validIds.length; i += BATCH_SIZE) {
    const batch = validIds.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('vendors').delete().in('id', batch);

    if (error) {
      if (error.code === '23503') {
        throw new Error(
          'Cannot delete some vendors because they are referenced by parts or work centers. Remove those references first.',
        );
      }
      console.error('Error bulk deleting vendors:', error);
      throw new Error(error.message || 'Failed to delete vendors');
    }
  }
}

/**
 * Bulk import vendors from CSV data. The merge-confirmation step (e.g.
 * "PerformCoat of Michigan LL → PerformCoat of Michigan LLC") is handled in
 * the API route before this is called — this layer only inserts what's
 * already been resolved.
 */
export async function bulkImportVendors(
  companyId: string,
  rows: Array<{
    name: string;
    contact_name?: string;
    contact_email?: string;
    contact_phone?: string;
    address_line1?: string;
    address_line2?: string;
    city?: string;
    state?: string;
    postal_code?: string;
    country?: string;
    notes?: string;
    legacy_id?: string;
  }>,
): Promise<VendorImportResult> {
  const supabase = getSupabase();
  const results: VendorImportResult = {
    imported: 0,
    skipped: 0,
    errors: [],
  };

  const { data: existing } = await supabase
    .from('vendors')
    .select('name')
    .eq('company_id', companyId);

  const existingNames = new Set(
    (existing || []).map((r: { name: string }) => r.name.toLowerCase()),
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
      results.errors.push({ row: rowNum, reason: `Vendor "${row.name}" already exists` });
      results.skipped++;
      continue;
    }
    if (importedNames.has(nameKey)) {
      results.errors.push({ row: rowNum, reason: `Duplicate vendor "${row.name}" in file` });
      results.skipped++;
      continue;
    }

    const trimmed = (s?: string) => (s && s.trim() !== '' ? s.trim() : null);

    const { error } = await supabase.from('vendors').insert({
      company_id: companyId,
      name: row.name.trim(),
      contact_name: trimmed(row.contact_name),
      contact_email: trimmed(row.contact_email),
      contact_phone: trimmed(row.contact_phone),
      address_line1: trimmed(row.address_line1),
      address_line2: trimmed(row.address_line2),
      city: trimmed(row.city),
      state: trimmed(row.state),
      postal_code: trimmed(row.postal_code),
      country: trimmed(row.country) || 'USA',
      notes: trimmed(row.notes),
      legacy_id: trimmed(row.legacy_id),
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
