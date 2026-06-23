import { describe, it, expect } from 'vitest';
import {
  MAX_QUANTITY_DECIMALS,
  isValidQuantityInput,
  isValidQuantityValue,
} from '@/lib/quantityInput';

describe('quantityInput: isValidQuantityInput', () => {
  it('accepts whole numbers and the empty (cleared) field', () => {
    expect(isValidQuantityInput('')).toBe(true);
    expect(isValidQuantityInput('0')).toBe(true);
    expect(isValidQuantityInput('12')).toBe(true);
  });

  it('accepts decimals up to 4 places — the fractional-unit cases', () => {
    expect(isValidQuantityInput('0.32')).toBe(true); // the reported customer case
    expect(isValidQuantityInput('12.5')).toBe(true);
    expect(isValidQuantityInput('0.1875')).toBe(true); // 3/16" — exactly 4 dp
    expect(isValidQuantityInput('.')).toBe(true); // transient input state
    expect(isValidQuantityInput('0.')).toBe(true);
  });

  it('rejects more than 4 decimal places', () => {
    expect(isValidQuantityInput('0.32567')).toBe(false);
    expect(isValidQuantityInput('1.00001')).toBe(false);
  });

  it('rejects signs, separators, and non-numeric junk', () => {
    expect(isValidQuantityInput('-1')).toBe(false);
    expect(isValidQuantityInput('1.2.3')).toBe(false);
    expect(isValidQuantityInput('1,000')).toBe(false);
    expect(isValidQuantityInput('1e3')).toBe(false);
    expect(isValidQuantityInput('abc')).toBe(false);
  });
});

describe('quantityInput: isValidQuantityValue (save guard)', () => {
  it('accepts finite, positive, <=4-dp values', () => {
    expect(isValidQuantityValue(0.32)).toBe(true);
    expect(isValidQuantityValue(12)).toBe(true);
    expect(isValidQuantityValue(0.1875)).toBe(true);
  });

  it('rejects zero, negatives, and non-finite values', () => {
    expect(isValidQuantityValue(0)).toBe(false);
    expect(isValidQuantityValue(-1)).toBe(false);
    expect(isValidQuantityValue(NaN)).toBe(false);
    expect(isValidQuantityValue(Infinity)).toBe(false);
  });

  it('rejects values finer than the precision cap (paste / programmatic paths)', () => {
    expect(isValidQuantityValue(0.00001)).toBe(false); // 5 dp
    expect(isValidQuantityValue(0.123456)).toBe(false);
  });
});

describe('quantityInput: MAX_QUANTITY_DECIMALS', () => {
  it('is 4 — the manufacturing-practical ceiling (machining tenths)', () => {
    expect(MAX_QUANTITY_DECIMALS).toBe(4);
  });
});
