/**
 * Inventory count sheet — access layer (journey J9 in docs/modules/inventory.md).
 *
 * There is no count table. Loading a sheet is two batched reads (stocked parts, then all
 * their location balances in one query — never N+1 per part), and committing walks the lines
 * through the *existing* stock functions: `adjustPartStock` for untracked parts,
 * `adjustStockAtLocation` for tracked ones. Both already write their `inventory_transactions`
 * row, so the count's audit trail comes free.
 *
 * Commit is intentionally per-line and tolerant of partial failure: each counted line is an
 * independent fact, so line 50 failing doesn't invalidate lines 1-49.
 */
import { getTypedSupabase as getSupabase } from '@/lib/supabase';
import { getStockedParts, adjustPartStock } from '@/utils/partsAccess';
import {
  adjustStockAtLocation,
  getBalancesForParts,
  getLocationContentsPage,
  getLocations,
} from '@/utils/inventoryLocationsAccess';
import { resolveCountTarget, countNote, type LocationBalance } from '@/lib/inventoryCountPlan';
import type {
  CountCandidate,
  CountCommitProgress,
  CountCommitResult,
  CountVariance,
} from '@/types/inventoryCount';

/** The auto-created system bucket every tracked part starts in. Resolved by name, as the
 *  RPCs do — there's a partial unique index on (company_id) WHERE name = 'Unassigned'. */
const UNASSIGNED_NAME = 'Unassigned';

/**
 * Build the count sheet for a company.
 *
 * Returns every stocked part with its system quantity and resolved write target — including
 * the ones that can't be counted item-by-item, so the UI can name them rather than dropping
 * them silently.
 */
export async function loadCountCandidates(
  companyId: string,
  search: string = '',
): Promise<CountCandidate[]> {
  const parts = await getStockedParts(companyId, search);
  if (parts.length === 0) return [];

  const tracked = parts.filter((p) => p.is_location_tracked);

  // Locations are only needed to name balances and find Unassigned. A flag-off company has
  // none, and nothing here is tracked, so skip the read entirely.
  const [balances, locations] = await Promise.all([
    tracked.length > 0
      ? getBalancesForParts(companyId, tracked.map((p) => p.id))
      : new Map<string, LocationBalance[]>(),
    tracked.length > 0 ? getLocations(companyId) : Promise.resolve([]),
  ]);

  const unassignedRow = locations.find((l) => l.name === UNASSIGNED_NAME);
  const unassigned = unassignedRow ? { id: unassignedRow.id, name: unassignedRow.name } : null;

  return parts.map((part) => {
    const partBalances = balances.get(part.id) ?? [];

    return {
      partId: part.id,
      partName: part.part_name,
      description: part.description ?? null,
      // Every stocked part has one — parts_requires_unit CHECKs it — but the column is
      // nullable in the type, so fall back rather than render "null".
      unit: part.primary_unit ?? 'ea',
      systemQuantity: Number(part.quantity) || 0,
      target: resolveCountTarget(part.is_location_tracked, partBalances, unassigned),
    };
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
      target: { kind: 'location', locationId, locationName },
    })),
    total,
  };
}

/**
 * One part, at one place — the sheet you get from "Count here" on the part page.
 *
 * ## Why this cannot reuse the paged read
 *
 * `loadLocationCountCandidates` is built on `getLocationContentsPage`, which filters
 * `.gt('quantity', 0)`. That is right for browsing a bin and wrong here: the whole reason to
 * count one part at one place is usually that you think the number is wrong, and the most
 * valuable case — *the system says zero and I am holding twelve* — is precisely the row that
 * filter removes. This reads the part directly and asks for its balance separately.
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
    .select('id, part_name, description, primary_unit, is_location_tracked')
    .eq('id', partId)
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) {
    console.error('Error loading the part to count:', error);
    throw error;
  }
  if (!data) throw new Error('That part no longer exists.');
  // Mirrors the RPC's own guard, before the round trip rather than after it — the commit would
  // fail with `part % is not location-tracked` once the whole sheet had been filled in.
  if (!data.is_location_tracked) {
    throw new Error(`${data.part_name} isn't tracked by place, so it can't be counted at one.`);
  }

  const balances = await refreshLocationQuantities(locationId, [partId]);

  return {
    partId,
    partName: data.part_name,
    description: data.description,
    unit: data.primary_unit ?? 'ea',
    systemQuantity: balances.get(partId) ?? 0,
    target: { kind: 'location', locationId, locationName },
  };
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
  const CHUNK = 500;

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
 * Re-read current system quantities for the sheet's parts.
 *
 * Called on entering Review. Without it, a count resumed the next morning would show
 * variances against a snapshot taken when the sheet was opened, with no indication of its
 * age. The commit is unaffected either way (adjust sets an absolute value) — it's the
 * variance column and the big-variance prompt that would otherwise mislead.
 */
export async function refreshSystemQuantities(partIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (partIds.length === 0) return out;

  const supabase = getSupabase();
  const CHUNK = 500;

  for (let i = 0; i < partIds.length; i += CHUNK) {
    const { data, error } = await supabase
      .from('parts')
      .select('id, quantity')
      .in('id', partIds.slice(i, i + CHUNK));

    if (error) {
      console.error('Error refreshing system quantities for count:', error);
      throw error;
    }
    for (const row of data ?? []) out.set(row.id, Number(row.quantity) || 0);
  }
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
    onProgress?.({ done: i, total: variances.length, currentPartName: v.candidate.partName });

    try {
      if (v.candidate.target.kind === 'aggregate') {
        // Deliberately unattributed: `adjustPartStock` writes the aggregate ledger, which §5.4
        // intends to retire once every shop is location-tracked. Widening its signature to carry
        // an operator would be work invested in the path being removed.
        await adjustPartStock(v.candidate.partId, v.counted, v.candidate.unit, countNote(v));
      } else if (v.candidate.target.kind === 'location') {
        await adjustStockAtLocation(
          v.candidate.partId,
          v.candidate.target.locationId,
          v.counted,
          v.candidate.unit,
          { notes: countNote(v), operatorId },
        );
      } else {
        // Excluded lines are filtered out before commit; treat reaching here as a bug.
        throw new Error('This part is counted at its locations, not on the sheet.');
      }
      committed += 1;
    } catch (e) {
      failures.push({
        partName: v.candidate.partName,
        message: e instanceof Error ? e.message : 'Could not save this count.',
      });
    }
  }

  onProgress?.({ done: variances.length, total: variances.length, currentPartName: '' });
  return { committed, failures };
}
