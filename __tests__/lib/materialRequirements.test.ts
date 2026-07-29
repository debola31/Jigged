/**
 * The pure core behind J4 and J7.
 *
 * The two tests that matter most, because both encode a bug that would otherwise ship
 * looking correct:
 *   - `rollUpShortages` counting on-hand ONCE across jobs, not once per job.
 *   - `resolveUnitBasis` refusing to compare units it can't convert, rather than returning
 *     the unconverted number the way `convertToBaseUnit` does.
 */
import { describe, it, expect } from 'vitest';
import {
  buildRequirement,
  requiredQuantity,
  resolveUnitBasis,
  rollUpShortages,
  shortageWindowEnd,
} from '@/lib/materialRequirements';
import type {
  MaterialRequirement,
  MaterialStockFacts,
  ShortageContribution,
} from '@/types/materialCheck';

const stock = (over: Partial<MaterialStockFacts> & { partId: string }): MaterialStockFacts => ({
  partName: over.partId.toUpperCase(),
  primaryUnit: 'each',
  onHand: 0,
  isStocked: true,
  isLocationTracked: false,
  isArchived: false,
  ...over,
});

const req = (over: Partial<Parameters<typeof buildRequirement>[0]> = {}) =>
  buildRequirement({
    bomLineId: 'b1',
    bomQuantity: 2,
    bomUnit: 'each',
    consumeWholeUnits: false,
    orderQuantity: 5,
    stock: stock({ partId: 'p1', onHand: 100 }),
    customFactor: null,
    issued: 0,
    hasDiscrepancy: false,
    ...over,
  });

describe('requiredQuantity', () => {
  it('multiplies the BOM quantity by the order quantity', () => {
    expect(requiredQuantity(10, 0.05, false)).toBeCloseTo(0.5);
  });

  // "0.05 strips" means nothing to someone pulling material off a shelf.
  it('rounds up for discrete stock you cannot cut a fraction of', () => {
    expect(requiredQuantity(10, 0.05, true)).toBe(1);
    expect(requiredQuantity(3, 1.2, true)).toBe(4);
  });

  it('returns 0 for a missing or non-positive order quantity', () => {
    expect(requiredQuantity(0, 4, false)).toBe(0);
    expect(requiredQuantity(-1, 4, true)).toBe(0);
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

  it('labels a never-stocked material rather than calling it short', () => {
    const r = req({ bomQuantity: 5, orderQuantity: 1, stock: stock({ partId: 'p1', onHand: 0, isStocked: false }) });
    expect(r.status).toBe('not_stocked');
  });

  it('labels an archived material rather than dropping the row', () => {
    const r = req({ stock: stock({ partId: 'p1', onHand: 0, isArchived: true }) });
    expect(r.status).toBe('archived');
  });
});

describe('rollUpShortages', () => {
  const contribution = (over: Partial<ShortageContribution> & { jobId: string }): ShortageContribution => ({
    jobNumber: over.jobId.toUpperCase(),
    jobPartId: `${over.jobId}-jp`,
    madePartName: 'Widget',
    dueDate: null,
    isHot: false,
    required: null,
    ...over,
  });

  const line = (jobId: string, requirement: MaterialRequirement, over: Partial<ShortageContribution> = {}) => ({
    contribution: contribution({ jobId, ...over }),
    requirement,
  });

  /**
   * THE test. Two jobs each need 10 of a part with 15 on hand. Individually neither is
   * short. Aggregated, the shop is 5 short. A roll-up that compares each job to the full
   * on-hand — or sums per-job shortfalls — reports "fine" and the shop runs out mid-week.
   */
  it('counts on-hand once across jobs instead of once per job', () => {
    const r = () => req({ bomQuantity: 10, orderQuantity: 1, stock: stock({ partId: 'steel', onHand: 15 }) });
    const [row] = rollUpShortages([line('j1', r()), line('j2', r())]);

    expect(row.partId).toBe('steel');
    expect(row.totalRequired).toBe(20);
    expect(row.onHand).toBe(15);
    expect(row.shortBy).toBe(5);
    expect(row.status).toBe('short');
    expect(row.contributions).toHaveLength(2);
  });

  it('nets off stock already issued, which has left the shelf on-hand reflects', () => {
    const r = req({ bomQuantity: 20, orderQuantity: 1, issued: 8, stock: stock({ partId: 'steel', onHand: 10 }) });
    const [row] = rollUpShortages([line('j1', r)]);
    expect(row.totalIssued).toBe(8);
    expect(row.shortBy).toBe(2); // (20 − 8) − 10
  });

  // A job with two job_parts drawing the same material carries the identical job-level
  // issued figure on both rows. Adding both would halve the apparent shortage.
  it('does not double-count issued when one job draws a material twice', () => {
    const r = () => req({ bomQuantity: 5, orderQuantity: 1, issued: 6, stock: stock({ partId: 'steel', onHand: 0 }) });
    const [row] = rollUpShortages([
      line('j1', r(), { jobPartId: 'jp-a' }),
      line('j1', r(), { jobPartId: 'jp-b' }),
    ]);
    expect(row.totalIssued).toBe(6);
  });

  it('quarantines an incomparable contribution without poisoning the comparable total', () => {
    const good = req({ bomQuantity: 4, orderQuantity: 1, stock: stock({ partId: 'steel', onHand: 1 }) });
    const bad = req({
      bomQuantity: 4, bomUnit: 'feet', orderQuantity: 1,
      stock: stock({ partId: 'steel', primaryUnit: 'pounds', onHand: 1 }),
    });
    const [row] = rollUpShortages([line('j1', good), line('j2', bad)]);

    expect(row.totalRequired).toBe(4);
    expect(row.shortBy).toBe(3);
    expect(row.incomparableJobCount).toBe(1);
    expect(row.status).toBe('short');
  });

  it('marks the part incomparable only when no contribution can be compared', () => {
    const bad = req({
      bomUnit: 'feet',
      stock: stock({ partId: 'steel', primaryUnit: 'pounds', onHand: 1 }),
    });
    const [row] = rollUpShortages([line('j1', bad)]);
    expect(row.status).toBe('incomparable');
    expect(row.totalRequired).toBeNull();
    expect(row.shortBy).toBeNull();
  });

  it('leaves never-stocked and archived materials off a purchasing list', () => {
    expect(rollUpShortages([
      line('j1', req({ stock: stock({ partId: 'a', isStocked: false }) })),
      line('j2', req({ stock: stock({ partId: 'b', isArchived: true }) })),
    ])).toEqual([]);
  });

  it('sorts shortages worst first, and contributions by due date with undated last', () => {
    const mk = (partId: string, need: number, onHand: number) =>
      req({ bomQuantity: need, orderQuantity: 1, stock: stock({ partId, onHand }) });
    const rows = rollUpShortages([
      line('j1', mk('mild', 12, 10), { dueDate: '2026-08-05' }),
      line('j2', mk('bad', 50, 0), { dueDate: null }),
      line('j3', mk('bad', 0, 0), { dueDate: '2026-08-01' }),
      line('j4', mk('fine', 1, 99), { dueDate: '2026-08-02' }),
    ]);
    expect(rows.map((r) => r.partId)).toEqual(['bad', 'mild', 'fine']);
    expect(rows[0].contributions.map((c) => c.jobId)).toEqual(['j3', 'j2']);
  });
});

describe('shortageWindowEnd', () => {
  // A rolling today+7 gives a different answer on Friday than on Monday for an unchanged set
  // of jobs, which is how people stop trusting the number. Week-ending is stable.
  it('ends "this week" on the coming Sunday, not seven days out', () => {
    expect(shortageWindowEnd('week', new Date(2026, 6, 28))).toBe('2026-08-02'); // Tue → Sun
    expect(shortageWindowEnd('week', new Date(2026, 6, 31))).toBe('2026-08-02'); // Fri → same Sun
  });

  it('keeps a Sunday on its own day rather than pushing a week out', () => {
    expect(shortageWindowEnd('week', new Date(2026, 7, 2))).toBe('2026-08-02');
  });

  it('gives 30 days for the month window and no bound for all', () => {
    expect(shortageWindowEnd('month', new Date(2026, 6, 28))).toBe('2026-08-27');
    expect(shortageWindowEnd('all', new Date(2026, 6, 28))).toBeNull();
  });
});
