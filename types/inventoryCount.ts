/**
 * Inventory count sheet — domain types (journey J9 in docs/modules/inventory.md).
 *
 * A count is deliberately NOT a server-side session. There is no count table: entries are client
 * state, and each committed line writes through `adjustStockAtLocation`. The audit record is the
 * `adjustment` rows in `inventory_transactions`, which already carry timestamp, actor and notes.
 * (Entries are not persisted anywhere either — the draft/resume layer was removed 2026-08-01;
 * navigating away discards the sheet, which is what leaving a stocktake means.)
 *
 * Two steps: choose the parts, then count them. The choosing step is what makes a count a
 * bounded, finishable task — "I'm counting these five things" rather than a form with a row
 * per stocked part. There is no third review step; the variance shows on each row as it's
 * typed, and a confirm dialog summarises before anything is written.
 */

/**
 * The place a counted quantity is written to.
 *
 * **A count row IS (part, place).** There is no other shape, on any of the four sheets.
 *
 * Two arms used to live here and both are gone. `aggregate` — write `parts.quantity` directly —
 * went with `is_location_tracked` in 20260802015837, when every part gained a place. `excluded`
 * went with this change: a part split across bins had no defensible home for a single total
 * (counted 38 against 10+20+10 — which bin absorbs the −2?), so it was held off the sheet and
 * named in a notice. The sheet no longer asks for a single total. It asks for a number per place,
 * so that ambiguity is not resolved — it is never posed.
 */
export interface CountTarget {
  locationId: string;
  locationName: string;
  /**
   * Full display path, root first: "Cabinet 3 › Shelf A".
   *
   * THE label for this row, and not a nicety: a company may have two bins both called "Shelf A",
   * and on a sheet that holds one part several times the place is the only thing telling the rows
   * apart. Equal to `locationName` on a place-scoped sheet, where every row shares one place and
   * the page title already names it.
   */
  locationPath: string;
}

/** One row on the sheet: a part, at one place. */
export interface CountCandidate {
  partId: string;
  partName: string;
  /**
   * Part description — a recognition aid, because part numbers alone aren't recognisable at a
   * shelf. **Never a substitute for the place.** Both render; the place is never something a
   * description can outrank.
   */
  description: string | null;
  /** Primary unit; counts are entered in it. */
  unit: string;
  /**
   * The balance AT `target.locationId` — never the `parts.quantity` roll-up across every place.
   * Re-read at save so variances aren't measured against a stale snapshot.
   */
  systemQuantity: number;
  target: CountTarget;
}

/**
 * What's been typed so far: **row key** → counted quantity — see `countRowKey`. Not the part id:
 * one sheet can hold the same part at several places.
 *
 * A missing key means "not counted" — never coerced to 0, so a part you walked past keeps its
 * balance rather than being zeroed by an abandoned sheet.
 */
export type CountEntries = Record<string, number>;

/** A counted part paired with what it will do, computed fresh at save. */
export interface CountVariance {
  candidate: CountCandidate;
  counted: number;
  /** counted - systemQuantity. Signed here; the ledger stores abs() with direction in notes. */
  delta: number;
  /** True when the system quantity moved since the sheet was opened. Reported after the save,
   *  not asked about before it — the count is what's on the shelf either way. */
  movedSinceOpened: boolean;
}

export interface CountCommitProgress {
  done: number;
  total: number;
  currentPartName: string;
  /** Which LINE, not just which part — one part can occupy three of them. */
  currentLocationName: string;
}

export interface CountCommitResult {
  committed: number;
  /**
   * `locationName` is load-bearing, not decoration: "BUY-ORING-214 could not be saved" does not
   * tell someone which of three numbers to re-enter.
   */
  failures: { partName: string; locationName: string; message: string }[];
}
