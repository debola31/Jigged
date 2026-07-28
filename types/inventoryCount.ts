/**
 * Inventory count sheet — domain types (journey J9 in docs/modules/inventory.md).
 *
 * A count is deliberately NOT a server-side session: the sheet is client state autosaved to
 * localStorage, and each committed line writes through the existing adjust functions. There
 * is no count table. The audit record is the `adjustment` rows in `inventory_transactions`,
 * which already carry timestamp, actor and notes — so "when did we last count this" is
 * answerable without one.
 */

/**
 * Where a counted quantity is written for a given part.
 *
 * An item-level count is ambiguous for a part split across bins — if it holds 10+20+10 and
 * you count 38, no bin defensibly absorbs the -2 — so those are excluded rather than guessed
 * at. See COUNT_TARGET rules in lib/inventoryCountPlan.ts.
 */
export type CountTarget =
  /** Untracked part: write parts.quantity directly via adjustPartStock. */
  | { kind: 'aggregate' }
  /** Location-tracked with an unambiguous destination: adjustStockAtLocation. */
  | { kind: 'location'; locationId: string; locationName: string }
  /** Location-tracked and split across bins — not countable item-by-item. */
  | { kind: 'excluded'; reason: string };

/** A part as it appears on the count sheet, with its system quantity and resolved target. */
export interface CountCandidate {
  partId: string;
  partName: string;
  /** Primary unit; counts are entered in it. Null units can't be counted (nor stocked). */
  unit: string;
  /** What the system believes right now — refreshed on entering Review. */
  systemQuantity: number;
  target: CountTarget;
}

/** One line of the sheet. `counted` is null until someone types a number. */
export interface CountLine {
  partId: string;
  /** null = not counted. Never coerced to 0: no entry means no opinion, so the balance
   *  is left alone rather than zeroed by an abandoned sheet. */
  counted: number | null;
}

/** The persisted draft. Versioned so a shape change can be discarded rather than crash. */
export interface CountDraft {
  version: 1;
  companyId: string;
  /** Sheet order, and the set of parts in scope. */
  partIds: string[];
  lines: CountLine[];
  /** ms epoch — shown as "saved 2 minutes ago" and used to warn on a stale resume. */
  savedAt: number;
}

/** A counted line paired with what it will do, computed fresh at Review. */
export interface CountVariance {
  candidate: CountCandidate;
  counted: number;
  /** counted - systemQuantity. Signed here; the ledger stores abs() with direction in notes. */
  delta: number;
  /** True when the system quantity moved since the sheet was opened. */
  movedSinceOpened: boolean;
  /** |delta| as a share of the system quantity, for the big-variance prompt. */
  magnitude: number;
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
