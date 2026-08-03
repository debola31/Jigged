import { describe, it, expect } from 'vitest';
import {
  KNOWN_DEFAULTS,
  readCompanyDefault,
  readQuoteValidityDays,
  readCompanyDefaults,
  readCustomPaymentTerms,
  readCompanyDefaultPaymentTerms,
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

describe('readCompanyDefaultPaymentTerms', () => {
  it('reads the shop-wide default from settings.default_payment_terms', () => {
    expect(
      readCompanyDefaultPaymentTerms({ settings: { default_payment_terms: '2/10 Net 30' } }),
    ).toBe('2/10 Net 30');
  });

  it('trims, so a stray space never reads as a different term downstream', () => {
    expect(
      readCompanyDefaultPaymentTerms({ settings: { default_payment_terms: '  Net 30  ' } }),
    ).toBe('Net 30');
  });

  it('returns null when unset, blank, or the wrong type', () => {
    // null (not '') is the single representation of "no shop default", so the
    // quote form can fall through to leaving the field empty rather than
    // prefilling something meaningless.
    expect(readCompanyDefaultPaymentTerms(null)).toBeNull();
    expect(readCompanyDefaultPaymentTerms(undefined)).toBeNull();
    expect(readCompanyDefaultPaymentTerms({ settings: {} })).toBeNull();
    expect(readCompanyDefaultPaymentTerms({ settings: { default_payment_terms: '' } })).toBeNull();
    expect(readCompanyDefaultPaymentTerms({ settings: { default_payment_terms: '  ' } })).toBeNull();
    expect(readCompanyDefaultPaymentTerms({ settings: { default_payment_terms: 30 } })).toBeNull();
    expect(
      readCompanyDefaultPaymentTerms({ settings: { default_payment_terms: ['Net 30'] } }),
    ).toBeNull();
  });

  it('lives BESIDE the numeric defaults block, not inside it', () => {
    // Regression guard on the placement decision. KNOWN_DEFAULTS is numeric
    // end-to-end (coerceInt, numeric fallback, a Record<string, number> patch,
    // a type="number" input), so a string default stored under settings.defaults
    // would be silently coerced. If someone later "tidies" this key into that
    // block, this test fails rather than the value quietly becoming a number.
    expect(
      readCompanyDefaultPaymentTerms({ settings: { defaults: { default_payment_terms: 'Net 30' } } }),
    ).toBeNull();
    expect(KNOWN_DEFAULTS.some((d) => d.key === 'default_payment_terms')).toBe(false);
  });

  it('is independent of the saved custom-terms list', () => {
    // Two different settings keys with related names — the shop default is one
    // value; custom_payment_terms is the reusable picker list.
    const company = {
      settings: {
        default_payment_terms: 'Net 45',
        custom_payment_terms: ['Net 30, 1% late'],
      },
    };
    expect(readCompanyDefaultPaymentTerms(company)).toBe('Net 45');
    expect(readCustomPaymentTerms(company)).toEqual(['Net 30, 1% late']);
  });
});
