/**
 * Job material requirements — the pure core (journeys J4 and J7 in docs/modules/inventory.md).
 *
 * No I/O, no React. `utils/materialCheckAccess.ts` is the thin driver that feeds this, exactly
 * as `inventoryCountAccess` feeds `inventoryCountPlan`. Two surfaces read the output — the job
 * page card and the shop-wide shortage view — so the arithmetic lives here once and is
 * unit-tested here once.
 */
import { getConversionFactor, resolveUnitAlias } from '@/lib/unitPresets';
import type {
  MaterialRequirement,
  MaterialStockFacts,
  PartShortage,
  ShortageContribution,
  ShortageWindow,
  UnitBasis,
} from '@/types/materialCheck';

/**
 * What a whole job draws of one BOM line.
 *
 * `consume_whole_units` marks discrete stock — a strip or a blank you can't cut a fraction
 * of — so the draw rounds up. Without it the shop floor is told it needs "0.05 strips".
 *
 * This is the ONE home for this rule. It previously existed twice, in JobPartMaterialsCard and
 * jobTravelerPdf, which is how a screen and its own printout come to disagree.
 */
export function requiredQuantity(
  orderQuantity: number,
  bomQuantity: number,
  consumeWholeUnits: boolean,
): number {
  if (!orderQuantity || orderQuantity <= 0) return 0;
  const raw = orderQuantity * bomQuantity;
  return consumeWholeUnits ? Math.ceil(raw) : raw;
}

/**
 * How to get from a BOM line's unit to the unit stock is held in.
 *
 * Deliberately does NOT use `convertToBaseUnit`: that returns the *unconverted* quantity with
 * a console.warn when it can't convert, which on a shortage screen renders "you have plenty"
 * for 4 ft against 120 in. `getConversionFactor` returns `undefined` instead, so the caller
 * can say so out loud. See docs/modules/inventory.md J9 §"Incomparable units".
 *
 * Precedence: same unit → the part's own custom conversion → a preset same-category factor.
 * A custom row wins over a preset because the shop entered it deliberately for this part.
 */
export function resolveUnitBasis(
  bomUnit: string,
  primaryUnit: string | null,
  customFactor: number | null,
): UnitBasis {
  const bom = (bomUnit || '').trim();
  if (!primaryUnit) {
    return { kind: 'incomparable', bomUnit: bom, stockUnit: null };
  }
  // A blank BOM unit is a legacy row that meant "the part's own unit".
  if (!bom) return { kind: 'same', unit: primaryUnit };
  if (resolveUnitAlias(bom) === resolveUnitAlias(primaryUnit)) {
    return { kind: 'same', unit: primaryUnit };
  }
  if (customFactor !== null && Number.isFinite(customFactor) && customFactor > 0) {
    return { kind: 'converted', from: bom, to: primaryUnit, factor: customFactor };
  }
  const preset = getConversionFactor(bom, primaryUnit);
  if (preset !== undefined && Number.isFinite(preset) && preset > 0) {
    return { kind: 'converted', from: bom, to: primaryUnit, factor: preset };
  }
  return { kind: 'incomparable', bomUnit: bom, stockUnit: primaryUnit };
}

/** Apply a basis to a quantity. `null` when the units don't relate. */
function inStockUnit(basis: UnitBasis, quantityInBomUnit: number): number | null {
  if (basis.kind === 'same') return quantityInBomUnit;
  if (basis.kind === 'converted') return quantityInBomUnit * basis.factor;
  return null;
}

/** One material row, fully derived. */
export function buildRequirement(args: {
  bomLineId: string;
  bomQuantity: number;
  bomUnit: string;
  consumeWholeUnits: boolean;
  orderQuantity: number;
  stock: MaterialStockFacts;
  customFactor: number | null;
  issued: number;
  hasDiscrepancy: boolean;
}): MaterialRequirement {
  const {
    bomLineId, bomQuantity, bomUnit, consumeWholeUnits, orderQuantity,
    stock, customFactor, issued, hasDiscrepancy,
  } = args;

  const requiredInBomUnit = requiredQuantity(orderQuantity, bomQuantity, consumeWholeUnits);
  const basis = resolveUnitBasis(bomUnit, stock.primaryUnit, customFactor);
  const requiredInStockUnit = inStockUnit(basis, requiredInBomUnit);

  // Over-issued is a real state (an operator took extra); it must read as "nothing left to
  // fetch", never as a negative that then subtracts from the shortage.
  const remainingToIssue =
    requiredInStockUnit === null ? null : Math.max(0, requiredInStockUnit - issued);
  const shortBy = remainingToIssue === null ? null : Math.max(0, remainingToIssue - stock.onHand);

  let status: MaterialRequirement['status'];
  if (stock.isArchived) status = 'archived';
  else if (basis.kind === 'incomparable') status = 'incomparable';
  else if (!stock.isStocked) status = 'not_stocked';
  else status = (shortBy ?? 0) > 0 ? 'short' : 'ok';

  return {
    bomLineId,
    partId: stock.partId,
    partName: stock.partName,
    bomUnit: (bomUnit || '').trim() || (stock.primaryUnit ?? ''),
    consumeWholeUnits,
    requiredInBomUnit,
    requiredInStockUnit,
    stockUnit: stock.primaryUnit,
    onHand: stock.onHand,
    issued,
    hasDiscrepancy,
    remainingToIssue,
    shortBy,
    status,
    basis,
    isLocationTracked: stock.isLocationTracked,
  };
}

/**
 * Aggregate every open job's claim on each part.
 *
 * The bug this shape exists to prevent: summing per-job shortfalls. Two jobs each needing 10
 * against 15 on hand are each individually fine, so a per-job sum reports "not short" — when
 * the shop is 5 short. Requirements are summed across jobs and on-hand is counted **once**.
 */
export function rollUpShortages(
  lines: Array<{ contribution: ShortageContribution; requirement: MaterialRequirement }>,
): PartShortage[] {
  const byPart = new Map<string, PartShortage>();
  // `issued` is per (job, part) — a job with two job_parts drawing the same material carries
  // the identical job-level figure on both rows, so add it once per pair or it doubles.
  const issuedCounted = new Set<string>();

  for (const { contribution, requirement: r } of lines) {
    // Archived and never-stocked materials are shown on a job, but they are not a purchasing
    // signal — "short by 4" for something nobody stocks is noise on a shop-wide list.
    if (r.status === 'archived' || r.status === 'not_stocked') continue;

    let row = byPart.get(r.partId);
    if (!row) {
      row = {
        partId: r.partId,
        partName: r.partName,
        stockUnit: r.stockUnit,
        onHand: r.onHand, // counted once per part, NOT per contributing job
        totalRequired: 0,
        totalIssued: 0,
        shortBy: 0,
        status: 'ok',
        incomparableJobCount: 0,
        contributions: [],
      };
      byPart.set(r.partId, row);
    }

    const pair = `${contribution.jobId}:${r.partId}`;
    if (!issuedCounted.has(pair)) {
      issuedCounted.add(pair);
      row.totalIssued += r.issued;
    }

    if (r.requiredInStockUnit === null) {
      row.incomparableJobCount += 1;
      row.contributions.push({ ...contribution, required: null });
      continue;
    }
    row.totalRequired = (row.totalRequired ?? 0) + r.requiredInStockUnit;
    row.contributions.push({ ...contribution, required: r.requiredInStockUnit });
  }

  for (const row of byPart.values()) {
    const comparableCount = row.contributions.filter((c) => c.required !== null).length;
    if (comparableCount === 0) {
      row.totalRequired = null;
      row.shortBy = null;
      row.status = 'incomparable';
    } else {
      // Issued stock has already left the shelf, so on-hand reflects it — subtract it from
      // what's required rather than comparing the gross figure to a net balance.
      const stillToFetch = Math.max(0, (row.totalRequired ?? 0) - row.totalIssued);
      row.shortBy = Math.max(0, stillToFetch - row.onHand);
      row.status = row.shortBy > 0 ? 'short' : 'ok';
    }

    row.contributions.sort((a, b) => {
      if (a.dueDate === b.dueDate) return a.jobNumber.localeCompare(b.jobNumber);
      if (!a.dueDate) return 1; // undated last
      if (!b.dueDate) return -1;
      return a.dueDate < b.dueDate ? -1 : 1;
    });
  }

  // Worst first, then by how soon it's needed.
  return [...byPart.values()].sort((a, b) => {
    const rank = (s: PartShortage['status']) => (s === 'short' ? 0 : s === 'incomparable' ? 1 : 2);
    if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
    if ((b.shortBy ?? 0) !== (a.shortBy ?? 0)) return (b.shortBy ?? 0) - (a.shortBy ?? 0);
    return a.partName.localeCompare(b.partName);
  });
}

/**
 * End of the shortage window, as a YYYY-MM-DD string.
 *
 * "This week" is the end of the current week, NOT today + 7. With a rolling seven days the
 * same unchanged set of jobs gives a different answer on Friday than on Monday, which is how
 * people stop trusting a number. Sunday-ending, matching the ISO week.
 *
 * `null` means no upper bound. Note the window only ever *adds* jobs: overdue, hot and undated
 * open jobs are in scope regardless — a "this week" view that hides last week's late job is
 * worse than no view.
 */
export function shortageWindowEnd(window: ShortageWindow, today: Date): string | null {
  if (window === 'all') return null;
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (window === 'month') {
    d.setDate(d.getDate() + 30);
  } else {
    // 0 = Sunday. Distance to the coming Sunday, 0 if today already is one.
    d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
