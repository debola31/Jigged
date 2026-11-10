/**
 * Purchase units against stock units (plan §3.5 "Units", criteria L1 and L3).
 *
 * The rule worth a test of its own: a unit that cannot be related to the stock unit is
 * INCOMPARABLE, never factor 1. `convertToBaseUnit` returns the unconverted number when it can't
 * convert, so "3 bars" would land as 3 inches of stock — a confident wrong answer on a receipt.
 */
import { describe, it, expect } from 'vitest';
import {
  convertUnitPrice,
  defaultPurchaseUnit,
  factorLabel,
  needsConversionRow,
  normalizeUnitName,
  pricePerPurchaseUnit,
  pricePerStockUnit,
  purchaseUnitOptions,
  resolvePurchaseUnit,
  stockEquivalentLabel,
  toPurchaseQuantity,
  toStockQuantity,
  wholePurchaseUnits,
} from '@/lib/purchasing/purchaseUnits';

const barRow = { from_unit: 'bar', to_primary_factor: 144 };

describe('normalizeUnitName — aliases resolve before anything compares (L1)', () => {
  it('maps the unitPresets aliases to their canonical names', () => {
    expect(normalizeUnitName('ea')).toBe('each');
    expect(normalizeUnitName(' in ')).toBe('inches');
    expect(normalizeUnitName('ft')).toBe('feet');
    expect(normalizeUnitName('lbs')).toBe('pounds');
  });

  it('reads standard units in any case, the way the importer does', () => {
    expect(normalizeUnitName('FT')).toBe('feet');
    expect(normalizeUnitName('Each')).toBe('each');
    expect(normalizeUnitName('l')).toBe('liters');
  });

  it('keeps a shop\'s own unit exactly as written', () => {
    expect(normalizeUnitName('Bar')).toBe('Bar');
    expect(normalizeUnitName('  bundle ')).toBe('bundle');
  });

  it('is empty for a missing unit', () => {
    expect(normalizeUnitName(null)).toBe('');
    expect(normalizeUnitName(undefined)).toBe('');
  });
});

describe('resolvePurchaseUnit (L1, L3)', () => {
  it('gives factor 1 for the stock unit itself', () => {
    expect(resolvePurchaseUnit('inches', 'inches', [])).toEqual({
      kind: 'same', unit: 'inches', stockUnit: 'inches', factor: 1,
    });
  });

  it('gives an `ea` line on an `each` part factor 1, written in the part\'s own spelling', () => {
    // The RPC's "same unit" test is a text compare, so the line must carry `each`, not `ea`.
    expect(resolvePurchaseUnit('ea', 'each', [])).toEqual({
      kind: 'same', unit: 'each', stockUnit: 'each', factor: 1,
    });
    expect(resolvePurchaseUnit('each', 'ea', []).unit).toBe('ea');
  });

  it('reads a blank unit as the stock unit', () => {
    expect(resolvePurchaseUnit('', 'inches', [])).toMatchObject({ kind: 'same', unit: 'inches' });
  });

  it('converts feet to inches at the preset 12, and says a conversion row must be written', () => {
    const basis = resolvePurchaseUnit('feet', 'inches', []);
    expect(basis).toEqual({ kind: 'converted', unit: 'feet', stockUnit: 'inches', factor: 12, source: 'preset' });
    expect(needsConversionRow(basis)).toBe(true);
  });

  it('normalises an alias before resolving, so `ft` is written as `feet`', () => {
    expect(resolvePurchaseUnit('ft', 'inches', [])).toMatchObject({ kind: 'converted', unit: 'feet', factor: 12 });
  });

  it('lets the part\'s own conversion beat the preset — the shop entered it on purpose', () => {
    const basis = resolvePurchaseUnit('feet', 'inches', [{ from_unit: 'feet', to_primary_factor: 11 }]);
    expect(basis).toEqual({ kind: 'converted', unit: 'feet', stockUnit: 'inches', factor: 11, source: 'conversion' });
    expect(needsConversionRow(basis)).toBe(false);
  });

  it('matches a stored conversion through its alias and keeps the stored spelling', () => {
    const basis = resolvePurchaseUnit('feet', 'inches', [{ from_unit: 'ft', to_primary_factor: 12 }]);
    expect(basis).toMatchObject({ kind: 'converted', unit: 'ft', factor: 12, source: 'conversion' });
  });

  it('uses a stored conversion for a shop\'s own unit', () => {
    expect(resolvePurchaseUnit('bar', 'inches', [barRow])).toEqual({
      kind: 'converted', unit: 'bar', stockUnit: 'inches', factor: 144, source: 'conversion',
    });
  });

  it('refuses bar against inches with no conversion — incomparable, never factor 1', () => {
    const basis = resolvePurchaseUnit('bar', 'inches', []);
    expect(basis).toEqual({ kind: 'incomparable', unit: 'bar', stockUnit: 'inches' });
    expect(factorLabel(basis)).toBeNull();
    expect(needsConversionRow(basis)).toBe(false);
  });

  it('refuses units of different kinds', () => {
    expect(resolvePurchaseUnit('pounds', 'inches', []).kind).toBe('incomparable');
  });

  it('ignores a nonsense stored factor instead of multiplying by it', () => {
    expect(resolvePurchaseUnit('bar', 'inches', [{ from_unit: 'bar', to_primary_factor: 0 }]).kind).toBe('incomparable');
    expect(resolvePurchaseUnit('bar', 'inches', [{ from_unit: 'bar', to_primary_factor: Number.NaN }]).kind).toBe('incomparable');
    expect(resolvePurchaseUnit('bar', 'inches', [{ from_unit: 'bar', to_primary_factor: -144 }]).kind).toBe('incomparable');
  });

  it('refuses everything for a part with no stock unit', () => {
    expect(resolvePurchaseUnit('each', null, []).kind).toBe('incomparable');
  });

  it('buys per hundred and per thousand from the count presets (L3)', () => {
    expect(resolvePurchaseUnit('hundred', 'each', [])).toMatchObject({ kind: 'converted', factor: 100, source: 'preset' });
    expect(resolvePurchaseUnit('thousand', 'pieces', [])).toMatchObject({ kind: 'converted', factor: 1000 });
  });
});

describe('stock and purchase quantities (L1, L3)', () => {
  it('converts a purchase quantity to stock exactly', () => {
    expect(toStockQuantity(2.5, 100)).toBe(250);
    expect(toStockQuantity(3, 144)).toBe(432);
    // The float product is 0.30000000000000004.
    expect(toStockQuantity(3, 0.1)).toBe(0.3);
    expect(toStockQuantity(20.833333, 12)).toBe(249.999996);
  });

  it('converts stock back to purchase units to six places', () => {
    expect(toPurchaseQuantity(432, 144)).toBe(3);
    expect(toPurchaseQuantity(100, 144)).toBe(0.694444);
    expect(toPurchaseQuantity(250, 100)).toBe(2.5);
  });

  it('rounds up to whole purchase units: 400 in is 3 bars, 288 in is exactly 2', () => {
    expect(wholePurchaseUnits(400, 144)).toBe(3);
    expect(wholePurchaseUnits(288, 144)).toBe(2);
  });

  it('rounds up with a tolerance, so float noise never adds a unit (0.3 ÷ 0.1 is 3)', () => {
    expect(wholePurchaseUnits(0.3, 0.1)).toBe(3);
    expect(wholePurchaseUnits(0.1 + 0.2, 0.1)).toBe(3);
    // 1.1 / 0.1 is 11.000000000000002 in floating point; a bare Math.ceil says 12.
    expect(wholePurchaseUnits(1.1, 0.1)).toBe(11);
  });

  it('never proposes a negative count, and refuses a factor that is not positive', () => {
    expect(wholePurchaseUnits(0, 144)).toBe(0);
    expect(wholePurchaseUnits(-5, 144)).toBe(0);
    expect(Number.isNaN(wholePurchaseUnits(10, 0))).toBe(true);
  });
});

describe('prices across units (L1, L2)', () => {
  it('divides a purchase-unit price by the factor for the stock-unit price', () => {
    expect(pricePerStockUnit(36, 144)).toBe(0.25);
    expect(pricePerStockUnit(5, 100)).toBe(0.05);
    expect(pricePerStockUnit(1.23, 1000)).toBe(0.00123);
  });

  it('multiplies a stock-unit price by the factor for the purchase-unit price', () => {
    expect(pricePerPurchaseUnit(0.25, 144)).toBe(36);
  });

  it('re-expresses a price from one purchase unit in another', () => {
    // $12 a foot is $1 an inch is $144 a 144-inch bar.
    expect(convertUnitPrice(12, 12, 144)).toBe(144);
    expect(convertUnitPrice(5, 100, 1)).toBe(0.05);
    expect(convertUnitPrice(7.5, 1, 1)).toBe(7.5);
  });
});

describe('labels (L1)', () => {
  it('reads "1 bar = 144 in"', () => {
    expect(factorLabel(resolvePurchaseUnit('bar', 'inches', [barRow]))).toBe('1 bar = 144 in');
  });

  it('uses the short symbol for standard units and groups thousands', () => {
    expect(factorLabel(resolvePurchaseUnit('feet', 'inches', []))).toBe('1 ft = 12 in');
    expect(factorLabel(resolvePurchaseUnit('thousand', 'each', []))).toBe('1 thousand = 1,000 ea');
  });

  it('has no label for the stock unit itself', () => {
    expect(factorLabel(resolvePurchaseUnit('each', 'each', []))).toBeNull();
  });

  it('states a purchase quantity in stock units', () => {
    expect(stockEquivalentLabel(3, resolvePurchaseUnit('bar', 'inches', [barRow]))).toBe('= 432 in');
    expect(stockEquivalentLabel(2.5, resolvePurchaseUnit('hundred', 'each', []))).toBe('= 250 ea');
    expect(stockEquivalentLabel(3, resolvePurchaseUnit('each', 'each', []))).toBeNull();
    expect(stockEquivalentLabel(3, resolvePurchaseUnit('bar', 'inches', []))).toBeNull();
  });
});

describe('purchaseUnitOptions — what the unit field offers (L1, L3)', () => {
  it('offers the stock unit, the part\'s conversions, then same-kind presets', () => {
    const options = purchaseUnitOptions('inches', [barRow]);
    expect(options.map((o) => o.unit)).toEqual(['inches', 'bar', 'feet', 'millimeters', 'centimeters', 'meters']);
    expect(options[0]).toMatchObject({ kind: 'same', factor: 1 });
    expect(options[1]).toMatchObject({ kind: 'converted', source: 'conversion', factor: 144 });
    expect(options[2]).toMatchObject({ kind: 'converted', source: 'preset', factor: 12 });
  });

  it('lists a unit once, with the part\'s own factor when it has one', () => {
    const options = purchaseUnitOptions('inches', [{ from_unit: 'feet', to_primary_factor: 11 }]);
    const feet = options.filter((o) => o.unit === 'feet');
    expect(feet).toHaveLength(1);
    expect(feet[0]).toMatchObject({ source: 'conversion', factor: 11 });
  });

  it('skips conversions it cannot use', () => {
    const options = purchaseUnitOptions('inches', [{ from_unit: 'bar', to_primary_factor: 0 }]);
    expect(options.map((o) => o.unit)).not.toContain('bar');
  });

  it('offers hundred and thousand on a counted part (L3)', () => {
    expect(purchaseUnitOptions('each', []).map((o) => o.unit)).toEqual(['each', 'pieces', 'dozen', 'hundred', 'thousand']);
  });

  it('offers nothing for a part with no stock unit', () => {
    expect(purchaseUnitOptions(null, [barRow])).toEqual([]);
  });
});

describe('defaultPurchaseUnit — sheet unit, then last ordered, then stock (L1)', () => {
  const conversions = [barRow];

  it('prefers the vendor\'s price-sheet unit', () => {
    expect(defaultPurchaseUnit({ sheetUnit: 'bar', lastOrderedUnit: 'feet', stockUnit: 'inches', conversions })).toBe('bar');
  });

  it('falls back to the unit last ordered for this part', () => {
    expect(defaultPurchaseUnit({ sheetUnit: null, lastOrderedUnit: 'feet', stockUnit: 'inches', conversions })).toBe('feet');
  });

  it('falls back to the stock unit', () => {
    expect(defaultPurchaseUnit({ sheetUnit: null, lastOrderedUnit: null, stockUnit: 'inches', conversions })).toBe('inches');
  });

  it('skips a candidate that no longer relates to the stock unit', () => {
    // The part's primary unit changed since the last PO; `bar` has no conversion any more.
    expect(defaultPurchaseUnit({ sheetUnit: null, lastOrderedUnit: 'bar', stockUnit: 'inches', conversions: [] })).toBe('inches');
  });

  it('returns the spelling to write', () => {
    expect(defaultPurchaseUnit({ sheetUnit: 'ft', lastOrderedUnit: null, stockUnit: 'inches', conversions: [] })).toBe('feet');
  });

  it('has nothing to offer for a part with no stock unit', () => {
    expect(defaultPurchaseUnit({ sheetUnit: 'bar', lastOrderedUnit: null, stockUnit: null, conversions })).toBeNull();
  });
});
