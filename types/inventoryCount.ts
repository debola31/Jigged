/**
 * Inventory count sheet — domain types (journey J9 in docs/modules/inventory.md).
 *
 * A count is deliberately NOT a server-side session: entries are client state autosaved to
 * localStorage, and each committed line writes through the existing adjust functions. There
 * is no count table. The audit record is the `adjustment` rows in `inventory_transactions`,
 * which already carry timestamp, actor and notes.
 *
 * Two steps: choose the parts, then count them. The choosing step is what makes a count a
 * bounded, finishable task — "I'm counting these five things" rather than a form with a row
 * per stocked part. There is no third review step; the variance shows on each row as it's
 * typed, and a confirm dialog summarises before anything is written.
 */

/**
 * Where a counted quantity is written for a given part.
 *
 * An item-level count is ambiguous for a part split across bins — if it holds 10+20+10 and
 * you count 38, no bin defensibly absorbs the -2 — so those are excluded rather than guessed
 * at. See `resolveCountTarget` in lib/inventoryCountPlan.ts.
 */
export type CountTarget =
  /** Untracked part: write parts.quantity directly via adjustPartStock. */
  | { kind: 'aggregate' }
  /** Location-tracked with an unambiguous destination: adjustStockAtLocation. */
  | { kind: 'location'; locationId: string; locationName: string }
  /**
   * Location-tracked and split across bins — not countable item-by-item *here*.
   *
   * `locations` carries the places actually holding stock, so the sheet can link to each
   * one's place-scoped worksheet instead of dead-ending. Excluding a part is only
   * defensible if we also say where to go: at one bin there is no ambiguity, so these are
   * countable — just not from a company-wide total. Empty when the exclusion has some
   * other cause (e.g. no Unassigned location exists).
   */
  | { kind: 'excluded'; reason: string; locations: { id: string; name: string }[] };

/** A part as it appears on the sheet, with its system quantity and resolved target. */
export interface CountCandidate {
  partId: string;
  partName: string;
  /** Sub-line on the sheet — part numbers alone aren't recognisable at a shelf. */
  description: string | null;
  /** Primary unit; counts are entered in it. */
  unit: string;
  /** What the system believes. Re-read at save so variances aren't against a stale snapshot. */
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
}

export interface CountCommitResult {
  committed: number;
  failures: { partName: string; message: string }[];
}
