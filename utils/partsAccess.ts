import { getSupabase } from '@/lib/supabase';
import type {
  Part,
  PartFormData,
  PartUnitConversion,
  PartUnitConversionFormData,
} from '@/types/part';
import type { InventoryTransaction, InventoryTransactionType } from '@/types/partTransaction';
import { convertToBaseUnit } from '@/lib/unitPresets';

const PART_COLUMNS =
  'id, company_id, part_name, description, is_manufacturable, is_stockable, primary_unit, quantity, cost_per_unit, cost_recalculated_at, reorder_point, preferred_vendor_id, legacy_id, created_at, updated_at';

interface PartRow {
  id: string;
  company_id: string;
  part_name: string;
  description: string | null;
  is_manufacturable: boolean;
  is_stockable: boolean;
  primary_unit: string | null;
  quantity: number;
  cost_per_unit: number | null;
  cost_recalculated_at: string | null;
  reorder_point: number | null;
  preferred_vendor_id: string | null;
  legacy_id: string | null;
  created_at: string;
  updated_at: string;
  routings?: Array<{ id: string }> | { id: string } | null;
}

function rowToPart(row: PartRow): Part {
  const routings = row.routings ?? null;
  const routingRecord = Array.isArray(routings) ? routings[0] : routings;
  return {
    id: row.id,
    company_id: row.company_id,
    part_name: row.part_name,
    description: row.description,
    is_manufacturable: row.is_manufacturable,
    is_stockable: row.is_stockable,
    primary_unit: row.primary_unit,
    quantity: Number(row.quantity ?? 0),
    cost_per_unit: row.cost_per_unit !== null ? Number(row.cost_per_unit) : null,
    cost_recalculated_at: row.cost_recalculated_at,
    reorder_point: row.reorder_point !== null ? Number(row.reorder_point) : null,
    preferred_vendor_id: row.preferred_vendor_id,
    legacy_id: row.legacy_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    routing: routingRecord
      ? { id: routingRecord.id, nodes_count: 0, total_run_time_per_unit: null }
      : undefined,
  };
}

// ============================================================
// READ
// ============================================================

/**
 * Get all parts for a company with optional filters.
 * Fetches in batches of 1000 to bypass Supabase's default row limit.
 */
export async function getAllParts(
  companyId: string,
  search: string = '',
  sortField: string = 'part_name',
  sortDirection: 'asc' | 'desc' = 'asc',
): Promise<Part[]> {
  const supabase = getSupabase();
  const BATCH_SIZE = 1000;
  let allData: PartRow[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    let query = supabase
      .from('parts')
      .select(`${PART_COLUMNS}, routings(id)`)
      .eq('company_id', companyId)
      .order(sortField, { ascending: sortDirection === 'asc' })
      .range(offset, offset + BATCH_SIZE - 1);

    if (search.trim()) {
      query = query.or(`part_name.ilike.%${search}%,description.ilike.%${search}%`);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching parts batch:', error);
      throw error;
    }

    allData = [...allData, ...((data as PartRow[]) || [])];
    hasMore = (data?.length || 0) === BATCH_SIZE;
    offset += BATCH_SIZE;
  }

  return allData.map(rowToPart);
}

/**
 * Stockable subset of getAllParts. Used by inventory-mental-model views and
 * by callers that need to pick a material part.
 */
export async function getStockableParts(
  companyId: string,
  search: string = '',
  sortField: string = 'part_name',
  sortDirection: 'asc' | 'desc' = 'asc',
): Promise<Part[]> {
  const supabase = getSupabase();

  let query = supabase
    .from('parts')
    .select(PART_COLUMNS)
    .eq('company_id', companyId)
    .eq('is_stockable', true)
    .order(sortField, { ascending: sortDirection === 'asc' });

  if (search.trim()) {
    query = query.or(`part_name.ilike.%${search}%,description.ilike.%${search}%`);
  }

  const { data, error } = await query;
  if (error) {
    console.error('Error fetching stockable parts:', error);
    throw error;
  }
  return ((data as PartRow[]) || []).map(rowToPart);
}

/**
 * Manufacturable subset of getAllParts.
 */
export async function getManufacturableParts(
  companyId: string,
  search: string = '',
  sortField: string = 'part_name',
  sortDirection: 'asc' | 'desc' = 'asc',
): Promise<Part[]> {
  const supabase = getSupabase();

  let query = supabase
    .from('parts')
    .select(`${PART_COLUMNS}, routings(id)`)
    .eq('company_id', companyId)
    .eq('is_manufacturable', true)
    .order(sortField, { ascending: sortDirection === 'asc' });

  if (search.trim()) {
    query = query.or(`part_name.ilike.%${search}%,description.ilike.%${search}%`);
  }

  const { data, error } = await query;
  if (error) {
    console.error('Error fetching manufacturable parts:', error);
    throw error;
  }
  return ((data as PartRow[]) || []).map(rowToPart);
}

/**
 * Orphan parts: neither stockable nor manufacturable. Surfaces parts that
 * have been quoted but never classified.
 */
export async function getOrphanParts(
  companyId: string,
  search: string = '',
  sortField: string = 'part_name',
  sortDirection: 'asc' | 'desc' = 'asc',
): Promise<Part[]> {
  const supabase = getSupabase();

  let query = supabase
    .from('parts')
    .select(PART_COLUMNS)
    .eq('company_id', companyId)
    .eq('is_manufacturable', false)
    .eq('is_stockable', false)
    .order(sortField, { ascending: sortDirection === 'asc' });

  if (search.trim()) {
    query = query.or(`part_name.ilike.%${search}%,description.ilike.%${search}%`);
  }

  const { data, error } = await query;
  if (error) {
    console.error('Error fetching orphan parts:', error);
    throw error;
  }
  return ((data as PartRow[]) || []).map(rowToPart);
}

/**
 * Get parts with server-side pagination for AG Grid.
 */
export async function getPartsPaginated(
  companyId: string,
  offset: number,
  limit: number,
  search: string = '',
  sortField: string = 'part_name',
  sortDirection: 'asc' | 'desc' = 'asc',
): Promise<Part[]> {
  const supabase = getSupabase();

  let query = supabase
    .from('parts')
    .select(PART_COLUMNS)
    .eq('company_id', companyId)
    .order(sortField, { ascending: sortDirection === 'asc' })
    .range(offset, offset + limit - 1);

  if (search.trim()) {
    query = query.or(`part_name.ilike.%${search}%,description.ilike.%${search}%`);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching paginated parts:', error);
    throw error;
  }

  return ((data as PartRow[]) || []).map(rowToPart);
}

/**
 * Get total count of parts for a company.
 */
export async function getPartsCount(
  companyId: string,
  search: string = '',
): Promise<number> {
  const supabase = getSupabase();

  let query = supabase
    .from('parts')
    .select('*', { count: 'exact', head: true })
    .eq('company_id', companyId);

  if (search.trim()) {
    query = query.or(`part_name.ilike.%${search}%,description.ilike.%${search}%`);
  }

  const { count, error } = await query;

  if (error) {
    console.error('Error fetching parts count:', error);
    throw error;
  }

  return count || 0;
}

/**
 * Get a single part by ID.
 */
export async function getPart(partId: string): Promise<Part | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('parts')
    .select(PART_COLUMNS)
    .eq('id', partId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching part:', error);
    throw error;
  }

  return data ? rowToPart(data as PartRow) : null;
}

/**
 * Get a part with related quotes/jobs counts, routing info, and BOM counts.
 */
export async function getPartWithRelations(partId: string): Promise<Part | null> {
  const supabase = getSupabase();

  const { data: part, error: partError } = await supabase
    .from('parts')
    .select(PART_COLUMNS)
    .eq('id', partId)
    .single();

  if (partError && partError.code !== 'PGRST116') {
    console.error('Error fetching part:', partError);
    throw partError;
  }

  if (!part) return null;

  // Quotes count: walk through line items and de-dupe by quote_id (a multi-tier quote on
  // the same part should still count as one quote).
  const { data: liQuoteRows, error: quotesError } = await supabase
    .from('quote_line_items')
    .select('quote_id')
    .eq('part_id', partId);
  const quotesCount = quotesError
    ? 0
    : new Set(((liQuoteRows ?? []) as Array<{ quote_id: string }>).map((r) => r.quote_id)).size;

  if (quotesError) {
    console.error('Error fetching quotes count:', quotesError);
  }

  // Jobs count derived from job_parts (jobs is parent, job_parts owns the part FK).
  const { count: jobsCount, error: jobsError } = await supabase
    .from('job_parts')
    .select('*', { count: 'exact', head: true })
    .eq('part_id', partId);

  if (jobsError) {
    console.error('Error fetching jobs count:', jobsError);
  }

  // Routing info (1:1 — at most one routing per part)
  const { data: routingData, error: routingError } = await supabase
    .from('routings')
    .select(`
      id,
      routing_operations(id, cycle_minutes_per_unit)
    `)
    .eq('part_id', partId)
    .maybeSingle();

  if (routingError) {
    console.error('Error fetching routing info:', routingError);
  }

  let routingInfo: Part['routing'] = null;
  if (routingData) {
    const ops =
      (routingData.routing_operations as Array<{
        id: string;
        cycle_minutes_per_unit: number | null;
      }>) || [];
    const totalRunTime = ops.reduce((sum, op) => sum + (op.cycle_minutes_per_unit || 0), 0);
    routingInfo = {
      id: routingData.id,
      nodes_count: ops.length,
      total_run_time_per_unit: totalRunTime || null,
    };
  }

  // BOM counts: how many children this part has, and how many parents reference it.
  const { count: bomLinesCount } = await supabase
    .from('parts_bom')
    .select('*', { count: 'exact', head: true })
    .eq('parent_part_id', partId);

  const { count: bomParentsCount } = await supabase
    .from('parts_bom')
    .select('*', { count: 'exact', head: true })
    .eq('child_part_id', partId);

  const base = rowToPart(part as PartRow);
  return {
    ...base,
    quotes_count: quotesCount || 0,
    jobs_count: jobsCount || 0,
    bom_lines_count: bomLinesCount || 0,
    bom_parents_count: bomParentsCount || 0,
    routing: routingInfo,
  };
}

/**
 * Lightweight parts query for dropdowns. Optional `kind` filter switches
 * between the unified, stockable, or manufacturable subset.
 */
export async function getPartsForSelect(
  companyId: string,
  kind: 'all' | 'stockable' | 'manufacturable' = 'all',
): Promise<Array<{
  id: string;
  part_name: string;
  description: string | null;
  has_routing: boolean;
  is_stockable: boolean;
  is_manufacturable: boolean;
  primary_unit: string | null;
  quantity: number;
  cost_per_unit: number | null;
}>> {
  const supabase = getSupabase();

  let query = supabase
    .from('parts')
    .select(`
      id,
      part_name,
      description,
      is_stockable,
      is_manufacturable,
      primary_unit,
      quantity,
      cost_per_unit,
      routings(id)
    `)
    .eq('company_id', companyId)
    .order('part_name', { ascending: true });

  if (kind === 'stockable') query = query.eq('is_stockable', true);
  else if (kind === 'manufacturable') query = query.eq('is_manufacturable', true);

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching parts for select:', error);
    throw error;
  }

  return (data || []).map((p: Record<string, unknown>) => {
    const routings = p.routings as Array<{ id: string }> | { id: string } | null;
    return {
      id: p.id as string,
      part_name: p.part_name as string,
      description: p.description as string | null,
      has_routing: Array.isArray(routings) ? routings.length > 0 : !!routings,
      is_stockable: p.is_stockable as boolean,
      is_manufacturable: p.is_manufacturable as boolean,
      primary_unit: p.primary_unit as string | null,
      quantity: Number(p.quantity ?? 0),
      cost_per_unit: p.cost_per_unit !== null ? Number(p.cost_per_unit) : null,
    };
  });
}

/**
 * Check if a part name already exists for a company.
 */
export async function checkPartNameExists(
  companyId: string,
  partName: string,
  excludeId?: string,
): Promise<boolean> {
  const supabase = getSupabase();

  let query = supabase
    .from('parts')
    .select('id')
    .eq('company_id', companyId)
    .ilike('part_name', partName);

  if (excludeId) {
    query = query.neq('id', excludeId);
  }

  const { data, error } = await query.limit(1);

  if (error) {
    console.error('Error checking part name:', error);
    throw error;
  }

  return (data?.length || 0) > 0;
}

// ============================================================
// CREATE / UPDATE / DELETE
// ============================================================

function formDataToInsert(formData: PartFormData): Record<string, unknown> {
  return {
    part_name: formData.part_name.trim(),
    description: formData.description.trim() || null,
    is_manufacturable: formData.is_manufacturable,
    is_stockable: formData.is_stockable,
    primary_unit: formData.primary_unit?.trim() || null,
    quantity: formData.quantity,
    cost_per_unit: formData.cost_per_unit,
    reorder_point: formData.reorder_point,
    preferred_vendor_id: formData.preferred_vendor_id || null,
  };
}

/**
 * Create a new part. Also writes any provided unit conversions.
 */
export async function createPart(companyId: string, formData: PartFormData): Promise<Part> {
  const supabase = getSupabase();

  const insertPayload = {
    company_id: companyId,
    ...formDataToInsert(formData),
  };

  const { data, error } = await supabase
    .from('parts')
    .insert(insertPayload)
    .select(PART_COLUMNS)
    .single();

  if (error) {
    console.error('Error creating part:', error);
    throw error;
  }

  if (formData.unit_conversions.length > 0) {
    await replacePartUnitConversions(data.id, formData.unit_conversions);
  }

  // Auto-apply the company's default markup rate so the new part has a
  // starting pricing tier without the user having to pick one manually.
  // Failures are non-fatal — the part is created either way.
  try {
    const { applyDefaultRateToPart } = await import('@/utils/markupRatesAccess');
    await applyDefaultRateToPart(companyId, data.id);
  } catch (autoApplyErr) {
    console.warn('Default markup rate auto-apply failed for new part:', autoApplyErr);
  }

  return rowToPart(data as PartRow);
}

/**
 * Update an existing part. Replaces the unit conversion list wholesale
 * (delete + insert), matching the previous inventory form behavior.
 */
export async function updatePart(partId: string, formData: PartFormData): Promise<Part> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('parts')
    .update({
      ...formDataToInsert(formData),
      updated_at: new Date().toISOString(),
    })
    .eq('id', partId)
    .select(PART_COLUMNS)
    .single();

  if (error) {
    console.error('Error updating part:', error);
    throw error;
  }

  await replacePartUnitConversions(partId, formData.unit_conversions);

  return rowToPart(data as PartRow);
}

/**
 * Delete a part permanently.
 * CASCADE removes the routing (and its operations) and parts_bom rows where
 * this part is the parent. Children are RESTRICTed — a part referenced as a
 * child somewhere can't be deleted without removing those references first.
 */
export async function deletePart(partId: string): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase.from('parts').delete().eq('id', partId);

  if (error) {
    if (error.code === '23503') {
      throw new Error(
        'Cannot delete this part because it is referenced by quotes, jobs, or another part\'s BOM. Remove those references first.',
      );
    }
    console.error('Error deleting part:', error);
    throw error;
  }
}

/**
 * Bulk delete parts permanently.
 */
export async function bulkDeleteParts(partIds: string[]): Promise<void> {
  if (partIds.length === 0) return;

  const validIds = partIds.filter((id) => id && typeof id === 'string');
  if (validIds.length === 0) return;

  const supabase = getSupabase();
  const BATCH_SIZE = 100;

  for (let i = 0; i < validIds.length; i += BATCH_SIZE) {
    const batch = validIds.slice(i, i + BATCH_SIZE);

    const { error } = await supabase
      .from('parts')
      .delete()
      .in('id', batch);

    if (error) {
      if (error.code === '23503') {
        throw new Error(
          'Cannot delete some parts because they are referenced by quotes, jobs, or BOM rows. Remove those references first.',
        );
      }
      if (error.code === '42501' || error.message?.includes('policy')) {
        throw new Error(
          'Permission denied. You may not have permission to delete these parts.',
        );
      }
      console.error('Error bulk deleting parts:', error);
      throw new Error(error.message || 'Failed to delete parts');
    }
  }
}

// ============================================================
// UNIT CONVERSIONS (per-part)
// ============================================================

export async function getPartUnitConversions(partId: string): Promise<PartUnitConversion[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('parts_unit_conversions')
    .select('*')
    .eq('part_id', partId)
    .order('from_unit', { ascending: true });

  if (error) {
    console.error('Error fetching part unit conversions:', error);
    throw error;
  }
  return (data || []) as PartUnitConversion[];
}

async function replacePartUnitConversions(
  partId: string,
  conversions: PartUnitConversionFormData[],
): Promise<void> {
  const supabase = getSupabase();

  const { error: deleteError } = await supabase
    .from('parts_unit_conversions')
    .delete()
    .eq('part_id', partId);

  if (deleteError) {
    console.error('Error replacing part unit conversions (delete):', deleteError);
    throw deleteError;
  }

  if (conversions.length === 0) return;

  const rows = conversions.map((uc) => ({
    part_id: partId,
    from_unit: uc.from_unit,
    to_primary_factor: uc.to_primary_factor,
  }));

  const { error: insertError } = await supabase
    .from('parts_unit_conversions')
    .insert(rows);

  if (insertError) {
    console.error('Error replacing part unit conversions (insert):', insertError);
    throw insertError;
  }
}

// ============================================================
// COST RECALCULATION + STALE DETECTION
// ============================================================

/**
 * Trigger a server-side cost rollup for a manufacturable part. Calls the
 * `recalculate_part_cost` SQL function and returns the new `cost_per_unit`.
 * The function also stamps `cost_recalculated_at`.
 */
export async function recalculatePartCost(partId: string): Promise<number> {
  const supabase = getSupabase();

  const { data, error } = await supabase.rpc('recalculate_part_cost', {
    p_part_id: partId,
  });

  if (error) {
    console.error('Error recalculating part cost:', error);
    throw error;
  }

  return data === null ? 0 : Number(data);
}

/**
 * Walk the BOM tree under this part and surface whether any descendant has
 * been touched since this part's last cost recalc — which signals the cost
 * is potentially stale.
 *
 * Implemented client-side as a single recursive walk: pull the BOM rows for
 * the company once, then BFS from `partId`. Done client-side to avoid
 * shipping yet another SQL function for one read; the BOM table is small
 * (<10K rows for Contour) and the walk is bounded by the cycle-detection
 * trigger (max depth 50).
 */
export async function getStaleCostInfo(
  partId: string,
): Promise<{ is_stale: boolean; stale_descendants: number }> {
  const supabase = getSupabase();

  const { data: rootRow, error: rootError } = await supabase
    .from('parts')
    .select('id, company_id, cost_recalculated_at')
    .eq('id', partId)
    .single();

  if (rootError || !rootRow) {
    throw rootError || new Error('part not found');
  }

  const recalculatedAt = rootRow.cost_recalculated_at
    ? Date.parse(rootRow.cost_recalculated_at)
    : null;

  // If the cost was never calculated, we can't know whether descendants are
  // newer — surface that as stale so the user is prompted to recalc.
  if (recalculatedAt === null) {
    const { count } = await supabase
      .from('parts_bom')
      .select('*', { count: 'exact', head: true })
      .eq('parent_part_id', partId);
    return { is_stale: (count || 0) > 0, stale_descendants: count || 0 };
  }

  // Pull BOM edges for the company once, then walk from the root part.
  const { data: bomRows, error: bomError } = await supabase
    .from('parts_bom')
    .select('parent_part_id, child_part_id')
    .eq('parent_part_id', partId);

  if (bomError) throw bomError;

  type Edge = { parent_part_id: string; child_part_id: string };
  const initialEdges = (bomRows || []) as Edge[];
  if (initialEdges.length === 0) {
    return { is_stale: false, stale_descendants: 0 };
  }

  const visited = new Set<string>();
  const queue: string[] = [];
  for (const edge of initialEdges) {
    if (!visited.has(edge.child_part_id)) {
      visited.add(edge.child_part_id);
      queue.push(edge.child_part_id);
    }
  }

  // Walk down the tree breadth-first, fetching one BOM-children batch per
  // level. Bounded by the cycle-detection trigger's depth=50, so the loop
  // can't run forever even if data is somehow corrupt.
  let depth = 0;
  let frontier = [...queue];
  while (frontier.length > 0 && depth < 50) {
    const { data: nextLevel, error: levelError } = await supabase
      .from('parts_bom')
      .select('parent_part_id, child_part_id')
      .in('parent_part_id', frontier);
    if (levelError) throw levelError;
    const nextFrontier: string[] = [];
    for (const edge of (nextLevel || []) as Edge[]) {
      if (!visited.has(edge.child_part_id)) {
        visited.add(edge.child_part_id);
        nextFrontier.push(edge.child_part_id);
      }
    }
    frontier = nextFrontier;
    depth += 1;
  }

  if (visited.size === 0) return { is_stale: false, stale_descendants: 0 };

  const descendantIds = Array.from(visited);
  const { data: descendants, error: descError } = await supabase
    .from('parts')
    .select('id, updated_at, cost_recalculated_at')
    .in('id', descendantIds);

  if (descError) throw descError;

  let staleCount = 0;
  for (const d of (descendants || []) as Array<{
    id: string;
    updated_at: string;
    cost_recalculated_at: string | null;
  }>) {
    const updatedMs = Date.parse(d.updated_at);
    const recalcMs = d.cost_recalculated_at ? Date.parse(d.cost_recalculated_at) : 0;
    const newest = Math.max(updatedMs, recalcMs);
    if (newest > recalculatedAt) staleCount += 1;
  }

  return { is_stale: staleCount > 0, stale_descendants: staleCount };
}

// ============================================================
// PART STOCK TRANSACTIONS
// (replaces inventoryAccess.addStock / removeStock / adjustStock /
//  removeStockGraceful / consumeMaterials)
// ============================================================

interface PartWithConversions {
  id: string;
  company_id: string;
  part_name: string;
  primary_unit: string | null;
  quantity: number;
  unit_conversions: Array<{ from_unit: string; to_primary_factor: number }>;
}

async function loadPartWithConversions(partId: string): Promise<PartWithConversions> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('parts')
    .select(`
      id, company_id, part_name, primary_unit, quantity,
      parts_unit_conversions(from_unit, to_primary_factor)
    `)
    .eq('id', partId)
    .single();

  if (error || !data) {
    throw error || new Error('Part not found');
  }

  return {
    id: data.id as string,
    company_id: data.company_id as string,
    part_name: data.part_name as string,
    primary_unit: data.primary_unit as string | null,
    quantity: Number(data.quantity ?? 0),
    unit_conversions:
      (data.parts_unit_conversions as Array<{
        from_unit: string;
        to_primary_factor: number;
      }>) || [],
  };
}

async function createInventoryTransaction(
  companyId: string,
  partId: string,
  itemName: string,
  type: InventoryTransactionType,
  quantity: number,
  unit: string,
  convertedQuantity: number,
  notes: string | null,
  jobId?: string,
  jobOperationId?: string,
  operatorId?: string,
  createdBy?: string,
  hasDiscrepancy: boolean = false,
): Promise<InventoryTransaction> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('inventory_transactions')
    .insert({
      company_id: companyId,
      part_id: partId,
      item_name: itemName,
      type,
      quantity,
      unit,
      converted_quantity: convertedQuantity,
      job_id: jobId || null,
      job_operation_id: jobOperationId || null,
      operator_id: operatorId || null,
      notes,
      created_by: createdBy || null,
      has_discrepancy: hasDiscrepancy,
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating part transaction:', error);
    throw error;
  }

  return data as InventoryTransaction;
}

/**
 * Add stock to a stockable part (addition transaction).
 */
export async function addPartStock(
  partId: string,
  quantity: number,
  unit: string,
  notes: string = '',
  createdBy?: string,
): Promise<{ part: Part; transaction: InventoryTransaction }> {
  if (quantity <= 0) throw new Error('Quantity must be positive');

  const supabase = getSupabase();
  const part = await loadPartWithConversions(partId);
  if (!part.primary_unit) {
    throw new Error('Part has no primary unit; cannot record a stock transaction.');
  }

  const convertedQuantity = convertToBaseUnit(
    quantity,
    unit,
    part.primary_unit,
    part.unit_conversions,
  );

  const newQuantity = part.quantity + convertedQuantity;

  const { data: updated, error: updateError } = await supabase
    .from('parts')
    .update({ quantity: newQuantity, updated_at: new Date().toISOString() })
    .eq('id', partId)
    .select(PART_COLUMNS)
    .single();

  if (updateError) {
    console.error('Error updating part quantity:', updateError);
    throw updateError;
  }

  const transaction = await createInventoryTransaction(
    part.company_id,
    partId,
    part.part_name,
    'addition',
    quantity,
    unit,
    convertedQuantity,
    notes || null,
    undefined,
    undefined,
    undefined,
    createdBy,
  );

  return { part: rowToPart(updated as PartRow), transaction };
}

/**
 * Remove stock from a stockable part (depletion transaction). Validates that
 * quantity won't go negative — see `removePartStockGraceful` for the
 * operator-flow version that clamps + flags discrepancy.
 */
export async function removePartStock(
  partId: string,
  quantity: number,
  unit: string,
  notes: string = '',
  jobId?: string,
  jobOperationId?: string,
  operatorId?: string,
  createdBy?: string,
): Promise<{ part: Part; transaction: InventoryTransaction }> {
  if (quantity <= 0) throw new Error('Quantity must be positive');

  const supabase = getSupabase();
  const part = await loadPartWithConversions(partId);
  if (!part.primary_unit) {
    throw new Error('Part has no primary unit; cannot record a stock transaction.');
  }

  const convertedQuantity = convertToBaseUnit(
    quantity,
    unit,
    part.primary_unit,
    part.unit_conversions,
  );

  const newQuantity = part.quantity - convertedQuantity;
  if (newQuantity < 0) {
    throw new Error(
      `Insufficient stock. Current: ${part.quantity} ${part.primary_unit}, Requested: ${convertedQuantity} ${part.primary_unit}`,
    );
  }

  const { data: updated, error: updateError } = await supabase
    .from('parts')
    .update({ quantity: newQuantity, updated_at: new Date().toISOString() })
    .eq('id', partId)
    .select(PART_COLUMNS)
    .single();

  if (updateError) {
    console.error('Error updating part quantity:', updateError);
    throw updateError;
  }

  const transaction = await createInventoryTransaction(
    part.company_id,
    partId,
    part.part_name,
    'depletion',
    quantity,
    unit,
    convertedQuantity,
    notes || null,
    jobId,
    jobOperationId,
    operatorId,
    createdBy,
  );

  return { part: rowToPart(updated as PartRow), transaction };
}

/**
 * Set a part's stock to a specific value (adjustment transaction).
 */
export async function adjustPartStock(
  partId: string,
  newQuantity: number,
  unit: string,
  notes: string = '',
  createdBy?: string,
): Promise<{ part: Part; transaction: InventoryTransaction }> {
  if (newQuantity < 0) throw new Error('Quantity cannot be negative');

  const supabase = getSupabase();
  const part = await loadPartWithConversions(partId);
  if (!part.primary_unit) {
    throw new Error('Part has no primary unit; cannot record a stock transaction.');
  }

  const convertedNewQuantity = convertToBaseUnit(
    newQuantity,
    unit,
    part.primary_unit,
    part.unit_conversions,
  );
  const difference = convertedNewQuantity - part.quantity;

  const { data: updated, error: updateError } = await supabase
    .from('parts')
    .update({ quantity: convertedNewQuantity, updated_at: new Date().toISOString() })
    .eq('id', partId)
    .select(PART_COLUMNS)
    .single();

  if (updateError) {
    console.error('Error updating part quantity:', updateError);
    throw updateError;
  }

  const transaction = await createInventoryTransaction(
    part.company_id,
    partId,
    part.part_name,
    'adjustment',
    Math.abs(difference),
    part.primary_unit,
    Math.abs(difference),
    notes || `Adjusted from ${part.quantity} to ${convertedNewQuantity} ${part.primary_unit}`,
    undefined,
    undefined,
    undefined,
    createdBy,
  );

  return { part: rowToPart(updated as PartRow), transaction };
}

/**
 * Remove stock without blocking on insufficient inventory. When the operator
 * confirms more usage than is on hand, we deplete to zero, record the FULL
 * confirmed amount, and flag the row with `has_discrepancy=true`.
 */
export async function removePartStockGraceful(
  partId: string,
  quantity: number,
  unit: string,
  notes: string = '',
  jobId?: string,
  jobOperationId?: string,
  operatorId?: string,
  createdBy?: string,
): Promise<{
  part: Part;
  transaction: InventoryTransaction;
  hasDiscrepancy: boolean;
  shortfall: number;
}> {
  if (quantity <= 0) throw new Error('Quantity must be positive');

  const supabase = getSupabase();
  const part = await loadPartWithConversions(partId);
  if (!part.primary_unit) {
    throw new Error('Part has no primary unit; cannot record a stock transaction.');
  }

  const convertedQuantity = convertToBaseUnit(
    quantity,
    unit,
    part.primary_unit,
    part.unit_conversions,
  );

  let newQuantity = part.quantity - convertedQuantity;
  let hasDiscrepancy = false;
  let shortfall = 0;
  let finalNotes = notes || null;

  if (newQuantity < 0) {
    hasDiscrepancy = true;
    shortfall = Math.abs(newQuantity);
    newQuantity = 0;

    const discrepancyNote = `[DISCREPANCY: Confirmed ${convertedQuantity} ${part.primary_unit}, but only ${part.quantity} ${part.primary_unit} was available. Shortfall: ${shortfall} ${part.primary_unit}]`;
    finalNotes = finalNotes ? `${finalNotes} ${discrepancyNote}` : discrepancyNote;
  }

  const { data: updated, error: updateError } = await supabase
    .from('parts')
    .update({ quantity: newQuantity, updated_at: new Date().toISOString() })
    .eq('id', partId)
    .select(PART_COLUMNS)
    .single();

  if (updateError) {
    console.error('Error updating part quantity:', updateError);
    throw updateError;
  }

  const transaction = await createInventoryTransaction(
    part.company_id,
    partId,
    part.part_name,
    'depletion',
    quantity,
    unit,
    convertedQuantity,
    finalNotes,
    jobId,
    jobOperationId,
    operatorId,
    createdBy,
    hasDiscrepancy,
  );

  return { part: rowToPart(updated as PartRow), transaction, hasDiscrepancy, shortfall };
}

/**
 * Update the notes field on an existing transaction. All other fields are
 * immutable (enforced by the `restrict_transaction_update_to_notes` trigger).
 */
export async function updateTransactionNotes(
  transactionId: string,
  notes: string,
): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('inventory_transactions')
    .update({ notes })
    .eq('id', transactionId);

  if (error) {
    console.error('Error updating transaction notes:', error);
    throw error;
  }
}

/**
 * Paginated transaction history for a single part.
 */
export async function getPartTransactions(
  partId: string,
  offset: number = 0,
  limit: number = 25,
): Promise<{ transactions: InventoryTransaction[]; total: number }> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('inventory_transactions')
    .select(`
      *,
      jobs!left(id, job_number),
      job_operations!left(id, operation_name, sequence)
    `)
    .eq('part_id', partId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error('Error fetching part transactions:', error);
    throw error;
  }

  const { count, error: countError } = await supabase
    .from('inventory_transactions')
    .select('*', { count: 'exact', head: true })
    .eq('part_id', partId);

  if (countError) {
    console.error('Error fetching part transaction count:', countError);
    throw countError;
  }

  type TxRow = InventoryTransaction & {
    jobs?: { id: string; job_number: string } | null;
    job_operations?: { id: string; operation_name: string; sequence: number } | null;
  };
  const transactions = ((data || []) as TxRow[]).map((t) => ({
    ...t,
    job: t.jobs || null,
    job_operation: t.job_operations || null,
  }));

  return { transactions, total: count || 0 };
}
