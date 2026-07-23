import { describe, it, expect } from 'vitest';
import {
  KNOWN_DEFAULTS,
  readCompanyDefault,
  readQuoteValidityDays,
  readCompanyDefaults,
  readCustomPaymentTerms,
} from '@/lib/companyDefaults';
import { DEFAULT_QUOTE_VALIDITY_DAYS } from '@/types/quote';

describe('companyDefaults: quote_validity_days', () => {
  it('is registered in KNOWN_DEFAULTS (so the settings card renders a row)', () => {
    expect(KNOWN_DEFAULTS.map((d) => d.key)).toContain('quote_validity_days');
  });

  it('falls back to DEFAULT_QUOTE_VALIDITY_DAYS when unset', () => {
    expect(readQuoteValidityDays({ settings: { defaults: {} } })).toBe(DEFAULT_QUOTE_VALIDITY_DAYS);
    expect(readQuoteValidityDays({ settings: {} })).toBe(DEFAULT_QUOTE_VALIDITY_DAYS);
    expect(readQuoteValidityDays(null)).toBe(DEFAULT_QUOTE_VALIDITY_DAYS);
    expect(readQuoteValidityDays(undefined)).toBe(DEFAULT_QUOTE_VALIDITY_DAYS);
  });

  it('reads an explicit stored value (number or numeric string)', () => {
    expect(readQuoteValidityDays({ settings: { defaults: { quote_validity_days: 20 } } })).toBe(20);
    expect(readQuoteValidityDays({ settings: { defaults: { quote_validity_days: '30' } } })).toBe(30);
  });

  it('rounds fractional stored values to the nearest integer', () => {
    expect(readQuoteValidityDays({ settings: { defaults: { quote_validity_days: 14.4 } } })).toBe(14);
  });

  it('rejects out-of-range / non-numeric values back to the fallback', () => {
    const fb = DEFAULT_QUOTE_VALIDITY_DAYS;
    expect(readQuoteValidityDays({ settings: { defaults: { quote_validity_days: 0 } } })).toBe(fb); // < min
    expect(readQuoteValidityDays({ settings: { defaults: { quote_validity_days: 999 } } })).toBe(fb); // > max
    expect(readQuoteValidityDays({ settings: { defaults: { quote_validity_days: 'abc' } } })).toBe(fb);
    expect(readQuoteValidityDays({ settings: { defaults: { quote_validity_days: null } } })).toBe(fb);
  });

  it('readCompanyDefault throws on an unknown key', () => {
    // @ts-expect-error — exercising the runtime guard with a bad key
    expect(() => readCompanyDefault({ settings: {} }, 'nope')).toThrow();
  });

  it('readCompanyDefaults returns a dense map resolved against fallbacks', () => {
    const values = readCompanyDefaults({ settings: { defaults: { quote_validity_days: 25 } } });
    expect(values.quote_validity_days).toBe(25);

    const none = readCompanyDefaults(null);
    expect(none.quote_validity_days).toBe(DEFAULT_QUOTE_VALIDITY_DAYS);
  });
});

describe('readCustomPaymentTerms', () => {
  it('returns [] when unset, null, or malformed', () => {
    expect(readCustomPaymentTerms(null)).toEqual([]);
    expect(readCustomPaymentTerms({ settings: {} })).toEqual([]);
    expect(readCustomPaymentTerms({ settings: { custom_payment_terms: 'nope' } })).toEqual([]);
    expect(readCustomPaymentTerms({ settings: { custom_payment_terms: [1, 2] } })).toEqual([]);
  });

  it('trims, drops blanks, and de-duplicates (order preserved)', () => {
    expect(
      readCustomPaymentTerms({
        settings: {
          custom_payment_terms: [
            '  Net 30, 1% late  ',
            '',
            'Prepay',
            'Net 30, 1% late',
            '   ',
            'Prepay',
          ],
        },
      }),
    ).toEqual(['Net 30, 1% late', 'Prepay']);
  });
});
