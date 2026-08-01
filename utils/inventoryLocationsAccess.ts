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
import { isReservedKind, RESERVED_KIND_MESSAGE } from '@/lib/locationKinds';
import { duplicateSubtreeAsSibling } from '@/utils/locationSpec';
import {
  deleteFileFromStorage,
  generateStoragePath,
  getSignedUrls,
  uploadFileToStorage,
} from '@/utils/storageHelpers';
import type {
  CreateLocationInput,
  DepleteOptions,
  StockWriteOptions,
  LocationHistoryEntry,
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
  'id, company_id, parent_id, name, kind, code, sort_order, photo_path, created_at, updated_at';

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
  /**
   * `photo_path` → signed URL, for the locations that have a photo.
   *
   * Resolved here rather than per tile: the bucket is private, so each thumbnail needs a signed
   * URL, and a board of 22 places would otherwise open 22 connections on every load. An absent
   * key means "no URL" (no photo, or an unreadable object) and renders as the drawn tile.
   */
  photoUrls: ReadonlyMap<string, string>;
}

/** How long a board thumbnail's signed URL stays good. Matches the other media surfaces. */
const PHOTO_URL_EXPIRY_SECONDS = 4 * 60 * 60;

/**
 * Everything the storage board needs, in a **fixed** number of requests whatever the tree size.
 *
 * Two `.from()` reads (locations + occupancy) plus, only when some location has a photo, one
 * batched `createSignedUrls`. Deliberately one function rather than three calls at the call site:
 * it gives the manager a single `useLoad` and gives the test a single thing to pin. A board that
 * grew a request per location would be the N+1 this shape exists to prevent — see the
 * request-count test.
 */
export async function getLocationBoard(companyId: string): Promise<LocationBoardData> {
  const [locations, directPartCounts] = await Promise.all([
    getLocations(companyId),
    getLocationOccupancy(companyId),
  ]);

  const paths = locations
    .map((l) => l.photo_path)
    .filter((p): p is string => Boolean(p));
  // Skipped entirely when nothing has a photo, which is every company today.
  const photoUrls = paths.length > 0 ? await getSignedUrls(paths, PHOTO_URL_EXPIRY_SECONDS) : EMPTY_URLS;

  return { locations, directPartCounts, photoUrls };
}

const EMPTY_URLS: ReadonlyMap<string, string> = new Map();

/**
 * Attach a photo to a location, replacing any previous one.
 *
 * Compression happens in the browser before this is called (`compressPhoto`), matching the job-feed
 * pipeline — a phone photo is several MB of pixels nobody needs at thumbnail size.
 *
 * Upload first, then point the row at it, then delete the old object. That order means a failure
 * anywhere leaves a *readable* location: a failed upload changes nothing, and a failed cleanup
 * leaves an invisible orphan in the bucket rather than a row pointing at a file that isn't there.
 * Same trade `note_media` makes deliberately.
 */
export async function setLocationPhoto(
  companyId: string,
  locationId: string,
  file: File,
  previousPath?: string | null,
): Promise<InventoryLocation> {
  const path = generateStoragePath(companyId, 'locations', locationId, file.name);
  await uploadFileToStorage(path, file);

  let updated: InventoryLocation;
  try {
    updated = await updateLocation(locationId, { photo_path: path });
  } catch (e) {
    // Don't leave an object nothing references.
    await deleteFileFromStorage(path).catch(() => {});
    throw e;
  }

  if (previousPath && previousPath !== path) {
    await deleteFileFromStorage(previousPath).catch((err) =>
      console.warn('Replaced a location photo but could not remove the old file:', err),
    );
  }
  return updated;
}

/** Drop a location's photo. Clears the row first, so a failed file delete only orphans bytes. */
export async function clearLocationPhoto(
  locationId: string,
  currentPath: string | null,
): Promise<InventoryLocation> {
  const updated = await updateLocation(locationId, { photo_path: null });
  if (currentPath) {
    await deleteFileFromStorage(currentPath).catch((err) =>
      console.warn('Cleared a location photo but could not remove the file:', err),
    );
  }
  return updated;
}

/** A signed URL for one location's photo — for the detail sheet, which shows one at a time. */
export async function getLocationPhotoUrl(path: string): Promise<string | null> {
  const urls = await getSignedUrls([path], PHOTO_URL_EXPIRY_SECONDS);
  return urls.get(path) ?? null;
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

/** Postgres unique-violation. Here it can only be a duplicate sibling name. */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Turn a duplicate-sibling-name violation into something a shop owner can act on.
 *
 * `inventory_locations_unique_sibling_name` is the only unique index a write from this module can
 * trip, so the mapping is unambiguous. Raw PostgREST text ("duplicate key value violates unique
 * constraint …") tells an owner nothing about which name to change.
 */
function mapLocationWriteError(error: { code?: string; message?: string }, name?: string): Error {
  if (error.code === PG_UNIQUE_VIOLATION) {
    return new Error(
      name
        ? `There's already a "${name}" in the same place. Pick a different name.`
        : 'There\'s already a location with that name in the same place. Pick a different name.',
    );
  }
  return new Error(error.message ?? 'Failed to save location.');
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
    throw mapLocationWriteError(error, input.name.trim());
  }
  return data as InventoryLocation;
}

export async function createLocation(
  companyId: string,
  input: CreateLocationInput,
): Promise<InventoryLocation> {
  if (!input.name?.trim()) throw new Error('Location name is required');
  // `system` is the marker for the auto-managed Unassigned bucket, and a location carrying it
  // loses its entire structural-actions block — rename included — with no way back. See
  // `isReservedKind`. Guarded here as well as in the form so no write path can set it.
  if (isReservedKind(input.kind)) throw new Error(RESERVED_KIND_MESSAGE);
  await assertParentInCompany(input.parent_id, companyId);
  return insertLocation(companyId, input);
}

export async function updateLocation(
  id: string,
  patch: UpdateLocationInput,
): Promise<InventoryLocation> {
  if (isReservedKind(patch.kind)) throw new Error(RESERVED_KIND_MESSAGE);
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('inventory_locations')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select(LOCATION_COLUMNS)
    .single();
  if (error) {
    console.error('Error updating inventory location:', error);
    // A rename can collide with a sibling just as a create can.
    throw mapLocationWriteError(error, patch.name);
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

/**
 * Root → leaf names for a location, e.g. `['Cabinet 1', 'Row 3', 'Left']`.
 *
 * Exported because this walk had been hand-rolled in three other places (the operator bin page,
 * the count page, and `PartLocationInventory`). Use this one rather than writing a fourth — the
 * cycle guard in particular is easy to leave out, and re-parenting can produce one.
 */
export function computePathNames(
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
        // Carried so callers can tell a SHELF from the `Unassigned` put-away pile. Without it,
        // "where does this part live?" answers "Unassigned" — which is precisely the answer
        // "nowhere yet", presented as though it were a place.
        kind: loc?.kind ?? null,
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

/** Rows per page when working through a location's contents. */
export const LOCATION_PAGE_SIZE = 100;

export interface LocationContentsQuery {
  /** Server-side match on the part name. Blank/absent means everything here. */
  search?: string;
  limit?: number;
  offset?: number;
}

/**
 * One page of a location's contents, searchable and offset-able.
 *
 * `getLocationContents` answers *"what's in this bin"* for a bin you can take in at a glance, and
 * caps at 200 with no way past it. That's the wrong shape for working through `Unassigned`, which on
 * a real shop holds **every part they own** — you can't scroll 9,428 rows and you can't select them
 * meaningfully. The realistic move is *"search for what I'm holding, take those"*, so search is
 * server-side and paging is explicit.
 *
 * Ordered by name (not quantity): a page you're going to search and tick through has to be
 * alphabetical to be navigable, and unlike the capped read there's no "keep the biggest" truncation
 * to be clever about.
 *
 * ⚠️ **An offset is only valid for an unchanged result set.** Putting parts away removes them from
 * *this* location's rows, so a caller that holds its offset across a move will silently skip
 * whatever shifted up. Refetch from offset 0 after any write — see the worksheet.
 */
export async function getLocationContentsPage(
  locationId: string,
  { search = '', limit = LOCATION_PAGE_SIZE, offset = 0 }: LocationContentsQuery = {},
): Promise<LocationContentsPage> {
  const supabase = getSupabase();
  let query = supabase
    .from('part_location_stock')
    .select(
      'quantity, part:parts!part_location_stock_part_fkey!inner(id, part_name, primary_unit)',
      { count: 'exact' },
    )
    .eq('location_id', locationId)
    .is('part.deleted_at', null)
    .gt('quantity', 0);

  const term = search.trim();
  // Filtering and ordering both reach through the embed, so the whole thing stays one request —
  // the alternative (fetch, then filter in JS) would have to fetch everything first, which is the
  // problem this function exists to avoid.
  if (term) query = query.ilike('part.part_name', `%${term}%`);

  const { data, error, count } = await query
    // `'part'` is the embed's ALIAS, not the table name. `referencedTable: 'parts'` makes PostgREST
    // reject the whole request with `PGRST108 'parts' is not an embedded resource` — verified
    // against the running stack, which is the only way this surfaces (it type-checks either way).
    .order('part_name', { referencedTable: 'part', ascending: true })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error('Error fetching location contents page:', error);
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
    .filter((r): r is LocationContent => r !== null);

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
  opts: StockWriteOptions = {},
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
    p_notes: opts.notes,
    // Written at INSERT — there is no later step that can attach either, because the RPC's row is
    // immutable except for notes. See StockWriteOptions.
    p_operator_id: opts.operatorId ?? undefined,
    p_photo_path: opts.photoPath ?? undefined,
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
  // No `photoPath`: an adjustment corrects a NUMBER, it is not a physical movement anyone can
  // photograph. Its evidence is the count that produced it.
  opts: Omit<StockWriteOptions, 'photoPath'> = {},
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
    p_notes: opts.notes,
    p_operator_id: opts.operatorId ?? undefined,
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
  opts: StockWriteOptions = {},
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
    p_notes: opts.notes,
    // Both halves of the pair get the same author and the same photo — one person moved it.
    p_operator_id: opts.operatorId ?? undefined,
    p_photo_path: opts.photoPath ?? undefined,
  });
  if (error) {
    console.error('Error transferring stock:', error);
    throw error;
  }
  return data as unknown as TransferResult;
}

/**
 * Most parts a single put-away may move — mirrors `PUT_AWAY_MAX` in the RPC.
 *
 * Duplicated here only so the UI can cap "select all shown" and say so *before* someone selects
 * 2,000 rows and gets refused. The DB is the enforcer; this is the courtesy.
 */
export const PUT_AWAY_MAX = 1000;

export interface PutAwayResult {
  /** Parts whose balance actually moved. */
  moved: number;
  /** Requested but not moved — no stock here, no row here, untracked, or archived. */
  skipped: number;
  /** One id for the whole batch, so the ledger reads it as a single event. */
  transfer_group_id: string;
}

/**
 * Move the FULL balance of many parts from one location to another, atomically.
 *
 * The counterpart to `transferStock` for the put-away job: no quantity and no unit, because it
 * moves everything each part holds. That means **no per-part conversion read** — one request for N
 * parts where looping `transferStock` would cost 2N.
 *
 * ⚠️ **Never chunk this array.** The reason `bulk_put_away` exists is that a half-moved pile is
 * worse than no move — you can't tell what you already did. Splitting into 500s would turn one
 * transaction into several, each with its own `transfer_group_id`, and a failure in the second batch
 * would leave precisely the mess the RPC prevents. `bulkDeleteParts` can chunk safely because
 * soft-delete is idempotent; this is not. The 500-chunk convention elsewhere in this file exists for
 * `.in()` reads, where the real limit is PostgREST's URL length — an RPC POSTs a body and has no
 * such constraint. The RPC caps the array itself at `PUT_AWAY_MAX` so no caller can re-introduce a
 * loop and quietly break the guarantee.
 */
export async function bulkPutAway(
  fromLocationId: string,
  toLocationId: string,
  partIds: string[],
): Promise<PutAwayResult> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('bulk_put_away', {
    p_from_location_id: fromLocationId,
    p_to_location_id: toLocationId,
    p_part_ids: partIds,
  });
  if (error) {
    console.error('Error putting stock away:', error);
    throw error;
  }
  return data as unknown as PutAwayResult;
}


// ===========================================================================
// Bin history
// ===========================================================================

/**
 * What has happened in one place lately.
 *
 * Until now there was **no operator-side ledger view at all** — the history existed in
 * `inventory_transactions` and could only be read from the admin part page. That made a photo on a
 * movement write-only: worth taking, impossible to look at. This is the read half.
 *
 * ## Why the author needs a second query
 *
 * `operator_id` has **no foreign key** (`inventory_transactions`' only FKs are `company_id`,
 * `job_id`, `job_operation_id`, `part_id`), so the PostgREST embed the notes feed uses —
 * `author:user_company_access(name)` — cannot work here: an embed needs a declared relationship.
 * Hence one extra round trip to resolve ids to names. Adding the FK would be the tidier fix, but it
 * needs the existing column values validated first, so it is deliberately not done here.
 *
 * `created_by` is no help: it holds an `auth.users` id, which the browser cannot read at all.
 * A movement written before `operator_id` was populated on add/adjust/transfer simply has no
 * author, and renders as such rather than guessing.
 *
 * Three requests, all batched, regardless of how many rows come back: the page, the distinct
 * authors, and one signed-URL call for every photo.
 */
/** Columns every movement view needs. One literal — a concatenation defeats the typed client. */
const MOVEMENT_COLUMNS =
  'id, created_at, type, part_id, item_name, quantity, unit, notes, operator_id, photo_path, has_discrepancy, transfer_group_id, location_id, location_name';

interface MovementRow {
  id: string;
  created_at: string;
  type: string;
  part_id: string | null;
  item_name: string;
  quantity: number;
  unit: string;
  notes: string | null;
  operator_id: string | null;
  photo_path: string | null;
  has_discrepancy: boolean;
  transfer_group_id: string | null;
  location_id: string | null;
  location_name: string | null;
}

/**
 * Resolve the two things a movement row cannot carry itself: the author's name and a viewable
 * photo URL.
 *
 * ## Why the author needs a separate query
 *
 * `operator_id` has **no foreign key** — `inventory_transactions`' only FKs are `company_id`,
 * `job_id`, `job_operation_id` and `part_id` — so the PostgREST embed the notes feed uses
 * (`author:user_company_access(name)`) cannot work here: an embed needs a declared relationship.
 * Adding the FK would be tidier, but it needs the existing column values validated first.
 *
 * `created_by` is no help either: it holds an `auth.users` id the browser cannot read at all. A
 * movement written before `operator_id` was populated on add/adjust/transfer therefore has no
 * author, and is returned with none rather than a guess.
 *
 * Two batched requests regardless of row count: the distinct authors, and one signed-URL call.
 */
async function hydrateMovements(rows: MovementRow[]): Promise<LocationHistoryEntry[]> {
  if (rows.length === 0) return [];
  const supabase = getSupabase();

  const actorIds = [...new Set(rows.map((r) => r.operator_id).filter((v): v is string => !!v))];
  const photoPaths = rows.map((r) => r.photo_path).filter((v): v is string => !!v);

  const [actors, photoUrls] = await Promise.all([
    actorIds.length > 0
      ? supabase.from('user_company_access').select('id, name').in('id', actorIds)
      : Promise.resolve({ data: [], error: null }),
    photoPaths.length > 0
      ? getSignedUrls(photoPaths, PHOTO_URL_EXPIRY_SECONDS)
      : Promise.resolve(EMPTY_URLS),
  ]);

  // A failed name lookup must not take the history down with it — the movements are the point,
  // the names are the caption.
  const nameById = new Map<string, string>();
  for (const a of (actors.data ?? []) as Array<{ id: string; name: string | null }>) {
    if (a.name) nameById.set(a.id, a.name);
  }

  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    partId: r.part_id,
    type: r.type === 'addition' || r.type === 'depletion' ? r.type : 'adjustment',
    itemName: r.item_name,
    quantity: Number(r.quantity ?? 0),
    unit: r.unit,
    notes: r.notes,
    actorName: r.operator_id ? nameById.get(r.operator_id) ?? null : null,
    photoUrl: r.photo_path ? photoUrls.get(r.photo_path) ?? null : null,
    hasDiscrepancy: Boolean(r.has_discrepancy),
    transferGroupId: r.transfer_group_id,
    locationId: r.location_id,
    // Snapshotted on the row by `trg_snapshot_txn_location`, so it still reads correctly after a
    // location is deleted and `location_id` goes NULL.
    locationName: r.location_name,
  }));
}

/**
 * What has happened in ONE place lately.
 *
 * Until this existed there was no operator-side ledger view at all — movements lived in
 * `inventory_transactions` and could only be read from the admin part page, which is what made a
 * photo on a put-away write-only. It also answers "who took the last one?"
 */
export async function getLocationHistory(
  locationId: string,
  limit = 20,
): Promise<LocationHistoryEntry[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('inventory_transactions')
    .select(MOVEMENT_COLUMNS)
    .eq('location_id', locationId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('Error fetching location history:', error);
    throw error;
  }
  return hydrateMovements((data ?? []) as unknown as MovementRow[]);
}

/**
 * What has happened anywhere in the shop lately.
 *
 * This is what replaces browsing a drawn board on the operator surface. A board is a map of places
 * you are standing among — with 12–18 of them, walking beats scrolling. What a phone genuinely
 * knows that you do not is *what changed while you were elsewhere*, and every row here is a tap
 * straight to the place it happened in, so it doubles as the way to reach a bin whose label is
 * missing.
 *
 * Rows with no `location_id` (an aggregate, non-location-tracked movement) are excluded — they
 * name no place to go to.
 */
export async function getRecentActivity(
  companyId: string,
  limit = 15,
): Promise<LocationHistoryEntry[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('inventory_transactions')
    .select(MOVEMENT_COLUMNS)
    // Over-fetch, because folding each transfer pair into one row shrinks the list. Without this
    // a screen of moves would render as half a screen.
    .eq('company_id', companyId)
    .not('location_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit * 2);

  if (error) {
    console.error('Error fetching recent inventory activity:', error);
    throw error;
  }
  return foldTransfers(await hydrateMovements((data ?? []) as unknown as MovementRow[])).slice(
    0,
    limit,
  );
}

/**
 * One move, one row — and one *batch*, one row.
 *
 * A transfer writes **two** ledger rows sharing a `transfer_group_id`: a depletion at the source
 * and an addition at the destination. Right for the ledger, wrong for a shop-wide feed, where the
 * same event appears twice back to back with opposite signs.
 *
 * ## The group id is NOT unique per part
 *
 * `bulk_put_away` mints `v_group` **once, before its loop**
 * ([migration](../supabase/migrations/20260730010705_inventory_bulk_put_away.sql)), so a 15-part
 * put-away writes 30 rows all sharing one id. The first version of this function keyed on the
 * group alone and therefore treated an entire batch as a single pair: it dropped one row, folded
 * one, and left the other 28 — the exact wall of rows folding exists to prevent. `transfer_stock`
 * mints its id per call, which is why single put-aways looked fine and hid the bug.
 *
 * So the unit of a move is `(transfer_group_id, part_id)`, and a group holding more than one part
 * is a **batch**: it collapses to one row reading "15 parts moved", because fifteen rows with the
 * same timestamp, same route and no photo are one action to the person who performed it. Tapping
 * it goes to the destination, where the parts actually are.
 *
 * Folding is safe **only here**. `getLocationHistory` shows one bin, which sees exactly one leg of
 * any move, so there is nothing to fold and the remaining leg's direction is that place's truth.
 *
 * A group with legs on only one side — the other half fell outside the fetch window — passes
 * through unfolded. A half-shown move beats a missing one.
 */
function foldTransfers(entries: LocationHistoryEntry[]): LocationHistoryEntry[] {
  const byGroup = new Map<string, LocationHistoryEntry[]>();
  for (const e of entries) {
    if (!e.transferGroupId) continue;
    const g = byGroup.get(e.transferGroupId);
    if (g) g.push(e);
    else byGroup.set(e.transferGroupId, [e]);
  }

  const out: LocationHistoryEntry[] = [];
  const emitted = new Set<string>();

  for (const e of entries) {
    const group = e.transferGroupId ? byGroup.get(e.transferGroupId) : undefined;
    if (!group) {
      out.push(e);
      continue;
    }

    const arrivals = group.filter((g) => g.type === 'addition');
    const departures = group.filter((g) => g.type === 'depletion');
    if (arrivals.length === 0 || departures.length === 0) {
      out.push(e);
      continue;
    }

    // The group renders once, at the position of its newest member — entries arrive newest-first.
    if (emitted.has(e.transferGroupId as string)) continue;
    emitted.add(e.transferGroupId as string);

    const parts = new Set(group.map((g) => g.partId).filter((id): id is string => Boolean(id)));
    const lead = arrivals[0];
    const from = departures[0];

    if (parts.size > 1) {
      out.push({
        ...lead,
        type: 'transfer',
        fromName: from.locationName,
        partCount: parts.size,
        // No total: a batch mixes units, and "1,588 of six different things" is a number that
        // means nothing. The count of parts is the honest summary.
        quantity: 0,
        // Both are per-part and would name one arbitrary member of the batch. `bulk_put_away`
        // writes neither a photo nor an operator id anyway.
        notes: null,
        photoUrl: null,
      });
      continue;
    }

    out.push({
      ...lead,
      type: 'transfer',
      fromName: from.locationName,
      notes: stripAutoNote(lead.notes),
    });
  }
  return out;
}

function stripAutoNote(notes: string | null): string | null {
  if (!notes) return notes;
  const stripped = notes
    // `[Transfer to X]` / `[Transfer from Y]`, appended by `transfer_stock`.
    .replace(/\s*\[Transfer (?:to|from) [^\]]*\]$/, '')
    // The whole note when `bulk_put_away` wrote it — the row already states the route.
    .replace(/^Put away (?:to|from) .*$/, '')
    .trim();
  return stripped.length > 0 ? stripped : null;
}
