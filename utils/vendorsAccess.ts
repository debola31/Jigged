import { getSupabase } from '@/lib/supabase';
import type {
  Vendor,
  VendorFormData,
  VendorWithDerivedRoles,
  VendorImportResult,
} from '@/types/vendor';
import type {
  VendorContact,
  VendorContactFormData,
} from '@/types/vendorContact';

const VENDOR_COLUMNS =
  'id, company_id, name, address_line1, address_line2, city, state, postal_code, country, legacy_id, created_at, updated_at';

const VENDOR_CONTACT_COLUMNS =
  'id, vendor_id, name, role, role_label, email, phone, is_primary, created_at, updated_at';

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
    // Search the vendor name + city only. Contact-name search would require a
    // join through vendor_contacts; defer until usability shows users want it.
    query = query.or(`name.ilike.%${search}%,city.ilike.%${search}%`);
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
 *
 * Also fetches the vendor's primary contact (if any) for display in the
 * detail page header / list contact column. `primary_contact` is null when
 * the vendor has no contact rows or no contact is marked is_primary
 * (legitimate state — see the migration's NOTICE log).
 */
export async function getVendorWithDerivedRoles(
  vendorId: string,
): Promise<VendorWithDerivedRoles | null> {
  const supabase = getSupabase();

  const vendor = await getVendor(vendorId);
  if (!vendor) return null;

  const [
    { count: suppliesCount, error: supError },
    { count: opsCount, error: opError },
    { data: primaryRows, error: contactError },
  ] = await Promise.all([
    supabase
      .from('parts')
      .select('*', { count: 'exact', head: true })
      .eq('preferred_vendor_id', vendorId),
    supabase
      .from('work_centers')
      .select('*', { count: 'exact', head: true })
      .eq('vendor_id', vendorId),
    supabase
      .from('vendor_contacts')
      .select(VENDOR_CONTACT_COLUMNS)
      .eq('vendor_id', vendorId)
      .eq('is_primary', true)
      .limit(1),
  ]);

  if (supError) throw supError;
  if (opError) throw opError;
  if (contactError) throw contactError;

  const primaryContact =
    ((primaryRows || []) as VendorContact[])[0] || null;

  return {
    ...vendor,
    supplies_materials_count: suppliesCount || 0,
    performs_outside_ops_count: opsCount || 0,
    primary_contact: primaryContact,
  };
}

/**
 * List all vendors with their derived role counts in a single round trip.
 * The role counts come from two aggregate queries fanned across the company,
 * not row-by-row. Primary contacts come from a single query against
 * vendor_contacts WHERE is_primary=true; the result is stitched onto each
 * vendor by vendor_id (null when no primary exists).
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

  const vendorIds = vendors.map((v) => v.id);

  const [
    { data: partRows, error: partError },
    { data: wcRows, error: wcError },
    { data: contactRows, error: contactError },
  ] = await Promise.all([
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
    supabase
      .from('vendor_contacts')
      .select(VENDOR_CONTACT_COLUMNS)
      .in('vendor_id', vendorIds)
      .eq('is_primary', true),
  ]);

  if (partError) throw partError;
  if (wcError) throw wcError;
  if (contactError) throw contactError;

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

  const primaryByVendor = new Map<string, VendorContact>();
  for (const c of (contactRows || []) as VendorContact[]) {
    primaryByVendor.set(c.vendor_id, c);
  }

  return vendors.map((v) => ({
    ...v,
    supplies_materials_count: suppliesByVendor.get(v.id) || 0,
    performs_outside_ops_count: opsByVendor.get(v.id) || 0,
    primary_contact: primaryByVendor.get(v.id) || null,
  }));
}

/**
 * Linked parts (preferred-vendor backlink) for the vendor detail page.
 */
export async function getPartsByPreferredVendor(
  vendorId: string,
): Promise<Array<{ id: string; part_name: string; primary_unit: string | null }>> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('parts')
    .select('id, part_name, primary_unit')
    .eq('preferred_vendor_id', vendorId)
    .order('part_name', { ascending: true });

  if (error) {
    console.error('Error fetching parts by preferred vendor:', error);
    throw error;
  }

  return (data || []) as Array<{
    id: string;
    part_name: string;
    primary_unit: string | null;
  }>;
}

/**
 * Linked work_centers (vendor_id backlink) for the vendor detail page.
 */
export async function getWorkCentersByVendor(
  vendorId: string,
): Promise<Array<{ id: string; name: string; kind: 'internal' | 'external' }>> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('work_centers')
    .select('id, name, kind')
    .eq('vendor_id', vendorId)
    .order('name', { ascending: true });

  if (error) {
    console.error('Error fetching work centers by vendor:', error);
    throw error;
  }

  return (data || []) as Array<{
    id: string;
    name: string;
    kind: 'internal' | 'external';
  }>;
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
    address_line1: trimmed(formData.address_line1),
    address_line2: trimmed(formData.address_line2),
    city: trimmed(formData.city),
    state: trimmed(formData.state),
    postal_code: trimmed(formData.postal_code),
    country: trimmed(formData.country) || 'USA',
  };
}

/**
 * Create a vendor. If `initialContact` is provided, also inserts one
 * vendor_contacts row marked is_primary=true. The two writes are sequenced
 * (vendor first so the contact has a vendor_id to reference); a failure on
 * the contact insert leaves the vendor row in place — the user can add a
 * contact via the Contacts card on the detail page afterward.
 *
 * The VendorForm in `mode='create'` passes initialContact when the user
 * fills in the embedded "Initial contact" sub-form; in edit mode the
 * Contacts card on the detail page handles all contact CRUD instead.
 */
export async function createVendor(
  companyId: string,
  formData: VendorFormData,
  initialContact?: VendorContactFormData,
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
  const vendor = data as Vendor;

  if (initialContact && initialContact.name.trim() !== '') {
    const trimmed = (s: string) => (s.trim() === '' ? null : s.trim());
    const { error: contactError } = await supabase
      .from('vendor_contacts')
      .insert({
        vendor_id: vendor.id,
        name: initialContact.name.trim(),
        role: initialContact.role,
        role_label:
          initialContact.role === 'other'
            ? trimmed(initialContact.role_label)
            : null,
        email: trimmed(initialContact.email),
        phone: trimmed(initialContact.phone),
        is_primary: true,
      });
    if (contactError) {
      console.error('Error creating initial vendor contact:', contactError);
      throw contactError;
    }
  }

  return vendor;
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
    address_line1?: string;
    address_line2?: string;
    city?: string;
    state?: string;
    postal_code?: string;
    country?: string;
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
      address_line1: trimmed(row.address_line1),
      address_line2: trimmed(row.address_line2),
      city: trimmed(row.city),
      state: trimmed(row.state),
      postal_code: trimmed(row.postal_code),
      country: trimmed(row.country) || 'USA',
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
