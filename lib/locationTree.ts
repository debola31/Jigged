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
