/**
 * PO and RFQ numbering — the preview and the checks the settings dialog runs before the RPC does
 * (plan §3.2 "Numbering and settings", criteria N1 and N2).
 *
 * A number is `prefix + next`, zero-padded to the minimum digits and never truncated. A PO number
 * is at most 11 characters because QuickBooks Desktop's `refNumber` is; RFQs never go to QuickBooks.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PURCHASING_SERIES,
  PURCHASING_PREFIX_PATTERN,
  VENDOR_PO_NUMBER_MAX_LENGTH,
  formatPurchasingDocumentNumber,
  previewPurchasingDocumentNumber,
  validatePurchasingNumbering,
} from '@/lib/purchasing/numbering';

describe('defaults (N1)', () => {
  it('starts each company at PO-0001 and RFQ-0001', () => {
    expect(DEFAULT_PURCHASING_SERIES).toEqual({
      vendor_purchase_order: { prefix: 'PO-', nextNumber: 1, minDigits: 4 },
      vendor_rfq: { prefix: 'RFQ-', nextNumber: 1, minDigits: 4 },
    });
    const po = DEFAULT_PURCHASING_SERIES.vendor_purchase_order;
    expect(formatPurchasingDocumentNumber(po.prefix, po.nextNumber, po.minDigits)).toBe('PO-0001');
    const rfq = DEFAULT_PURCHASING_SERIES.vendor_rfq;
    expect(formatPurchasingDocumentNumber(rfq.prefix, rfq.nextNumber, rfq.minDigits)).toBe('RFQ-0001');
  });

  it('caps a PO number at QuickBooks Desktop\'s 11 characters', () => {
    expect(VENDOR_PO_NUMBER_MAX_LENGTH).toBe(11);
  });
});

describe('formatPurchasingDocumentNumber (N2)', () => {
  it('zero-pads to the minimum digits', () => {
    expect(formatPurchasingDocumentNumber('PO-', 7, 4)).toBe('PO-0007');
    expect(formatPurchasingDocumentNumber('PO-', 1043, 4)).toBe('PO-1043');
  });

  it('continues a QuickBooks sequence with an empty prefix and one digit', () => {
    expect(formatPurchasingDocumentNumber('', 1043, 1)).toBe('1043');
  });

  it('never truncates a number longer than the minimum', () => {
    expect(formatPurchasingDocumentNumber('PO-', 123456, 4)).toBe('PO-123456');
  });
});

describe('the prefix character set (N2)', () => {
  it('allows letters, digits and hyphens, up to six, including none', () => {
    for (const ok of ['', 'PO-', 'P', 'ACME-1', 'po-']) expect(PURCHASING_PREFIX_PATTERN.test(ok), ok).toBe(true);
    for (const bad of ['PO_', 'P O', 'PO/', 'PURCHASE', 'Ünï']) expect(PURCHASING_PREFIX_PATTERN.test(bad), bad).toBe(false);
  });
});

describe('previewPurchasingDocumentNumber — the live preview (N2)', () => {
  it('reads "Next: PO-1043 · 7 of 11 characters"', () => {
    expect(
      previewPurchasingDocumentNumber({ kind: 'vendor_purchase_order', prefix: 'PO-', nextNumber: 1043, minDigits: 4 }),
    ).toEqual({
      ok: true,
      number: 'PO-1043',
      length: 7,
      maxLength: 11,
      caption: 'Next: PO-1043 · 7 of 11 characters',
      errors: {},
    });
  });

  it('has no character budget for RFQs', () => {
    expect(
      previewPurchasingDocumentNumber({ kind: 'vendor_rfq', prefix: 'RFQ-', nextNumber: 1, minDigits: 4 }),
    ).toMatchObject({ ok: true, number: 'RFQ-0001', maxLength: null, caption: 'Next: RFQ-0001' });
  });

  it('shows no number while the settings are invalid', () => {
    expect(
      previewPurchasingDocumentNumber({ kind: 'vendor_purchase_order', prefix: 'PO_', nextNumber: 1, minDigits: 4 }),
    ).toMatchObject({ ok: false, number: null, caption: null });
  });
});

describe('validatePurchasingNumbering — refused before the database refuses it (N2)', () => {
  const po = (over: Partial<Parameters<typeof validatePurchasingNumbering>[0]> = {}) =>
    validatePurchasingNumbering({ kind: 'vendor_purchase_order', prefix: 'PO-', nextNumber: 1043, minDigits: 4, ...over });

  it('accepts the defaults and an empty prefix', () => {
    expect(po()).toEqual({});
    expect(po({ prefix: '', minDigits: 1 })).toEqual({});
  });

  it('refuses a character outside letters, digits and hyphens', () => {
    expect(po({ prefix: 'PO_' })).toEqual({ prefix: 'A prefix can use letters, numbers and hyphens only.' });
  });

  it('refuses a prefix longer than six characters', () => {
    expect(po({ prefix: 'PURCHASE' })).toEqual({ prefix: 'A prefix can be at most 6 characters.' });
  });

  it('refuses a next number that is not a whole number of 1 or more', () => {
    for (const bad of [0, -5, 1.5, Number.NaN]) {
      expect(po({ nextNumber: bad }), String(bad)).toEqual({ nextNumber: 'The next number must be a whole number, 1 or more.' });
    }
  });

  it('refuses digits outside 1 to 8', () => {
    expect(po({ minDigits: 0 })).toEqual({ minDigits: 'Digits must be between 1 and 8.' });
    expect(po({ minDigits: 9 })).toEqual({ minDigits: 'Digits must be between 1 and 8.' });
  });

  it('refuses a 6-character prefix with 6 digits — 12 characters is over the limit', () => {
    expect(po({ prefix: 'ACME-P', minDigits: 6, nextNumber: 1 })).toEqual({
      minDigits: 'A 6-character prefix and 6 digits make 12 characters; PO numbers can have at most 11 (QuickBooks Desktop\'s limit).',
    });
  });

  it('accepts PO-99999999 at exactly 11 characters, and refuses the number after it', () => {
    expect(po({ nextNumber: 99999999 })).toEqual({});
    expect(po({ nextNumber: 100000000 })).toEqual({
      nextNumber: 'PO-100000000 is 12 characters; PO numbers can have at most 11 (QuickBooks Desktop\'s limit).',
    });
  });

  it('has no length limit for RFQs', () => {
    expect(validatePurchasingNumbering({ kind: 'vendor_rfq', prefix: 'RFQ-', nextNumber: 100000000, minDigits: 8 })).toEqual({});
  });

  it('refuses a next number at or below the highest already issued under the prefix', () => {
    expect(po({ nextNumber: 1042, highestIssuedNumber: 1042 })).toEqual({
      nextNumber: 'PO-1042 is already used. Start above 1042.',
    });
    expect(po({ nextNumber: 1043, highestIssuedNumber: 1042 })).toEqual({});
    expect(po({ nextNumber: 1, highestIssuedNumber: null })).toEqual({});
  });
});
