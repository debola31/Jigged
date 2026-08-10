/**
 * Which locations may be offered as a destination — the one place that answers it.
 *
 * ## Why this exists
 *
 * Six call sites each built their own `LocationPickerOption[]` with their own copy of the
 * root→leaf ancestry walk, and **none of them filtered containers**. That is how a cabinet made
 * only of Side 1 and Side 2 stayed a selectable place to put a part, on every surface at once.
 * `LocationPicker` could not fix it centrally either: its option type carries `id`, `label`,
 * `kind` and `quantity`, and nothing about parentage, so leafness is not even expressible there.
 *
 * As of 20260806160053 the database refuses the write, so an unfiltered picker no longer produces
 * bad data — it produces an error dialog on a choice that should never have been offered. Filtering
 * here is what keeps the guard from being something a user meets.
 *
 * ## Two rules, two functions, deliberately not merged
 *
 * "Where may this STOCK go" and "where may this SHELF go" look alike and are not:
 *
 * | | containers | the `Unassigned` pile | itself / its own subtree |
 * |---|---|---|---|
 * | `stockDestinationOptions` | **excluded** — stock lives on leaves | excluded | excluded |
 * | `locationParentOptions`   | **required** — a container is the whole point | excluded | excluded |
 *
 * Collapsing them into one function with a flag would put the two opposite answers to the container
 * question behind a boolean, which is exactly the shape that invites passing the wrong one.
 *
 * Pure and DB-free, like `locationSpec.ts` and `locationOccupancy.ts` beside it: decisions live in
 * functions you can test without a network.
 */
import type { LocationPickerOption } from '@/components/inventory/locations/LocationPicker';
import { compareLocationNames, computePathNames } from '@/lib/locationTree';
import { SYSTEM_KIND } from '@/lib/locationKinds';
import { occupancyFor, type OccupancyMap } from '@/utils/locationOccupancy';
import type {
  InventoryLocation,
  PartLocationBalanceWithLocation,
} from '@/types/inventoryLocations';

/** Ids that are somebody's parent. One pass, so leafness is a set lookup rather than a scan. */
function parentIds(locations: InventoryLocation[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const l of locations) if (l.parent_id) out.add(l.parent_id);
  return out;
}

/** Full path root→leaf, falling back to the bare name for a root. */
function labelFor(location: InventoryLocation, byId: Map<string, InventoryLocation>): string {
  return computePathNames(location.id, byId).join(' › ') || location.name;
}

export interface StockDestinationOptions {
  /** The source location, dropped so you cannot move something to where it already is. */
  excludeId?: string | null;
  /**
   * The subject part's balances, merged in so each option can say what is already there.
   * `LocationPicker` renders these only when the caller also passes `unit`.
   */
  balances?: PartLocationBalanceWithLocation[];
}

/**
 * Where a PART may go: leaves only, never the put-away pile.
 *
 * Sorted with places already holding some of this part first — putting stock back with the rest of
 * it is the common case, and it keeps one part from scattering across the shop — then
 * alphabetically within each group, so the order is stable and learnable rather than shifting with
 * stock levels. Callers that pass no balances get plain alphabetical.
 */
export function stockDestinationOptions(
  locations: InventoryLocation[],
  { excludeId, balances = [] }: StockDestinationOptions = {},
): LocationPickerOption[] {
  const byId = new Map(locations.map((l) => [l.id, l] as const));
  const parents = parentIds(locations);
  const heldAt = new Map(balances.map((b) => [b.location_id, Number(b.quantity ?? 0)] as const));

  return locations
    .filter(
      (l) =>
        l.id !== excludeId &&
        l.kind !== SYSTEM_KIND &&
        // The rule this module exists for: a container holds its children, not stock.
        !parents.has(l.id),
    )
    .map((l) => ({
      id: l.id,
      label: labelFor(l, byId),
      kind: l.kind,
      quantity: heldAt.get(l.id) ?? 0,
    }))
    .sort((a, b) => {
      const aHas = (a.quantity ?? 0) > 0;
      const bHas = (b.quantity ?? 0) > 0;
      if (aHas !== bHas) return aHas ? -1 : 1;
      return compareLocationNames(a.label, b.label);
    });
}

export interface LocationParentOptions {
  /** The location being moved. It and everything under it are excluded. */
  nodeId: string;
  /**
   * Roll-up occupancy, used to drop any location that holds stock DIRECTLY.
   *
   * Direct, not rolled-up: a cabinet whose shelves are full holds nothing itself and is a perfectly
   * good parent. Using `hasStock` here would exclude every populated cabinet in the shop.
   */
  occupancy: OccupancyMap;
}

/**
 * Where a LOCATION may go: any container except itself, its own descendants, the put-away pile, or
 * a location that already holds stock directly.
 *
 * That last exclusion is new, and it is the reachability half of the guard. Re-parenting into a
 * stocked location would make that location a container while stock sat in it — direction (b) of
 * the invariant — and unlike "Divide it up…" there is no distribution step to hang on a Move, so
 * the database simply refuses it. Dropping those targets means the user meets an absence rather
 * than an error.
 */
export function locationParentOptions(
  locations: InventoryLocation[],
  { nodeId, occupancy }: LocationParentOptions,
): LocationPickerOption[] {
  const byId = new Map(locations.map((l) => [l.id, l] as const));

  // A location cannot move inside itself. Walk up from each candidate rather than down from the
  // node: same answer, and the cycle guard is already written in `computePathNames`' shape.
  const isUnder = (candidate: InventoryLocation): boolean => {
    let cursor: string | null = candidate.id;
    const guard = new Set<string>();
    while (cursor && !guard.has(cursor)) {
      if (cursor === nodeId) return true;
      guard.add(cursor);
      cursor = byId.get(cursor)?.parent_id ?? null;
    }
    return false;
  };

  return locations
    .filter(
      (l) =>
        l.kind !== SYSTEM_KIND &&
        !isUnder(l) &&
        occupancyFor(occupancy, l.id).directParts === 0,
    )
    .map((l) => ({ id: l.id, label: labelFor(l, byId), kind: l.kind }))
    .sort((a, b) => compareLocationNames(a.label, b.label));
}
