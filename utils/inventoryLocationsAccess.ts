/**
 * Inventory Locations & QR-addressable stock — access layer.
 *
 * Tree CRUD (inventory_locations) is plain company-scoped CRUD via the typed
 * Supabase client. Balance mutations go through the SECURITY DEFINER RPCs
 * (add/deplete/adjust/transfer/enable/disable) because part_location_stock is
 * SELECT-only under RLS and each mutation must be paired atomically with an
 * inventory_transactions row. Unit conversion mirrors partsAccess: we convert
 * the caller's (quantity, unit) to the part's primary unit and hand the RPC
 * both the display values and the converted quantity.
 */
import { getTypedSupabase as getSupabase } from '@/lib/supabase';
import { convertToBaseUnit } from '@/lib/unitPresets';
import { duplicateSubtreeAsSibling } from '@/utils/locationSpec';
import type {
  CreateLocationInput,
  DepleteOptions,
  InventoryLocation,
  InventoryLocationNode,
  LocationContent,
  LocationSpecNode,
  PartLocationBalanceWithLocation,
  ResolvedScan,
  StockMutationResult,
  TrackingResult,
  TransferResult,
  UpdateLocationInput,
} from '@/types/inventoryLocations';
import type { MaterialLocation } from '@/types/materialCheck';

const LOCATION_COLUMNS =
  'id, company_id, parent_id, name, kind, code, sort_order, created_at, updated_at';

/** Split an id list so a batched `.in()` stays inside PostgREST's URL limits. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ===========================================================================
// Occupancy — "is there anything in this bin?"
// ===========================================================================

/**
 * Distinct live parts held DIRECTLY at each location, keyed by location id.
 *
 * Reads the `inventory_location_occupancy` view rather than counting
 * `part_location_stock` client-side. That is not an optimisation: PostgREST caps responses at
 * `max_rows` (1000 locally), and every stocked part gets an Unassigned balance row from
 * `trg_auto_track_stocked_part` — so a flat read on a few-thousand-part shop would **silently
 * truncate** and render wrong fill state with no error. The view returns one row per occupied
 * location instead.
 *
 * **Occupied locations only.** An absent key means empty; go through
 * `occupancyFor` in `utils/locationOccupancy.ts` rather than reading the map directly.
 */
export async function getLocationOccupancy(companyId: string): Promise<Map<string, number>> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('inventory_location_occupancy')
    .select('location_id, part_count')
    .eq('company_id', companyId);

  if (error) {
    console.error('Error fetching location occupancy:', error);
    throw error;
  }

  const out = new Map<string, number>();
  for (const row of data ?? []) {
    if (row.location_id === null) continue; // view columns are nullable in the generated type
    out.set(row.location_id, Number(row.part_count) || 0);
  }
  return out;
}

export interface LocationBoardData {
  locations: InventoryLocation[];
  /** Direct counts only — roll up with `rollUpOccupancy` before rendering. */
  directPartCounts: ReadonlyMap<string, number>;
}

/**
 * Everything the storage board needs, in **exactly two requests** whatever the tree size.
 *
 * Deliberately one function rather than two calls at the call site: it gives the manager a
 * single `useLoad` and gives the test a single thing to pin. A board that grew a request per
 * location would be the N+1 this shape exists to prevent — see the request-count test.
 */
export async function getLocationBoard(companyId: string): Promise<LocationBoardData> {
  const [locations, directPartCounts] = await Promise.all([
    getLocations(companyId),
    getLocationOccupancy(companyId),
  ]);
  return { locations, directPartCounts };
}

// ===========================================================================
// Tree CRUD
// ===========================================================================

/** Flat list of every location in a company, ordered for stable tree assembly. */
export async function getLocations(companyId: string): Promise<InventoryLocation[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('inventory_locations')
    .select(LOCATION_COLUMNS)
    .eq('company_id', companyId)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });

  if (error) {
    console.error('Error fetching inventory locations:', error);
    throw error;
  }
  return (data ?? []) as InventoryLocation[];
}

/** Assemble a flat location list into a nested tree (roots first). */
export function buildLocationTree(locations: InventoryLocation[]): InventoryLocationNode[] {
  const byId = new Map<string, InventoryLocationNode>();
  for (const loc of locations) {
    byId.set(loc.id, { ...loc, children: [], depth: 0 });
  }
  const roots: InventoryLocationNode[] = [];
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) {
      byId.get(node.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const assignDepth = (node: InventoryLocationNode, depth: number) => {
    node.depth = depth;
    for (const child of node.children) assignDepth(child, depth + 1);
  };
  for (const root of roots) assignDepth(root, 0);
  return roots;
}

export async function getLocation(id: string): Promise<InventoryLocation | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('inventory_locations')
    .select(LOCATION_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) {
    console.error('Error fetching inventory location:', error);
    throw error;
  }
  return (data as InventoryLocation | null) ?? null;
}

/** Assert a parent (if given) belongs to the same company. RLS validates the
 * written row but not the parent_id it points at, so we check it explicitly. */
async function assertParentInCompany(
  parentId: string | null | undefined,
  companyId: string,
): Promise<void> {
  if (!parentId) return;
  const parent = await getLocation(parentId);
  if (!parent || parent.company_id !== companyId) {
    throw new Error('Parent location must belong to the same company.');
  }
}

/**
 * The insert half of `createLocation`, with the parent check already done.
 *
 * Split out for `materializeLocationSpec`, whose nested parents are rows it created moments ago
 * in this same company — re-fetching each one to prove that costs a request per node for no
 * information. A 16-node cabinet went from ~31 requests to ~17.
 */
async function insertLocation(
  companyId: string,
  input: CreateLocationInput,
): Promise<InventoryLocation> {
  if (!input.name?.trim()) throw new Error('Location name is required');

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('inventory_locations')
    .insert({
      company_id: companyId,
      parent_id: input.parent_id ?? null,
      name: input.name.trim(),
      kind: input.kind ?? null,
      code: input.code ?? null,
      sort_order: input.sort_order ?? 0,
    })
    .select(LOCATION_COLUMNS)
    .single();

  if (error) {
    console.error('Error creating inventory location:', error);
    throw error;
  }
  return data as InventoryLocation;
}

export async function createLocation(
  companyId: string,
  input: CreateLocationInput,
): Promise<InventoryLocation> {
  if (!input.name?.trim()) throw new Error('Location name is required');
  await assertParentInCompany(input.parent_id, companyId);
  return insertLocation(companyId, input);
}

export async function updateLocation(
  id: string,
  patch: UpdateLocationInput,
): Promise<InventoryLocation> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('inventory_locations')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select(LOCATION_COLUMNS)
    .single();
  if (error) {
    console.error('Error updating inventory location:', error);
    throw error;
  }
  return data as InventoryLocation;
}

/** Re-parent a node, guarding against same-company violations and cycles
 * (a node cannot be moved beneath one of its own descendants). */
export async function moveLocation(
  id: string,
  newParentId: string | null,
  companyId: string,
): Promise<InventoryLocation> {
  if (newParentId === id) throw new Error('A location cannot be its own parent.');
  await assertParentInCompany(newParentId, companyId);

  if (newParentId) {
    const all = await getLocations(companyId);
    const byId = new Map(all.map((l) => [l.id, l] as const));
    let cursor: string | null = newParentId;
    while (cursor) {
      if (cursor === id) {
        throw new Error('Cannot move a location beneath one of its own sub-locations.');
      }
      cursor = byId.get(cursor)?.parent_id ?? null;
    }
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('inventory_locations')
    .update({ parent_id: newParentId, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select(LOCATION_COLUMNS)
    .single();
  if (error) {
    console.error('Error moving inventory location:', error);
    throw error;
  }
  return data as InventoryLocation;
}

/**
 * Delete a location (and its EMPTY subtree) via the delete_location RPC. The RPC
 * refuses only when some location in the subtree still holds qty>0 stock;
 * otherwise it cascade-deletes the empty sub-locations and their leftover
 * zero-qty balance rows (SELECT-only for clients). Historical ledger rows keep
 * their location_name snapshot; their location_id is nulled by the FK.
 */
export async function deleteLocation(id: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc('delete_location', { p_location_id: id });
  if (error) {
    console.error('Error deleting inventory location:', error);
    const msg = error.message ?? '';
    if (msg.includes('still holds stock')) {
      throw new Error('This location (or something inside it) still holds stock. Move it out first.');
    }
    throw new Error('Failed to delete location.');
  }
}

/** Insert a spec forest under a parent already proven to be in `companyId`. */
async function insertSpecForest(
  companyId: string,
  parentId: string | null,
  nodes: LocationSpecNode[],
  startSortOrder: number,
): Promise<InventoryLocation[]> {
  const created: InventoryLocation[] = [];
  let sortOrder = startSortOrder;
  for (const node of nodes) {
    const row = await insertLocation(companyId, {
      parent_id: parentId,
      name: node.name,
      kind: node.kind,
      code: node.code,
      sort_order: sortOrder++,
    });
    created.push(row);
    if (node.children.length > 0) {
      // `row` was just inserted with company_id = companyId, so its children need no re-check.
      created.push(...(await insertSpecForest(companyId, row.id, node.children, 0)));
    }
  }
  return created;
}

/**
 * Materialize a LocationSpecNode forest (built client-side by the visual builder) into
 * inventory_locations. Parent before children; names and codes come straight from the precomputed
 * spec. Every location is stockable and printable.
 *
 * The caller-supplied `parentId` is validated ONCE here. It used to be re-validated inside
 * `createLocation` for every node, including nodes whose parent this function had just created —
 * a wasted `getLocation` per node (a 16-node cabinet cost ~31 requests instead of ~17).
 *
 * Still sequential and still **not transactional**: a failure partway leaves the nodes created
 * before it. That's why `buildSpecFromLevels` takes the parent's existing sibling names — a
 * repeat subdivide continues the numbering instead of colliding, so the sibling-name unique
 * index can't kill a run halfway. A single multi-row insert (or an RPC) is the real fix and is
 * tracked separately.
 */
export async function materializeLocationSpec(
  companyId: string,
  parentId: string | null,
  nodes: LocationSpecNode[],
  startSortOrder = 0,
): Promise<InventoryLocation[]> {
  await assertParentInCompany(parentId, companyId);
  return insertSpecForest(companyId, parentId, nodes, startSortOrder);
}

/**
 * Duplicate a location and its entire subtree as a new sibling — structure
 * only, no stock. The copy's root is named past the existing siblings
 * (Cabinet 1 → Cabinet 2) and sorted after them; every code is re-derived under
 * the same parent from the bumped name + kind (the shared builder/bulk-generate
 * scheme, so a custom edited code is not preserved). Sequential inserts via
 * materializeLocationSpec.
 */
export async function duplicateLocation(
  companyId: string,
  locationId: string,
): Promise<InventoryLocation[]> {
  const all = await getLocations(companyId);
  const target = all.find((l) => l.id === locationId);
  if (!target) throw new Error('Location not found.');

  // getLocations is already ordered by sort_order then name, so children keep
  // their display order.
  const childrenOf = (parentId: string | null) => all.filter((l) => l.parent_id === parentId);

  const toSpec = (loc: InventoryLocation): LocationSpecNode => ({
    key: loc.id, // ignored by materialize; cloneSubtree assigns fresh keys
    name: loc.name,
    kind: loc.kind,
    code: loc.code,
    children: childrenOf(loc.id).map(toSpec),
  });

  const parentCode = target.parent_id
    ? (all.find((l) => l.id === target.parent_id)?.code ?? null)
    : null;
  const siblings = childrenOf(target.parent_id);
  const clone = duplicateSubtreeAsSibling(
    toSpec(target),
    parentCode,
    siblings.map((l) => l.name),
  );
  // Sort the copy after the existing siblings (sort_order ASC, name ASC read
  // order) rather than letting it default to 0 and jump to the front.
  const nextSortOrder = siblings.reduce((max, s) => Math.max(max, s.sort_order), -1) + 1;
  return materializeLocationSpec(companyId, target.parent_id, [clone], nextSortOrder);
}

// ===========================================================================
// Balances & scan resolution (reads)
// ===========================================================================

function computePathNames(
  locationId: string,
  byId: Map<string, InventoryLocation>,
): string[] {
  const names: string[] = [];
  let cursor: string | null = locationId;
  const guard = new Set<string>();
  while (cursor && byId.has(cursor) && !guard.has(cursor)) {
    guard.add(cursor);
    const node: InventoryLocation = byId.get(cursor)!;
    names.unshift(node.name);
    cursor = node.parent_id;
  }
  return names;
}

/** A part's balances across locations, each with its full display path. */
export async function getBalancesForPart(
  partId: string,
): Promise<PartLocationBalanceWithLocation[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('part_location_stock')
    .select('company_id, location_id, quantity')
    .eq('part_id', partId);
  if (error) {
    console.error('Error fetching part balances:', error);
    throw error;
  }
  const rows = (data ?? []) as Array<{ company_id: string; location_id: string; quantity: number }>;
  if (rows.length === 0) return [];

  const locations = await getLocations(rows[0].company_id);
  const byId = new Map(locations.map((l) => [l.id, l] as const));

  return rows
    .map((r) => {
      const loc = byId.get(r.location_id);
      return {
        location_id: r.location_id,
        location_name: loc?.name ?? 'Unknown',
        location_code: loc?.code ?? null,
        path: computePathNames(r.location_id, byId),
        quantity: Number(r.quantity),
      };
    })
    .sort((a, b) => a.path.join(' / ').localeCompare(b.path.join(' / ')));
}

/**
 * Balances for MANY parts, in one query — the batched sibling of `getBalancesForPart`.
 *
 * A sheet or a job's material list covering a few hundred parts would N+1 the single-part
 * version into the ground. `path` here is the ANCESTOR names only (root first), excluding the
 * location itself, so callers can render "Cabinet 3 › Shelf A" without repeating the leaf.
 *
 * Lifted out of `inventoryCountAccess`, where it lived privately and left `locationName` blank
 * for the call site to patch in — a comment there flagged exactly that. Both J7 and J9 use it.
 */
export async function getBalancesForParts(
  companyId: string,
  partIds: string[],
): Promise<Map<string, MaterialLocation[]>> {
  const byPart = new Map<string, MaterialLocation[]>();
  if (partIds.length === 0) return byPart;

  const supabase = getSupabase();
  const CHUNK = 500; // keep the IN () list well inside PostgREST's URL limits

  const [locations, ...pages] = await Promise.all([
    getLocations(companyId),
    ...chunk(partIds, CHUNK).map(async (ids) => {
      const { data, error } = await supabase
        .from('part_location_stock')
        .select('part_id, location_id, quantity')
        .in('part_id', ids);
      if (error) {
        console.error('Error loading location balances:', error);
        throw error;
      }
      return (data ?? []) as Array<{ part_id: string; location_id: string; quantity: number }>;
    }),
  ]);

  const byId = new Map(locations.map((l) => [l.id, l] as const));

  for (const row of pages.flat()) {
    const full = computePathNames(row.location_id, byId);
    const list = byPart.get(row.part_id) ?? [];
    list.push({
      locationId: row.location_id,
      locationName: byId.get(row.location_id)?.name ?? 'Unknown location',
      path: full.slice(0, -1), // ancestors only; the leaf is locationName
      quantity: Number(row.quantity) || 0,
    });
    byPart.set(row.part_id, list);
  }

  for (const list of byPart.values()) {
    list.sort((a, b) => [...a.path, a.locationName].join(' / ')
      .localeCompare([...b.path, b.locationName].join(' / ')));
  }
  return byPart;
}

/**
 * How many parts one location lists at a time.
 *
 * Bounded on purpose. This read used to have no limit at all, which meant PostgREST's
 * `max_rows = 1000` (`supabase/config.toml`) clipped it **silently** — invisible on the seed's
 * 14 rows, wrong on a shop whose `Unassigned` bucket holds every part they own. An explicit cap
 * paired with an exact `total` lets the UI say "showing 200 of 9,428" instead of quietly lying.
 */
export const LOCATION_CONTENTS_LIMIT = 200;

export interface LocationContentsPage {
  contents: LocationContent[];
  /** Exact parts held here, ignoring the page size — so the UI can admit truncation. */
  total: number;
}

/**
 * Parts (and quantities > 0) stored directly at a location, capped at `limit`.
 *
 * Archived parts are excluded, which matches `inventory_location_occupancy` exactly — without
 * that the board would chip a cabinet "3 parts" while the sheet listed four.
 *
 * Truncation is ordered by quantity descending so it's deterministic and useful (the biggest
 * holdings survive); the returned page is then sorted alphabetically, which is how an operator
 * scans a bin. At any realistic location count the two are the same list.
 */
export async function getLocationContents(
  locationId: string,
  limit: number = LOCATION_CONTENTS_LIMIT,
): Promise<LocationContentsPage> {
  const supabase = getSupabase();
  const { data, error, count } = await supabase
    .from('part_location_stock')
    .select(
      'quantity, part:parts!part_location_stock_part_fkey!inner(id, part_name, primary_unit)',
      { count: 'exact' },
    )
    .eq('location_id', locationId)
    .is('part.deleted_at', null)
    .gt('quantity', 0)
    .order('quantity', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('Error fetching location contents:', error);
    throw error;
  }

  type Row = {
    quantity: number;
    part:
      | { id: string; part_name: string; primary_unit: string | null }
      | Array<{ id: string; part_name: string; primary_unit: string | null }>
      | null;
  };

  const contents = ((data ?? []) as Row[])
    .map((row) => {
      const part = Array.isArray(row.part) ? row.part[0] : row.part;
      if (!part) return null;
      return {
        part_id: part.id,
        part_name: part.part_name,
        primary_unit: part.primary_unit,
        quantity: Number(row.quantity),
      } as LocationContent;
    })
    .filter((r): r is LocationContent => r !== null)
    .sort((a, b) => a.part_name.localeCompare(b.part_name));

  return { contents, total: count ?? contents.length };
}

/** Resolve a scanned location id into node + ancestor path + children +
 * contents, so the bin view can render drill-down (parent) vs actions (leaf). */
export async function resolveScan(locationId: string): Promise<ResolvedScan> {
  const node = await getLocation(locationId);
  if (!node) throw new Error('Location not found');

  const [locations, page] = await Promise.all([
    getLocations(node.company_id),
    getLocationContents(locationId),
  ]);
  const byId = new Map(locations.map((l) => [l.id, l] as const));

  const path: InventoryLocation[] = [];
  let cursor: string | null = locationId;
  const guard = new Set<string>();
  while (cursor && byId.has(cursor) && !guard.has(cursor)) {
    guard.add(cursor);
    path.unshift(byId.get(cursor)!);
    cursor = byId.get(cursor)!.parent_id;
  }

  const children = locations
    .filter((l) => l.parent_id === locationId)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));

  return { node, path, children, contents: page.contents, contentsTotal: page.total };
}

// ===========================================================================
// Balance mutations (RPC wrappers — atomic balance + ledger)
// ===========================================================================

async function loadConversionContext(
  partId: string,
): Promise<{ primaryUnit: string; conversions: { from_unit: string; to_primary_factor: number }[] }> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('parts')
    .select('primary_unit, parts_unit_conversions(from_unit, to_primary_factor)')
    .eq('id', partId)
    .single();
  if (error || !data) throw error || new Error('Part not found');
  if (!data.primary_unit) {
    throw new Error('Part has no primary unit; cannot record a stock transaction.');
  }
  return {
    primaryUnit: data.primary_unit,
    conversions:
      (data.parts_unit_conversions as Array<{ from_unit: string; to_primary_factor: number }>) ?? [],
  };
}

export async function enableLocationTracking(
  partId: string,
  initialLocationId?: string,
): Promise<TrackingResult> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('enable_location_tracking', {
    p_part_id: partId,
    p_initial_location_id: initialLocationId,
  });
  if (error) {
    console.error('Error enabling location tracking:', error);
    throw error;
  }
  return data as unknown as TrackingResult;
}

export async function disableLocationTracking(partId: string): Promise<TrackingResult> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('disable_location_tracking', { p_part_id: partId });
  if (error) {
    console.error('Error disabling location tracking:', error);
    throw error;
  }
  return data as unknown as TrackingResult;
}

export async function addStockAtLocation(
  partId: string,
  locationId: string,
  quantity: number,
  unit: string,
  notes?: string,
): Promise<StockMutationResult> {
  const { primaryUnit, conversions } = await loadConversionContext(partId);
  const converted = convertToBaseUnit(quantity, unit, primaryUnit, conversions);

  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('add_stock_at_location', {
    p_part_id: partId,
    p_location_id: locationId,
    p_quantity: quantity,
    p_unit: unit,
    p_converted_quantity: converted,
    p_notes: notes,
  });
  if (error) {
    console.error('Error adding stock at location:', error);
    throw error;
  }
  return data as unknown as StockMutationResult;
}

export async function depleteStockAtLocation(
  partId: string,
  locationId: string,
  quantity: number,
  unit: string,
  opts: DepleteOptions = {},
): Promise<StockMutationResult> {
  const { primaryUnit, conversions } = await loadConversionContext(partId);
  const converted = convertToBaseUnit(quantity, unit, primaryUnit, conversions);

  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('deplete_stock_at_location', {
    p_part_id: partId,
    p_location_id: locationId,
    p_quantity: quantity,
    p_unit: unit,
    p_converted_quantity: converted,
    p_graceful: opts.graceful ?? false,
    p_notes: opts.notes,
    p_job_id: opts.jobId,
    p_job_operation_id: opts.jobOperationId,
    p_operator_id: opts.operatorId,
  });
  if (error) {
    console.error('Error depleting stock at location:', error);
    throw error;
  }
  return data as unknown as StockMutationResult;
}

export async function adjustStockAtLocation(
  partId: string,
  locationId: string,
  newQuantity: number,
  unit: string,
  notes?: string,
): Promise<StockMutationResult> {
  const { primaryUnit, conversions } = await loadConversionContext(partId);
  const converted = convertToBaseUnit(newQuantity, unit, primaryUnit, conversions);

  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('adjust_stock_at_location', {
    p_part_id: partId,
    p_location_id: locationId,
    p_new_quantity: newQuantity,
    p_unit: unit,
    p_converted_new_quantity: converted,
    p_notes: notes,
  });
  if (error) {
    console.error('Error adjusting stock at location:', error);
    throw error;
  }
  return data as unknown as StockMutationResult;
}

export async function transferStock(
  partId: string,
  fromLocationId: string,
  toLocationId: string,
  quantity: number,
  unit: string,
  notes?: string,
): Promise<TransferResult> {
  const { primaryUnit, conversions } = await loadConversionContext(partId);
  const converted = convertToBaseUnit(quantity, unit, primaryUnit, conversions);

  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('transfer_stock', {
    p_part_id: partId,
    p_from_location_id: fromLocationId,
    p_to_location_id: toLocationId,
    p_quantity: quantity,
    p_unit: unit,
    p_converted_quantity: converted,
    p_notes: notes,
  });
  if (error) {
    console.error('Error transferring stock:', error);
    throw error;
  }
  return data as unknown as TransferResult;
}

