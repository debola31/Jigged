import {
  calculateUnitPriceFromMarkup,
  calculateMarkupFromUnitPrice,
  calculateTotalPrice,
} from '@/types/quote';

describe('calculateUnitPriceFromMarkup', () => {
  it('calculates 0% markup correctly', () => {
    expect(calculateUnitPriceFromMarkup(100, 0)).toBe(100);
  });

  it('calculates 40% markup correctly', () => {
    // $100 at 40% markup = $140
    expect(calculateUnitPriceFromMarkup(100, 40)).toBe(140);
  });

  it('calculates 100% markup correctly', () => {
    // $50 at 100% markup = $100
    expect(calculateUnitPriceFromMarkup(50, 100)).toBe(100);
  });

  it('handles negative markup', () => {
    // $100 at -20% markup = $80
    expect(calculateUnitPriceFromMarkup(100, -20)).toBe(80);
  });

  it('returns null for NaN base cost', () => {
    expect(calculateUnitPriceFromMarkup(NaN, 40)).toBeNull();
  });

  it('returns null for negative base cost', () => {
    expect(calculateUnitPriceFromMarkup(-10, 40)).toBeNull();
  });

  it('returns null for NaN markup', () => {
    expect(calculateUnitPriceFromMarkup(100, NaN)).toBeNull();
  });

  it('handles 0 base cost', () => {
    expect(calculateUnitPriceFromMarkup(0, 40)).toBe(0);
  });

  it('rounds to 2 decimal places', () => {
    // $103.25 at 35% markup = 103.25 * 1.35 = 139.3875 → 139.39
    expect(calculateUnitPriceFromMarkup(103.25, 35)).toBe(139.39);
  });
});

describe('calculateMarkupFromUnitPrice', () => {
  it('back-calculates correctly for 40% markup', () => {
    // $140 from $100 base = 40%
    expect(calculateMarkupFromUnitPrice(100, 140)).toBe(40);
  });

  it('back-calculates correctly for 100% markup', () => {
    // $200 from $100 base = 100%
    expect(calculateMarkupFromUnitPrice(100, 200)).toBe(100);
  });

  it('returns null for 0 base cost', () => {
    expect(calculateMarkupFromUnitPrice(0, 100)).toBeNull();
  });

  it('returns null for negative base cost', () => {
    expect(calculateMarkupFromUnitPrice(-10, 100)).toBeNull();
  });

  it('returns null for NaN unit price', () => {
    expect(calculateMarkupFromUnitPrice(100, NaN)).toBeNull();
  });

  it('returns null for negative unit price', () => {
    expect(calculateMarkupFromUnitPrice(100, -50)).toBeNull();
  });

  it('handles price less than cost (negative markup)', () => {
    // $80 from $100 base = -20%
    expect(calculateMarkupFromUnitPrice(100, 80)).toBe(-20);
  });

  it('handles price equal to cost (0% markup)', () => {
    expect(calculateMarkupFromUnitPrice(100, 100)).toBe(0);
  });

  it('rounds to 2 decimal places', () => {
    // $139.39 from $103.25 = ((139.39 - 103.25) / 103.25) * 100 = 35.0024...
    expect(calculateMarkupFromUnitPrice(103.25, 139.39)).toBeCloseTo(35, 0);
  });
});

describe('calculateTotalPrice', () => {
  it('calculates total correctly', () => {
    expect(calculateTotalPrice(10, 25.50)).toBe(255);
  });

  it('returns null for null unit price', () => {
    expect(calculateTotalPrice(10, null)).toBeNull();
  });

  it('returns null for NaN unit price', () => {
    expect(calculateTotalPrice(10, NaN)).toBeNull();
  });

  it('returns null for 0 quantity', () => {
    expect(calculateTotalPrice(0, 25)).toBeNull();
  });

  it('returns null for negative quantity', () => {
    expect(calculateTotalPrice(-1, 25)).toBeNull();
  });
});
