import type { InventoryLocation } from '@/types/inventoryLocations';
import type { OnHandRow } from '@/utils/inventoryOnHandAccess';

/**
 * Decisions about the Storage Inventory table, as pure functions.
 *
 * Sibling of `locationOccupancy.ts` and `locationSpec.ts`: the decisions live here where a test can
 * reach them without a network, and the access layer only fetches.
 */

/** What the footer says, over whatever rows are currently showing. */
export interface OnHandSummary {
  /** Distinct parts in the filtered rows — not a row count; one part can sit on several shelves. */
  partCount: number;
  /** Rows, i.e. (part, place, lot) balances. */
  balanceCount: number;
  /**
   * The money, over the rows that HAVE a cost.
   *
   * **NULL, not zero, when nothing showing is costable.** `$0` would say "what is here is worth
   * nothing", which is a different and false claim from "nothing here has a cost on file".
   */
  costedTotal: number | null;
  /** Distinct parts with no purchase tier — someone has not recorded one. Actionable. */
  noCostTierParts: number;
  /** Distinct made parts, whose cost lives in the routing rollup by design. Not a complaint. */
  madeParts: number;
  /** Distinct parts held below their smallest break, costed at the floor and flagged. */
  belowMinParts: number;
}

/**
 * Summarise the rows the table is showing.
 *
 * **Over the FILTERED rows, deliberately.** A footer that reported the whole shop while the table
 * showed one cabinet would be answering a question nobody asked, next to rows that contradict it.
 *
 * Counts are of distinct PARTS, not rows, everywhere except `balanceCount`: "3 parts have no cost"
 * is actionable, while "5 balances have no cost" counts the same part three times for sitting on
 * three shelves.
 */
export function summariseOnHand(rows: OnHandRow[]): OnHandSummary {
  const parts = new Set<string>();
  const noTier = new Set<string>();
  const made = new Set<string>();
  const belowMin = new Set<string>();
  let total = 0;
  let anyCosted = false;

  for (const row of rows) {
    parts.add(row.partId);
    if (row.gap === 'no_cost_tier') noTier.add(row.partId);
    if (row.gap === 'made') made.add(row.partId);
    if (row.costBelowMin) belowMin.add(row.partId);
    if (row.onHandCost !== null) {
      total += row.onHandCost;
      anyCosted = true;
    }
  }

  return {
    partCount: parts.size,
    balanceCount: rows.length,
    // Rounded once at the end: the per-row figures are already rounded to the cent in SQL, so this
    // only clears the float dust that summing them accumulates.
    costedTotal: anyCosted ? Math.round(total * 100) / 100 : null,
    noCostTierParts: noTier.size,
    madeParts: made.size,
    belowMinParts: belowMin.size,
  };
}

/**
 * The honest sentence under the table, or null when there is nothing to disclose.
 *
 * Shown whether or not the money is: how complete a shop's cost data is, is not itself a dollar
 * figure, so a salesperson and a shop with the flag off still get to know that some of what is on
 * the shelf is not in the total.
 */
export function gapSentence(summary: OnHandSummary): string | null {
  const parts: string[] = [];
  if (summary.noCostTierParts > 0) {
    parts.push(
      `${summary.noCostTierParts} ${summary.noCostTierParts === 1 ? 'part has' : 'parts have'} no cost on file`,
    );
  }
  if (summary.madeParts > 0) {
    parts.push(
      `${summary.madeParts} made ${summary.madeParts === 1 ? 'part is' : 'parts are'} costed from its routing`,
    );
  }
  if (summary.belowMinParts > 0) {
    parts.push(
      `${summary.belowMinParts} ${summary.belowMinParts === 1 ? 'is' : 'are'} priced at the smallest break`,
    );
  }
  if (parts.length === 0) return null;

  const excluded = summary.noCostTierParts > 0 || summary.madeParts > 0;
  return `${parts.join(' · ')}${excluded ? ' — not in the total.' : '.'}`;
}

/**
 * A location and everything beneath it.
 *
 * **Stock only ever sits at a leaf**: since 20260806160053 a location with children holds none. So
 * "Raw stock rack" can only mean the bins under it, and a filter that matched the rack alone would
 * return nothing at all — the one result that looks like an empty shelf and is actually a bug.
 *
 * Walks the flat list rather than a built tree, so a caller does not have to build one to filter.
 */
export function locationAndDescendants(
  locations: InventoryLocation[],
  rootId: string,
): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const loc of locations) {
    if (!loc.parent_id) continue;
    const siblings = childrenOf.get(loc.parent_id);
    if (siblings) siblings.push(loc.id);
    else childrenOf.set(loc.parent_id, [loc.id]);
  }

  const out = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const next = queue.pop() as string;
    for (const child of childrenOf.get(next) ?? []) {
      // Guarded against a cycle the schema should prevent but this walk must survive: a parent
      // chain that loops would otherwise spin here forever and hang the page.
      if (out.has(child)) continue;
      out.add(child);
      queue.push(child);
    }
  }
  return out;
}
