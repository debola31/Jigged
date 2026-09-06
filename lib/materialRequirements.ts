/**
 * Job material requirements — the pure core (journeys J4 and J7 in docs/modules/inventory.md).
 *
 * No I/O, no React. `utils/materialCheckAccess.ts` is the thin driver that feeds this, exactly
 * as `inventoryCountAccess` feeds `inventoryCountPlan`. The arithmetic lives here so it is
 * unit-testable without a database.
 */
import { getConversionFactor, resolveUnitAlias } from '@/lib/unitPresets';
import type {
  MaterialRequirement,
  MaterialStockFacts,
  UnitBasis,
} from '@/types/materialCheck';

/**
 * What a whole job draws of one BOM line.
 *
 * The draw is exact. It used to round up when the BOM line was flagged as discrete stock, so
 * the floor was told "1 strip" for a job that consumed 0.6 of one — and the same flag was
 * ceilinging the COST, where it silently charged a whole $70 bar for the fifth of it a part
 * actually used. The flag is gone; the quantity says what it says. A job needing 0.6 of a bar
 * now reads as 0.6, and whoever fetches it still carries one bar to the machine.
 *
 * This is the ONE home for this rule. It previously existed twice, in JobPartMaterialsCard and
 * jobTravelerPdf, which is how a screen and its own printout come to disagree.
 */
export function requiredQuantity(orderQuantity: number, bomQuantity: number): number {
  if (!orderQuantity || orderQuantity <= 0) return 0;
  return orderQuantity * bomQuantity;
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
  orderQuantity: number;
  stock: MaterialStockFacts;
  customFactor: number | null;
  issued: number;
  hasDiscrepancy: boolean;
}): MaterialRequirement {
  const {
    bomLineId, bomQuantity, bomUnit, orderQuantity,
    stock, customFactor, issued, hasDiscrepancy,
  } = args;

  const requiredInBomUnit = requiredQuantity(orderQuantity, bomQuantity);
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
  else status = (shortBy ?? 0) > 0 ? 'short' : 'ok';

  return {
    bomLineId,
    partId: stock.partId,
    partName: stock.partName,
    bomUnit: (bomUnit || '').trim() || (stock.primaryUnit ?? ''),
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
  };
}
