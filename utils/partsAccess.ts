import { getSupabase } from '@/lib/supabase';
import type { Part, PartFormData } from '@/types/part';

/**
 * Get all parts for a company with optional filters.
 * Fetches in batches of 1000 to bypass Supabase's default row limit.
 */
export async function getAllParts(
  companyId: string,
  search: string = '',
  sortField: string = 'part_name',
  sortDirection: 'asc' | 'desc' = 'asc'
): Promise<Part[]> {
  const supabase = getSupabase();
  const BATCH_SIZE = 1000;
  let allData: Record<string, unknown>[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    let query = supabase
      .from('parts')
      .select('*, routings(id), markup_rates(id, name)')
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

    allData = [...allData, ...(data || [])];
    hasMore = (data?.length || 0) === BATCH_SIZE;
    offset += BATCH_SIZE;
  }

  return allData.map((part) => {
    const routings = part.routings as Array<{ id: string }> | { id: string } | null;
    const routingRecord = Array.isArray(routings) ? routings[0] : routings;
    const rateRel = part.markup_rates as { id: string; name: string } | null;
    return {
      id: part.id as string,
      company_id: part.company_id as string,
      part_name: part.part_name as string,
      description: part.description as string | null,
      markup_rate_id: (part.markup_rate_id as string | null) ?? null,
      markup_rate_name: rateRel?.name ?? null,
      created_at: part.created_at as string,
      updated_at: part.updated_at as string,
      routing: routingRecord
        ? { id: routingRecord.id, nodes_count: 0, total_run_time_per_unit: null }
        : undefined,
    };
  });
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
  sortDirection: 'asc' | 'desc' = 'asc'
): Promise<Part[]> {
  const supabase = getSupabase();

  let query = supabase
    .from('parts')
    .select('*')
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

  return (data || []).map((part: Record<string, unknown>) => ({
    id: part.id as string,
    company_id: part.company_id as string,
    part_name: part.part_name as string,
    description: part.description as string | null,
    markup_rate_id: (part.markup_rate_id as string | null) ?? null,
    created_at: part.created_at as string,
    updated_at: part.updated_at as string,
  }));
}

/**
 * Get total count of parts for a company.
 */
export async function getPartsCount(
  companyId: string,
  search: string = ''
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
    .select('*')
    .eq('id', partId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching part:', error);
    throw error;
  }

  return data;
}

/**
 * Get a part with related quotes/jobs counts and routing info.
 */
export async function getPartWithRelations(partId: string): Promise<Part | null> {
  const supabase = getSupabase();

  const { data: part, error: partError } = await supabase
    .from('parts')
    .select('*')
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

  // Get jobs count
  const { count: jobsCount, error: jobsError } = await supabase
    .from('jobs')
    .select('*', { count: 'exact', head: true })
    .eq('part_id', partId);

  if (jobsError) {
    console.error('Error fetching jobs count:', jobsError);
  }

  // Get routing info (1:1 — at most one routing per part)
  const { data: routingData, error: routingError } = await supabase
    .from('routings')
    .select(`
      id,
      routing_nodes(id, run_time_per_unit)
    `)
    .eq('part_id', partId)
    .maybeSingle();

  if (routingError) {
    console.error('Error fetching routing info:', routingError);
  }

  let routingInfo: Part['routing'] = null;
  if (routingData) {
    const nodes = (routingData.routing_nodes as Array<{ id: string; run_time_per_unit: number | null }>) || [];
    const totalRunTime = nodes.reduce((sum, n) => sum + (n.run_time_per_unit || 0), 0);
    routingInfo = {
      id: routingData.id,
      nodes_count: nodes.length,
      total_run_time_per_unit: totalRunTime || null,
    };
  }

  return {
    ...part,
    quotes_count: quotesCount || 0,
    jobs_count: jobsCount || 0,
    routing: routingInfo,
  };
}

/**
 * Lightweight parts query for dropdowns.
 * Returns id, part name, description, and whether the part has a routing.
 */
export async function getPartsForSelect(
  companyId: string
): Promise<Array<{
  id: string;
  part_name: string;
  description: string | null;
  has_routing: boolean;
}>> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('parts')
    .select(`
      id,
      part_name,
      description,
      routings(id)
    `)
    .eq('company_id', companyId)
    .order('part_name', { ascending: true });

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
    };
  });
}

/**
 * Check if a part name already exists for a company.
 */
export async function checkPartNameExists(
  companyId: string,
  partName: string,
  excludeId?: string
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

/**
 * Create a new part.
 */
export async function createPart(companyId: string, formData: PartFormData): Promise<Part> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('parts')
    .insert({
      company_id: companyId,
      part_name: formData.part_name.trim(),
      description: formData.description.trim() || null,
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating part:', error);
    throw error;
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

  return data;
}

/**
 * Update an existing part.
 */
export async function updatePart(partId: string, formData: PartFormData): Promise<Part> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('parts')
    .update({
      part_name: formData.part_name.trim(),
      description: formData.description.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', partId)
    .select()
    .single();

  if (error) {
    console.error('Error updating part:', error);
    throw error;
  }

  return data;
}

/**
 * Delete a part permanently.
 * CASCADE will delete its routing (and routing's nodes/edges).
 */
export async function deletePart(partId: string): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase.from('parts').delete().eq('id', partId);

  if (error) {
    if (error.code === '23503') {
      throw new Error(
        'Cannot delete this part because it is referenced by quotes or jobs. Remove those references first.'
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
          'Cannot delete some parts because they are referenced by quotes or jobs. Remove those references first.'
        );
      }
      if (error.code === '42501' || error.message?.includes('policy')) {
        throw new Error(
          'Permission denied. You may not have permission to delete these parts.'
        );
      }
      console.error('Error bulk deleting parts:', error);
      throw new Error(error.message || 'Failed to delete parts');
    }
  }
}
