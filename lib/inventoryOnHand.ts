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

/** One line per PART, which is what the stock list shows. */
export interface OnHandPartRow {
  partId: string;
  partName: string;
  primaryUnit: string | null;
  /** Summed across every place. Safe: balances are all in the part's own primary unit. */
  quantity: number;
  /**
   * How many distinct PLACES hold it — not how many balance rows it has.
   *
   * Two heats on one shelf is two balances and one place. Counting rows would put "2" in a column
   * headed Places while the side rail said "across 1 location", and the rail would be right.
   */
  placeCount: number;
  costPerUnit: number | null;
  costBelowMin: boolean;
  /** Summed value, or null when the part has no cost on file. */
  onHandCost: number | null;
  gap: 'no_cost_tier' | 'made' | null;
  /** The most recent movement across all of its places. */
  lastMovedAt: string | null;
  /** Every place path and heat this part sits under, lowercased — what the one search box matches. */
  searchText: string;
}

/**
 * Roll the balance rows into one line per part.
 *
 * **The list is one line per part; the side rail is where a part comes apart.** A bar on three
 * shelves under two heats is one thing a shop owns, and three rows of it made a stock list read as
 * three unrelated holdings — which is also why the Place column went: a column that can only show
 * one of three places has to either pick one or repeat the part.
 *
 * `costPerUnit` is the same on every balance of a part by construction — the view picks the tier at
 * the part's TOTAL on-hand, not per balance — so taking the first is not a choice between rivals.
 *
 * `searchText` carries every place path and heat, so typing a rack or a heat still finds the part
 * even though neither is a column any more.
 */
export function rollUpByPart(
  rows: OnHandRow[],
  pathOf: (locationId: string) => string,
): OnHandPartRow[] {
  const byPart = new Map<string, OnHandPartRow>();
  const placesSeen = new Map<string, Set<string>>();

  for (const row of rows) {
    const existing = byPart.get(row.partId);
    const place = pathOf(row.locationId);
    const bits = [place, row.heatNumber ?? '', row.lotCode ?? ''].filter(Boolean).join(' ');

    const places = placesSeen.get(row.partId) ?? new Set<string>();
    places.add(row.locationId);
    placesSeen.set(row.partId, places);

    if (!existing) {
      byPart.set(row.partId, {
        partId: row.partId,
        partName: row.partName,
        primaryUnit: row.primaryUnit,
        quantity: row.quantity,
        placeCount: places.size,
        costPerUnit: row.costPerUnit,
        costBelowMin: row.costBelowMin,
        onHandCost: row.onHandCost,
        gap: row.gap,
        lastMovedAt: row.lastMovedAt,
        searchText: `${row.partName} ${bits}`.toLowerCase(),
      });
      continue;
    }

    existing.quantity += row.quantity;
    existing.placeCount = places.size;
    existing.searchText += ` ${bits.toLowerCase()}`;
    // NULL stays NULL: a part with no cost has no value, and adding zero for it would state a
    // total that quietly excluded part of the holding.
    if (row.onHandCost !== null) {
      existing.onHandCost = (existing.onHandCost ?? 0) + row.onHandCost;
    }
    if (row.lastMovedAt && (!existing.lastMovedAt || row.lastMovedAt > existing.lastMovedAt)) {
      existing.lastMovedAt = row.lastMovedAt;
    }
  }

  for (const part of byPart.values()) {
    if (part.onHandCost !== null) part.onHandCost = Math.round(part.onHandCost * 100) / 100;
  }
  return [...byPart.values()];
}

/** The footer, over the part rows the table is showing. */
export function summariseParts(parts: OnHandPartRow[]): OnHandSummary {
  let total = 0;
  let anyCosted = false;
  let noTier = 0;
  let made = 0;
  let belowMin = 0;

  for (const part of parts) {
    if (part.gap === 'no_cost_tier') noTier += 1;
    if (part.gap === 'made') made += 1;
    if (part.costBelowMin) belowMin += 1;
    if (part.onHandCost !== null) {
      total += part.onHandCost;
      anyCosted = true;
    }
  }

  return {
    partCount: parts.length,
    balanceCount: parts.reduce((n, p) => n + p.placeCount, 0),
    costedTotal: anyCosted ? Math.round(total * 100) / 100 : null,
    noCostTierParts: noTier,
    madeParts: made,
    belowMinParts: belowMin,
  };
}
