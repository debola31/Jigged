import { getSupabase } from '@/lib/supabase';
import { toFriendlyError } from '@/lib/supabaseErrors';
import type {
  WorkCenter,
  WorkCenterFormData,
  WorkCenterWithRelations,
} from '@/types/workCenter';
import { orIlikeValue } from '@/utils/searchFilter';

// ONE string literal, deliberately: the typed client infers the row type from
// the select string, and a concatenated expression widens to `string` — which
// silently degrades every read in this file to GenericStringError. The optional
// machine attributes (make…purchased_on) are read everywhere a work center is
// read, so the maintenance surfaces need no second query for them.
const WORK_CENTER_COLUMNS =
  'id, company_id, name, labor_rate, description, make, model, serial_number, year_built, purchased_on, metadata, created_at, updated_at';

/**
 * The optional machine attributes, normalised for a write.
 *
 * Blank means NULL rather than an empty string, so "nobody filled this in" has
 * exactly one representation. A surface that decides whether to render a detail
 * row would otherwise have to test for two, and one of them would eventually get
 * missed — rendering "Serial:" against nothing on a machine the shop never
 * described, which is the empty-state prompt §4.5 refuses, arrived at by
 * accident.
 */
function machineDetailFields(formData: WorkCenterFormData) {
  return {
    make: formData.make.trim() || null,
    model: formData.model.trim() || null,
    serial_number: formData.serial_number.trim() || null,
    year_built: formData.year_built ? parseInt(formData.year_built, 10) : null,
    purchased_on: formData.purchased_on || null,
  };
}

/**
 * Get all work centers as a flat list for AG Grid display.
 */
export async function getAllWorkCenters(
  companyId: string,
  search?: string,
  sortField: string = 'name',
  sortDirection: 'asc' | 'desc' = 'asc',
): Promise<WorkCenter[]> {
  const supabase = getSupabase();

  let query = supabase
    .from('work_centers')
    .select(WORK_CENTER_COLUMNS)
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .order(sortField, { ascending: sortDirection === 'asc' });

  if (search?.trim()) {
    query = query.or(`name.ilike.${orIlikeValue(search)}`);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching work centers:', error);
    throw error;
  }

  return (data || []) as WorkCenter[];
}

/**
 * Flat work-center list for dropdowns.
 *
 * (There was a `getWorkCentersByKind` here, and a `kind` option on this
 * function. Both are gone: every row in this table is an in-house station now,
 * so there is no kind left to filter on. Outsourced processes come from
 * `vendorServicesAccess`.)
 */
export async function getWorkCentersFlat(
  companyId: string,
  options?: { search?: string },
): Promise<WorkCenter[]> {
  const supabase = getSupabase();

  let query = supabase
    .from('work_centers')
    .select(WORK_CENTER_COLUMNS)
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .order('name', { ascending: true });

  if (options?.search?.trim()) {
    query = query.or(`name.ilike.${orIlikeValue(options.search)}`);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching work centers flat:', error);
    throw error;
  }

  return (data || []) as WorkCenter[];
}

/**
 * Routing operation picker shape — the in-house half.
 *
 * The routing editor offers stations AND vendor services in one picker; this
 * supplies the stations and `getVendorServicesForRouting` supplies the rest.
 * Kept as its own call rather than a union query because the two carry
 * different money (an hourly rate vs a price per piece) and merging them here
 * would mean inventing a shape that flattens that distinction.
 */
export async function getWorkCentersForRouting(
  companyId: string,
): Promise<Array<{
  id: string;
  name: string;
  labor_rate: number | null;
}>> {
  const supabase = getSupabase();

  type Row = {
    id: string;
    name: string;
    labor_rate: number | null;
  };

  const BATCH_SIZE = 1000;
  let allData: Row[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from('work_centers')
      .select(`id, name, labor_rate`)
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .order('name', { ascending: true })
      .range(offset, offset + BATCH_SIZE - 1);

    if (error) {
      console.error('Error fetching work centers for routing:', error);
      throw error;
    }

    allData = [...allData, ...((data as Row[]) || [])];
    hasMore = (data?.length || 0) === BATCH_SIZE;
    offset += BATCH_SIZE;
  }

  return allData.map((r) => ({
    id: r.id,
    name: r.name,
    labor_rate: r.labor_rate !== null ? Number(r.labor_rate) : null,
  }));
}

/**
 * Get a single work center by ID.
 */
export async function getWorkCenter(workCenterId: string): Promise<WorkCenter | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('work_centers')
    .select(WORK_CENTER_COLUMNS)
    .eq('id', workCenterId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching work center:', error);
    throw error;
  }

  return data as WorkCenter | null;
}

/**
 * Get a work center with relation counts for delete constraint checks
 * and the joined vendor for display.
 */
export async function getWorkCenterWithRelations(
  workCenterId: string,
): Promise<WorkCenterWithRelations | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('work_centers')
    .select(WORK_CENTER_COLUMNS)
    .eq('id', workCenterId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching work center:', error);
    throw error;
  }

  if (!data) return null;

  const { count: routingOpsCount, error: opsError } = await supabase
    .from('routing_operations')
    .select('*', { count: 'exact', head: true })
    .eq('work_center_id', workCenterId);

  if (opsError) {
    console.error('Error fetching routing_operations count:', opsError);
    throw opsError;
  }

  return {
    ...(data as WorkCenter),
    routing_operations_count: routingOpsCount || 0,
  };
}

/**
 * Check if a *live* work center name already exists for a company. Archived work
 * centers are intentionally ignored: their name is free to reuse, and reusing it
 * revives the archived row (see createWorkCenter). Scoping this to `deleted_at IS
 * NULL` is what stops an archived name from falsely blocking creation.
 */
export async function checkWorkCenterNameExists(
  companyId: string,
  name: string,
  excludeId?: string,
): Promise<boolean> {
  const supabase = getSupabase();

  let query = supabase
    .from('work_centers')
    .select('id')
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .ilike('name', name);

  if (excludeId) {
    query = query.neq('id', excludeId);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error checking work center name:', error);
    throw error;
  }

  return (data?.length || 0) > 0;
}

/**
 * Create a new work center.
 *
 * A unique-name collision (23505) with an ARCHIVED work center means the user is
 * reusing a name they previously archived. Name is the natural identity here, so
 * revive that row (un-archive + apply the new form values) instead of blocking. A
 * collision with a LIVE work center is a genuine duplicate — re-throw the error.
 */
export async function createWorkCenter(
  companyId: string,
  formData: WorkCenterFormData,
): Promise<WorkCenter> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('work_centers')
    .insert({
      company_id: companyId,
      name: formData.name.trim(),
      labor_rate: formData.labor_rate ? parseFloat(formData.labor_rate) : null,
      description: formData.description.trim() || null,
      ...machineDetailFields(formData),
      metadata: {},
    })
    .select(WORK_CENTER_COLUMNS)
    .single();

  if (error) {
    if (error.code === '23505') {
      const revived = await reviveArchivedWorkCenterByName(companyId, formData);
      if (revived) return revived;
    }
    console.error('Error creating work center:', error);
    throw toFriendlyError(error, { entity: 'work center' });
  }

  return data as WorkCenter;
}

/**
 * Revive the archived work center that holds `formData.name` for this company,
 * applying the new form values and clearing `deleted_at`. Returns the revived work
 * center, or null when the colliding row is *live* (a real duplicate the caller
 * should surface as an error). There is at most one row per (company_id, name) —
 * the full unique constraint work_centers_unique_per_company.
 */
async function reviveArchivedWorkCenterByName(
  companyId: string,
  formData: WorkCenterFormData,
): Promise<WorkCenter | null> {
  const supabase = getSupabase();
  const name = formData.name.trim();

  const { data: existing } = await supabase
    .from('work_centers')
    .select('id, deleted_at')
    .eq('company_id', companyId)
    .eq('name', name)
    .maybeSingle();

  // No archived match (or the collision was with a live work center) → let the caller throw.
  if (!existing || existing.deleted_at === null) return null;

  const { data, error } = await supabase
    .from('work_centers')
    .update({
      name,
      labor_rate: formData.labor_rate ? parseFloat(formData.labor_rate) : null,
      description: formData.description.trim() || null,
      ...machineDetailFields(formData),
      metadata: {},
      deleted_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', existing.id)
    .select(WORK_CENTER_COLUMNS)
    .single();

  if (error) {
    console.error('Error reviving archived work center:', error);
    throw toFriendlyError(error, { entity: 'work center' });
  }

  return data as WorkCenter;
}

/**
 * Update an existing work center.
 */
export async function updateWorkCenter(
  workCenterId: string,
  formData: WorkCenterFormData,
): Promise<WorkCenter> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('work_centers')
    .update({
      name: formData.name.trim(),
      labor_rate: formData.labor_rate ? parseFloat(formData.labor_rate) : null,
      description: formData.description.trim() || null,
      ...machineDetailFields(formData),
      updated_at: new Date().toISOString(),
    })
    .eq('id', workCenterId)
    .select(WORK_CENTER_COLUMNS)
    .single();

  if (error) {
    console.error('Error updating work center:', error);
    throw toFriendlyError(error, { entity: 'work center' });
  }

  return data as WorkCenter;
}

/**
 * Archive a work center ("Delete" in the UI). Never blocked by references: the row
 * and every routing operation that references it survive — the work center is just
 * hidden from lists and pickers (reads filter deleted_at IS NULL). Reusing its name
 * later revives it (see createWorkCenter).
 */
export async function deleteWorkCenter(workCenterId: string): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase
    .from('work_centers')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', workCenterId);

  if (error) {
    console.error('Error archiving work center:', error);
    throw toFriendlyError(error, { entity: 'work center' });
  }
}

/**
 * Bulk archive work centers ("Delete" in the UI). Stamps deleted_at per batch;
 * never blocked by routing-operation references — archived rows are just hidden
 * from lists and pickers. Reusing a name later revives that row (see createWorkCenter).
 */
export async function bulkDeleteWorkCenters(workCenterIds: string[]): Promise<void> {
  if (workCenterIds.length === 0) return;

  const validIds = workCenterIds.filter((id) => id && typeof id === 'string');
  if (validIds.length === 0) return;

  const supabase = getSupabase();
  const BATCH_SIZE = 100;

  for (let i = 0; i < validIds.length; i += BATCH_SIZE) {
    const batch = validIds.slice(i, i + BATCH_SIZE);

    const { error } = await supabase
      .from('work_centers')
      .update({ deleted_at: new Date().toISOString() })
      .in('id', batch);

    if (error) {
      console.error('Error archiving work centers:', error);
      throw toFriendlyError(error, {
        entity: 'work center',
        fallback: 'Failed to archive these work centers.',
      });
    }
  }
}
