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
import { getSupabase } from '@/lib/supabase';
import { toFriendlyError } from '@/lib/supabaseErrors';
import { ID_CHUNK } from '@/lib/queryLimits';
import { convertToBaseUnit } from '@/lib/unitPresets';
import { isReservedKind, RESERVED_KIND_MESSAGE } from '@/lib/locationKinds';
import { compareLocationNames, computePathNames } from '@/lib/locationTree';
import { resolveMovementAttribution } from '@/utils/movementAttribution';
import { duplicateSubtreeAsSibling } from '@/utils/locationSpec';
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
  TransferResult,
  UpdateLocationInput,
} from '@/types/inventoryLocations';
import type { MaterialLocation } from '@/types/materialCheck';

const LOCATION_COLUMNS =
  'id, company_id, parent_id, name, kind, sort_order, created_at, updated_at';

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
 * Everything the storage board needs, in a **fixed** number of requests whatever the tree size.
 *
 * Exactly two `.from()` reads — locations and occupancy — unconditionally. It used to be "two, plus
 * one batched `createSignedUrls` when some location had a photo", which was only ever two because
 * no company ever set a photo; place photos are gone (313 locations, 0 photos), so the guarantee is
 * now structural rather than accidental. Deliberately one function rather than two calls at the
 * call site: it gives the manager a single `useLoad` and gives the test a single thing to pin. A
 * board that grew a request per location would be the N+1 this shape exists to prevent — see the
 * request-count test.
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

/**
 * Flat list of every location in a company, ordered for stable tree assembly.
 *
 * **Re-sorted client-side, and that is the point.** Postgres orders text by collation, so the
 * server's `.order('name')` puts `Bin 10` before `Bin 2`. This is the root of that bug for the whole
 * module: `buildLocationTree` relies on this order for child ordering, so every consumer that does
 * not sort for itself — the tree, the detail sheet's child list, `duplicateLocation`'s sibling
 * numbering — inherits it. Fixing it here repairs all of them at once.
 *
 * The `.order()` calls stay: they make the response deterministic before we touch it, and
 * `sort_order` is the primary key of the ordering either way. Only the name tiebreak is redone.
 */
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
  return ((data ?? []) as InventoryLocation[]).sort(
    (a, b) => a.sort_order - b.sort_order || compareLocationNames(a.name, b.name),
  );
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
  // Everything else goes through the shared translator rather than passing `error.message`
  // straight out: that fallback rendered raw PostgREST text to the user, so a lapsed shop saw
  // 'new row violates row-level security policy "billing_gate_insert"…' instead of being told
  // its subscription needs restarting.
  return toFriendlyError(error, { entity: 'location', fallback: 'Failed to save location.' });
}

/**
 * The insert half of `createLocation`, with the parent check already done.
 *
 * Split out when `materializeLocationSpec` shared it; that caller now goes through
 * `create_location_tree`, so `createLocation` is the only one left. Kept separate rather than
 * inlined because the parent check and the insert fail differently and are worth reading apart.
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
    // A move can collide with a sibling name exactly as a create or a rename can — the
    // (company_id, parent_id, name) unique index does not care how the row got there. Raw, the
    // user sees `23505 duplicate key value violates unique constraint`.
    throw mapLocationWriteError(error, undefined);
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
    throw toFriendlyError(error, { entity: 'location', fallback: 'Failed to delete location.' });
  }
}

/**
 * Materialize a LocationSpecNode forest (built client-side by the visual builder) into
 * `inventory_locations`, in **one transaction and one round trip**.
 *
 * ## What this replaced, and why it mattered (#618)
 *
 * It used to insert each node with its own awaited `INSERT`, recursively. A 12 × 15 cabinet was 240
 * sequential round trips — slow enough on an old office computer that a shop owner concluded the
 * app had frozen, which is the observation that got this fixed. And a failure partway left every
 * node created before it: a partial tree, no rollback, an opaque error.
 *
 * Two mitigations used to stand in for the real fix and are now unnecessary. The parent was
 * validated once here rather than per node (a 16-node cabinet cost ~31 requests instead of ~17) —
 * `create_location_tree` proves the parent itself, in the same transaction, so that read is gone
 * too. And `buildSpecFromLevels` continues sibling numbering so a repeat subdivide could not die
 * halfway on the unique index; that is still worth having, because continuing the numbering is what
 * the user meant, but it is no longer load-bearing for atomicity.
 *
 * ## Shape
 *
 * `flattenSpec` is shared with `subdivideLocation`: both RPCs take the same flat
 * `{ref, parent_ref}` list, parent before child, so the client serializes a spec exactly once.
 * `startSortOrder` still offsets the top level — a repeat subdivide appends rather than
 * interleaving with what is already there.
 */
export async function materializeLocationSpec(
  companyId: string,
  parentId: string | null,
  nodes: LocationSpecNode[],
  startSortOrder = 0,
): Promise<InventoryLocation[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('create_location_tree', {
    p_company_id: companyId,
    p_parent_id: parentId ?? undefined,
    p_nodes: flattenSpec(nodes, null, startSortOrder),
  });

  if (error) {
    console.error('Error creating location tree:', error);
    // A duplicate sibling name is the one failure a user can act on, and it arrives raw as
    // `23505 duplicate key value violates unique constraint`. Same mapper as every other write
    // path on this table, so the message does not depend on which one you came through.
    throw mapLocationWriteError(error, undefined);
  }
  return (data ?? []) as InventoryLocation[];
}

/** One part's stock moving into one of the sub-locations about to be created. */
export interface SubdivideMove {
  partId: string;
  /** `LocationSpecNode.key` of the destination — a leaf of the spec, which does not exist yet. */
  toRef: string;
  quantity: number;
  unit: string;
}

/** Flatten a spec forest to `{ref, parent_ref}` rows, parent before child, as the RPC requires. */
function flattenSpec(
  nodes: LocationSpecNode[],
  parentRef: string | null,
  startSortOrder: number,
): Array<{ ref: string; parent_ref: string | null; name: string; kind: string | null; sort_order: number }> {
  const out: ReturnType<typeof flattenSpec> = [];
  let sortOrder = startSortOrder;
  for (const node of nodes) {
    out.push({
      ref: node.key,
      parent_ref: parentRef,
      name: node.name,
      kind: node.kind,
      sort_order: sortOrder++,
    });
    // Depth-first, so a child always follows its parent — the RPC rejects a forward reference
    // rather than guessing, because silently rooting a node in the wrong place is unrecoverable.
    out.push(...flattenSpec(node.children, node.key, 0));
  }
  return out;
}

/**
 * Subdivide a place, moving whatever it holds down into the new sub-locations.
 *
 * ## Why this is an RPC and not `materializeLocationSpec` plus some transfers
 *
 * Since 20260806160053 a place with sub-locations cannot hold stock, and the two halves of this
 * operation each break that rule on their own: creating the children first makes the parent a
 * container while its stock is still in it, and moving the stock first has nowhere to move it to.
 * Only doing both in one transaction is legal, so `subdivide_location` defers the constraint and
 * the whole thing either happens or does not.
 *
 * It also fixes what `materializeLocationSpec` documents about itself two functions up: that path
 * is sequential and not transactional, so a failure partway leaves the nodes created before it.
 *
 * Conversion happens here, per part, exactly as it does for `transferStock` — the RPC delegates
 * each move to `transfer_stock`, which wants both the display values and the converted quantity.
 * One `loadConversionContext` per distinct part rather than per move, since splitting one part
 * across three bins is three moves against one part.
 */
export async function subdivideLocation(
  parentId: string,
  nodes: LocationSpecNode[],
  moves: SubdivideMove[],
  startSortOrder = 0,
): Promise<InventoryLocation[]> {
  const contexts = new Map<string, Awaited<ReturnType<typeof loadConversionContext>>>();
  for (const partId of new Set(moves.map((m) => m.partId))) {
    contexts.set(partId, await loadConversionContext(partId));
  }

  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('subdivide_location', {
    p_parent_id: parentId,
    p_nodes: flattenSpec(nodes, null, startSortOrder),
    p_moves: moves.map((m) => {
      const { primaryUnit, conversions } = contexts.get(m.partId)!;
      return {
        part_id: m.partId,
        to_ref: m.toRef,
        quantity: m.quantity,
        unit: m.unit,
        converted_quantity: convertToBaseUnit(m.quantity, m.unit, primaryUnit, conversions),
      };
    }),
  });

  if (error) {
    console.error('Error subdividing location:', error);
    throw toFriendlyError(error, { entity: 'location' });
  }
  return (data ?? []) as InventoryLocation[];
}

/**
 * Duplicate a location and its entire subtree as a new sibling — structure
 * only, no stock. The copy's root is named past the existing siblings
 * (Cabinet 1 → Cabinet 2) and sorted after them. Sequential inserts via
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
    children: childrenOf(loc.id).map(toSpec),
  });

  const siblings = childrenOf(target.parent_id);
  const clone = duplicateSubtreeAsSibling(
    toSpec(target),
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
 * Re-exported so existing importers keep working. The implementation moved to
 * [`lib/locationTree.ts`](../lib/locationTree.ts) because it needs nothing from this module, and
 * importing it from here forced a Supabase client into every consumer — and into every test of one.
 *
 * New callers should import from `@/lib/locationTree` directly.
 */
export { computePathNames };

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
        path: computePathNames(r.location_id, byId),
        quantity: Number(r.quantity),
        // Carried so callers can tell a SHELF from the `Unassigned` put-away pile. Without it,
        // "where does this part live?" answers "Unassigned" — which is precisely the answer
        // "nowhere yet", presented as though it were a place.
        kind: loc?.kind ?? null,
      };
    })
    .sort((a, b) => compareLocationNames(a.path.join(' / '), b.path.join(' / ')));
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
  const CHUNK = ID_CHUNK;
  const PAGE = 1000; // PostgREST's `max_rows`

  /**
   * Page each chunk. Issue #619.
   *
   * A chunk of 500 parts is not 500 rows: a part has one row per place it actually holds stock in,
   * so three places per part is 1,500 rows against a `max_rows` of 1,000. PostgREST does not error
   * on that — it **returns the first 1,000 and stops**, so the missing balances read as "this part
   * is nowhere" and a material check quietly reports stock the shop has. Exactly 1,000 is safe;
   * 1,001 is not.
   *
   * The arithmetic got BETTER in 20260802144310, not worse: `trg_auto_track_stocked_part` no
   * longer seeds an `Unassigned` row for every stocked part, and emptied bins lose their rows —
   * so the row count is now places-actually-held rather than places-ever-visited. The paging
   * stays because the bound is still real, just further away.
   *
   * `.order()` on both columns is what makes paging deterministic — without a total order,
   * successive ranges can repeat or skip rows.
   */
  const readChunk = async (ids: string[]) => {
    const out: Array<{ part_id: string; location_id: string; quantity: number }> = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase
        .from('part_location_stock')
        .select('part_id, location_id, quantity')
        .in('part_id', ids)
        // No `quantity > 0` filter any more, and that is not an omission. It used to hide the
        // residue `transfer_stock` and `bulk_put_away` left behind; 20260802144310 deleted that
        // residue and added `CHECK (quantity > 0)`, so a row existing and the part being there
        // are now the same fact. Filtering would be restating the constraint.
        .order('part_id')
        .order('location_id')
        .range(offset, offset + PAGE - 1);
      if (error) {
        console.error('Error loading location balances:', error);
        throw error;
      }
      const rows = (data ?? []) as Array<{ part_id: string; location_id: string; quantity: number }>;
      out.push(...rows);
      if (rows.length < PAGE) return out;
    }
  };

  const [locations, ...pages] = await Promise.all([
    getLocations(companyId),
    ...chunk(partIds, CHUNK).map(readChunk),
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
    list.sort((a, b) =>
      compareLocationNames(
        [...a.path, a.locationName].join(' / '),
        [...b.path, b.locationName].join(' / '),
      ),
    );
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
      'location_id, quantity, part:parts!part_location_stock_part_fkey!inner(id, part_name, primary_unit)',
      { count: 'exact' },
    )
    .eq('location_id', locationId)
    .is('part.deleted_at', null)
    // No `quantity > 0`: since 20260802144310 a row at this bin IS stock at this bin.
    .order('quantity', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('Error fetching location contents:', error);
    throw error;
  }

  const contents = toLocationContents(data)
    .sort((a, b) => a.part_name.localeCompare(b.part_name));

  return { contents, total: count ?? contents.length };
}

type ContentRow = {
  location_id: string;
  quantity: number;
  part:
    | { id: string; part_name: string; primary_unit: string | null }
    | Array<{ id: string; part_name: string; primary_unit: string | null }>
    | null;
};

/** Shared row mapper — PostgREST types a to-one embed as possibly-an-array, so unwrap once. */
function toLocationContents(data: unknown): LocationContent[] {
  return ((data ?? []) as ContentRow[])
    .map((row) => {
      const part = Array.isArray(row.part) ? row.part[0] : row.part;
      if (!part) return null;
      return {
        part_id: part.id,
        part_name: part.part_name,
        primary_unit: part.primary_unit,
        quantity: Number(row.quantity),
        location_id: row.location_id,
      } as LocationContent;
    })
    .filter((r): r is LocationContent => r !== null);
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
  query: LocationContentsQuery = {},
): Promise<LocationContentsPage> {
  return getContentsPageForLocations([locationId], query);
}

/**
 * One page of the contents of SEVERAL bins at once — what counting a whole cabinet reads.
 *
 * A container holds no stock of its own (20260806160053), so "count Cabinet 1-A" can only mean the
 * bins beneath it. Every row keeps its own `location_id`, which is what makes that safe: a count
 * line commits with `adjustStockAtLocation` against the row's own bin, so a sheet spanning ten bins
 * is ten independent one-bin assertions rather than one ambiguous total.
 *
 * That is also why the rows are NOT aggregated per part. A part in two bins yields two lines, and
 * that is the point — it is exactly the ambiguity that forces the company-wide sheet to *skip*
 * split parts ("count it at its locations"), and counting bin by bin is how the ambiguity stops
 * existing.
 *
 * **Ordering is a walking route, as far as one query can express it:** by the bin's `sort_order`
 * then its name, then the part. Across two shelves that interleaves by sibling position rather
 * than strict depth-first, which is why every row also carries its bin so the sheet can label it —
 * the label is what tells a counter where to stand, not the sort.
 */
export async function getContentsPageForLocations(
  locationIds: string[],
  { search = '', limit = LOCATION_PAGE_SIZE, offset = 0 }: LocationContentsQuery = {},
): Promise<LocationContentsPage> {
  if (locationIds.length === 0) return { contents: [], total: 0 };

  const supabase = getSupabase();
  let query = supabase
    .from('part_location_stock')
    .select(
      'location_id, quantity, ' +
        'place:inventory_locations!inner(id, name, sort_order), ' +
        'part:parts!part_location_stock_part_fkey!inner(id, part_name, primary_unit)',
      { count: 'exact' },
    )
    .in('location_id', locationIds)
    .is('part.deleted_at', null);

  const term = search.trim();
  // Filtering and ordering both reach through the embed, so the whole thing stays one request —
  // the alternative (fetch, then filter in JS) would have to fetch everything first, which is the
  // problem this function exists to avoid.
  if (term) query = query.ilike('part.part_name', `%${term}%`);

  const { data, error, count } = await query
    // `'part'` / `'place'` are the embeds' ALIASES, not table names. `referencedTable: 'parts'`
    // makes PostgREST reject the whole request with `PGRST108 'parts' is not an embedded resource`
    // — verified against the running stack, which is the only way this surfaces (it type-checks
    // either way).
    .order('sort_order', { referencedTable: 'place', ascending: true })
    .order('name', { referencedTable: 'place', ascending: true })
    .order('part_name', { referencedTable: 'part', ascending: true })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error('Error fetching location contents page:', error);
    throw error;
  }

  // Order is the server's — deliberately NOT re-sorted here, which would only reshuffle the
  // current page and make the route jump at every page boundary.
  const contents = toLocationContents(data);
  return { contents, total: count ?? contents.length };
}

/** Resolve a scanned location id into node + ancestor path + children +
 * contents, so the bin view can render drill-down (parent) vs actions (leaf). */
/** One place a searched-for part is sitting, with how much of it is there. */
export interface PartPlacement {
  partId: string;
  partName: string;
  primaryUnit: string | null;
  locationId: string;
  quantity: number;
}

/**
 * "Where is my o-ring?" — every place a part matching this name is stocked.
 *
 * ## Why this exists
 *
 * Storage is place-first by design: you pick a cabinet, then a bin. That is the right default and
 * it leaves one question unanswerable from the page — the one where you know the PART and not the
 * place. The only search on the screen matched storage-unit names, so typing a part number into it
 * returned "Nothing matches", which is a dead end wearing the clothes of an answer.
 *
 * ## Rows are (part, place), never (part)
 *
 * The same part in three bins is three rows. Rolling them into one total would answer a question
 * nobody asked — you are not trying to learn how many you own, you are trying to learn which shelf
 * to walk to. Ordered by quantity so the shelf holding most of it leads.
 *
 * Scoped by `company_id` on the stock row rather than through the part, so the filter is on the
 * table being scanned. RLS enforces the same boundary; this keeps the query narrow as well as safe.
 */
export async function searchPartPlacements(
  companyId: string,
  query: string,
  limit = 20,
): Promise<PartPlacement[]> {
  const q = query.trim();
  // Two characters is where a match stops meaning "most of the catalogue". Below that the caller
  // gets nothing rather than a list it would have to explain.
  if (q.length < 2) return [];

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('part_location_stock')
    .select(
      'location_id, quantity, part:parts!part_location_stock_part_fkey!inner(id, part_name, primary_unit, deleted_at)',
    )
    .eq('company_id', companyId)
    // `%` and `_` are wildcards in `ilike`; a part number containing one would otherwise match far
    // more than it looks like it should.
    .ilike('part.part_name', `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`)
    .is('part.deleted_at', null)
    .order('quantity', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('Error searching part placements:', error);
    throw error;
  }

  type Row = {
    location_id: string;
    quantity: number;
    part: { id: string; part_name: string; primary_unit: string | null } | null;
  };

  return ((data ?? []) as unknown as Row[])
    .filter((r): r is Row & { part: NonNullable<Row['part']> } => r.part !== null)
    .map((r) => ({
      partId: r.part.id,
      partName: r.part.part_name,
      primaryUnit: r.part.primary_unit,
      locationId: r.location_id,
      quantity: Number(r.quantity),
    }));
}

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
    .sort((a, b) => a.sort_order - b.sort_order || compareLocationNames(a.name, b.name));

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

/*
 * `enableLocationTracking` / `disableLocationTracking` were removed 2026-08-02 with the RPCs they
 * called (migration 20260802015101). Every part has a place now, so there is nothing to opt into,
 * and both had been callerless for weeks — `disable` in particular deleted every balance row for
 * a part while being executable by any signed-in browser role.
 */

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
    throw toFriendlyError(error, { entity: 'stock' });
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
    throw toFriendlyError(error, { entity: 'stock' });
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
    throw toFriendlyError(error, { entity: 'stock' });
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
    throw toFriendlyError(error, { entity: 'stock' });
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
    throw toFriendlyError(error, { entity: 'stock' });
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
 * Turn raw movement rows into renderable history entries.
 *
 * The author-name and photo-URL lookups live in
 * [`resolveMovementAttribution`](movementAttribution.ts) — the owner's part-ledger table needs the
 * identical pair against the identical columns, and keeping two copies is how one of them ends up
 * knowing something the other does not. The reason those lookups cannot be a PostgREST embed
 * (`operator_id` has no foreign key) is documented there.
 */
async function hydrateMovements(rows: MovementRow[]): Promise<LocationHistoryEntry[]> {
  if (rows.length === 0) return [];
  const { nameById, urlByPath } = await resolveMovementAttribution(rows);

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
    photoUrl: r.photo_path ? urlByPath.get(r.photo_path) ?? null : null,
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
