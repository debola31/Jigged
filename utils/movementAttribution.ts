/**
 * Who made a stock movement, and what they photographed.
 *
 * Extracted from `hydrateMovements` because the operator's bin history and the owner's part-ledger
 * table need the identical two lookups against the identical columns, and the owner's table was
 * fetching both and rendering neither — so the operator on a phone had a strictly better view of
 * the same rows than the person at the desk. Two copies of this would have drifted the moment one
 * of them learned something the other did not.
 *
 * ## Why the author needs its own query
 *
 * `inventory_transactions.operator_id` has **no foreign key** — the table's only FKs are
 * `company_id`, `job_id`, `job_operation_id` and `part_id`. PostgREST needs a declared
 * relationship to resolve an embed, so the `author:user_company_access(name)` shape the notes feed
 * uses ([`utils/operatorAccess.ts`](operatorAccess.ts)) cannot work here at all. Adding the FK
 * would be tidier, but it needs the existing column values validated first.
 *
 * `created_by` is no help either: it holds an `auth.users` id the browser cannot read under any
 * policy. A movement written before `operator_id` was populated on add/adjust/transfer therefore
 * has **no** author, and comes back with none rather than a guess — see the rule below.
 *
 * ## Never invent an author
 *
 * An unattributed row renders without a name. It does not render "Unknown", "System" or the
 * company name. The absence is self-explaining once you know that anything recent does carry a
 * name, and a placeholder would be a claim about who touched the shelf.
 *
 * ## Two requests, whatever the row count
 *
 * One `in()` over the distinct authors and one batched `createSignedUrls`, both skipped entirely
 * when there is nothing to resolve. A failed name lookup must not take the history down with it:
 * the movements are the point, the names are the caption.
 */

import { getSupabase } from '@/lib/supabase';
import { getSignedUrls } from '@/utils/storageHelpers';

/** Matches the other media surfaces. Owned here, separate from the location-photo constant. */
const MOVEMENT_PHOTO_EXPIRY_SECONDS = 4 * 60 * 60;

const EMPTY_URLS: ReadonlyMap<string, string> = new Map();

/** The two columns this resolves. Any row shape carrying them can be passed. */
export interface AttributableRow {
  operator_id?: string | null;
  photo_path?: string | null;
}

export interface MovementAttribution {
  /** `operator_id` → member name. Absent means unattributed; do not substitute a placeholder. */
  nameById: ReadonlyMap<string, string>;
  /** `photo_path` → signed URL. Absent means no photo, or the object has gone. */
  urlByPath: ReadonlyMap<string, string>;
}

export interface ResolveOptions {
  /**
   * Sign photo URLs. Pass `false` from a caller that renders no image.
   *
   * Not a micro-optimisation: `getPartActivity` reads 100 transactions for a feed with no
   * thumbnail, and signing 100 URLs nobody looks at is a storage round trip per part-page open.
   */
  photos?: boolean;
}

export async function resolveMovementAttribution(
  rows: AttributableRow[],
  { photos = true }: ResolveOptions = {},
): Promise<MovementAttribution> {
  if (rows.length === 0) return { nameById: new Map(), urlByPath: EMPTY_URLS };

  const supabase = getSupabase();
  const actorIds = [...new Set(rows.map((r) => r.operator_id).filter((v): v is string => !!v))];
  const photoPaths = photos
    ? rows.map((r) => r.photo_path).filter((v): v is string => !!v)
    : [];

  const [actors, urlByPath] = await Promise.all([
    actorIds.length > 0
      ? supabase.from('user_company_access').select('id, name').in('id', actorIds)
      : Promise.resolve({ data: [], error: null }),
    photoPaths.length > 0
      ? getSignedUrls(photoPaths, MOVEMENT_PHOTO_EXPIRY_SECONDS)
      : Promise.resolve(EMPTY_URLS),
  ]);

  const nameById = new Map<string, string>();
  for (const a of (actors.data ?? []) as Array<{ id: string; name: string | null }>) {
    if (a.name) nameById.set(a.id, a.name);
  }
  return { nameById, urlByPath };
}
