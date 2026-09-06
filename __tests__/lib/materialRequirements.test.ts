/**
 * The pure core behind J4.
 *
 * The one that matters most is `resolveUnitBasis` refusing to compare units it can't convert,
 * rather than returning the unconverted number the way `convertToBaseUnit` does — that's the
 * difference between "we can't tell" and a confident wrong answer.
 */
import { describe, it, expect } from 'vitest';
import {
  buildRequirement,
  requiredQuantity,
  resolveUnitBasis,
} from '@/lib/materialRequirements';
import type { MaterialStockFacts } from '@/types/materialCheck';

const stock = (over: Partial<MaterialStockFacts> & { partId: string }): MaterialStockFacts => ({
  partName: over.partId.toUpperCase(),
  primaryUnit: 'each',
  onHand: 0,
  isLocationTracked: false,
  isArchived: false,
  ...over,
});

const req = (over: Partial<Parameters<typeof buildRequirement>[0]> = {}) =>
  buildRequirement({
    bomLineId: 'b1',
    bomQuantity: 2,
    bomUnit: 'each',
    orderQuantity: 5,
    stock: stock({ partId: 'p1', onHand: 100 }),
    customFactor: null,
    issued: 0,
    hasDiscrepancy: false,
    ...over,
  });

describe('requiredQuantity', () => {
  it('multiplies the BOM quantity by the order quantity', () => {
    expect(requiredQuantity(10, 0.05)).toBeCloseTo(0.5);
  });

  // This used to round up when the line was flagged as discrete stock. The same
  // flag was ceilinging the COST, where it charged a whole $70 bar for the fifth
  // of one a part actually used, so it is gone from both. A job needing 0.6 of a
  // bar now says 0.6, and whoever fetches it still carries one bar to the machine.
  it('never rounds up — the draw is exactly what the BOM says', () => {
    expect(requiredQuantity(10, 0.05)).toBeCloseTo(0.5);
    expect(requiredQuantity(3, 1.2)).toBeCloseTo(3.6);
    expect(requiredQuantity(1, 0.2)).toBeCloseTo(0.2);
  });

  it('returns 0 for a missing or non-positive order quantity', () => {
    expect(requiredQuantity(0, 4)).toBe(0);
    expect(requiredQuantity(-1, 4)).toBe(0);
  });
});

describe('resolveUnitBasis', () => {
  it('treats an identical unit as the same', () => {
    expect(resolveUnitBasis('each', 'each', null)).toEqual({ kind: 'same', unit: 'each' });
  });

  it('resolves aliases before comparing, so ea and each are not "converted"', () => {
    expect(resolveUnitBasis('ea', 'each', null).kind).toBe('same');
  });

  // Legacy rows left the unit blank meaning "the part's own unit".
  it('treats a blank BOM unit as the primary unit', () => {
    expect(resolveUnitBasis('', 'inches', null)).toEqual({ kind: 'same', unit: 'inches' });
  });

  it('uses a preset factor for two units in the same category', () => {
    const basis = resolveUnitBasis('feet', 'inches', null);
    expect(basis.kind).toBe('converted');
    if (basis.kind === 'converted') expect(basis.factor).toBeCloseTo(12);
  });

  // The shop entered the custom row deliberately for this part; it outranks the generic table.
  it('prefers a custom conversion over the preset', () => {
    const basis = resolveUnitBasis('feet', 'inches', 11);
    expect(basis.kind).toBe('converted');
    if (basis.kind === 'converted') expect(basis.factor).toBe(11);
  });

  it('refuses to compare across categories rather than guessing', () => {
    expect(resolveUnitBasis('feet', 'pounds', null).kind).toBe('incomparable');
  });

  it('refuses when the part has no primary unit at all', () => {
    expect(resolveUnitBasis('feet', null, null).kind).toBe('incomparable');
  });

  it('ignores a nonsense custom factor instead of multiplying by it', () => {
    expect(resolveUnitBasis('feet', 'pounds', 0).kind).toBe('incomparable');
    expect(resolveUnitBasis('feet', 'pounds', Number.NaN).kind).toBe('incomparable');
  });
});

describe('buildRequirement', () => {
  it('reports a shortage when the job needs more than is on hand', () => {
    const r = req({ bomQuantity: 30, orderQuantity: 1, stock: stock({ partId: 'p1', onHand: 10 }) });
    expect(r.requiredInStockUnit).toBe(30);
    expect(r.shortBy).toBe(20);
    expect(r.status).toBe('short');
  });

  it('is not short when the on-hand exactly covers it', () => {
    const r = req({ bomQuantity: 10, orderQuantity: 1, stock: stock({ partId: 'p1', onHand: 10 }) });
    expect(r.shortBy).toBe(0);
    expect(r.status).toBe('ok');
  });

  it('converts the requirement into the stock unit before comparing', () => {
    const r = req({
      bomQuantity: 2, bomUnit: 'feet', orderQuantity: 1,
      stock: stock({ partId: 'p1', primaryUnit: 'inches', onHand: 30 }),
    });
    expect(r.requiredInBomUnit).toBe(2);
    expect(r.requiredInStockUnit).toBeCloseTo(24);
    expect(r.shortBy).toBe(0);
  });

  // The whole point of the incomparable state: shortBy must be null, never 0. A 0 reads as
  // "you're fine", which is the exact wrong answer when we don't actually know.
  it('returns a null shortage — never zero — when the units cannot be compared', () => {
    const r = req({
      bomUnit: 'feet',
      stock: stock({ partId: 'p1', primaryUnit: 'pounds', onHand: 0 }),
    });
    expect(r.requiredInStockUnit).toBeNull();
    expect(r.shortBy).toBeNull();
    expect(r.remainingToIssue).toBeNull();
    expect(r.status).toBe('incomparable');
  });

  it('subtracts what has already been issued from what is left to fetch', () => {
    const r = req({ bomQuantity: 10, orderQuantity: 1, issued: 4, stock: stock({ partId: 'p1', onHand: 10 }) });
    expect(r.remainingToIssue).toBe(6);
    expect(r.shortBy).toBe(0);
  });

  // An operator can take more than the BOM says. That must read as "nothing left to fetch",
  // not as a negative that then cancels out a real shortage elsewhere.
  it('never goes negative when more was issued than required', () => {
    const r = req({ bomQuantity: 10, orderQuantity: 1, issued: 25, stock: stock({ partId: 'p1', onHand: 0 }) });
    expect(r.remainingToIssue).toBe(0);
    expect(r.shortBy).toBe(0);
  });

  /**
   * Replaces "labels a never-stocked material rather than calling it short". `is_stocked` is
   * gone — every part is stockable — so a child sitting at 0 against a real requirement IS short,
   * and `not_stocked` is no longer a status the engine can produce.
   */
  it('calls a material at zero short rather than exempting it', () => {
    const r = req({ bomQuantity: 5, orderQuantity: 1, stock: stock({ partId: 'p1', onHand: 0 }) });
    expect(r.status).toBe('short');
    expect(r.shortBy).toBe(5);
  });

  it('labels an archived material rather than dropping the row', () => {
    const r = req({ stock: stock({ partId: 'p1', onHand: 0, isArchived: true }) });
    expect(r.status).toBe('archived');
  });
});
