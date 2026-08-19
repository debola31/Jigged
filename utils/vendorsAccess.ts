// Typed Supabase client (typed-client rollout). Aliased so the 11 call
// sites stay untouched. See CLAUDE.md "Typed Supabase client".
import { getSupabase } from '@/lib/supabase';
import { toFriendlyError } from '@/lib/supabaseErrors';
import type { Database } from '@/types/database';
import { orIlikeValue } from '@/utils/searchFilter';

// Insert payload for the vendors table, minus company_id which is added
// at the boundary. Narrowing this avoids the Record<string, unknown>
// spread that defeats typed-mode column-name validation.
type VendorInsert = Database['public']['Tables']['vendors']['Insert'];
import type {
  Vendor,
  VendorFormData,
  VendorWithPrimaryContact,
} from '@/types/vendor';
import type {
  VendorContact,
  VendorContactFormData,
} from '@/types/vendorContact';

const VENDOR_COLUMNS =
  'id, company_id, name, address_line1, address_line2, city, state, postal_code, country, created_at, updated_at';

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
  const BATCH_SIZE = 1000;
  let allData: Vendor[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    let query = supabase
      .from('vendors')
      .select(VENDOR_COLUMNS)
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .order(sortField, { ascending: sortDirection === 'asc' })
      .range(offset, offset + BATCH_SIZE - 1);

    if (search.trim()) {
      // Search the vendor name + city only. Contact-name search would require a
      // join through vendor_contacts; defer until usability shows users want it.
      query = query.or(`name.ilike.${orIlikeValue(search)},city.ilike.${orIlikeValue(search)}`);
    }

    const { data, error } = await query;
    if (error) {
      console.error('Error fetching vendors:', error);
      throw error;
    }

    allData = [...allData, ...((data as Vendor[]) || [])];
    hasMore = (data?.length || 0) === BATCH_SIZE;
    offset += BATCH_SIZE;
  }

  return allData;
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
 * List all vendors with their primary contact (if any) joined in. Primary
 * contacts come from a single query against vendor_contacts
 * WHERE is_primary=true; the result is stitched onto each vendor by
 * vendor_id (null when no primary exists).
 */
export async function getAllVendorsWithPrimaryContact(
  companyId: string,
  search: string = '',
  sortField: string = 'name',
  sortDirection: 'asc' | 'desc' = 'asc',
): Promise<VendorWithPrimaryContact[]> {
  const supabase = getSupabase();

  const vendors = await getAllVendors(companyId, search, sortField, sortDirection);
  if (vendors.length === 0) return [];

  const vendorIds = vendors.map((v) => v.id);

  const { data: contactRows, error: contactError } = await supabase
    .from('vendor_contacts')
    .select(VENDOR_CONTACT_COLUMNS)
    .in('vendor_id', vendorIds)
    .eq('is_primary', true);

  if (contactError) throw contactError;

  const primaryByVendor = new Map<string, VendorContact>();
  for (const c of (contactRows || []) as VendorContact[]) {
    primaryByVendor.set(c.vendor_id, c);
  }

  return vendors.map((v) => ({
    ...v,
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
    .is('deleted_at', null)
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
    .is('deleted_at', null)
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
 * Check if a *live* vendor name already exists for a company. Archived vendors are
 * intentionally ignored: their name is free to reuse, and reusing it revives the
 * archived row (see createVendor / reviveArchivedVendorByName). Scoping this to
 * `deleted_at IS NULL` is what stops an archived name from falsely blocking creation.
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
    .is('deleted_at', null)
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

function formDataToInsert(formData: VendorFormData): Omit<VendorInsert, 'company_id'> {
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

  let vendor: Vendor;
  if (error) {
    // A unique name collision (23505) with an ARCHIVED vendor means the user is
    // reusing a name they previously archived. Name is the natural identity here, so
    // revive that row (un-archive + apply the new form values) instead of blocking. A
    // collision with a LIVE vendor is a genuine duplicate — re-throw the original error.
    if (error.code === '23505') {
      const revived = await reviveArchivedVendorByName(companyId, formData);
      if (revived) {
        vendor = revived;
      } else {
        console.error('Error creating vendor:', error);
        throw toFriendlyError(error, { entity: 'vendor' });
      }
    } else {
      console.error('Error creating vendor:', error);
      throw toFriendlyError(error, { entity: 'vendor' });
    }
  } else {
    vendor = data as Vendor;
  }

  // Runs for both the fresh-insert and revive paths: when the create form supplies
  // an initial contact, attach it as the primary contact of the resulting vendor.
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

/**
 * Revive the archived vendor that holds `formData.name` for this company, applying the
 * new form values and clearing `deleted_at`. Returns the revived vendor, or null when the
 * colliding row is *live* (a real duplicate the caller should surface as an error). There
 * is at most one row per (company_id, name) — the full unique constraint.
 */
async function reviveArchivedVendorByName(
  companyId: string,
  formData: VendorFormData,
): Promise<Vendor | null> {
  const supabase = getSupabase();
  const name = formData.name.trim();

  const { data: existing } = await supabase
    .from('vendors')
    .select('id, deleted_at')
    .eq('company_id', companyId)
    .eq('name', name)
    .maybeSingle();

  // No archived match (or the collision was with a live vendor) → let the caller throw.
  if (!existing || existing.deleted_at === null) return null;

  const { data, error } = await supabase
    .from('vendors')
    .update({
      ...formDataToInsert(formData),
      deleted_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', existing.id)
    .select(VENDOR_COLUMNS)
    .single();

  if (error) {
    console.error('Error reviving archived vendor:', error);
    throw toFriendlyError(error, { entity: 'vendor' });
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
    throw toFriendlyError(error, { entity: 'vendor' });
  }
  return data as Vendor;
}

/**
 * Archive a vendor ("Delete" in the UI). Never blocked by references: the row and every
 * part (preferred vendor) or work-center link survive — the vendor is just hidden from
 * lists, search, and pickers (reads filter deleted_at IS NULL). Reusing its name later
 * revives it (see createVendor / reviveArchivedVendorByName).
 */
export async function deleteVendor(vendorId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('vendors')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', vendorId);

  if (error) {
    console.error('Error archiving vendor:', error);
    throw toFriendlyError(error, { entity: 'vendor' });
  }
}

/**
 * Archive vendors in bulk ("Delete" in the UI). Stamps deleted_at per batch; never blocks
 * on references (parts/work-center links survive). See deleteVendor for the single-row form.
 */
export async function bulkDeleteVendors(vendorIds: string[]): Promise<void> {
  if (vendorIds.length === 0) return;

  const validIds = vendorIds.filter((id) => id && typeof id === 'string');
  if (validIds.length === 0) return;

  const supabase = getSupabase();
  const BATCH_SIZE = 100;

  for (let i = 0; i < validIds.length; i += BATCH_SIZE) {
    const batch = validIds.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('vendors')
      .update({ deleted_at: new Date().toISOString() })
      .in('id', batch);

    if (error) {
      console.error('Error archiving vendors:', error);
      throw toFriendlyError(error, {
        entity: 'vendor',
        fallback: 'Failed to archive these vendors.',
      });
    }
  }
}
