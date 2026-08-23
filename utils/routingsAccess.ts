/**
 * Routings Data Access Layer
 *
 * Linear routing model: a routing is an ordered list of routing_operations
 * (ordered by `sequence`). Each part has exactly one routing (1:1). BOM
 * lines live separately on the part itself (`parts_bom`) and are managed by
 * `utils/bomAccess.ts`.
 */

// Typed Supabase client (typed-client rollout). Aliased so the 12 call
// sites stay untouched. See CLAUDE.md "Typed Supabase client".
import { getSupabase } from '@/lib/supabase';
import { toFriendlyError } from '@/lib/supabaseErrors';
import { friendlyErrorMessage } from '@/lib/supabaseErrors';
import { orIlikeValue } from '@/utils/searchFilter';
import type { Database } from '@/types/database';

// Insert payload for routing_operations, minus the columns the callers
// add at the boundary (routing_id, sequence, metadata). Narrowing the
// form-derived shape lets the typed .insert() validate column names
// instead of falling back to Record<string, unknown>.
type RoutingOperationInsert = Database['public']['Tables']['routing_operations']['Insert'];
import type {
  Routing,
  RoutingOperation,
  RoutingOperationWithWorkCenter,
  RoutingWithPart,
  RoutingWithStats,
  RoutingWithGraph,
  RoutingOperationFormData,
} from '@/types/routings';

// ============================================
// Routing CRUD
// ============================================

const ROUTING_OP_COLUMNS =
  'id, routing_id, work_center_id, vendor_service_id, sequence, setup_minutes, cycle_minutes_per_unit, labor_rate_override, external_unit_price, instructions, metadata, created_at, updated_at';

// Both targets are joined on every routing read. Exactly one resolves per row
// (routing_operations_exactly_one_target), so this is two LEFT JOINs rather
// than a choice — the caller reads `vendor_service` first and its presence IS
// the "outside work" test.
const WC_JOIN = 'work_center:work_centers(id, name, labor_rate)';
const VS_JOIN =
  'vendor_service:vendor_services(id, name, unit_price, vendor:vendors(id, name))';
const TARGET_JOINS = `${WC_JOIN}, ${VS_JOIN}`;

interface WCJoinShape {
  id: string;
  name: string;
  labor_rate: number | null;
}

interface VSJoinShape {
  id: string;
  name: string;
  unit_price: number | null;
  vendor: { id: string; name: string } | { id: string; name: string }[] | null;
}

function shapeWorkCenterJoin(
  wc: WCJoinShape | WCJoinShape[] | null,
): RoutingOperationWithWorkCenter['work_center'] {
  const single = Array.isArray(wc) ? wc[0] : wc;
  if (!single) return null;
  return {
    id: single.id,
    name: single.name,
    labor_rate: single.labor_rate !== null ? Number(single.labor_rate) : null,
  };
}

function shapeVendorServiceJoin(
  vs: VSJoinShape | VSJoinShape[] | null,
): RoutingOperationWithWorkCenter['vendor_service'] {
  const single = Array.isArray(vs) ? vs[0] : vs;
  if (!single) return null;
  const vendor = Array.isArray(single.vendor) ? single.vendor[0] : single.vendor;
  return {
    id: single.id,
    name: single.name,
    unit_price: single.unit_price !== null ? Number(single.unit_price) : null,
    vendor: vendor ?? null,
  };
}

/**
 * Get the routing for a part (1:1). Returns null if the part has no routing.
 */
export async function getRoutingForPart(partId: string): Promise<RoutingWithGraph | null> {
  const supabase = getSupabase();

  const { data: routing, error: routingError } = await supabase
    .from('routings')
    .select(`
      *,
      part:parts(id, part_name, description)
    `)
    .eq('part_id', partId)
    .maybeSingle();

  if (routingError) {
    console.error('Error fetching routing for part:', routingError);
    throw routingError;
  }

  if (!routing) return null;

  return await loadRoutingGraph(routing);
}

/**
 * Lightweight routing summary for a part (for list/detail displays).
 */
export async function getRoutingSummaryForPart(
  partId: string,
): Promise<{ id: string; nodeCount: number; totalRunTime: number | null } | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('routings')
    .select(`
      id,
      routing_operations(id, cycle_minutes_per_unit)
    `)
    .eq('part_id', partId)
    .maybeSingle();

  if (error) {
    console.error('Error fetching routing summary:', error);
    throw error;
  }

  if (!data) return null;

  const ops =
    (data.routing_operations as Array<{ id: string; cycle_minutes_per_unit: number | null }>) ||
    [];
  const totalRun = ops.reduce((sum, op) => sum + (op.cycle_minutes_per_unit || 0), 0);

  return {
    id: data.id,
    nodeCount: ops.length,
    totalRunTime: totalRun || null,
  };
}

/**
 * List all routings for a company with stats.
 */
export async function getRoutings(
  companyId: string,
  options?: {
    search?: string;
    partId?: string;
    sortField?: string;
    sortDirection?: 'asc' | 'desc';
  },
): Promise<RoutingWithStats[]> {
  const supabase = getSupabase();
  const { search, partId, sortField = 'name', sortDirection = 'asc' } = options || {};

  let query = supabase
    .from('routings')
    .select(`
      *,
      part:parts(id, part_name, description),
      operations:routing_operations(id, cycle_minutes_per_unit)
    `)
    .eq('company_id', companyId);

  if (search?.trim()) {
    query = query.or(`name.ilike.${orIlikeValue(search)},description.ilike.${orIlikeValue(search)}`);
  }

  if (partId) {
    query = query.eq('part_id', partId);
  }

  query = query.order(sortField, { ascending: sortDirection === 'asc' });

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching routings:', error);
    throw error;
  }

  interface RoutingRow {
    id: string;
    company_id: string;
    part_id: string;
    name: string;
    description: string | null;
    created_by: string | null;
    // Mirror DB nullability (DEFAULT-without-NOT-NULL).
    created_at: string | null;
    updated_at: string | null;
    part: { id: string; part_name: string; description: string | null } | null;
    operations?: Array<{ id: string; cycle_minutes_per_unit: number | null }>;
  }

  return (data || []).map((routing: RoutingRow) => {
    const ops = routing.operations || [];
    const totalRun = ops.reduce(
      (sum: number, op) => sum + (op.cycle_minutes_per_unit || 0),
      0,
    );

    const { operations: _ops, ...rest } = routing;
    void _ops;
    return {
      ...rest,
      operations_count: ops.length,
      total_run_time_per_unit: totalRun || null,
    } as RoutingWithStats;
  });
}

/**
 * Get a single routing by ID with basic info.
 */
export async function getRouting(routingId: string): Promise<RoutingWithPart | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('routings')
    .select(`
      *,
      part:parts(id, part_name, description)
    `)
    .eq('id', routingId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    console.error('Error fetching routing:', error);
    throw error;
  }

  return data;
}

/**
 * Get a routing with full operations data.
 */
export async function getRoutingWithGraph(routingId: string): Promise<RoutingWithGraph | null> {
  const supabase = getSupabase();

  const { data: routing, error: routingError } = await supabase
    .from('routings')
    .select(`
      *,
      part:parts(id, part_name, description)
    `)
    .eq('id', routingId)
    .single();

  if (routingError) {
    if (routingError.code === 'PGRST116') return null;
    console.error('Error fetching routing:', routingError);
    throw routingError;
  }

  return await loadRoutingGraph(routing);
}

/**
 * Internal helper: given a routing row, fetch its operations.
 */
async function loadRoutingGraph(
  routing: Routing & { part: { id: string; part_name: string; description: string | null } | null },
): Promise<RoutingWithGraph> {
  const supabase = getSupabase();

  const { data: ops, error: opsError } = await supabase
    .from('routing_operations')
    .select(`${ROUTING_OP_COLUMNS}, ${TARGET_JOINS}`)
    .eq('routing_id', routing.id)
    .order('sequence', { ascending: true })
    .order('created_at', { ascending: true });

  if (opsError) {
    console.error('Error fetching routing operations:', opsError);
    throw opsError;
  }

  type OpRow = RoutingOperation & {
    work_center: WCJoinShape | WCJoinShape[] | null;
    vendor_service: VSJoinShape | VSJoinShape[] | null;
  };
  const operations = ((ops || []) as OpRow[]).map((row) => ({
    ...row,
    work_center: shapeWorkCenterJoin(row.work_center),
    vendor_service: shapeVendorServiceJoin(row.vendor_service),
  })) as RoutingOperationWithWorkCenter[];

  return {
    ...routing,
    operations,
  };
}

/**
 * Delete a routing (cascades to its operations).
 */
export async function deleteRouting(routingId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from('routings').delete().eq('id', routingId);
  if (error) {
    console.error('Error deleting routing:', error);
    throw new Error(
      friendlyErrorMessage(error, { entity: 'routing', fallback: 'Failed to delete routing.' }),
    );
  }
}

// ============================================
// Routing Operation CRUD
// ============================================

async function getNextOperationSequence(routingId: string): Promise<number> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('routing_operations')
    .select('sequence')
    .eq('routing_id', routingId)
    .order('sequence', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('Error fetching max operation sequence:', error);
    throw error;
  }

  return (data?.sequence ?? 0) + 10;
}

function parseNumOrNull(s: string): number | null {
  if (!s || !s.trim()) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function formDataToOpInsert(
  formData: RoutingOperationFormData,
): Omit<RoutingOperationInsert, 'routing_id' | 'sequence' | 'metadata'> {
  return {
    // Exactly one target, per routing_operations_exactly_one_target. The form
    // carries whichever the user picked; the other is explicitly NULL rather
    // than omitted, so an edit that switches a step from a station to a service
    // clears the old target instead of tripping the CHECK.
    work_center_id: formData.vendor_service_id ? null : formData.work_center_id,
    vendor_service_id: formData.vendor_service_id || null,
    // Blank means unknown, not zero — see saveRoutingWithOperations.
    setup_minutes: parseNumOrNull(formData.setup_minutes),
    cycle_minutes_per_unit: parseNumOrNull(formData.cycle_minutes_per_unit),
    labor_rate_override: parseNumOrNull(formData.labor_rate_override),
    external_unit_price: parseNumOrNull(formData.external_unit_price),
    instructions: formData.instructions.trim() || null,
  };
}

export async function createRoutingOperation(
  routingId: string,
  formData: RoutingOperationFormData,
  sequence?: number,
): Promise<RoutingOperation> {
  const supabase = getSupabase();
  const seq = sequence ?? (await getNextOperationSequence(routingId));

  const { data, error } = await supabase
    .from('routing_operations')
    .insert({
      routing_id: routingId,
      ...formDataToOpInsert(formData),
      metadata: {},
      sequence: seq,
    })
    .select(ROUTING_OP_COLUMNS)
    .single();

  if (error) {
    console.error('Error creating routing operation:', error);
    throw toFriendlyError(error, { entity: 'operation' });
  }

  return data as RoutingOperation;
}

export async function updateRoutingOperation(
  operationId: string,
  formData: RoutingOperationFormData,
): Promise<RoutingOperation> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('routing_operations')
    .update({
      ...formDataToOpInsert(formData),
      updated_at: new Date().toISOString(),
    })
    .eq('id', operationId)
    .select(ROUTING_OP_COLUMNS)
    .single();

  if (error) {
    console.error('Error updating routing operation:', error);
    throw toFriendlyError(error, { entity: 'operation' });
  }

  return data as RoutingOperation;
}

export async function deleteRoutingOperation(operationId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from('routing_operations').delete().eq('id', operationId);
  if (error) {
    console.error('Error deleting routing operation:', error);
    throw new Error(
      friendlyErrorMessage(error, {
        entity: 'operation',
        fallback: 'Failed to delete operation.',
      }),
    );
  }
}

// ============================================
// Wizard Save Operations (atomic)
// ============================================

/**
 * Pending operation row from the linear builder.
 *  - tempId: synthetic id for new rows (prefix `temp-op-`); real uuid for existing rows.
 *  - All other fields mirror routing_operations.
 */
export interface PendingOperation {
  tempId: string;
  /** Exactly one of workCenterId / vendorServiceId is set. */
  workCenterId: string | null;
  vendorServiceId: string | null;
  /** The station's or the service's name, for display in the builder. */
  workCenterName: string;
  /** The vendor performing it, when this step is outside work. */
  vendorName: string | null;
  setupMinutes: number | null;
  cycleMinutesPerUnit: number | null;
  laborRateOverride: number | null;
  externalUnitPrice: number | null;
  instructions: string | null;
}

/**
 * Save a routing's operations from the wizard. Handles create + edit modes.
 * Routing name is auto-generated from the part name.
 *
 * BOM is no longer routing-attached; the part page orchestrates a separate
 * BOM save through `utils/bomAccess.ts`.
 *
 * Operations are saved with `sequence` matching their position in the input
 * array (steps of 10).
 */
export async function saveRoutingWithOperations(
  companyId: string,
  partId: string,
  routingId: string | null,
  pendingOperations: PendingOperation[],
  originalOperationIds: Set<string>,
): Promise<Routing> {
  const supabase = getSupabase();
  const isEditMode = !!routingId;

  const { data: partData, error: partError } = await supabase
    .from('parts')
    .select('part_name')
    .eq('id', partId)
    .single();

  if (partError) throw partError;
  const autoName = `Routing - ${partData.part_name}`;

  // Step 1: Create or update the routing row
  let routing: Routing;
  if (isEditMode) {
    const { data, error } = await supabase
      .from('routings')
      .update({ name: autoName, updated_at: new Date().toISOString() })
      .eq('id', routingId)
      .select()
      .single();
    if (error) throw error;
    routing = data;
  } else {
    const { data, error } = await supabase
      .from('routings')
      .insert({ company_id: companyId, part_id: partId, name: autoName })
      .select()
      .single();
    if (error) throw error;
    routing = data;
  }

  // Step 2: Diff against the original sets to find deletions
  const currentIds = new Set(pendingOperations.map((op) => op.tempId));
  const opsToDelete = [...originalOperationIds].filter((id) => !currentIds.has(id));

  if (opsToDelete.length > 0) {
    const { error } = await supabase
      .from('routing_operations')
      .delete()
      .in('id', opsToDelete);
    if (error) throw error;
  }

  // Step 3: Two-phase update so the (routing_id, sequence) unique constraint
  //   isn't violated while reordering. Park existing rows at sequences
  //   100000+, then assign final sequences.
  if (pendingOperations.length > 0) {
    const existingRows = pendingOperations.filter((op) => originalOperationIds.has(op.tempId));
    if (existingRows.length > 0) {
      let temp = 100000;
      for (const op of existingRows) {
        const { error } = await supabase
          .from('routing_operations')
          .update({ sequence: temp })
          .eq('id', op.tempId);
        if (error) throw error;
        temp += 10;
      }
    }

    let seq = 10;
    for (const op of pendingOperations) {
      const isExisting = originalOperationIds.has(op.tempId);
      const payload = {
        // Exactly one target — the other is written NULL, not omitted, so
        // re-pointing an existing step clears the target it no longer uses.
        work_center_id: op.vendorServiceId ? null : op.workCenterId,
        vendor_service_id: op.vendorServiceId,
        // NOT `?? 0`. Zero setup is a real answer — plenty of operations have
        // none — but it is a different answer from "nobody has said yet", and
        // coercing turned the second into the first. That mattered the moment a
        // part could be routed before it was timed: an operation stored as 0/0
        // with a labour rate computes $0.00 and no longer looks unknown to
        // `get_priceable_part_ids`, so the part reads as ready to quote for free.
        setup_minutes: op.setupMinutes,
        cycle_minutes_per_unit: op.cycleMinutesPerUnit,
        labor_rate_override: op.laborRateOverride,
        external_unit_price: op.externalUnitPrice,
        instructions: op.instructions,
        sequence: seq,
      };

      if (isExisting) {
        const { error } = await supabase
          .from('routing_operations')
          .update({ ...payload, updated_at: new Date().toISOString() })
          .eq('id', op.tempId);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('routing_operations')
          .insert({
            routing_id: routing.id,
            ...payload,
            metadata: {},
          });
        if (error) throw error;
      }
      seq += 10;
    }
  }

  return routing;
}
