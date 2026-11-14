/**
 * The access layer's unit reading (plan §3.5 "Units", criterion L1).
 *
 * `unitNameKey` and the unit resolver each live ONCE, in lib/purchasing/purchaseUnits.ts. The access
 * layer used to keep its own copy of the key and respell a unit before resolving it — from before
 * `resolvePurchaseUnit` compared names the way the database does — so the PO form and the access
 * layer were two readings of one unit that could drift. These pin that they are one.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ getSupabase: () => ({}) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { resolvePartUnit, unitNameKey } from '@/utils/purchasingShared';
import * as purchaseUnits from '@/lib/purchasing/purchaseUnits';
import type { UnitConversionRow } from '@/lib/purchasing/purchaseUnits';

const barRow: UnitConversionRow = { from_unit: 'bar', to_primary_factor: 144 };

describe('unitNameKey', () => {
  it('is the one in lib/purchasing/purchaseUnits, re-exported — not a copy', () => {
    expect(unitNameKey).toBe(purchaseUnits.unitNameKey);
    expect(unitNameKey(' Bar ')).toBe('bar');
    expect(unitNameKey('ea')).toBe('each');
  });
});

describe('resolvePartUnit — the database’s reading of a unit name', () => {
  it('reads "Bar" as the part’s "bar" conversion, in the stored spelling', () => {
    expect(resolvePartUnit('Bar', 'inches', [barRow])).toEqual({
      kind: 'converted', unit: 'bar', stockUnit: 'inches', factor: 144, source: 'conversion',
    });
    expect(resolvePartUnit('bar', 'inches', [{ from_unit: 'Bar', to_primary_factor: 144 }])).toMatchObject({ unit: 'Bar', factor: 144 });
  });

  it('reads the stock unit in any case or alias as the stock unit, as the part spells it', () => {
    expect(resolvePartUnit('Inches', 'inches', [])).toEqual({ kind: 'same', unit: 'inches', stockUnit: 'inches', factor: 1 });
    expect(resolvePartUnit('ea', 'each', [])).toMatchObject({ kind: 'same', unit: 'each' });
    expect(resolvePartUnit('', 'inches', [])).toMatchObject({ kind: 'same', unit: 'inches' });
  });

  it('still refuses a unit the part cannot relate', () => {
    expect(resolvePartUnit('Bundle', 'inches', [barRow])).toEqual({ kind: 'incomparable', unit: 'Bundle', stockUnit: 'inches' });
    expect(resolvePartUnit('bar', null, [barRow])).toMatchObject({ kind: 'incomparable', stockUnit: null });
  });

  it('answers exactly as resolvePurchaseUnit does, whatever it is asked', () => {
    const cases: Array<[string | null, string | null, UnitConversionRow[]]> = [
      ['Bar', 'inches', [barRow]],
      [' BAR ', 'inches', [barRow]],
      ['bar', 'inches', [barRow, { from_unit: 'Bar', to_primary_factor: 144 }]],
      ['feet', 'inches', []],
      ['FT', 'feet', []],
      ['hundred', 'each', []],
      ['bag', 'Bag', []],
      ['L', 'liters', []],
      [null, 'inches', []],
      ['bar', null, [barRow]],
      ['crate', 'each', []],
    ];
    for (const [unit, stock, conversions] of cases) {
      expect(resolvePartUnit(unit, stock, conversions), `${unit} on ${stock}`).toEqual(
        purchaseUnits.resolvePurchaseUnit(unit, stock, conversions),
      );
    }
  });
});
