/**
 * Inventory count sheet — access layer (journey J9 in docs/modules/inventory.md).
 *
 * There is no count table. Loading a sheet is two batched reads (stocked parts, then all
 * their location balances in one query — never N+1 per part), and committing walks the lines
 * through `adjustStockAtLocation`, which already writes its `inventory_transactions` row — so
 * the count's audit trail comes free. There is one commit path, not two: since 20260802015837
 * every part has a place, so there is no part whose count lands on `parts.quantity`.
 *
 * Commit is intentionally per-line and tolerant of partial failure: each counted line is an
 * independent fact, so line 50 failing doesn't invalidate lines 1-49.
 */
import { getTypedSupabase as getSupabase } from '@/lib/supabase';
import { ID_CHUNK } from '@/lib/queryLimits';
import { getStockedParts } from '@/utils/partsAccess';
import {
  adjustStockAtLocation,
  getBalancesForPart,
  getBalancesForParts,
  getLocationContentsPage,
  getLocations,
} from '@/utils/inventoryLocationsAccess';
import { resolveFallbackPlace, countNote } from '@/lib/inventoryCountPlan';
import type {
  CountCandidate,
  CountCommitProgress,
  CountCommitResult,
  CountVariance,
} from '@/types/inventoryCount';

/**
 * The company-wide count sheet: **one row per (part, place)**.
 *
 * ## The row rule, stated once
 *
 *  - one row per place holding `quantity > 0`, carrying THAT place's balance; plus
 *  - exactly one row at the company's system (`Unassigned`) bucket when a part holds stock
 *    nowhere — the opening count, since `trg_auto_track_stocked_part` seeds every stocked part
 *    there at 0.
 *
 * The fallback row is the whole subtlety. Emitting rows only for places that hold stock would
 * make a part holding stock NOWHERE vanish from the sheet entirely — which deletes the opening
 * count and, ironically, the case the founder asked for most directly: saying where a part is
 * matters most when the system thinks it is nowhere.
 *
 * There is no longer a second trap on the other side. Until 20260802144310 every bin a part had
 * passed through kept a zero row forever, and rendering one put a live absolute write target on a
 * shelf the part had left — someone holding 12 typed 12 into the ghost, booking it to the wrong
 * place while the real shelf kept its stale figure. That residue is deleted and the table now
 * CHECKs `quantity > 0`, so the rows this reads are exactly the places the part is.
 *
 * ## Cost
 *
 * No new query and no extra request: `getBalancesForParts` was already fetching every balance for
 * every stocked part to resolve one target per part. Only the row count changes, and only on the
 * sheet — the picker stays part-grained (see `groupByPart`).
 */
export async function loadCountCandidates(
  companyId: string,
  search: string = '',
): Promise<CountCandidate[]> {
  const parts = await getStockedParts(companyId, search);
  if (parts.length === 0) return [];

  // `getBalancesForParts` already filters `quantity > 0`, pages past PostgREST's max_rows, and
  // computes each location's ancestor path — so the row rule above needs no query of its own.
  const [balances, locations] = await Promise.all([
    getBalancesForParts(companyId, parts.map((p) => p.id)),
    getLocations(companyId),
  ]);

  const fallback = resolveFallbackPlace(locations);

  return parts.flatMap((part) => {
    const base = {
      partId: part.id,
      partName: part.part_name,
      description: part.description ?? null,
      // Every stocked part has one — parts_requires_unit CHECKs it — but the column is
      // nullable in the type, so fall back rather than render "null".
      unit: part.primary_unit ?? 'ea',
    };

    const held = balances.get(part.id) ?? [];
    if (held.length === 0) {
      return [
        {
          ...base,
          systemQuantity: 0,
          target: {
            locationId: fallback.id,
            locationName: fallback.name,
            locationPath: fallback.name,
          },
        },
      ];
    }

    return held.map((b) => ({
      ...base,
      systemQuantity: b.quantity,
      target: {
        locationId: b.locationId,
        locationName: b.locationName,
        locationPath: [...b.path, b.locationName].join(' › '),
      },
    }));
  });
}

/**
 * Build the count sheet for ONE location.
 *
 * §5.11 asks for the count to be **place-scoped**, and the company-wide sheet above never was —
 * it's part-first, and you walk a shop bin by bin, not part by part.
 *
 * It also removes an exclusion the company-wide sheet cannot avoid. There, a part split across
 * bins is *unc*ountable: if it holds 10+20+10 and you count 38, no bin defensibly absorbs the −2,
 * so `resolveCountTarget` drops it. Standing at one bin there is no such ambiguity — "Shelf A holds
 * 830" adjusts Shelf A and says nothing about Shelf B. **So every part here is countable, including
 * the split ones the other sheet has to name and skip.**
 *
 * `systemQuantity` is therefore the balance AT THIS LOCATION, not the part's company-wide total.
 */
export async function loadLocationCountCandidates(
  locationId: string,
  locationName: string,
  opts: { search?: string; limit?: number; offset?: number } = {},
): Promise<{ candidates: CountCandidate[]; total: number }> {
  const { contents, total } = await getLocationContentsPage(locationId, opts);

  return {
    candidates: contents.map((c) => ({
      partId: c.part_id,
      partName: c.part_name,
      // The paged read is deliberately narrow — it doesn't join descriptions, because this list is
      // reached by searching for a part you're holding rather than by browsing for one.
      description: null,
      unit: c.primary_unit ?? 'ea',
      systemQuantity: c.quantity,
      // `locationPath` is the plain name here: every row on this sheet shares one place and the
      // page title already says which, so an ancestor path would repeat down every row.
      target: { locationId, locationName, locationPath: locationName },
    })),
    total,
  };
}

/**
 * One part, at one place — the sheet you get from "Count here" on the part page.
 *
 * ## Why this cannot reuse the paged read
 *
 * `loadLocationCountCandidates` is built on `getLocationContentsPage`, which lists what a bin
 * HOLDS. The whole reason to count one part at one place is usually that you think the number is
 * wrong, and the most valuable case — *the system says zero and I am holding twelve* — is a part
 * with no row at that bin at all, so no listing of the bin's contents can reach it. This reads the
 * part directly and asks for its balance separately.
 *
 * (Until 20260802144310 that row existed and was hidden by a `quantity > 0` filter. Now it does
 * not exist. The consequence for this function is the same either way, which is why it is
 * unchanged: it must not assume, it must read.)
 *
 * ## The balance is READ, never assumed
 *
 * A tempting shortcut is `systemQuantity: 0` when the part has no row at this place. It is wrong
 * in a way that fails silently: `committableVariances` drops any line whose delta is 0, so
 * counting 12 against an assumed 0 works, but counting **0** against a real balance of 12 would
 * compute a delta of −12 correctly, while counting 0 against an assumed 0 computes 0 and commits
 * nothing at all. The count that confirms an empty shelf has to be able to write.
 */
export async function loadPartAtLocationCandidate(
  companyId: string,
  partId: string,
  locationId: string,
  locationName: string,
): Promise<CountCandidate> {
  const supabase = getSupabase();

  // Its own read rather than `getPartsForSelectByIds`, which filters neither by company nor by
  // `deleted_at` — a by-id helper for a picker that has already scoped its options. Same line
  // count here, and it closes both gaps.
  const { data, error } = await supabase
    .from('parts')
    .select('id, part_name, description, primary_unit')
    .eq('id', partId)
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) {
    console.error('Error loading the part to count:', error);
    throw error;
  }
  if (!data) throw new Error('That part no longer exists.');

  const balances = await refreshLocationQuantities(locationId, [partId]);

  return {
    partId,
    partName: data.part_name,
    description: data.description,
    unit: data.primary_unit ?? 'ea',
    systemQuantity: balances.get(partId) ?? 0,
    target: { locationId, locationName, locationPath: locationName },
  };
}

/**
 * One part, EVERY place it sits — the sheet the excluded-part chips have been promising.
 *
 * ## The gap this closes
 *
 * A part whose stock is split across bins is deliberately kept off the company-wide sheet: a
 * single total has no unambiguous home, and writing it would have to guess which shelf absorbed
 * the difference. The picker says so and offers a chip per place — but each chip was a separate
 * one-row sheet, so counting a part in three places meant three trips out through the picker and
 * three saves. For the one journey that *is* part-first ("where has this gone?"), that is the
 * long way round.
 *
 * This returns one candidate per place, each targeting its own location, so the existing commit
 * path already does the right thing: `commitCount` routes every line through
 * `adjustStockAtLocation` for ITS location, and no line touches another shelf.
 *
 * ## The same row rule as the company-wide sheet
 *
 * One row per place holding some, plus one row at the system bucket when the part holds stock
 * nowhere. A part that has passed through a bin keeps a zero balance row forever
 * (`transfer_stock` decrements, `bulk_put_away` sets 0), and putting every historical shelf here
 * would send someone to look at empties.
 *
 * The fallback row is what stops this sheet being reachable-but-empty. Before it, a part holding
 * stock nowhere landed on an empty table with a disabled Save and no explanation — which is
 * precisely the part you most need to say "it's over here, and there are twelve" about.
 */
export async function loadPartEverywhereCandidates(
  companyId: string,
  partId: string,
): Promise<{ partName: string; candidates: CountCandidate[] }> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('parts')
    .select('id, part_name, description, primary_unit')
    .eq('id', partId)
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) {
    console.error('Error loading the part to count:', error);
    throw error;
  }
  if (!data) throw new Error('That part no longer exists.');

  const [balances, locations] = await Promise.all([
    getBalancesForPart(partId),
    getLocations(companyId),
  ]);
  const unit = data.primary_unit ?? 'ea';
  const fallback = resolveFallbackPlace(locations);

  // `getBalancesForPart` is the unfiltered read, but since 20260802144310 there is nothing to
  // filter: a row exists only where the part actually is.
  const held = balances.filter((b) => Number(b.quantity ?? 0) > 0);

  // The place used to be crammed into `description` because there was nowhere else to put it.
  // `target.locationPath` is that place now, so the description can go back to being the
  // description — and a row can show both.
  const base = { partId, partName: data.part_name, description: data.description, unit };

  const candidates: CountCandidate[] =
    held.length === 0
      ? [
          {
            ...base,
            systemQuantity: 0,
            target: {
              locationId: fallback.id,
              locationName: fallback.name,
              locationPath: fallback.name,
            },
          },
        ]
      : held
          .map((b) => ({
            ...base,
            systemQuantity: Number(b.quantity ?? 0),
            target: {
              locationId: b.location_id,
              locationName: b.location_name,
              locationPath: [...b.path, b.location_name].join(' › ') || b.location_name,
            },
          }))
          .sort((a, b) => a.target.locationPath.localeCompare(b.target.locationPath));

  return { partName: data.part_name, candidates };
}

/**
 * Re-read the balances AT ONE LOCATION before committing a place-scoped count.
 *
 * The company-wide sibling below reads `parts.quantity`, which is the roll-up across every bin —
 * using it here would compare a shelf count against the whole shop's total and report a variance
 * on every line.
 */
export async function refreshLocationQuantities(
  locationId: string,
  partIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (partIds.length === 0) return out;

  const supabase = getSupabase();
  const CHUNK = ID_CHUNK;

  for (let i = 0; i < partIds.length; i += CHUNK) {
    const { data, error } = await supabase
      .from('part_location_stock')
      .select('part_id, quantity')
      .eq('location_id', locationId)
      .in('part_id', partIds.slice(i, i + CHUNK));

    if (error) {
      console.error('Error refreshing location quantities for count:', error);
      throw error;
    }
    for (const row of data ?? []) out.set(row.part_id, Number(row.quantity) || 0);
  }
  // A part whose row vanished (moved away mid-count) reads 0 rather than going missing, so the
  // sheet shows "0 here now" instead of silently keeping the opening number.
  for (const id of partIds) if (!out.has(id)) out.set(id, 0);
  return out;
}

/**
 * Commit counted lines, one at a time, reporting progress.
 *
 * Each line routes to the write path its target demands — there is no third path, and
 * `parts.quantity` is never written directly for a tracked part (the
 * `enforce_tracked_part_quantity` trigger would reject it anyway).
 *
 * A failing line is recorded and the walk continues: the counts already committed are real
 * observations and shouldn't be rolled back because a later one failed.
 */
export async function commitCount(
  variances: CountVariance[],
  /**
   * An options bag rather than more positionals, matching `addStockAtLocation` and its siblings.
   *
   * `operatorId` names who ran the count in the ledger. Without it a count session — the one
   * movement whose author matters most, because it is a human assertion about a shelf rather
   * than a consequence of a job — lands anonymous.
   */
  { onProgress, operatorId }: { onProgress?: (p: CountCommitProgress) => void; operatorId?: string | null } = {},
): Promise<CountCommitResult> {
  const failures: CountCommitResult['failures'] = [];
  let committed = 0;

  for (let i = 0; i < variances.length; i += 1) {
    const v = variances[i];
    onProgress?.({
      done: i,
      total: variances.length,
      currentPartName: v.candidate.partName,
      currentLocationName: v.candidate.target.locationPath,
    });

    try {
      await adjustStockAtLocation(
        v.candidate.partId,
        v.candidate.target.locationId,
        v.counted,
        v.candidate.unit,
        { notes: countNote(v), operatorId },
      );
      committed += 1;
    } catch (e) {
      failures.push({
        partName: v.candidate.partName,
        // Without the place, "BUY-ORING-214 could not be saved" leaves someone who counted it at
        // three shelves with no idea which number to re-enter.
        locationName: v.candidate.target.locationPath,
        message: e instanceof Error ? e.message : 'Could not save this count.',
      });
    }
  }

  onProgress?.({
    done: variances.length,
    total: variances.length,
    currentPartName: '',
    currentLocationName: '',
  });
  return { committed, failures };
}
