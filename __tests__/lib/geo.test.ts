import { describe, it, expect } from 'vitest';
import {
  COUNTRIES,
  US_STATES,
  CA_PROVINCES,
  subdivisionsForCountry,
  resolveCountryCode,
  resolveCountryName,
  resolveSubdivisionName,
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

describe('resolveCountryCode', () => {
  it('resolves names, codes, and common aliases (case-insensitive)', () => {
    expect(resolveCountryCode('United States')).toBe('US');
    expect(resolveCountryCode('us')).toBe('US');
    expect(resolveCountryCode('USA')).toBe('US');
    expect(resolveCountryCode('united states of america')).toBe('US');
    expect(resolveCountryCode('Canada')).toBe('CA');
    expect(resolveCountryCode('can')).toBe('CA');
    expect(resolveCountryCode('France')).toBe('FR');
  });
  it('returns null for junk / empty', () => {
    expect(resolveCountryCode('Mexi')).toBeNull();
    expect(resolveCountryCode(',mex')).toBeNull();
    expect(resolveCountryCode('')).toBeNull();
    expect(resolveCountryCode(null)).toBeNull();
  });
});

describe('resolveCountryName', () => {
  it('returns the canonical display name', () => {
    expect(resolveCountryName('USA')).toBe('United States');
    expect(resolveCountryName('us')).toBe('United States');
    expect(resolveCountryName('Mexi')).toBeNull();
  });
});

describe('resolveSubdivisionName', () => {
  it('resolves US states by name or code, case-insensitive', () => {
    expect(resolveSubdivisionName('US', 'California')).toBe('California');
    expect(resolveSubdivisionName('USA', 'ca')).toBe('California');
    expect(resolveSubdivisionName('United States', 'IL')).toBe('Illinois');
  });
  it('resolves CA provinces', () => {
    expect(resolveSubdivisionName('Canada', 'on')).toBe('Ontario');
  });
  it('returns null for unrecognized values or list-less countries', () => {
    expect(resolveSubdivisionName('US', 'Califnia')).toBeNull();
    expect(resolveSubdivisionName('France', 'Paris')).toBeNull();
    expect(resolveSubdivisionName('US', '')).toBeNull();
  });
});
