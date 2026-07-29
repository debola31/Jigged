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
  created_at: string;
  updated_at: string;
}

/** A location with its children resolved, for the tree view. */
export interface InventoryLocationNode extends InventoryLocation {
  children: InventoryLocationNode[];
  depth: number;
}

/**
 * The minimum a storage-board drawing needs.
 *
 * `InventoryLocationNode` satisfies this structurally (real rows), and `LocationSpecNode`
 * converts via `specToBoard` (unsaved structure, keyed rather than id'd). Both shapes exist on
 * purpose: the builder must preview storage that does not exist yet, while the board draws what
 * does — and §5.5's promise is that they look the same, so the drawing is shared even though
 * the data isn't.
 */
export interface BoardNode {
  id: string;
  name: string;
  kind: string | null;
  code: string | null;
  children: BoardNode[];
}

export interface CreateLocationInput {
  parent_id?: string | null;
  name: string;
  kind?: string | null;
  code?: string | null;
  sort_order?: number;
}

export type UpdateLocationInput = Partial<
  Pick<InventoryLocation, 'name' | 'kind' | 'code' | 'sort_order'>
>;

/**
 * Spec for the bulk generator, e.g. { count: 10, kind: 'row',
 * namePattern: 'Row {n}', leaves: ['Left', 'Right'] } → 10 rows each with a
 * Left and Right leaf.
 */
export interface BulkGenerateSpec {
  count: number;
  kind?: string;
  /** `{n}` is replaced with the (zero-padded for code) index. Default `'{n}'`. */
  namePattern?: string;
  /** First index. Default 1. */
  startAt?: number;
  /** Optional leaf children created under each generated node. */
  leaves?: string[];
  leafKind?: string;
}

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

export interface PartLocationBalance {
  id: string;
  company_id: string;
  part_id: string;
  location_id: string;
  quantity: number;
  created_at: string;
}

/** A part's balance at a location, with the location's full path for display. */
export interface PartLocationBalanceWithLocation {
  location_id: string;
  location_name: string;
  location_code: string | null;
  /** Full path, root → leaf, e.g. ['Cabinet 1', 'Row 3', 'Left']. */
  path: string[];
  quantity: number;
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
  /** Parts + quantities at this node (for leaf → actions). */
  contents: LocationContent[];
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
