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
  code: string | null;
  sort_order: number;
  /** Path in the private `attachments` bucket to a photo of this place — see §5.5 decision 5. */
  photo_path: string | null;
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
  code?: string | null;
  sort_order?: number;
}

export type UpdateLocationInput = Partial<
  Pick<InventoryLocation, 'name' | 'kind' | 'code' | 'sort_order' | 'photo_path'>
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
 * inventory_locations on Create. `key` is a stable client id for board
 * rendering / prune (NOT the DB id); `code` is precomputed during assembly
 * (parent-prefixed, zero-padded) to match the manual bulk generator. Every
 * location can hold stock and be printed, so no per-node stockable/QR flags.
 */
export interface LocationSpecNode {
  key: string;
  name: string;
  kind: string | null;
  code: string | null;
  children: LocationSpecNode[];
}

/** A part's balance at a location, with the location's full path for display. */
export interface PartLocationBalanceWithLocation {
  location_id: string;
  location_name: string;
  location_code: string | null;
  /** Full path, root → leaf, e.g. ['Cabinet 1', 'Row 3', 'Left']. */
  path: string[];
  quantity: number;
  /**
   * The location's kind. `'system'` marks the `Unassigned` bucket, which is NOT a place — it is
   * the put-away pile. A caller answering "where does this live?" must not present it as a shelf.
   */
  kind: string | null;
}

/** A part stored at a given location, for the bin/scan view contents list. */
export interface LocationContent {
  part_id: string;
  part_name: string;
  primary_unit: string | null;
  quantity: number;
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
}

export interface TransferResult {
  transfer_group_id: string;
  from_balance: number;
  to_balance: number;
}

export interface TrackingResult {
  part_quantity: number;
  tracked: boolean;
  location_id?: string;
  noop?: boolean;
}

export interface DepleteOptions {
  graceful?: boolean;
  notes?: string;
  jobId?: string;
  jobOperationId?: string;
  operatorId?: string;
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
