import { describe, it, expect } from 'vitest';
import { unitShortLabel, quantityUnitSuffix } from '@/lib/standardUnits';

describe('standardUnits: unitShortLabel', () => {
  it('maps a standard unit key to its short symbol', () => {
    expect(unitShortLabel('inches')).toBe('in');
    expect(unitShortLabel('pounds')).toBe('lb');
    expect(unitShortLabel('each')).toBe('ea');
  });

  it('falls back to the raw value for custom/company units', () => {
    expect(unitShortLabel('barrel')).toBe('barrel');
  });

  it('returns null for a null/empty unit', () => {
    expect(unitShortLabel(null)).toBeNull();
    expect(unitShortLabel(undefined)).toBeNull();
    expect(unitShortLabel('')).toBeNull();
  });
});

describe('standardUnits: quantityUnitSuffix', () => {
  it('labels non-count units so a fractional quantity is unambiguous', () => {
    expect(quantityUnitSuffix('inches')).toBe('in');
    expect(quantityUnitSuffix('pounds')).toBe('lb');
    expect(quantityUnitSuffix('gallons')).toBe('gal');
  });

  it('suppresses the suffix for count units (a bare number is conventional)', () => {
    expect(quantityUnitSuffix('each')).toBeNull();
    expect(quantityUnitSuffix('pieces')).toBeNull();
    expect(quantityUnitSuffix('dozen')).toBeNull();
  });

  it('labels custom units (treated as non-count)', () => {
    expect(quantityUnitSuffix('barrel')).toBe('barrel');
  });

  it('returns null for a null/empty unit', () => {
    expect(quantityUnitSuffix(null)).toBeNull();
    expect(quantityUnitSuffix(undefined)).toBeNull();
  });
});
