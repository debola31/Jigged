/**
 * `lib/money.ts` — the one money formatter, and the exact decimal rounding every purchasing
 * amount goes through (plan §3.5 "Money", criterion P7).
 *
 * The cases that matter are the float traps: 1.005, 2.675 and 0.3 × 0.05 all sit a hair BELOW
 * their half-cent in binary, so `Math.round(x * 100) / 100` and `toFixed(2)` round them DOWN while
 * Postgres `round(numeric, 2)` — working on the decimal the user typed — rounds them up. A screen
 * and its own database would then disagree by a cent on the same line.
 */
import { describe, it, expect } from 'vitest';
import {
  divideDecimal,
  formatMoney,
  formatUnitPrice,
  multiplyDecimal,
  multiplyDivideDecimal,
  roundCents,
  roundDecimal,
  sumDecimal,
} from '@/lib/money';

describe('roundCents — half-up on the decimal value, like Postgres round(numeric, 2) (P7)', () => {
  it('rounds the binary float traps up, the way the database does', () => {
    expect(roundCents(1.005)).toBe(1.01);
    expect(roundCents(2.675)).toBe(2.68);
    expect(roundCents(0.125)).toBe(0.13);
    expect(roundCents(1.255)).toBe(1.26);
  });

  it('rounds below the half-cent down', () => {
    expect(roundCents(1.0049)).toBe(1);
    expect(roundCents(0.0049)).toBe(0);
  });

  it('rounds halves away from zero for negatives, matching numeric rounding', () => {
    expect(roundCents(-1.005)).toBe(-1.01);
    expect(roundCents(-0.004)).toBe(0);
  });

  it('leaves whole and two-place values exactly as they are', () => {
    expect(roundCents(10)).toBe(10);
    expect(roundCents(19.99)).toBe(19.99);
  });

  it('passes a non-finite value through rather than inventing a number', () => {
    expect(Number.isNaN(roundCents(Number.NaN))).toBe(true);
  });
});

describe('roundDecimal / multiplyDecimal / divideDecimal / sumDecimal (P7)', () => {
  it('rounds to any number of places, including exponent-notation inputs', () => {
    expect(roundDecimal(1.234565, 5)).toBe(1.23457);
    expect(roundDecimal(1e-7, 6)).toBe(0);
    expect(roundDecimal(5e-7, 6)).toBe(0.000001);
    expect(roundDecimal(123.456, 0)).toBe(123);
  });

  it('multiplies exactly before rounding once', () => {
    // 3 × 0.3333 = 0.9999 → 1.00: the rounding is applied to the exact product.
    expect(multiplyDecimal(3, 0.3333, 2)).toBe(1);
    // 0.3 × 0.05 = 0.015 exactly; the float product is 0.01499999… and would round down.
    expect(multiplyDecimal(0.3, 0.05, 2)).toBe(0.02);
    expect(multiplyDecimal(2.5, 144, 6)).toBe(360);
  });

  it('divides with one half-up rounding at the requested place', () => {
    expect(divideDecimal(1, 3, 5)).toBe(0.33333);
    expect(divideDecimal(2, 3, 5)).toBe(0.66667);
    expect(divideDecimal(-2, 3, 2)).toBe(-0.67);
    expect(divideDecimal(432, 144, 6)).toBe(3);
  });

  it('refuses to divide by zero with NaN rather than Infinity', () => {
    expect(Number.isNaN(divideDecimal(1, 0, 2))).toBe(true);
    expect(Number.isNaN(multiplyDivideDecimal(1, 2, 0, 2))).toBe(true);
  });

  it('multiplies then divides as one exact fraction, rounding once', () => {
    // $12 a foot (12 in) re-expressed per 144-inch bar.
    expect(multiplyDivideDecimal(12, 144, 12, 5)).toBe(144);
    // A factor with a long expansion: 1 ÷ 12 ft per inch, times 12 — exactly 1, not 0.99999…
    expect(multiplyDivideDecimal(1, 12, 12, 5)).toBe(1);
    expect(multiplyDivideDecimal(0.3333, 3, 1, 2)).toBe(1);
    expect(multiplyDivideDecimal(-1, 2, 3, 2)).toBe(-0.67);
  });

  it('adds exactly, so cents never pick up float noise', () => {
    expect(sumDecimal([0.1, 0.2])).toBe(0.3);
    expect(sumDecimal([1.01, 2.02, 3.03])).toBe(6.06);
    expect(sumDecimal([])).toBe(0);
  });
});

describe('formatMoney — two places, always (P7)', () => {
  it('formats dollars with cents and thousands separators', () => {
    expect(formatMoney(1234.5)).toBe('$1,234.50');
    expect(formatMoney(0)).toBe('$0.00');
    expect(formatMoney(12)).toBe('$12.00');
  });

  it('rounds half-up to the cent on the decimal value', () => {
    expect(formatMoney(1.005)).toBe('$1.01');
    expect(formatMoney(2.675)).toBe('$2.68');
  });

  it('never prints a negative zero', () => {
    expect(formatMoney(-0)).toBe('$0.00');
    expect(formatMoney(-0.001)).toBe('$0.00');
  });

  it('prints a negative amount with its sign', () => {
    expect(formatMoney(-5)).toBe('-$5.00');
  });

  it('prints a dash for a missing value, or the caller\'s word for it', () => {
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney(undefined)).toBe('—');
    expect(formatMoney(Number.NaN)).toBe('—');
    expect(formatMoney(null, { nullText: 'TBC' })).toBe('TBC');
  });
});

describe('formatUnitPrice — up to 5 places, trailing zeros trimmed down to 2 (P7)', () => {
  it('keeps at least two places', () => {
    expect(formatUnitPrice(1.5)).toBe('$1.50');
    expect(formatUnitPrice(12)).toBe('$12.00');
    expect(formatUnitPrice(2.1)).toBe('$2.10');
  });

  it('shows the places a sub-cent price needs, up to five', () => {
    expect(formatUnitPrice(0.0125)).toBe('$0.0125');
    expect(formatUnitPrice(0.12345)).toBe('$0.12345');
    expect(formatUnitPrice(1234.56789)).toBe('$1,234.56789');
  });

  it('trims trailing zeros past the second place', () => {
    expect(formatUnitPrice(1.23)).toBe('$1.23');
    expect(formatUnitPrice(1.2)).toBe('$1.20');
  });

  it('rounds half-up at the fifth place', () => {
    expect(formatUnitPrice(1.234565)).toBe('$1.23457');
    expect(formatUnitPrice(0.000005)).toBe('$0.00001');
  });

  it('prints the caller\'s word for an unpriced line', () => {
    expect(formatUnitPrice(null)).toBe('—');
    expect(formatUnitPrice(null, { nullText: 'TBC' })).toBe('TBC');
  });
});
