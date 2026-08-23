import { getSupabase } from '@/lib/supabase';
import { toFriendlyError } from '@/lib/supabaseErrors';
import type {
  VendorService,
  VendorServiceFormData,
  VendorServiceWithUsage,
} from '@/types/vendorService';

/**
 * Access layer for vendor services — the processes an outside vendor performs on
 * your parts. These were `work_centers` rows carrying `kind='external'` until
 * the split; this file is deliberately the one greppable place that knows it.
 *
 * Archive is universal: `deleted_at` is stamped, never a SQL DELETE, and never
 * blocked by a routing or job reference. Every list/picker/count below filters
 * `deleted_at IS NULL`; the by-id read does not, so a document holding an
 * archived service keeps resolving.
 */

// ONE string literal: the typed client infers the row type from the select
// string, and a concatenated expression widens to `string`, silently degrading
// the read to GenericStringError.
const VENDOR_SERVICE_COLUMNS =
  'id, company_id, vendor_id, name, description, unit_price, created_at, updated_at';

function numOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = parseFloat(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Live services for one vendor, for the vendor detail page. */
export async function getVendorServicesForVendor(
  vendorId: string,
): Promise<VendorService[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('vendor_services')
    .select(VENDOR_SERVICE_COLUMNS)
    .eq('vendor_id', vendorId)
    .is('deleted_at', null)
    .order('name', { ascending: true });

  if (error) {
    console.error('Error fetching vendor services:', error);
    throw error;
  }

  return (data || []) as VendorService[];
}

/**
 * Every live service in the company.
 *
 * The Vendors list needs a Services column per row, and a shop has tens of
 * services, not thousands — so this is one small query grouped in the browser
 * rather than an aggregate per row. Deliberately NOT an RPC: the equivalent
 * per-row shape is what timed out on 2026-08-19.
 */
export async function getVendorServicesForCompany(
  companyId: string,
): Promise<VendorService[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('vendor_services')
    .select(VENDOR_SERVICE_COLUMNS)
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .order('name', { ascending: true });

  if (error) {
    console.error('Error fetching vendor services for company:', error);
    throw error;
  }

  return (data || []) as VendorService[];
}

/**
 * Routing operation picker shape — the outside half.
 *
 * Carries the vendor name so the picker can group by supplier without a second
 * query, and `unit_price` so the editor can pre-fill the step. The pre-fill is
 * a display convenience only: cost reads the service price live through
 * COALESCE, so a step that never overrides it follows the vendor's price.
 */
export async function getVendorServicesForRouting(
  companyId: string,
): Promise<Array<{
  id: string;
  name: string;
  unit_price: number | null;
  vendor_name: string | null;
}>> {
  const supabase = getSupabase();

  type Row = {
    id: string;
    name: string;
    unit_price: number | null;
    vendor: { name: string } | { name: string }[] | null;
  };

  const { data, error } = await supabase
    .from('vendor_services')
    .select('id, name, unit_price, vendor:vendors(name)')
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .order('name', { ascending: true });

  if (error) {
    console.error('Error fetching vendor services for routing:', error);
    throw error;
  }

  return ((data as Row[]) || []).map((r) => {
    const vendor = Array.isArray(r.vendor) ? r.vendor[0] : r.vendor;
    return {
      id: r.id,
      name: r.name,
      unit_price: r.unit_price !== null ? Number(r.unit_price) : null,
      vendor_name: vendor?.name ?? null,
    };
  });
}

/**
 * By-id read. Resolves ARCHIVED services too, on purpose: a routing or job that
 * already points at one must keep rendering. Returns null when the id is
 * genuinely unknown (PGRST116) rather than throwing.
 */
export async function getVendorService(
  serviceId: string,
): Promise<VendorService | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('vendor_services')
    .select(VENDOR_SERVICE_COLUMNS)
    .eq('id', serviceId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching vendor service:', error);
    throw error;
  }

  return (data as VendorService | null) ?? null;
}

/**
 * Services for a vendor, each with the two counts the detail card shows.
 *
 * "Used on" counts LIVE routing steps; "Out now" counts distinct jobs with an
 * open (pending or sent) op. Two extra queries over a handful of ids, then
 * counted in the browser — PostgREST cannot GROUP BY, and the alternative is an
 * RPC per surface.
 */
export async function getVendorServicesWithUsage(
  vendorId: string,
): Promise<VendorServiceWithUsage[]> {
  const supabase = getSupabase();
  const services = await getVendorServicesForVendor(vendorId);
  if (services.length === 0) return [];

  const ids = services.map((s) => s.id);

  const [{ data: routingRows, error: routingError }, { data: jobRows, error: jobError }] =
    await Promise.all([
      supabase
        .from('routing_operations')
        .select('vendor_service_id')
        .in('vendor_service_id', ids),
      supabase
        .from('job_operations')
        .select('vendor_service_id, job_id')
        .in('vendor_service_id', ids)
        .in('status', ['pending', 'sent']),
    ]);

  if (routingError) {
    console.error('Error counting routing steps per service:', routingError);
    throw routingError;
  }
  if (jobError) {
    console.error('Error counting open jobs per service:', jobError);
    throw jobError;
  }

  const routingCounts = new Map<string, number>();
  for (const row of routingRows || []) {
    const id = row.vendor_service_id;
    if (id) routingCounts.set(id, (routingCounts.get(id) || 0) + 1);
  }

  // Distinct JOBS, not ops: two anodize steps on one job is one box going out.
  const jobsPerService = new Map<string, Set<string>>();
  for (const row of jobRows || []) {
    const id = row.vendor_service_id;
    if (!id) continue;
    const set = jobsPerService.get(id) ?? new Set<string>();
    set.add(row.job_id);
    jobsPerService.set(id, set);
  }

  return services.map((s) => ({
    ...s,
    routing_operations_count: routingCounts.get(s.id) || 0,
    open_job_count: jobsPerService.get(s.id)?.size || 0,
  }));
}

/**
 * Does this VENDOR already list a live service by this name?
 *
 * Scoped to the vendor, matching `vendor_services_unique_per_vendor` — two
 * vendors may both offer "Anodize". Archived rows are ignored so an archived
 * name never falsely blocks a create; reusing it revives instead.
 */
export async function checkVendorServiceNameExists(
  vendorId: string,
  name: string,
  excludeId?: string,
): Promise<boolean> {
  const supabase = getSupabase();

  let query = supabase
    .from('vendor_services')
    .select('id')
    .eq('vendor_id', vendorId)
    .is('deleted_at', null)
    .ilike('name', name);

  if (excludeId) {
    query = query.neq('id', excludeId);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error checking vendor service name:', error);
    throw error;
  }

  return (data?.length || 0) > 0;
}

/**
 * Create a service under a vendor.
 *
 * A 23505 collision with an ARCHIVED service of the same name under the SAME
 * vendor means the user is reusing a name they archived — revive that row. A
 * collision with a live one is a genuine duplicate and re-throws.
 */
export async function createVendorService(
  companyId: string,
  vendorId: string,
  formData: VendorServiceFormData,
): Promise<VendorService> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('vendor_services')
    .insert({
      company_id: companyId,
      vendor_id: vendorId,
      name: formData.name.trim(),
      unit_price: numOrNull(formData.unit_price),
      description: formData.description.trim() || null,
    })
    .select(VENDOR_SERVICE_COLUMNS)
    .single();

  if (error) {
    if (error.code === '23505') {
      const revived = await reviveArchivedServiceByName(vendorId, formData);
      if (revived) return revived;
    }
    console.error('Error creating vendor service:', error);
    throw toFriendlyError(error, { entity: 'service' });
  }

  return data as VendorService;
}

/**
 * Revive the archived service holding this name for this vendor, applying the
 * new form values. Returns null when the colliding row is LIVE, which the
 * caller surfaces as a duplicate. At most one row per (vendor_id, name) — the
 * full unique constraint vendor_services_unique_per_vendor.
 */
async function reviveArchivedServiceByName(
  vendorId: string,
  formData: VendorServiceFormData,
): Promise<VendorService | null> {
  const supabase = getSupabase();
  const name = formData.name.trim();

  const { data: existing } = await supabase
    .from('vendor_services')
    .select('id, deleted_at')
    .eq('vendor_id', vendorId)
    .eq('name', name)
    .maybeSingle();

  if (!existing || existing.deleted_at === null) return null;

  const { data, error } = await supabase
    .from('vendor_services')
    .update({
      name,
      unit_price: numOrNull(formData.unit_price),
      description: formData.description.trim() || null,
      deleted_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', existing.id)
    .select(VENDOR_SERVICE_COLUMNS)
    .single();

  if (error) {
    console.error('Error reviving archived vendor service:', error);
    throw toFriendlyError(error, { entity: 'service' });
  }

  return data as VendorService;
}

export async function updateVendorService(
  serviceId: string,
  formData: VendorServiceFormData,
): Promise<VendorService> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('vendor_services')
    .update({
      name: formData.name.trim(),
      unit_price: numOrNull(formData.unit_price),
      description: formData.description.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', serviceId)
    .select(VENDOR_SERVICE_COLUMNS)
    .single();

  if (error) {
    console.error('Error updating vendor service:', error);
    throw toFriendlyError(error, { entity: 'service' });
  }

  return data as VendorService;
}

/**
 * Archive a service ("Delete" in the UI). Stamps `deleted_at`; never a SQL
 * DELETE, and never blocked even at routing_operations_count > 0 — every
 * routing and job already using it keeps working, and it simply leaves the
 * pickers. Reusing the name later revives it.
 */
export async function deleteVendorService(serviceId: string): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase
    .from('vendor_services')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', serviceId);

  if (error) {
    console.error('Error archiving vendor service:', error);
    throw toFriendlyError(error, { entity: 'service' });
  }
}

/** Un-archive, for the Show-archived view on the vendor page. */
export async function restoreVendorService(serviceId: string): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase
    .from('vendor_services')
    .update({ deleted_at: null, updated_at: new Date().toISOString() })
    .eq('id', serviceId);

  if (error) {
    console.error('Error restoring vendor service:', error);
    throw toFriendlyError(error, { entity: 'service' });
  }
}
