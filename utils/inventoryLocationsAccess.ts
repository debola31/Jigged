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
import { generatedCode, explicitCode, duplicateSubtreeAsSibling } from '@/utils/locationSpec';
import type {
  BulkGenerateSpec,
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

const LOCATION_COLUMNS =
  'id, company_id, parent_id, name, kind, code, is_stockable, is_qr_anchor, sort_order, created_at, updated_at';

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

export async function getLocationTree(companyId: string): Promise<InventoryLocationNode[]> {
  return buildLocationTree(await getLocations(companyId));
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

export async function createLocation(
  companyId: string,
  input: CreateLocationInput,
): Promise<InventoryLocation> {
  if (!input.name?.trim()) throw new Error('Location name is required');
  await assertParentInCompany(input.parent_id, companyId);

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('inventory_locations')
    .insert({
      company_id: companyId,
      parent_id: input.parent_id ?? null,
      name: input.name.trim(),
      kind: input.kind ?? null,
      code: input.code ?? null,
      is_stockable: input.is_stockable ?? true,
      is_qr_anchor: input.is_qr_anchor ?? false,
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

/**
 * Bulk-generate repetitive structure under a parent — e.g. 10 rows × {Left,
 * Right}. Names follow `namePattern` ('{n}' → index); codes are zero-padded
 * for sortability (shared scheme with the visual builder via locationSpec).
 * Created sequentially so leaves can attach to their row.
 */
export async function bulkGenerateChildren(
  companyId: string,
  parentId: string,
  spec: BulkGenerateSpec,
): Promise<InventoryLocation[]> {
  if (spec.count <= 0) throw new Error('Count must be positive');
  await assertParentInCompany(parentId, companyId);

  const parent = await getLocation(parentId);
  const start = spec.startAt ?? 1;
  const width = Math.max(2, String(start + spec.count - 1).length);
  const pattern = spec.namePattern ?? '{n}';
  const created: InventoryLocation[] = [];

  for (let i = 0; i < spec.count; i++) {
    const idx = start + i;
    const node = await createLocation(companyId, {
      parent_id: parentId,
      name: pattern.replace('{n}', String(idx)),
      kind: spec.kind ?? null,
      code: generatedCode(parent?.code ?? null, spec.kind ?? '', idx, width),
      sort_order: idx,
    });
    created.push(node);

    for (let j = 0; j < (spec.leaves?.length ?? 0); j++) {
      const leafName = spec.leaves![j];
      const leaf = await createLocation(companyId, {
        parent_id: node.id,
        name: leafName,
        kind: spec.leafKind ?? 'side',
        code: explicitCode(node.code, leafName),
        sort_order: j,
      });
      created.push(leaf);
    }
  }
  return created;
}

/**
 * Materialize a LocationSpecNode forest (built client-side by the visual
 * builder) into inventory_locations. Recursively composes the existing
 * `createLocation` — parent before children — so all the company/parent
 * validation and code handling is shared with the manual flow. Names and codes
 * come straight from the precomputed spec; every location is stockable +
 * printable (createLocation defaults).
 *
 * Sequential inserts mirror bulkGenerateChildren; a single multi-row insert is
 * a cheap future optimization if specs ever get large.
 */
export async function materializeLocationSpec(
  companyId: string,
  parentId: string | null,
  nodes: LocationSpecNode[],
  startSortOrder = 0,
): Promise<InventoryLocation[]> {
  const created: InventoryLocation[] = [];
  let sortOrder = startSortOrder;
  for (const node of nodes) {
    const row = await createLocation(companyId, {
      parent_id: parentId,
      name: node.name,
      kind: node.kind,
      code: node.code,
      sort_order: sortOrder++,
    });
    created.push(row);
    if (node.children.length > 0) {
      created.push(...(await materializeLocationSpec(companyId, row.id, node.children)));
    }
  }
  return created;
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

/** Parts (and quantities > 0) stored directly at a location. */
export async function getLocationContents(locationId: string): Promise<LocationContent[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('part_location_stock')
    .select('quantity, part:parts!part_location_stock_part_fkey(id, part_name, primary_unit)')
    .eq('location_id', locationId)
    .gt('quantity', 0);
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

  return ((data ?? []) as Row[])
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
}

/** Resolve a scanned location id into node + ancestor path + children +
 * contents, so the bin view can render drill-down (parent) vs actions (leaf). */
export async function resolveScan(locationId: string): Promise<ResolvedScan> {
  const node = await getLocation(locationId);
  if (!node) throw new Error('Location not found');

  const [locations, contents] = await Promise.all([
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

  return { node, path, children, contents };
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

// ===========================================================================
// QR
// ===========================================================================

/** Deep-link a location scan to the operator login, which routes to the bin
 * view post-login (payload is the UUID, never the human code). */
export function buildLocationUrl(companyId: string, locationId: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}/operator/${companyId}/login?location=${locationId}`;
}
