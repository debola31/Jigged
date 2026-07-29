/**
 * Job material check — domain types (journey J4 in docs/modules/inventory.md).
 *
 * One computation, two consumers: the job page card and the shop-wide shortage view.
 * Everything here is derived — there is no material table and no migration. Required comes
 * from the live BOM × the job-part order quantity; issued is the sum of `depletion` ledger
 * rows carrying the job (written at the bin, per J7); short-by is arithmetic on read.
 *
 * **Top-level materials only.** `parts_bom` is recursive, but this compares one level: a job
 * for a pump reads "you need 1 pump core", not the aluminium the core is made from. Both
 * surfaces say so on screen; the recursive explode is the follow-up.
 */

/**
 * How a BOM line's unit relates to the stock unit it must be compared against.
 *
 * `parts_bom.unit` is free text per line, while `parts.quantity` is always in the part's
 * `primary_unit`. When there is no route between them the honest answer is `incomparable` —
 * NOT a silently unconverted number, which is what `convertToBaseUnit` would hand back.
 * Comparing 4 ft against 120 in and rendering "you have plenty" is the exact failure J4
 * exists to prevent.
 */
export type UnitBasis =
  /** BOM line is already in the part's primary unit. */
  | { kind: 'same'; unit: string }
  /** A custom `parts_unit_conversions` row or a preset same-category conversion applies. */
  | { kind: 'converted'; from: string; to: string; factor: number }
  /** No conversion exists. The comparison is refused rather than guessed. */
  | { kind: 'incomparable'; bomUnit: string; stockUnit: string | null };

/**
 * Why a material row reads the way it does.
 *
 * `not_stocked` and `archived` exist so those rows are *shown and labelled* rather than
 * dropped — a BOM line vanishing from a material list is worse than one flagged as odd.
 * Both are excluded from shortage totals.
 */
export type RequirementStatus = 'ok' | 'short' | 'incomparable' | 'not_stocked' | 'archived';

/** Stock facts about a BOM child, which `getBomForPart` deliberately does not return. */
export interface MaterialStockFacts {
  partId: string;
  partName: string;
  primaryUnit: string | null;
  /** `parts.quantity` — authoritative for BOTH engines (a trigger rolls up bin balances). */
  onHand: number;
  isStocked: boolean;
  isLocationTracked: boolean;
  isArchived: boolean;
}

/** A bin holding some of a part, with its display path. */
export interface MaterialLocation {
  locationId: string;
  locationName: string;
  /** Ancestor names, root first — rendered as "Cabinet 3 › Shelf A". */
  path: string[];
  quantity: number;
}

/** One material line for one job part: what it needs, what's there, what's already gone. */
export interface MaterialRequirement {
  bomLineId: string;
  partId: string;
  partName: string;
  /** The unit written on the BOM line, which may not be the stock unit. */
  bomUnit: string;
  consumeWholeUnits: boolean;
  /** Job draw in the BOM line's own unit, ceil applied when `consumeWholeUnits`. */
  requiredInBomUnit: number;
  /** The same draw in the part's primary unit. `null` ⟺ the units are incomparable. */
  requiredInStockUnit: number | null;
  stockUnit: string | null;
  onHand: number;
  /**
   * Σ `converted_quantity` of this job's depletions for this part.
   *
   * Job-level, not job-part-level — `inventory_transactions` has no `job_part_id`, so a
   * multi-part job sharing a material attributes the same total to each part. Labelled as
   * "issued to this job" for that reason; never as "issued to this part".
   */
  issued: number;
  /** Any of those depletions was clamped to zero (took more than was recorded). */
  hasDiscrepancy: boolean;
  /** `max(0, required − issued)` — what's still to fetch. `null` when incomparable. */
  remainingToIssue: number | null;
  /** `max(0, remaining − onHand)`. `null` when incomparable — never 0, which reads as fine. */
  shortBy: number | null;
  status: RequirementStatus;
  basis: UnitBasis;
  isLocationTracked: boolean;
}

/** One job's claim on a part, for the shop-wide view. */
export interface ShortageContribution {
  jobId: string;
  jobNumber: string;
  jobPartId: string;
  madePartName: string | null;
  dueDate: string | null;
  isHot: boolean;
  /** `null` when this job's line is incomparable, so it can't join the total. */
  required: number | null;
}

/** A part aggregated across every open job that needs it. */
export interface PartShortage {
  partId: string;
  partName: string;
  stockUnit: string | null;
  /** Counted ONCE, however many jobs want it — the whole point of aggregating. */
  onHand: number;
  totalRequired: number | null;
  totalIssued: number;
  shortBy: number | null;
  status: 'ok' | 'short' | 'incomparable';
  /** How many contributing jobs couldn't be compared, surfaced rather than swallowed. */
  incomparableJobCount: number;
  /** Due date ascending, undated last. */
  contributions: ShortageContribution[];
}

/**
 * Which open jobs the shop-wide view counts.
 *
 * Overdue, hot and undated jobs are in scope in EVERY window — see `shortageWindowEnd`.
 */
export type ShortageWindow = 'week' | 'month' | 'all';
