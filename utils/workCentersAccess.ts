import { getTypedSupabase as getSupabase } from '@/lib/supabase';
import type {
  WorkCenter,
  WorkCenterFormData,
  WorkCenterKind,
  WorkCenterWithRelations,
  WorkCenterImportResult,
} from '@/types/workCenter';

const WORK_CENTER_COLUMNS =
  'id, company_id, name, kind, vendor_id, labor_rate, description, metadata, created_at, updated_at';

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
    .order(sortField, { ascending: sortDirection === 'asc' });

  if (search?.trim()) {
    query = query.or(`name.ilike.%${search}%`);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching work centers:', error);
    throw error;
  }

  return (data || []) as WorkCenter[];
}

/**
 * Filter by kind ('internal' | 'external'). Used by both the work-centers
 * list page (when the user filters) and by the routing operation picker.
 */
export async function getWorkCentersByKind(
  companyId: string,
  kind: WorkCenterKind,
  search?: string,
): Promise<WorkCenter[]> {
  const supabase = getSupabase();

  let query = supabase
    .from('work_centers')
    .select(WORK_CENTER_COLUMNS)
    .eq('company_id', companyId)
    .eq('kind', kind)
    .order('name', { ascending: true });

  if (search?.trim()) {
    query = query.or(`name.ilike.%${search}%`);
  }

  const { data, error } = await query;
  if (error) {
    console.error('Error fetching work centers by kind:', error);
    throw error;
  }
  return (data || []) as WorkCenter[];
}

/**
 * Flat work-center list for dropdowns. Optional `kind` filter switches
 * between internal-only / external-only / both.
 */
export async function getWorkCentersFlat(
  companyId: string,
  options?: { search?: string; kind?: WorkCenterKind },
): Promise<WorkCenter[]> {
  const supabase = getSupabase();

  let query = supabase
    .from('work_centers')
    .select(WORK_CENTER_COLUMNS)
    .eq('company_id', companyId)
    .order('name', { ascending: true });

  if (options?.kind) {
    query = query.eq('kind', options.kind);
  }
  if (options?.search?.trim()) {
    query = query.or(`name.ilike.%${options.search}%`);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching work centers flat:', error);
    throw error;
  }

  return (data || []) as WorkCenter[];
}

/**
 * Routing operation picker shape — pulls vendor name for external work
 * centers so the UI can show "PerformCoat (PerformCoat of Michigan)" without
 * a second query.
 */
export async function getWorkCentersForRouting(
  companyId: string,
  kind?: WorkCenterKind,
): Promise<Array<{
  id: string;
  name: string;
  kind: WorkCenterKind;
  labor_rate: number | null;
  vendor_name: string | null;
}>> {
  const supabase = getSupabase();

  type Row = {
    id: string;
    name: string;
    kind: WorkCenterKind;
    labor_rate: number | null;
    vendor: { name: string } | { name: string }[] | null;
  };

  const BATCH_SIZE = 1000;
  let allData: Row[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    let query = supabase
      .from('work_centers')
      .select(`id, name, kind, labor_rate, vendor:vendors(name)`)
      .eq('company_id', companyId)
      .order('name', { ascending: true })
      .range(offset, offset + BATCH_SIZE - 1);

    if (kind) {
      query = query.eq('kind', kind);
    }

    const { data, error } = await query;
    if (error) {
      console.error('Error fetching work centers for routing:', error);
      throw error;
    }

    allData = [...allData, ...((data as Row[]) || [])];
    hasMore = (data?.length || 0) === BATCH_SIZE;
    offset += BATCH_SIZE;
  }

  return allData.map((r) => {
    const vendor = Array.isArray(r.vendor) ? r.vendor[0] : r.vendor;
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      labor_rate: r.labor_rate !== null ? Number(r.labor_rate) : null,
      vendor_name: vendor?.name ?? null,
    };
  });
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
    .select(`${WORK_CENTER_COLUMNS}, vendor:vendors(id, name)`)
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

  type Row = WorkCenter & { vendor: { id: string; name: string } | { id: string; name: string }[] | null };
  const row = data as Row;
  const vendor = Array.isArray(row.vendor) ? row.vendor[0] : row.vendor;

  return {
    ...row,
    routing_operations_count: routingOpsCount || 0,
    vendor: vendor ?? null,
  };
}

/**
 * Check if a work center name already exists for a company.
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
      kind: formData.kind,
      vendor_id: formData.kind === 'external' ? formData.vendor_id : null,
      labor_rate: formData.labor_rate ? parseFloat(formData.labor_rate) : null,
      description: formData.description.trim() || null,
      metadata: {},
    })
    .select(WORK_CENTER_COLUMNS)
    .single();

  if (error) {
    console.error('Error creating work center:', error);
    throw error;
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
      kind: formData.kind,
      vendor_id: formData.kind === 'external' ? formData.vendor_id : null,
      labor_rate: formData.labor_rate ? parseFloat(formData.labor_rate) : null,
      description: formData.description.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', workCenterId)
    .select(WORK_CENTER_COLUMNS)
    .single();

  if (error) {
    console.error('Error updating work center:', error);
    throw error;
  }

  return data as WorkCenter;
}

/**
 * Delete a work center.
 */
export async function deleteWorkCenter(workCenterId: string): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase.from('work_centers').delete().eq('id', workCenterId);

  if (error) {
    if (error.code === '23503') {
      throw new Error(
        'Cannot delete this work center because it is used in routing operations. Remove those references first.',
      );
    }
    console.error('Error deleting work center:', error);
    throw error;
  }
}

/**
 * Bulk delete work centers.
 */
export async function bulkDeleteWorkCenters(workCenterIds: string[]): Promise<void> {
  if (workCenterIds.length === 0) return;

  const validIds = workCenterIds.filter((id) => id && typeof id === 'string');
  if (validIds.length === 0) return;

  const supabase = getSupabase();
  const BATCH_SIZE = 100;

  for (let i = 0; i < validIds.length; i += BATCH_SIZE) {
    const batch = validIds.slice(i, i + BATCH_SIZE);

    const { error } = await supabase.from('work_centers').delete().in('id', batch);

    if (error) {
      if (error.code === '23503') {
        throw new Error(
          'Cannot delete some work centers because they are used in routing operations. Remove those references first.',
        );
      }
      console.error('Error bulk deleting work centers:', error);
      throw new Error(error.message || 'Failed to delete work centers');
    }
  }
}

/**
 * Bulk import work centers from CSV data. External work centers (kind='external')
 * require a `vendor_name` that must already exist for the company; the import
 * resolves the name to `vendor_id` server-side, matching the unknown_vendor /
 * unknown_part error pattern in the dependency-chain importer.
 */
export async function bulkImportWorkCenters(
  companyId: string,
  rows: Array<{
    name: string;
    kind?: 'internal' | 'external';
    vendor_name?: string;
    labor_rate?: string;
    description?: string;
    legacy_id?: string;
  }>,
): Promise<WorkCenterImportResult> {
  const supabase = getSupabase();
  const results: WorkCenterImportResult = {
    imported: 0,
    skipped: 0,
    errors: [],
  };

  const { data: existing } = await supabase
    .from('work_centers')
    .select('name')
    .eq('company_id', companyId);

  const existingNames = new Set(
    (existing || []).map((r: { name: string }) => r.name.toLowerCase()),
  );

  // Pre-fetch vendor names → ids so we don't round-trip per row.
  const { data: vendorRows } = await supabase
    .from('vendors')
    .select('id, name')
    .eq('company_id', companyId);
  const vendorIdByName = new Map<string, string>();
  for (const v of (vendorRows || []) as Array<{ id: string; name: string }>) {
    vendorIdByName.set(v.name.toLowerCase(), v.id);
  }

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
        reason: `Work center "${row.name}" already exists`,
      });
      results.skipped++;
      continue;
    }

    if (importedNames.has(nameKey)) {
      results.errors.push({
        row: rowNum,
        reason: `Duplicate work center "${row.name}" in file`,
      });
      results.skipped++;
      continue;
    }

    const kind: WorkCenterKind = row.kind === 'external' ? 'external' : 'internal';

    let vendorId: string | null = null;
    if (kind === 'external') {
      if (!row.vendor_name?.trim()) {
        results.errors.push({
          row: rowNum,
          reason: 'External work center requires vendor_name',
        });
        results.skipped++;
        continue;
      }
      vendorId = vendorIdByName.get(row.vendor_name.trim().toLowerCase()) || null;
      if (!vendorId) {
        results.errors.push({
          row: rowNum,
          reason: `Unknown vendor "${row.vendor_name}" — import the vendor first`,
        });
        results.skipped++;
        continue;
      }
    }

    const { error } = await supabase.from('work_centers').insert({
      company_id: companyId,
      name: row.name.trim(),
      kind,
      vendor_id: vendorId,
      labor_rate: row.labor_rate ? parseFloat(row.labor_rate) : null,
      description: row.description?.trim() || null,
      metadata: row.legacy_id ? { legacy_id: row.legacy_id } : {},
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
