/**
 * Level templates for the "add several at once" generator.
 *
 * ## What used to be here
 *
 * Two palettes of icon cards — `STORAGE_TYPES` (10 entries, for a new top-level unit) and
 * `SUBDIVISION_TYPES` (for dividing one that exists) — plus the `StorageType` shape they shared.
 * All of it is gone with the drawn board.
 *
 * `STORAGE_TYPES` had been **unreachable for its entire life**: the builder computes
 * `subdividing = parentId !== null` and its only caller always passes a parent, so the top-level
 * palette and the title "Build storage visually" never rendered once. `SUBDIVISION_TYPES` did
 * render, but all it ever did was pre-fill two numbers the very next screen let you edit — so it
 * cost a step and bought nothing. The generator now opens straight on those numbers.
 *
 * What remains is the one thing that was load-bearing: a deep clone, so editing a template's
 * levels cannot mutate the template.
 */

import type { LevelSpec } from '@/types/inventoryLocations';

export function cloneLevels(levels: LevelSpec[]): LevelSpec[] {
  return levels.map((l) => ({ ...l, names: l.names ? [...l.names] : undefined }));
}
