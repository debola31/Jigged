/**
 * Inventory Locations & QR-addressable stock — domain types.
 *
 * Mirrors the `inventory_locations` / `part_location_stock` tables and the
 * jsonb returned by the stock-mutation RPCs (see
 * supabase/migrations/20260622023407_inventory_location_stock_rpcs.sql).
 */

export interface InventoryLocation {
  id: string;
  company_id: string;
  parent_id: string | null;
  name: string;
  kind: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** A location with its children resolved, for the tree view. */
export interface InventoryLocationNode extends InventoryLocation {
  children: InventoryLocationNode[];
  depth: number;
}

export interface CreateLocationInput {
  parent_id?: string | null;
  name: string;
  kind?: string | null;
  sort_order?: number;
}

export type UpdateLocationInput = Partial<
  Pick<InventoryLocation, 'name' | 'kind' | 'sort_order'>
>;

/**
 * One configured division level in the visual builder, e.g. "10 rows named
 * Row {n}" or "{Left, Right}". Either a generated count+pattern OR explicit
 * names. Levels are ordered shallow → deep.
 */
export interface LevelSpec {
  kind: string;
  /** Generated mode: how many, with `{n}` substitution in namePattern. */
  count?: number;
  namePattern?: string;
  /** Explicit mode: fixed child names (e.g. ['Left', 'Right']). */
  names?: string[];
}

/**
 * In-memory location tree the visual builder assembles entirely client-side,
 * before any DB write. `materializeLocationSpec` inserts it into
 * inventory_locations on Create. Every location can hold stock and be printed, so no
 * per-node stockable/QR flags — and no `code`: that column went in 20260803034616, along with the
 * whole parent-prefixed zero-padded scheme that existed to fill it.
 *
 * ## `key` — a client id, which on a reshape may *carry* a DB id
 *
 * On the create path a key is purely a stable handle for React and for prune, and is never a
 * location id. On the **reshape** path it has to be more than that: telling "this is Row 3,
 * renamed" apart from "this is a new location that happens to be called Row 3" is the entire
 * difference between a rename and a remove-then-create, and only the key can carry it.
 *
 * So [`locationReshape`](../utils/locationReshape.ts) owns one encoding — `id:<uuid>` for a node
 * that already exists, anything else for one that does not — and `isExistingKey` is the only
 * decoder. A prefix rather than a bare uuid, because the other minters here emit `0/1` and `e3`,
 * and "does this look like a uuid?" is a guess where a prefix is a fact. **Nothing outside that
 * module may parse a key.**
 */
export interface LocationSpecNode {
  key: string;
  name: string;
  kind: string | null;
  children: LocationSpecNode[];
}

/**
 * A part's balance at a location, with the location's full path for display.
 *
 * **One row is one (location, lot), not one location.** Since lots landed a part can hold two
 * heats on one shelf, and a caller that keys or counts by `location_id` alone will render the
 * same place twice and call it two locations — which is exactly what the part drawer did.
 */
export interface PartLocationBalanceWithLocation {
  location_id: string;
  location_name: string;
  /** Full path, root → leaf, e.g. ['Cabinet 1', 'Row 3', 'Left']. */
  path: string[];
  quantity: number;
  /** The lot this balance is, or null for a part that is not lot-tracked. */
  lot_id: string | null;
  /** The lot's handle — the mill heat when there is one, else a minted code. */
  lot_code: string | null;
  /** The mill's own heat number, or null when the material arrived without one. */
  heat_number: string | null;
  /**
   * The location's kind. `'system'` marks the `Unassigned` bucket, which is NOT a place — it is
   * the put-away pile. A caller answering "where does this live?" must not present it as a shelf.
   */
  kind: string | null;
}

/**
 * A part stored at a given location, for the bin/scan view contents list.
 *
 * **One row is one (part, location, lot).** A lot-tracked part holding two heats in one bin
 * produces two rows, and a caller that keys by part alone will collapse them.
 */
export interface LocationContent {
  part_id: string;
  part_name: string;
  primary_unit: string | null;
  quantity: number;
  /** The lot this row is, or null for a part that is not lot-tracked. */
  lot_id: string | null;
  lot_code: string | null;
  heat_number: string | null;
  /**
   * Which bin this row is in.
   *
   * Redundant when the caller asked about one location and knew the answer already — and required
   * the moment it asks about several, which counting a whole cabinet does. Kept **non-optional** so
   * there is one row shape rather than one that sometimes knows where it is: a count line commits
   * against this id, and a silently-absent field there would write to the wrong shelf.
   */
  location_id: string;
}

/** Result of resolving a scanned location id into a renderable view. */
export interface ResolvedScan {
  node: InventoryLocation;
  /** Ancestor path including the node itself, root → node. */
  path: InventoryLocation[];
  /** Direct children (for parent → drill-down). */
  children: InventoryLocation[];
  /** Parts + quantities at this node (for leaf → actions). Capped — see `contentsTotal`. */
  contents: LocationContent[];
  /**
   * Exact parts held here, which may exceed `contents.length`.
   *
   * Carried so the bin view can say "showing 200 of 9,428" rather than presenting a clipped
   * list as the whole truth — `max_rows` was already doing that silently.
   */
  contentsTotal: number;
}

// ---- RPC return shapes (jsonb) -------------------------------------------

export interface StockMutationResult {
  location_balance: number;
  part_quantity: number;
  has_discrepancy?: boolean;
  shortfall?: number;
  /** The lot the movement landed on, when the part is tracked. */
  lot_id?: string | null;
  /**
   * True when THIS receipt is what started tracing the part — the first heat recorded against it.
   *
   * Returned so the surface that caused it can say so. From here on every removal of this part
   * must name a heat, and a part that silently begins refusing takes is exactly the surprise the
   * per-part flag exists to avoid; the dialog in front of the person who typed the number is the
   * only place that can explain it at the moment it becomes true.
   */
  started_tracking?: boolean;
}

export interface TransferResult {
  transfer_group_id: string;
  from_balance: number;
  to_balance: number;
}

export interface DepleteOptions {
  graceful?: boolean;
  notes?: string;
  jobId?: string;
  jobOperationId?: string;
  operatorId?: string;
  /**
   * The mill heat / lot number read off the bar being taken. With `jobId`, this is what the
   * job's packing slip will print. Optional; the database upper-cases and trims it, and an
   * empty string becomes "not recorded" (NULL) rather than a blank heat.
   *
   * On the way OUT this can only name a heat that already exists: an unknown one resolves to
   * nothing and the take is refused for a lot-tracked part. Prefer `lotId`, which the pickers
   * supply; this stays for callers that only have a string.
   */
  heatNumber?: string;
  /** The lot being taken, picked from what is actually at this location. */
  lotId?: string;
}

/**
 * Everything a stock write can carry besides the numbers.
 *
 * `operatorId` is `user_company_access.id`, NOT an auth user id. It is what lets bin history name
 * who did this: `created_by` holds the auth user, which the browser cannot resolve to a name —
 * there is no FK to embed through and no policy that would allow the lookup.
 */
export interface StockWriteOptions {
  notes?: string;
  operatorId?: string | null;
  /**
   * Storage path of a photo taken as evidence of the movement.
   *
   * **Upload first, then call.** The path is written at INSERT inside the RPC and is immutable
   * afterwards, so there is no second step in which to attach it. A failed RPC therefore leaves an
   * orphaned object in the bucket — the accepted cost, because the alternative ordering needs the
   * column to stay mutable, and evidence that can be swapped afterwards is not evidence.
   */
  photoPath?: string | null;
  /**
   * The mill heat / lot number off the tag of the bar being put down — the only place a heat
   * first enters Jigged. Optional; normalised (upper-case, trimmed, "" → NULL) by the database.
   *
   * On the way IN this may name a heat we have never seen: the lot is created on first sight,
   * and a lot-tracked part with no heat at all gets a minted code so untagged material is still
   * storable. That asymmetry with a removal is deliberate — see `resolve_lot`.
   */
  heatNumber?: string;
  /** An existing lot to add to, when the caller already knows which. Wins over `heatNumber`. */
  lotId?: string;
}

/** A lot of material — in a machine shop, one mill heat. Mirrors `material_lots`. */
export interface MaterialLot {
  id: string;
  company_id: string;
  part_id: string;
  /** The handle: the mill heat when known, else a minted code. Never blank. */
  lot_code: string;
  /** The mill's own heat number, or null when the material arrived without one. */
  heat_number: string | null;
  vendor_id: string | null;
  received_at: string;
  notes: string | null;
  created_at: string;
}

/** One movement in a place's history, with its author and photo already resolved. */
export interface LocationHistoryEntry {
  id: string;
  createdAt: string;
  /**
   * `transfer` is a synthetic type produced only by the shop-wide feed, where both halves of a
   * move are visible and get folded into one row. A single bin never sees it — standing in the
   * source you saw a depletion, standing in the destination an addition, and both are true.
   */
  type: 'addition' | 'depletion' | 'adjustment' | 'transfer';
  itemName: string;
  quantity: number;
  unit: string;
  notes: string | null;
  /** The mill heat on this movement, or null when none was recorded — the normal case. */
  heatNumber: string | null;
  /** Null when the movement predates operator attribution, or the name could not be read. */
  actorName: string | null;
  /** Signed URL, or null when there is no photo — or the object has gone. */
  photoUrl: string | null;
  hasDiscrepancy: boolean;
  /** Set on both halves of a move, so the pair can be recognised as one action. */
  transferGroupId: string | null;
  /**
   * Which part moved. Load-bearing for folding: `bulk_put_away` shares ONE `transfer_group_id`
   * across every part in a batch, so the group alone does not identify a single move.
   */
  partId: string | null;
  /**
   * Set only on a folded `transfer` that collapsed a multi-part batch. When present the row
   * summarises N parts and its `quantity` and `itemName` are meaningless — a batch mixes units.
   */
  partCount?: number;
  /**
   * Null once the place is deleted; `locationName` survives it as a snapshot on the row.
   *
   * On a folded `transfer` this is the **destination** — where the stock is now, which is the
   * only one of the two worth walking to.
   */
  locationId: string | null;
  locationName: string | null;
  /** Where a folded `transfer` came from. Absent on every other type. */
  fromName?: string | null;
}
