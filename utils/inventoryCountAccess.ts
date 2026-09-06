/**
 * Inventory count sheet — access layer (journey J9 in docs/modules/inventory.md).
 *
 * There is no count table. Loading a sheet is two batched reads (a page of parts, then all
 * their location balances in one query — never N+1 per part), and committing walks the lines
 * through `adjustStockAtLocation`, which already writes its `inventory_transactions` row — so
 * the count's audit trail comes free. There is one commit path, not two: since 20260802015837
 * every part has a place, so there is no part whose count lands on `parts.quantity`.
 *
 * Commit is intentionally per-line and tolerant of partial failure: each counted line is an
 * independent fact, so line 50 failing doesn't invalidate lines 1-49.
 */
import { getSupabase } from '@/lib/supabase';
import { COUNT_PICKER_LIMIT, ID_CHUNK } from '@/lib/queryLimits';
import { searchPartsForSelect } from '@/utils/partsAccess';
import {
  adjustStockAtLocation,
  getBalancesForPart,
  getBalancesForParts,
  getContentsPageForLocations,
  getLocations,
  getLotsForPart,
  getLotsForTrackedParts,
} from '@/utils/inventoryLocationsAccess';
import {
  resolveFallbackPlace,
  countNote,
  refreshedKey,
  rowHeatLabel,
} from '@/lib/inventoryCountPlan';
import { compareLocationNames } from '@/lib/locationTree';
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
 *    nowhere — the opening count. `seed_new_part_balance` gives a part an opening balance only
 *    when it is created carrying stock, so a part at 0 legitimately holds a row nowhere.
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
 * ## Cost, and why this is server-searched
 *
 * This used to read the whole stocked catalogue and filter it in the browser, which was
 * defensible while `is_stocked` bounded it: the biggest real list was ~722 rows at Contour, not
 * the 8,451-part catalogue. Dropping the flag removed that bound — every part is stockable now —
 * so the same code would have loaded 8.4k rows unvirtualised AND fanned `getBalancesForParts` out
 * from ~6 chunked queries to ~71.
 *
 * So the term goes to the server and the result is capped at `COUNT_PICKER_LIMIT`. Callers must
 * surface the cap (see the picker's hint) rather than let a part silently not be there — the one
 * failure mode a capped list has that an unbounded one does not.
 *
 * `searchPartsForSelect` is reused rather than reimplemented: it already does ILIKE over
 * name + description, pages nothing, and returns exactly the four fields a candidate row needs.
 * Its `updated_at DESC` ordering is what decides WHICH parts survive the cap (the ones being
 * worked on), and the alphabetical sort below is what decides how they READ.
 */
export async function loadCountCandidates(
  companyId: string,
  search: string = '',
  limit: number = COUNT_PICKER_LIMIT,
): Promise<CountCandidate[]> {
  const found = await searchPartsForSelect(companyId, search, 'all', limit);
  // Recently-touched decided the cut; part_name decides the reading order. A worksheet you walk
  // is alphabetical or it is nothing.
  const parts = [...found].sort((a, b) => a.part_name.localeCompare(b.part_name));
  if (parts.length === 0) return [];

  // `getBalancesForParts` already filters `quantity > 0`, pages past PostgREST's max_rows, and
  // computes each location's ancestor path — so the row rule above needs no query of its own.
  const [balances, locations] = await Promise.all([
    getBalancesForParts(companyId, parts.map((p) => p.id)),
    getLocations(companyId),
  ]);

  const fallback = resolveFallbackPlace(locations);

  /*
   * The stock-nowhere rows need a lot too, when their part is tracked.
   *
   * One batched read for every part holding nothing, not one per part: at an opening count that
   * set is the whole catalogue, and a query each would be thousands of round trips for a sheet.
   * `getLotsForTrackedParts` returns nothing for an untracked part, so the ordinary shop — every
   * part untracked — pays two queries that come back empty and the rows below are unchanged.
   */
  const emptyPartIds = parts.filter((p) => (balances.get(p.id) ?? []).length === 0).map((p) => p.id);
  const lotsForEmpty = await getLotsForTrackedParts(emptyPartIds);

  return parts.flatMap((part) => {
    const base = {
      partId: part.id,
      partName: part.part_name,
      description: part.description ?? null,
      // Every part has one — parts_requires_unit CHECKs it — but the column is
      // nullable in the type, so fall back rather than render "null".
      unit: part.primary_unit ?? 'ea',
    };

    const held = balances.get(part.id) ?? [];
    if (held.length === 0) {
      const target = {
        locationId: fallback.id,
        locationName: fallback.name,
        locationPath: fallback.name,
      };
      const lots = lotsForEmpty.get(part.id) ?? [];
      // A tracked part with lots gets a row per heat: "there are 12 here" is not a statement you
      // can make about a part whose material is told apart by heat. With no lots — tracking
      // switched on before anything was ever received — there is no heat to name and the single
      // row stands, which is also every untracked part.
      if (lots.length > 0) {
        return lots.map((lot) => ({
          ...base,
          systemQuantity: 0,
          lotId: lot.lotId,
          lotCode: lot.lotCode,
          heatNumber: lot.heatNumber,
          target,
        }));
      }
      return [
        {
          ...base,
          systemQuantity: 0,
          lotId: null,
          lotCode: null,
          heatNumber: null,
          target,
        },
      ];
    }

    return held.map((b) => ({
      ...base,
      systemQuantity: b.quantity,
      lotId: b.lotId,
      lotCode: b.lotCode,
      heatNumber: b.heatNumber,
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
  return loadCountCandidatesForPlaces(
    // `locationPath` is the plain name here: every row on this sheet shares one place and the page
    // title already says which, so an ancestor path would repeat down every row.
    [{ id: locationId, name: locationName, path: locationName }],
    opts,
  );
}

/** One bin a count sheet may write to, with the label its rows should carry. */
export interface CountPlace {
  id: string;
  name: string;
  /** How the row names its bin. Full path when a sheet spans several, plain name when it doesn't. */
  path: string;
}

/**
 * Build the count sheet for a SET of bins — what counting a whole cabinet means.
 *
 * A container holds no stock itself (20260806160053), so "count Cabinet 1-A" can only be "count
 * every bin under it". Nothing about committing changes: `commitCount` already adjusts each line at
 * `candidate.target.locationId`, so a sheet spanning ten bins is ten independent one-bin
 * assertions. That per-line target is what made this a small change rather than a new engine.
 *
 * **A part in two bins gets two lines, not one.** Aggregating would re-create precisely the
 * ambiguity that forces the company-wide sheet to skip split parts — if a part holds 380 + 200 and
 * you count 560, no bin defensibly absorbs the −20. Two lines means each number is an assertion
 * about one shelf you are standing at, which is also how you would physically do it.
 *
 * Rows keep the bin's **full path** because, unlike the single-bin sheet, the page title can no
 * longer say which place a row belongs to.
 */
export async function loadCountCandidatesForPlaces(
  places: CountPlace[],
  opts: { search?: string; limit?: number; offset?: number } = {},
): Promise<{ candidates: CountCandidate[]; total: number }> {
  const byId = new Map(places.map((p) => [p.id, p] as const));
  const { contents, total } = await getContentsPageForLocations(
    places.map((p) => p.id),
    opts,
  );

  return {
    candidates: contents.map((c) => {
      // Every row carries its own bin, so this lookup cannot miss — the ids came from `places`.
      const place = byId.get(c.location_id);
      return {
        partId: c.part_id,
        partName: c.part_name,
        // The paged read is deliberately narrow — it doesn't join descriptions, because this list
        // is reached by searching for a part you're holding rather than by browsing for one.
        description: null,
        unit: c.primary_unit ?? 'ea',
        systemQuantity: c.quantity,
        lotId: c.lot_id,
        lotCode: c.lot_code,
        heatNumber: c.heat_number,
        target: {
          locationId: c.location_id,
          locationName: place?.name ?? '',
          locationPath: place?.path ?? '',
        },
      };
    }),
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
 *
 * ## Why it returns a LIST
 *
 * One part at one place is one row only while the part is untracked. A heat-tracked part holding
 * two heats in a bin is two numbers — there is 8 of one and 4 of the other — and
 * `adjust_stock_at_location` refuses a count that does not say which. Returning a single lot-less
 * candidate for such a part would build a sheet you can fill in and only then be told the database
 * will not take, after the walk, which is the one moment a person is least willing to redo.
 */
export async function loadPartAtLocationCandidates(
  companyId: string,
  partId: string,
  locationId: string,
  locationName: string,
): Promise<CountCandidate[]> {
  const supabase = getSupabase();

  // Its own read rather than `getPartsForSelectByIds`, which filters neither by company nor by
  // `deleted_at` — a by-id helper for a picker that has already scoped its options. Same line
  // count here, and it closes both gaps.
  const { data, error } = await supabase
    .from('parts')
    .select('id, part_name, description, primary_unit, lot_tracked')
    .eq('id', partId)
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) {
    console.error('Error loading the part to count:', error);
    throw error;
  }
  if (!data) throw new Error('That part no longer exists.');

  const balances = await readPlaceBalances(locationId, [partId]);

  const base = {
    partId,
    partName: data.part_name,
    description: data.description,
    unit: data.primary_unit ?? 'ea',
    target: { locationId, locationName, locationPath: locationName },
  };

  /*
   * A row per balance ROW here, whatever the flag says.
   *
   * Driven by what `part_location_stock` holds rather than by `lot_tracked`, because the two can
   * legitimately disagree: switching tracking off leaves the split balances alone (merging them
   * would have to pick a survivor and silently add the others to it), so a no-longer-tracked part
   * can still sit here as three heats. Offering that part ONE lot-less line would write a fourth
   * balance row beside the three, and `parts.quantity` — a trigger rollup summing these rows —
   * would then count the same steel twice with no error anywhere.
   */
  const here = [...balances.values()];
  if (here.length > 0) {
    return here.map((b) => ({
      ...base,
      systemQuantity: b.quantity,
      lotId: b.lotId,
      lotCode: b.lotCode,
      heatNumber: b.heatNumber,
    }));
  }

  /*
   * Nothing here. For an ordinary part that is the single most valuable line on any sheet — *the
   * system says zero and I am holding twelve* — so it gets its row at 0.
   *
   * For a TRACKED part the same row would be refused, because an absolute count of heat-tracked
   * material has to say which heat. So every lot of the part becomes a row at 0 instead, which is
   * also the honest shape of the discovery: a bin holding none of this part on paper is exactly
   * where a mis-shelved heat turns up, and until you name one you have not said what you found.
   *
   * A tracked part with no lots at all — tracking switched on before anything was received — falls
   * through to the plain row and is refused at commit, per line, in the database's own words. That
   * is correct: material whose heat has never been recorded is received, not counted into being.
   */
  const lots = data.lot_tracked ? await getLotsForPart(partId) : [];
  if (lots.length === 0) {
    return [{ ...base, systemQuantity: 0, lotId: null, lotCode: null, heatNumber: null }];
  }
  return lots.map((lot) => ({
    ...base,
    systemQuantity: 0,
    lotId: lot.lotId,
    lotCode: lot.lotCode,
    heatNumber: lot.heatNumber,
  }));
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
    .select('id, part_name, description, primary_unit, lot_tracked')
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

  /*
   * The stock-nowhere row has to name a lot too, when the part is tracked.
   *
   * `resolveFallbackPlace` puts one row at the system bucket so a part with no balance anywhere is
   * still countable — the opening count, and the most valuable line on the sheet. For a tracked
   * part that row is only writable if it says which heat, so it becomes one row per lot.
   *
   * A tracked part with NO lots is possible and gets the plain row: tracking switched on before
   * anything was ever received leaves nothing to name. That count is refused at commit with the
   * database's own sentence about naming a heat, per line and without touching the others — the
   * honest answer, because material whose heat has never been recorded cannot be counted into
   * existence. It is received, which is where a heat enters Jigged at all.
   */
  const nowhere = async (): Promise<CountCandidate[]> => {
    const target = {
      locationId: fallback.id,
      locationName: fallback.name,
      locationPath: fallback.name,
    };
    const lots = data.lot_tracked ? await getLotsForPart(partId) : [];
    if (lots.length === 0) {
      return [{ ...base, systemQuantity: 0, target, lotId: null, lotCode: null, heatNumber: null }];
    }
    return lots.map((lot) => ({
      ...base,
      systemQuantity: 0,
      target,
      lotId: lot.lotId,
      lotCode: lot.lotCode,
      heatNumber: lot.heatNumber,
    }));
  };

  const candidates: CountCandidate[] =
    held.length === 0
      ? await nowhere()
      : held
          .map((b) => ({
            ...base,
            systemQuantity: Number(b.quantity ?? 0),
            lotId: b.lot_id,
            lotCode: b.lot_code,
            heatNumber: b.heat_number,
            target: {
              locationId: b.location_id,
              locationName: b.location_name,
              locationPath: [...b.path, b.location_name].join(' › ') || b.location_name,
            },
          }))
          // Place first, then heat within it — the row order is a walking route, and the two heats
          // of one bar are two labels you read off tags while standing in the same spot.
          .sort(
            (a, b) =>
              compareLocationNames(a.target.locationPath, b.target.locationPath) ||
              (a.lotCode ?? '').localeCompare(b.lotCode ?? ''),
          );

  return { partName: data.part_name, candidates };
}

/**
 * What a bin actually holds of some parts — the per-place read, lot by lot.
 *
 * The company-wide sibling below reads `parts.quantity`, which is the roll-up across every bin —
 * using it here would compare a shelf count against the whole shop's total and report a variance
 * on every line.
 *
 * **One entry per (part, lot), which is one row of `part_location_stock`.** Never per part: a bar
 * holding two heats on one shelf is two balances, and collapsing them would both hide a heat and
 * measure every count against whichever row came back last. It is also what makes the count safe
 * to WRITE — `adjust_stock_at_location` sets one balance row absolutely, so a sheet line has to
 * correspond to one of these or it is setting a number nobody can point at.
 *
 * (Renamed from `refreshLocationQuantities` in 2026-09, when a quantity stopped being enough to
 * describe what is at a place.)
 */
export async function readPlaceBalances(
  locationId: string,
  partIds: string[],
): Promise<Map<string, PlaceBalance>> {
  const out = new Map<string, PlaceBalance>();
  if (partIds.length === 0) return out;

  const supabase = getSupabase();
  const CHUNK = ID_CHUNK;

  for (let i = 0; i < partIds.length; i += CHUNK) {
    const { data, error } = await supabase
      .from('part_location_stock')
      .select('part_id, quantity, lot_id, material_lots (lot_code, heat_number)')
      .eq('location_id', locationId)
      .in('part_id', partIds.slice(i, i + CHUNK));

    if (error) {
      console.error('Error reading the balances at a place:', error);
      throw error;
    }

    type Row = {
      part_id: string;
      quantity: number;
      lot_id: string | null;
      material_lots: { lot_code: string; heat_number: string | null } | null;
    };
    for (const row of (data ?? []) as unknown as Row[]) {
      out.set(refreshedKey(row.part_id, row.lot_id), {
        quantity: Number(row.quantity) || 0,
        lotId: row.lot_id,
        lotCode: row.material_lots?.lot_code ?? null,
        heatNumber: row.material_lots?.heat_number ?? null,
      });
    }
  }
  return out;
}

/** One balance row at a place: how much, and of which lot. */
export interface PlaceBalance {
  quantity: number;
  lotId: string | null;
  lotCode: string | null;
  heatNumber: string | null;
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
        // Which heat was counted. Required by the RPC for a lot-tracked part, because setting an
        // absolute at a bin holding two heats has to say which one it is setting.
        { notes: countNote(v), operatorId, lotId: v.candidate.lotId ?? undefined },
      );
      committed += 1;
    } catch (e) {
      const heat = rowHeatLabel(v.candidate);
      failures.push({
        partName: v.candidate.partName,
        // Without the place, "BUY-ORING-214 could not be saved" leaves someone who counted it at
        // three shelves with no idea which number to re-enter. The heat is the same problem one
        // grain down, where two failed lines share a part AND a shelf.
        locationName: heat
          ? `${v.candidate.target.locationPath} · ${heat}`
          : v.candidate.target.locationPath,
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
