import { describe, it, expect } from 'vitest';
import {
  isUuid,
  isValidEmail,
  isValidPhone,
  normalizePhone,
  isValidPostalCode,
  parseOptionalNumber,
  parseOptionalInteger,
  numberToInputString,
} from '@/lib/validators';

describe('isUuid', () => {
  it('accepts a Postgres uuid in either case', () => {
    expect(isUuid('752325ba-2159-41a7-9cd2-716faf5a596b')).toBe(true);
    expect(isUuid('752325BA-2159-41A7-9CD2-716FAF5A596B')).toBe(true);
    expect(isUuid('22222222-2222-2222-2222-222222222222')).toBe(true);
  });

  /**
   * The route-segment cases, which are the reason this is shared rather than private.
   * `/dashboard/admin` sent "admin" to a `uuid` column and raised 22P02 in production.
   */
  it('rejects the things a URL segment actually contains', () => {
    expect(isUuid('admin')).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid('undefined')).toBe(false);
    expect(isUuid('null')).toBe(false);
    expect(isUuid('752325ba-2159-41a7-9cd2')).toBe(false); // truncated
    expect(isUuid('752325ba215941a79cd2716faf5a596b')).toBe(false); // unhyphenated
    expect(isUuid('752325bg-2159-41a7-9cd2-716faf5a596b')).toBe(false); // 'g' is not hex
  });

  // Anchored, so an id embedded in a longer string is not a match — `jiggedScan` depends on
  // this to refuse a foreign QR code that merely contains a uuid.
  it('is anchored', () => {
    expect(isUuid(' 752325ba-2159-41a7-9cd2-716faf5a596b')).toBe(false);
    expect(isUuid('/dashboard/752325ba-2159-41a7-9cd2-716faf5a596b')).toBe(false);
    expect(isUuid('752325ba-2159-41a7-9cd2-716faf5a596b/parts')).toBe(false);
  });

  it('rejects non-strings rather than throwing', () => {
    expect(isUuid(null)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(isUuid({})).toBe(false);
  });
});

describe('isValidEmail', () => {
  it('accepts well-formed addresses', () => {
    expect(isValidEmail('user@example.com')).toBe(true);
    expect(isValidEmail('a.b-c+tag@sub.example.co.uk')).toBe(true);
  });
  it('trims surrounding whitespace', () => {
    expect(isValidEmail('  user@example.com  ')).toBe(true);
  });
  it('rejects malformed addresses', () => {
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('user')).toBe(false);
    expect(isValidEmail('user@example')).toBe(false);
    expect(isValidEmail('user @example.com')).toBe(false);
    expect(isValidEmail('@example.com')).toBe(false);
  });
});

describe('normalizePhone', () => {
  it('strips all non-digit characters', () => {
    expect(normalizePhone('+1 (555) 123-4567')).toBe('15551234567');
  });
});

describe('isValidPhone', () => {
  it('accepts common formats', () => {
    expect(isValidPhone('555-123-4567')).toBe(true);
    expect(isValidPhone('(555) 123 4567')).toBe(true);
    expect(isValidPhone('+44 20 7946 0958')).toBe(true);
    expect(isValidPhone('5551234')).toBe(true); // 7 digits, minimum
  });
  it('rejects too-short, too-long, empty, or lettered input', () => {
    expect(isValidPhone('')).toBe(false);
    expect(isValidPhone('12345')).toBe(false); // 5 digits
    expect(isValidPhone('1234567890123456')).toBe(false); // 16 digits
    expect(isValidPhone('555-CALL-NOW')).toBe(false);
  });
});

describe('isValidPostalCode', () => {
  it('validates US ZIP and ZIP+4', () => {
    expect(isValidPostalCode('US', '90210')).toBe(true);
    expect(isValidPostalCode('US', '90210-1234')).toBe(true);
    expect(isValidPostalCode('US', '9021')).toBe(false);
    expect(isValidPostalCode('US', 'ABCDE')).toBe(false);
  });
  it('validates Canadian postal codes (space optional)', () => {
    expect(isValidPostalCode('CA', 'K1A 0B1')).toBe(true);
    expect(isValidPostalCode('CA', 'K1A0B1')).toBe(true);
    expect(isValidPostalCode('CA', '12345')).toBe(false);
  });
  it('resolves country names and aliases, not just codes', () => {
    // Forms store the display name / legacy alias, not the ISO code — validation
    // must still fire.
    expect(isValidPostalCode('United States', '90210')).toBe(true);
    expect(isValidPostalCode('USA', '9021')).toBe(false);
    expect(isValidPostalCode('Canada', 'K1A 0B1')).toBe(true);
  });
  it('is permissive for unknown countries and empty values', () => {
    expect(isValidPostalCode('FR', '75008')).toBe(true);
    expect(isValidPostalCode(null, 'anything')).toBe(true);
    expect(isValidPostalCode('US', '')).toBe(true); // presence enforced elsewhere
    expect(isValidPostalCode('US', '   ')).toBe(true);
  });
});

describe('parseOptionalNumber', () => {
  it('parses decimals, returns null for blank/invalid', () => {
    expect(parseOptionalNumber('12.5')).toBe(12.5);
    expect(parseOptionalNumber('0')).toBe(0);
    expect(parseOptionalNumber('')).toBeNull();
    expect(parseOptionalNumber('   ')).toBeNull();
    expect(parseOptionalNumber('abc')).toBeNull();
  });
});

describe('parseOptionalInteger', () => {
  it('truncates and returns null for blank/invalid', () => {
    expect(parseOptionalInteger('12')).toBe(12);
    expect(parseOptionalInteger('12.9')).toBe(12);
    expect(parseOptionalInteger('-3')).toBe(-3);
    expect(parseOptionalInteger('')).toBeNull();
    expect(parseOptionalInteger('abc')).toBeNull();
  });
});

describe('numberToInputString', () => {
  it('renders numbers and blanks null/undefined', () => {
    expect(numberToInputString(5)).toBe('5');
    expect(numberToInputString(0)).toBe('0');
    expect(numberToInputString(null)).toBe('');
    expect(numberToInputString(undefined)).toBe('');
  });
});
