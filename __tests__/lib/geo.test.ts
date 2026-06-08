import { describe, it, expect } from 'vitest';
import {
  COUNTRIES,
  US_STATES,
  CA_PROVINCES,
  subdivisionsForCountry,
} from '@/lib/geo';

describe('COUNTRIES', () => {
  it('includes the common ones with unique codes', () => {
    const codes = COUNTRIES.map((c) => c.code);
    expect(codes).toContain('US');
    expect(codes).toContain('CA');
    expect(codes).toContain('GB');
    expect(new Set(codes).size).toBe(codes.length); // no duplicate codes
  });
});

describe('subdivisionsForCountry', () => {
  it('returns US states for US / USA / full name', () => {
    expect(subdivisionsForCountry('US')).toBe(US_STATES);
    expect(subdivisionsForCountry('USA')).toBe(US_STATES);
    expect(subdivisionsForCountry('United States')).toBe(US_STATES);
    expect(subdivisionsForCountry('united states of america')).toBe(US_STATES);
  });
  it('returns CA provinces for CA / Canada', () => {
    expect(subdivisionsForCountry('CA')).toBe(CA_PROVINCES);
    expect(subdivisionsForCountry('Canada')).toBe(CA_PROVINCES);
  });
  it('returns null for unknown / empty country', () => {
    expect(subdivisionsForCountry('France')).toBeNull();
    expect(subdivisionsForCountry('')).toBeNull();
    expect(subdivisionsForCountry(null)).toBeNull();
    expect(subdivisionsForCountry(undefined)).toBeNull();
  });
});

describe('subdivision lists', () => {
  it('have the expected sizes', () => {
    expect(US_STATES.length).toBe(52); // 50 states + DC + Puerto Rico
    expect(CA_PROVINCES.length).toBe(13);
  });
});
