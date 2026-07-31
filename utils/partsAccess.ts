// Typed Supabase client (typed-client rollout). Aliased so the 30 call
// sites stay untouched. See CLAUDE.md "Typed Supabase client".
import { getTypedSupabase as getSupabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

// Insert payload for the parts table. company_id is supplied at the call
// site (so the helper that builds the rest of the columns doesn't need
// to know about scope), but every other NOT NULL column has to be
// present for the typed insert to compile.
type PartsInsert = Database['public']['Tables']['parts']['Insert'];
import type {
  Part,
  PartFormData,
  PartNote,
  PartNoteType,
  PartUnitConversion,
  PartUnitConversionFormData,
} from '@/types/part';
import type { InventoryTransaction, InventoryTransactionType } from '@/types/partTransaction';
import { convertToBaseUnit } from '@/lib/unitPresets';
import { orIlikeValue } from '@/utils/searchFilter';

const PART_COLUMNS =
  'id, company_id, part_name, description, source, is_stocked, primary_unit, quantity, reorder_point, preferred_vendor_id, costing_batch_quantity, is_location_tracked, created_at, updated_at';

interface PartRow {
  id: string;
  company_id: string;
  part_name: string;
  description: string | null;
  source: 'made' | 'bought';
  is_stocked: boolean;
  primary_unit: string | null;
  quantity: number;
  reorder_point: number | null;
  preferred_vendor_id: string | null;
  costing_batch_quantity: number | string | null;
  is_location_tracked: boolean;
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
    source: row.source,
    is_stocked: row.is_stocked,
    primary_unit: row.primary_unit,
    quantity: Number(row.quantity ?? 0),
    reorder_point: row.reorder_point !== null ? Number(row.reorder_point) : null,
    preferred_vendor_id: row.preferred_vendor_id,
    costing_batch_quantity:
      row.costing_batch_quantity === null || row.costing_batch_quantity === undefined
        ? null
        : Number(row.costing_batch_quantity),
    is_location_tracked: row.is_location_tracked ?? false,
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
      .is('deleted_at', null)
      .order(sortField, { ascending: sortDirection === 'asc' })
      .range(offset, offset + BATCH_SIZE - 1);

    if (search.trim()) {
      query = query.or(`part_name.ilike.${orIlikeValue(search)},description.ilike.${orIlikeValue(search)}`);
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
 * Stocked subset of getAllParts (is_stocked=true). Used by inventory-
 * mental-model views and by callers that need to pick a material part.
 *
 * Replaces the prior `getStockableParts` (renamed in chunk 11 alongside
 * the is_stockable → is_stocked column rename).
 */
export async function getStockedParts(
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
      .select(PART_COLUMNS)
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .eq('is_stocked', true)
      .order(sortField, { ascending: sortDirection === 'asc' })
      .range(offset, offset + BATCH_SIZE - 1);

    if (search.trim()) {
      query = query.or(`part_name.ilike.${orIlikeValue(search)},description.ilike.${orIlikeValue(search)}`);
    }

    const { data, error } = await query;
    if (error) {
      console.error('Error fetching stocked parts:', error);
      throw error;
    }

    allData = [...allData, ...((data as PartRow[]) || [])];
    hasMore = (data?.length || 0) === BATCH_SIZE;
    offset += BATCH_SIZE;
  }

  return allData.map(rowToPart);
}

/**
 * Made parts (source='made'). Replaces the prior `getManufacturableParts`.
 */
export async function getMadeParts(
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
      .is('deleted_at', null)
      .eq('source', 'made')
      .order(sortField, { ascending: sortDirection === 'asc' })
      .range(offset, offset + BATCH_SIZE - 1);

    if (search.trim()) {
      query = query.or(`part_name.ilike.${orIlikeValue(search)},description.ilike.${orIlikeValue(search)}`);
    }

    const { data, error } = await query;
    if (error) {
      console.error('Error fetching made parts:', error);
      throw error;
    }

    allData = [...allData, ...((data as PartRow[]) || [])];
    hasMore = (data?.length || 0) === BATCH_SIZE;
    offset += BATCH_SIZE;
  }

  return allData.map(rowToPart);
}

/**
 * Bought parts (source='bought'). New in chunk 11 — there's no equivalent in
 * the prior boolean model since "not manufacturable" was conflated with the
 * orphan state.
 */
export async function getBoughtParts(
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
      .select(PART_COLUMNS)
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .eq('source', 'bought')
      .order(sortField, { ascending: sortDirection === 'asc' })
      .range(offset, offset + BATCH_SIZE - 1);

    if (search.trim()) {
      query = query.or(`part_name.ilike.${orIlikeValue(search)},description.ilike.${orIlikeValue(search)}`);
    }

    const { data, error } = await query;
    if (error) {
      console.error('Error fetching bought parts:', error);
      throw error;
    }

    allData = [...allData, ...((data as PartRow[]) || [])];
    hasMore = (data?.length || 0) === BATCH_SIZE;
    offset += BATCH_SIZE;
  }

  return allData.map(rowToPart);
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
    .is('deleted_at', null)
    .order(sortField, { ascending: sortDirection === 'asc' })
    .range(offset, offset + limit - 1);

  if (search.trim()) {
    query = query.or(`part_name.ilike.${orIlikeValue(search)},description.ilike.${orIlikeValue(search)}`);
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
    .eq('company_id', companyId)
    .is('deleted_at', null);

  if (search.trim()) {
    query = query.or(`part_name.ilike.${orIlikeValue(search)},description.ilike.${orIlikeValue(search)}`);
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
 * One row per job this part appears on (via job_parts). Powers the Usage tab.
 * Sorted newest-first by job creation. Throws on error — no silent [].
 */
export interface PartJobUsage {
  job_id: string;
  job_number: string;
  production_status: string;
  fulfillment_status: string;
  quantity: number;
  customer_name: string | null;
  due_date: string | null;
  created_at: string | null;
}

export async function getJobsForPart(partId: string): Promise<PartJobUsage[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('job_parts')
    .select(`
      quantity,
      jobs!inner (
        id, job_number, production_status, fulfillment_status, due_date, created_at,
        customers ( name )
      )
    `)
    .eq('part_id', partId);

  if (error) {
    console.error('Error fetching jobs for part:', error);
    throw error;
  }

  type Row = {
    quantity: number;
    jobs:
      | {
          id: string;
          job_number: string;
          production_status: string;
          fulfillment_status: string;
          due_date: string | null;
          created_at: string | null;
          customers: { name: string | null } | { name: string | null }[] | null;
        }
      | null;
  };

  return ((data ?? []) as Row[])
    .map((r) => {
      const job = r.jobs;
      if (!job) return null;
      const customer = Array.isArray(job.customers) ? job.customers[0] : job.customers;
      return {
        job_id: job.id,
        job_number: job.job_number,
        production_status: job.production_status,
        fulfillment_status: job.fulfillment_status,
        quantity: r.quantity,
        customer_name: customer?.name ?? null,
        due_date: job.due_date,
        created_at: job.created_at,
      } satisfies PartJobUsage;
    })
    .filter((r): r is PartJobUsage => r !== null)
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
}

/**
 * One row per quote this part appears on (via quote_line_items), de-duped by
 * quote_id — a part shows up once per pricing tier, so collapse to one row to
 * match the DISTINCT-quote_id count in getPartWithRelations. Newest-first.
 */
export interface PartQuoteUsage {
  quote_id: string;
  quote_number: string;
  status: string;
  customer_name: string | null;
  expiration_date: string | null;
  created_at: string | null;
}

export async function getQuotesForPart(partId: string): Promise<PartQuoteUsage[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('quote_line_items')
    .select(`
      quote_id,
      quotes!inner (
        id, quote_number, status, expiration_date, created_at,
        customers ( name )
      )
    `)
    .eq('part_id', partId);

  if (error) {
    console.error('Error fetching quotes for part:', error);
    throw error;
  }

  type Row = {
    quotes:
      | {
          id: string;
          quote_number: string;
          status: string;
          expiration_date: string | null;
          created_at: string | null;
          customers: { name: string | null } | { name: string | null }[] | null;
        }
      | null;
  };

  const byQuote = new Map<string, PartQuoteUsage>();
  for (const row of (data ?? []) as Row[]) {
    const quote = row.quotes;
    if (!quote || byQuote.has(quote.id)) continue;
    const customer = Array.isArray(quote.customers) ? quote.customers[0] : quote.customers;
    byQuote.set(quote.id, {
      quote_id: quote.id,
      quote_number: quote.quote_number,
      status: quote.status,
      customer_name: customer?.name ?? null,
      expiration_date: quote.expiration_date,
      created_at: quote.created_at,
    });
  }

  return Array.from(byQuote.values()).sort((a, b) =>
    (b.created_at ?? '').localeCompare(a.created_at ?? ''),
  );
}

/**
 * Lightweight parts query for dropdowns. Optional `kind` filter switches
 * between the unified, made, stocked, or bought subset (matches the saved
 * views on the parts list page).
 */
export interface PartSelectOption {
  id: string;
  part_name: string;
  description: string | null;
  has_routing: boolean;
  is_stocked: boolean;
  /**
   * Whether stock for this part is held per-location (`part_location_stock`) rather than as the
   * single `quantity` above.
   *
   * Needed to answer "where is this?" honestly: an untracked part has no `part_location_stock`
   * rows at all, so an empty balances result means "not tracked by place" for one part and
   * "tracked, but none anywhere" for another. Without this flag those are indistinguishable, and
   * the operator lookup would tell someone their stock is nowhere when it simply isn't binned.
   */
  is_location_tracked: boolean;
  source: 'made' | 'bought';
  primary_unit: string | null;
  quantity: number;
  /**
   * Present on rows loaded from the DB (used to order pickers most-recently-
   * updated first). Optional because callers occasionally synthesize a
   * PartSelectOption for a locally-known part that has no loaded row.
   */
  updated_at?: string;
}

const PART_SELECT_COLUMNS = `
  id,
  part_name,
  description,
  is_stocked,
  is_location_tracked,
  source,
  primary_unit,
  quantity,
  updated_at,
  routings(id)
`;

function rowToPartSelectOption(p: Record<string, unknown>): PartSelectOption {
  const routings = p.routings as Array<{ id: string }> | { id: string } | null;
  return {
    id: p.id as string,
    part_name: p.part_name as string,
    description: p.description as string | null,
    has_routing: Array.isArray(routings) ? routings.length > 0 : !!routings,
    is_stocked: p.is_stocked as boolean,
    is_location_tracked: Boolean(p.is_location_tracked),
    source: p.source as 'made' | 'bought',
    primary_unit: p.primary_unit as string | null,
    quantity: Number(p.quantity ?? 0),
    updated_at: p.updated_at as string,
  };
}

export async function getPartsForSelect(
  companyId: string,
  kind: 'all' | 'made' | 'stocked' | 'bought' = 'all',
): Promise<PartSelectOption[]> {
  const supabase = getSupabase();
  const BATCH_SIZE = 1000;
  let allData: Array<Record<string, unknown>> = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    let query = supabase
      .from('parts')
      .select(PART_SELECT_COLUMNS)
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .order('part_name', { ascending: true })
      .range(offset, offset + BATCH_SIZE - 1);

    if (kind === 'stocked') query = query.eq('is_stocked', true);
    else if (kind === 'made') query = query.eq('source', 'made');
    else if (kind === 'bought') query = query.eq('source', 'bought');

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching parts for select:', error);
      throw error;
    }

    allData = [...allData, ...((data as Array<Record<string, unknown>>) || [])];
    hasMore = (data?.length || 0) === BATCH_SIZE;
    offset += BATCH_SIZE;
  }

  return allData.map(rowToPartSelectOption);
}

/**
 * Server-side search variant of `getPartsForSelect` for autocomplete pickers
 * over very large parts tables. Returns at most `limit` rows matching `query`
 * (ILIKE on part_name + description), **ordered most-recently-updated first**
 * (part_name as the tiebreak). When `query` is empty, returns the `limit` most
 * recently updated parts — so on focus the picker shows the parts the user is
 * actively working on, not the alphabetical top.
 *
 * Callers should debounce input changes (e.g. 300ms) so we don't fire one
 * request per keystroke.
 */
export async function searchPartsForSelect(
  companyId: string,
  query: string,
  kind: 'all' | 'made' | 'stocked' | 'bought' = 'all',
  limit: number = 50,
): Promise<PartSelectOption[]> {
  const supabase = getSupabase();

  // Order by most-recently-updated so the picker surfaces the parts the user is
  // actively working on first (routing/pricing/BOM edits bump parts.updated_at
  // via DB triggers). part_name is a stable secondary tiebreak.
  let q = supabase
    .from('parts')
    .select(PART_SELECT_COLUMNS)
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .order('part_name', { ascending: true })
    .limit(limit);

  if (kind === 'stocked') q = q.eq('is_stocked', true);
  else if (kind === 'made') q = q.eq('source', 'made');
  else if (kind === 'bought') q = q.eq('source', 'bought');

  const trimmed = query.trim();
  if (trimmed) {
    q = q.or(`part_name.ilike.${orIlikeValue(trimmed)},description.ilike.${orIlikeValue(trimmed)}`);
  }

  const { data, error } = await q;

  if (error) {
    console.error('Error searching parts for select:', error);
    throw error;
  }

  return ((data as Array<Record<string, unknown>>) || []).map(rowToPartSelectOption);
}

/**
 * Hydrate selection-state for an autocomplete that uses
 * `searchPartsForSelect`. Given a list of part IDs (e.g. the ids currently
 * referenced by an edit-mode form), returns the same row shape as the search
 * function so the picker can display each id's label without an extra search.
 */
export async function getPartsForSelectByIds(
  partIds: string[],
): Promise<PartSelectOption[]> {
  if (partIds.length === 0) return [];
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('parts')
    .select(PART_SELECT_COLUMNS)
    .in('id', partIds);

  if (error) {
    console.error('Error fetching parts by ids for select:', error);
    throw error;
  }

  return ((data as Array<Record<string, unknown>>) || []).map(rowToPartSelectOption);
}

/**
 * Slim id → part_name lookup. Used by the part-detail breadcrumb to label
 * a chain of ancestor parts in a single query. Missing ids (deleted parts,
 * URL-tampered junk) simply don't appear in the returned Map — callers
 * should fall back to a placeholder for those.
 */
export async function getPartNamesByIds(partIds: string[]): Promise<Map<string, string>> {
  if (partIds.length === 0) return new Map();
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('parts')
    .select('id, part_name')
    .in('id', partIds);

  if (error) {
    console.error('Error fetching part names by ids:', error);
    throw error;
  }

  const out = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ id: string; part_name: string }>) {
    out.set(row.id, row.part_name);
  }
  return out;
}

/**
 * Check if a *live* part name already exists for a company. Archived parts are
 * intentionally ignored: their name is free to reuse, and reusing it revives the
 * archived row (see createPart / the name-keyed import upsert). Scoping this to
 * `deleted_at IS NULL` is what stops an archived name from falsely blocking creation.
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
    .is('deleted_at', null)
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

function formDataToInsert(formData: PartFormData): Omit<PartsInsert, 'company_id'> {
  // `quantity` is intentionally NOT written through this path: only
  // inventory_transactions ever changes the on-hand count
  // (PartTransactionModal / recordInventoryTransaction) so there is always
  // an audit row explaining where the number came from. On create it
  // defaults to 0; on update, omitting it leaves the existing value
  // untouched.
  return {
    part_name: formData.part_name.trim(),
    description: formData.description.trim() || null,
    source: formData.source,
    is_stocked: formData.is_stocked,
    primary_unit: formData.primary_unit?.trim() || null,
    reorder_point: formData.reorder_point,
    preferred_vendor_id: formData.preferred_vendor_id || null,
  };
}

/**
 * Create a new part.
 *
 * Unit conversions are NOT created here as of chunk 11 — they're managed on
 * the part detail page after the row exists. See PartUnitConversion access
 * helpers below.
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
    // A unique part_name collision (23505) with an ARCHIVED part means the user is
    // reusing a name they previously archived. Name is the natural identity here, so
    // revive that row (un-archive + apply the new form values) instead of blocking. A
    // collision with a LIVE part is a genuine duplicate — re-throw the original error.
    if (error.code === '23505') {
      const revived = await reviveArchivedPartByName(companyId, formData);
      if (revived) return revived;
    }
    console.error('Error creating part:', error);
    throw error;
  }

  // No pricing is seeded on create — each part owns its markup directly. The
  // detail page's Pricing card shows a single unfilled tier row for the user
  // to fill; until they do, the part reads as "no markup / not priceable".
  return rowToPart(data as PartRow);
}

/**
 * Revive the archived part that holds `formData.part_name` for this company, applying
 * the new form values and clearing `deleted_at`. Returns the revived part, or null when
 * the colliding row is *live* (a real duplicate the caller should surface as an error).
 * There is at most one row per (company_id, part_name) — the full unique constraint.
 */
async function reviveArchivedPartByName(
  companyId: string,
  formData: PartFormData,
): Promise<Part | null> {
  const supabase = getSupabase();
  const name = formData.part_name.trim();

  const { data: existing } = await supabase
    .from('parts')
    .select('id, deleted_at')
    .eq('company_id', companyId)
    .eq('part_name', name)
    .maybeSingle();

  // No archived match (or the collision was with a live part) → let the caller throw.
  if (!existing || existing.deleted_at === null) return null;

  const { data, error } = await supabase
    .from('parts')
    .update({
      ...formDataToInsert(formData),
      deleted_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', existing.id)
    .select(PART_COLUMNS)
    .single();

  if (error) {
    console.error('Error reviving archived part:', error);
    throw error;
  }

  return rowToPart(data as PartRow);
}

/**
 * Update an existing part. Unit conversions are managed separately on the
 * detail page (see chunk 11 form refactor).
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

  return rowToPart(data as PartRow);
}

/**
 * Set the preferred vendor for a part. Used by the Cost section's vendor
 * picker on the part detail page — that picker doubles as both the
 * preferred-vendor setter and the cost-tier-sheet selector. Pass null to
 * clear. Returns nothing; the caller updates its own local state.
 */
export async function updatePartPreferredVendor(
  partId: string,
  vendorId: string | null,
): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('parts')
    .update({
      preferred_vendor_id: vendorId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', partId);
  if (error) {
    console.error('Error updating preferred vendor:', error);
    throw error;
  }
}

/**
 * Set a made part's costing (standard lot size) quantity — the run its cost is
 * amortized over, and the qty it's valued at when consumed as a BOM material.
 * Always a positive number (the column is NOT NULL, default 1).
 */
export async function updatePartCostingBatchQuantity(
  partId: string,
  batchQuantity: number,
): Promise<void> {
  if (!Number.isFinite(batchQuantity) || batchQuantity <= 0) {
    throw new Error('Costing quantity must be greater than zero.');
  }
  const supabase = getSupabase();
  const { error } = await supabase
    .from('parts')
    .update({
      costing_batch_quantity: batchQuantity,
      updated_at: new Date().toISOString(),
    })
    .eq('id', partId);
  if (error) {
    console.error('Error updating costing batch quantity:', error);
    throw error;
  }
}

/**
 * Archive a part ("Delete" in the UI). Never blocked by references: the row, its
 * attachments, and every quote / job / BOM link survive — the part is just hidden from
 * lists, search, and pickers (reads filter deleted_at IS NULL). Reusing its name later
 * revives it (see createPart). Delegates to bulkDeleteParts so both paths share the
 * archive_parts RPC (which also detaches the part as a BOM child so parents recompute cost).
 */
export async function deletePart(partId: string): Promise<void> {
  await bulkDeleteParts([partId]);
}

/**
 * Archive parts in bulk ("Delete" in the UI). Calls the archive_parts RPC, which — per
 * batch, atomically — stamps deleted_at and deletes the parts' parts_bom child edges so
 * every dependent parent part's live cost rollup recomputes without them. Never blocks.
 */
export async function bulkDeleteParts(partIds: string[]): Promise<void> {
  if (partIds.length === 0) return;

  const validIds = partIds.filter((id) => id && typeof id === 'string');
  if (validIds.length === 0) return;

  const supabase = getSupabase();
  const BATCH_SIZE = 500;

  for (let i = 0; i < validIds.length; i += BATCH_SIZE) {
    const batch = validIds.slice(i, i + BATCH_SIZE);

    const { error } = await supabase.rpc('archive_parts', { p_ids: batch });

    if (error) {
      if (error.code === '42501' || error.message?.includes('policy')) {
        throw new Error(
          'Permission denied. You may not have permission to delete these parts.',
        );
      }
      console.error('Error archiving parts:', error);
      throw new Error(error.message || 'Failed to archive parts');
    }
  }
}

/**
 * Reference counts for the pre-archive impact warning, aggregated via the
 * parts_deletion_impact RPC (a uuid[] arg, so it works for a bulk selection of
 * thousands without hitting the URL-length limit of a huge `.in()` filter).
 * Best-effort: on error it returns zero counts so the delete dialog still opens.
 */
export interface PartsDeletionImpact {
  /** number of parts about to be archived (echoed back for convenience) */
  partCount: number;
  /** distinct quotes that reference these parts — their history is kept */
  quotesCount: number;
  /** distinct jobs that reference these parts — their history is kept */
  jobsCount: number;
  /** OTHER parts that have these as a BOM component; their cost will recompute */
  bomParentsCount: number;
}

export async function getPartsDeletionImpact(partIds: string[]): Promise<PartsDeletionImpact> {
  const base: PartsDeletionImpact = {
    partCount: partIds.length,
    quotesCount: 0,
    jobsCount: 0,
    bomParentsCount: 0,
  };
  if (partIds.length === 0) return base;

  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('parts_deletion_impact', { p_ids: partIds });

  if (error) {
    console.error('Error computing parts deletion impact:', error);
    return base;
  }

  const row = Array.isArray(data) ? data[0] : data;
  return {
    partCount: partIds.length,
    quotesCount: row?.quotes_count ?? 0,
    jobsCount: row?.jobs_count ?? 0,
    bomParentsCount: row?.bom_parents_count ?? 0,
  };
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

/**
 * Replace the full unit-conversion list for a part (delete + insert).
 * Exported for use by the part detail page (chunk 14 moves unit-conversion
 * editing out of the create/edit form).
 */
export async function replacePartUnitConversions(
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

/**
 * Ensure a single unit-conversion row exists for a part, without touching the
 * others. Used when a BOM line picks a standard same-dimension unit (e.g. feet
 * for an inches part): the cost engine bridges only via `parts_unit_conversions`,
 * so the row must exist at rest for `compute_part_cost_at_qty` to convert. The
 * factor is the known standard ratio (`getSuggestedConversionFactor`). No-op if
 * a row already exists (a duplicate insert race is swallowed).
 */
export async function ensurePartUnitConversion(
  partId: string,
  fromUnit: string,
  toPrimaryFactor: number,
): Promise<void> {
  const supabase = getSupabase();

  const { data: existing, error: selError } = await supabase
    .from('parts_unit_conversions')
    .select('id')
    .eq('part_id', partId)
    .eq('from_unit', fromUnit)
    .maybeSingle();

  if (selError) {
    console.error('Error checking part unit conversion:', selError);
    throw selError;
  }
  if (existing) return;

  const { error: insError } = await supabase
    .from('parts_unit_conversions')
    .insert({ part_id: partId, from_unit: fromUnit, to_primary_factor: toPrimaryFactor });

  if (insError) {
    // 23505 = the row was created concurrently; it exists either way.
    if ((insError as { code?: string }).code === '23505') return;
    console.error('Error ensuring part unit conversion:', insError);
    throw insError;
  }
}

// ============================================================
// LIVE COST LOOKUP
// ============================================================

/**
 * Compute a part's per-unit cost at a given quantity by calling the
 * canonical SQL function `compute_part_cost_at_qty`. The function walks the
 * BOM recursively, picks each bought leaf's procurement tier at the
 * cumulative cascaded qty, and rolls labor + setup/qty + materials up to
 * the root.
 *
 * Returns `null` when any bought leaf in the subtree has no matching
 * procurement tier. Callers that need to surface *which* leaf is missing
 * should use `getPartCostExplain` instead.
 *
 * Throws when a made part has a routing operation with no labor rate or
 * no external pricing, or when a BOM line uses a unit with no conversion
 * to the child's primary unit.
 */
export async function getComputedPartCost(
  partId: string,
  qty: number,
): Promise<number | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase.rpc('compute_part_cost_at_qty', {
    p_part_id: partId,
    p_qty: qty,
  });

  if (error) {
    console.error('Error computing part cost:', error);
    throw error;
  }

  return data === null ? null : Number(data);
}

export interface PartCostMissingLeaf {
  part_id: string;
  part_name: string;
  depth: number;
  qty_required: number;
}

/** A part in the BOM tree (root or descendant) that has no pricing tier (markup). */
export interface PartMarkupGap {
  part_id: string;
  part_name: string;
  depth: number;
  source: 'made' | 'bought';
}

/** A made part in the BOM tree that has an unpriced routing operation. */
export interface PartOpRateGap {
  part_id: string;
  part_name: string;
  depth: number;
}

/**
 * Full structural pricing status for a part and its BOM tree — the single
 * source of truth the part-detail page shares with the parts list
 * (`get_priceable_part_ids`). `is_priceable` is true iff all three gap arrays
 * are empty, so the detail chip and the list ✓/⚠ column can never disagree.
 */
export interface PartPricingStatus {
  /** Best-effort unit cost; NULL when a rate/tier is missing. Display only. */
  unit_cost: number | null;
  /** True iff there are no missing leaves, markups, or op rates. */
  is_priceable: boolean;
  /** Bought leaves whose procurement tier lookup returned NULL at the cascaded qty. */
  missing_leaves: PartCostMissingLeaf[];
  /** Any part in the tree (root or descendant) with no pricing tier (markup). */
  missing_markups: PartMarkupGap[];
  /** Made parts in the tree with an unpriced routing op. */
  missing_op_rates: PartOpRateGap[];
}

/**
 * Structural pricing status for a part: its best-effort `unit_cost`, an
 * `is_priceable` verdict, and three gap arrays describing exactly why a part
 * isn't ready to quote — bought leaves with no procurement tier
 * (`missing_leaves`), the part itself with no markup (`missing_markups` — a
 * material's own markup is never required), and made nodes with an unpriced op
 * (`missing_op_rates`).
 *
 * Each array is skinny: `{ part_id, part_name, depth, … }`, one row per
 * offending part (a diamond BOM occurrence collapses to its shallowest depth).
 * The UI links each entry to the offending part so the user can fix it there.
 */
export async function getPartCostExplain(
  partId: string,
  qty: number,
): Promise<PartPricingStatus> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .rpc('compute_part_cost_explain', {
      p_part_id: partId,
      p_qty: qty,
    })
    .single();

  if (error) {
    console.error('Error explaining part cost:', error);
    throw error;
  }

  const row = (data ?? {
    unit_cost: null,
    is_priceable: false,
    missing_leaves: [],
    missing_markups: [],
    missing_op_rates: [],
  }) as {
    unit_cost: number | null;
    is_priceable: boolean | null;
    missing_leaves: PartCostMissingLeaf[] | null;
    missing_markups: PartMarkupGap[] | null;
    missing_op_rates: PartOpRateGap[] | null;
  };

  return {
    unit_cost: row.unit_cost === null ? null : Number(row.unit_cost),
    is_priceable: row.is_priceable ?? false,
    missing_leaves: (row.missing_leaves ?? []).map((leaf) => ({
      part_id: leaf.part_id,
      part_name: leaf.part_name,
      depth: Number(leaf.depth),
      qty_required: Number(leaf.qty_required),
    })),
    missing_markups: (row.missing_markups ?? []).map((gap) => ({
      part_id: gap.part_id,
      part_name: gap.part_name,
      depth: Number(gap.depth),
      source: gap.source,
    })),
    missing_op_rates: (row.missing_op_rates ?? []).map((gap) => ({
      part_id: gap.part_id,
      part_name: gap.part_name,
      depth: Number(gap.depth),
    })),
  };
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

// ============================================================
// PART NOTES + ACTIVITY FEED
// ============================================================

/**
 * Notes on a part, newest-first. Mirrors getJobNotes (operatorAccess).
 */
export async function getPartNotes(partId: string, companyId: string): Promise<PartNote[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('part_comments')
    .select('id, part_id, body, created_at, author_id, note_type, author:user_company_access(name)')
    .eq('part_id', partId)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching part notes:', error);
    throw error;
  }

  type NoteRow = {
    id: string;
    part_id: string;
    body: string;
    created_at: string;
    author_id: string | null;
    note_type: string;
    author: { name: string | null } | { name: string | null }[] | null;
  };

  return ((data ?? []) as NoteRow[]).map((n) => {
    const author = Array.isArray(n.author) ? n.author[0] : n.author;
    return {
      id: n.id,
      part_id: n.part_id,
      body: n.body,
      created_at: n.created_at,
      author_id: n.author_id,
      author_name: author?.name ?? null,
      note_type: (n.note_type as PartNoteType) ?? 'user',
    };
  });
}

/**
 * Append a part note. `authorId` is the author's user_company_access id (from
 * getCurrentMember); RLS requires it to match the caller's access row.
 * `noteType` defaults to 'user' (manual note); pass 'pricing' for auto-logged
 * pricing-change entries (see addPartPricingNote).
 */
export async function addPartNote(
  partId: string,
  companyId: string,
  authorId: string,
  body: string,
  noteType: PartNoteType = 'user',
): Promise<PartNote> {
  const supabase = getSupabase();

  const trimmed = body.trim();
  if (!trimmed) throw new Error('Note cannot be empty.');

  const { data, error } = await supabase
    .from('part_comments')
    .insert({
      company_id: companyId,
      part_id: partId,
      author_id: authorId,
      body: trimmed,
      note_type: noteType,
    })
    .select('id, part_id, body, created_at, author_id, note_type, author:user_company_access(name)')
    .single();

  if (error) {
    console.error('Error adding part note:', error);
    throw error;
  }

  type NoteRow = {
    id: string;
    part_id: string;
    body: string;
    created_at: string;
    author_id: string | null;
    note_type: string;
    author: { name: string | null } | { name: string | null }[] | null;
  };
  const n = data as NoteRow;
  const author = Array.isArray(n.author) ? n.author[0] : n.author;
  return {
    id: n.id,
    part_id: n.part_id,
    body: n.body,
    created_at: n.created_at,
    author_id: n.author_id,
    author_name: author?.name ?? null,
    note_type: (n.note_type as PartNoteType) ?? 'user',
  };
}

/**
 * Auto-log a pricing change as a 'pricing' note. Thin wrapper over addPartNote
 * — the caller (PartPricing/PartProcurementPricingPanel save handlers) builds a
 * human-readable summary of the change. This is a real event captured at save
 * time, not derived from updated_at, so it's a legitimate audit entry.
 */
export async function addPartPricingNote(
  partId: string,
  companyId: string,
  authorId: string,
  body: string,
): Promise<PartNote> {
  return addPartNote(partId, companyId, authorId, body, 'pricing');
}

/**
 * Delete a part note. RLS restricts this to the author or a company admin.
 */
export async function deletePartNote(noteId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from('part_comments').delete().eq('id', noteId);
  if (error) {
    console.error('Error deleting part note:', error);
    throw error;
  }
}

/**
 * A single entry in the part Notes feed — a discriminated union over the
 * sources that accumulate against a part. `at` is the ISO timestamp used to
 * sort the merged feed; `id` is prefixed by kind for stable React keys.
 *
 * Notes carry their own `note_type` ('user' | 'pricing') so manual notes and
 * auto-logged pricing events render in one feed, filterable client-side.
 */
export type PartActivityEvent =
  | { kind: 'note'; id: string; at: string; note: PartNote }
  | { kind: 'transaction'; id: string; at: string; txn: InventoryTransaction };

/**
 * Aggregate-on-read part Notes feed: merges manual + auto (pricing) notes with
 * stock transactions into one newest-first timeline.
 *
 * Deliberately NOT a materialized table — that would be a second source of
 * truth needing triggers (the no-silent-fallback anti-pattern); per-part row
 * counts are small, so an in-memory merge is trivial. Throws if any source
 * errors (no silent partial feed).
 *
 * Job/quote links were dropped from this feed: they're redundant with the Jobs
 * and Quotes pages, where the part's usage is already visible. Pricing changes
 * are now captured as real 'pricing' notes at save time (see addPartPricingNote)
 * rather than derived from updated_at — a legitimate event, not a fabrication.
 */
export async function getPartActivity(
  partId: string,
  companyId: string,
): Promise<PartActivityEvent[]> {
  const [notes, txnResult] = await Promise.all([
    getPartNotes(partId, companyId),
    getPartTransactions(partId, 0, 100),
  ]);

  const events: PartActivityEvent[] = [];

  for (const note of notes) {
    events.push({ kind: 'note', id: `note-${note.id}`, at: note.created_at, note });
  }
  for (const txn of txnResult.transactions) {
    if (!txn.created_at) continue;
    events.push({ kind: 'transaction', id: `txn-${txn.id}`, at: txn.created_at, txn });
  }

  return events.sort((a, b) => b.at.localeCompare(a.at));
}
