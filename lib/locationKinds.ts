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
 * The one word a `kind` may not be.
 *
 * It marked the auto-managed `Unassigned` bucket until 20260906182638 removed that concept. The
 * word stays reserved rather than being freed, because the database now CHECKs it
 * (`inventory_locations_kind_not_system`): typing it would be refused by a constraint violation
 * instead of the sentence below, and nothing is gained by letting a shop label a shelf "system".
 */
export const SYSTEM_KIND = 'system';

/**
 * Guard the one reserved word, so the refusal is a sentence rather than a constraint violation.
 *
 * `kind` is free text on purpose (see above) and almost anything you type degrades gracefully:
 * `unitKind` falls through to a generic drawing and nothing else cares. `system` is the exception,
 * and the reason has changed. It used to be unrecoverable — it marked the `Unassigned` bucket, and
 * `LocationDetailSheet` withheld the whole structural-actions block from anything wearing it, so a
 * shelf you typed it into could no longer be renamed, subdivided or deleted and the only fix was
 * SQL. That trap is gone with the bucket; what remains is a database CHECK, and catching it here
 * turns a 23514 into something a person can act on.
 */
export function isReservedKind(kind: string | null | undefined): boolean {
  return (kind ?? '').trim().toLowerCase() === SYSTEM_KIND;
}

/** Shown wherever a reserved kind is refused, so the message is written once. */
export const RESERVED_KIND_MESSAGE =
  '"system" is a reserved word. Pick another — try shelf, bin or cabinet.';
