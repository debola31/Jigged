/**
 * One vocabulary for what a storage location *is*.
 *
 * There were two before, sharing nothing: `LocationFormModal`'s manual suggestions
 * (`cabinet, shelf, rack, row, drawer, side, bin, zone, aisle`) and whatever the builder's
 * templates happened to emit (`shelving`, `level`, `position`, `drawer unit`, `bay`). So a
 * template-built shelf carried `kind = 'shelving'` while a hand-added one carried `'shelf'`, and
 * the manual form couldn't suggest a word the builder had already used all over the tree.
 *
 * The board's `unitKind` matches on substrings precisely because `kind` is user-editable free
 * text and cannot be an enum. This list is the *suggested* vocabulary, not a constraint —
 * anything the user types is still valid.
 *
 * Follows `lib/unitPresets.ts` as precedent: shared vocabulary in `lib/`, consumed by both the
 * form and the builder.
 */

/**
 * Suggested kinds, ordered biggest-container → smallest-compartment.
 *
 * Ordering is the affordance: someone naming a thing scans down from "is it a room?" to "is it a
 * slot?" rather than reading an alphabetical list where `aisle` and `bin` sit next to each other.
 */
export const LOCATION_KINDS = [
  // Areas
  'aisle',
  'zone',
  'floor',
  'outside',
  // Furniture
  'cabinet',
  'shelving',
  'rack',
  'drawer unit',
  'bench',
  // Divisions of furniture
  'bay',
  'row',
  'shelf',
  'level',
  'drawer',
  'side',
  // Compartments
  'bin',
  'position',
] as const;

export type LocationKind = (typeof LOCATION_KINDS)[number];

/**
 * The auto-managed `Unassigned` bucket's kind.
 *
 * Not a suggestion and never user-assignable: it marks the one row the stock RPCs create and
 * resolve by literal name, and the UI withholds every structural action from it. Kept here so
 * the string has exactly one definition.
 */
export const SYSTEM_KIND = 'system';

/**
 * Guard the one reserved word, because typing it is unrecoverable.
 *
 * `kind` is free text on purpose (see above), and almost anything you type degrades gracefully:
 * `unitKind` falls through to a generic drawing and nothing else cares. `system` is the exception.
 * It is the marker for the auto-managed `Unassigned` bucket, and every surface treats that bucket
 * as not-a-place — the destination pickers drop it, the operator lookup reports its contents as
 * "not put away yet", the count sheet refuses it as a put-away target, and, fatally,
 * `LocationDetailSheet` withholds the whole structural-actions block from it.
 *
 * Rename lives in that block. So a shelf you accidentally typed "system" into can no longer be
 * renamed, subdivided or deleted, and there is no other edit path: the typo is permanent and the
 * only fix is SQL. Rejecting it at the two write points costs nothing.
 */
export function isReservedKind(kind: string | null | undefined): boolean {
  return (kind ?? '').trim().toLowerCase() === SYSTEM_KIND;
}

/** Shown wherever a reserved kind is refused, so the message is written once. */
export const RESERVED_KIND_MESSAGE =
  '"system" is reserved for the Unassigned pile. Pick another word — try shelf, bin or cabinet.';
