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
import { adjustStockAtLocation, getLocations } from '@/utils/inventoryLocationsAccess';
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
 * Every location balance for a set of parts, in one query.
 *
 * `getBalancesForPart` exists but is per-part; a sheet over a few hundred parts would N+1 it
 * into the ground, so this is the batched sibling.
 */
async function loadBalancesFor(partIds: string[]): Promise<Map<string, LocationBalance[]>> {
  const byPart = new Map<string, LocationBalance[]>();
  if (partIds.length === 0) return byPart;

  const supabase = getSupabase();
  const CHUNK = 500; // keep the IN () list well inside PostgREST's URL limits

  for (let i = 0; i < partIds.length; i += CHUNK) {
    const { data, error } = await supabase
      .from('part_location_stock')
      .select('part_id, location_id, quantity')
      .in('part_id', partIds.slice(i, i + CHUNK));

    if (error) {
      console.error('Error loading location balances for count:', error);
      throw error;
    }

    for (const row of data ?? []) {
      const list = byPart.get(row.part_id) ?? [];
      list.push({
        locationId: row.location_id,
        locationName: '', // filled in below, once we have the location names
        quantity: Number(row.quantity) || 0,
      });
      byPart.set(row.part_id, list);
    }
  }
  return byPart;
}

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
    tracked.length > 0 ? loadBalancesFor(tracked.map((p) => p.id)) : new Map<string, LocationBalance[]>(),
    tracked.length > 0 ? getLocations(companyId) : Promise.resolve([]),
  ]);

  const locationNameById = new Map(locations.map((l) => [l.id, l.name]));
  const unassignedRow = locations.find((l) => l.name === UNASSIGNED_NAME);
  const unassigned = unassignedRow ? { id: unassignedRow.id, name: unassignedRow.name } : null;

  return parts.map((part) => {
    const partBalances = (balances.get(part.id) ?? []).map((b) => ({
      ...b,
      locationName: locationNameById.get(b.locationId) ?? 'Unknown location',
    }));

    return {
      partId: part.id,
      partName: part.part_name,
      // Every stocked part has one — parts_requires_unit CHECKs it — but the column is
      // nullable in the type, so fall back rather than render "null".
      unit: part.primary_unit ?? 'ea',
      systemQuantity: Number(part.quantity) || 0,
      target: resolveCountTarget(part.is_location_tracked, partBalances, unassigned),
    };
  });
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
  onProgress?: (p: CountCommitProgress) => void,
): Promise<CountCommitResult> {
  const failures: CountCommitResult['failures'] = [];
  let committed = 0;

  for (let i = 0; i < variances.length; i += 1) {
    const v = variances[i];
    onProgress?.({ done: i, total: variances.length, currentPartName: v.candidate.partName });

    try {
      if (v.candidate.target.kind === 'aggregate') {
        await adjustPartStock(v.candidate.partId, v.counted, v.candidate.unit, countNote(v));
      } else if (v.candidate.target.kind === 'location') {
        await adjustStockAtLocation(
          v.candidate.partId,
          v.candidate.target.locationId,
          v.counted,
          v.candidate.unit,
          countNote(v),
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
