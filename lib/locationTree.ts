/**
 * Pure walks over the location tree — no Supabase, no network.
 *
 * ## Why this is in `lib/` rather than beside the access layer
 *
 * `computePathNames` lived in `utils/inventoryLocationsAccess.ts`, which builds a Supabase client
 * at import time. Anything wanting a display path therefore dragged the whole access layer in with
 * it, and any test touching such a component had to stub `lib/supabase` before it could even load
 * the module — a workaround `__tests__/components/operator/PutAwayPickerDialog.test.tsx` records
 * having to make. The function itself never needed any of that: it reads a Map the caller already
 * has.
 *
 * Sibling of `locationSpec.ts` and `locationOccupancy.ts` in intent: decisions live in pure
 * functions, and only the access layer talks to the network.
 */
import type { InventoryLocation } from '@/types/inventoryLocations';

/**
 * Root → leaf names for a location, e.g. `['Cabinet 1', 'Row 3', 'Left']`.
 *
 * Exists because this walk had been hand-rolled in four separate places (the operator bin page, the
 * count page, `PartLocationInventory` and the put-away dialog). Use this one rather than writing a
 * fifth — the cycle guard in particular is easy to leave out, and re-parenting can produce one.
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

/**
 * Compare two location names — or two full paths — the way a person reads them.
 *
 * ## The bug this exists for
 *
 * Plain `localeCompare` is character-by-character, so `Bin 10` sorts before `Bin 2`. The Storage
 * table hid it by sorting on `sort_order` first, but every PICKER sorts on the name or the joined
 * path alone — and a shop with a 12 × 15 cabinet has 180 bins in the Move list, where
 * `Bin 1, Bin 10, Bin 11, … Bin 2` is the difference between usable and not.
 *
 * `numeric: true` compares each run of digits by magnitude, which fixes bare names (`Row 9` before
 * `Row 10`) and joined paths alike (`Cabinet 1 › Row 2 › Left` before `Cabinet 1 › Row 10 › Left`),
 * because the option applies per numeric run wherever it appears in the string.
 *
 * `sensitivity: 'base'` folds case and accents, matching the sibling-name unique index
 * (`lower(btrim(name))`) — so two names the database considers the same never sort apart.
 *
 * ## Why not zero-pad the names instead
 *
 * The standard warehouse advice is to name bins `Bin 01`, so plain alphabetical ordering happens to
 * work. Rejected: the name is what gets printed on the label and said out loud, and padding it to
 * satisfy a sort lets the database dictate the shop's vocabulary. Sort properly instead.
 *
 * ## One site this does NOT fix
 *
 * `getContentsPageForLocations` orders in Postgres because it is a paged query — re-sorting one
 * page client-side would reshuffle it and make the walking route jump at every page boundary. That
 * one needs SQL-side ordering (a `natural_sort_key` expression) and is deliberately left alone.
 */
export function compareLocationNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}
