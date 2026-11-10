/**
 * The PO line amount rule (plan §3.5 "Money", criterion P7).
 *
 * THE CASES LIVE IN A FILE THREE RUNNERS READ. `__tests__/fixtures/vendorPoAmountCases.json` is
 * fed to `vendorPoLineAmount()` here, to `public.vendor_po_line_amount()` by the DB tests, and to
 * the Python QuickBooks payload builder, so a total on screen, in the status view and in
 * QuickBooks Online's `Amount` cannot drift apart by a cent. Add a case there, not here.
 */
import { describe, it, expect } from 'vitest';
import amountFixture from '../../fixtures/vendorPoAmountCases.json';
import {
  formatVendorPoAmount,
  formatVendorPoUnitPrice,
  isValidUnitPriceInput,
  roundUnitPrice,
  TO_BE_CONFIRMED,
  VENDOR_PO_UNIT_PRICE_PLACES,
  vendorPoLineAmount,
  vendorPoTotal,
} from '@/lib/purchasing/amount';

const amountCases = amountFixture.cases;

describe('vendorPoLineAmount — golden cases shared with SQL and Python (P7)', () => {
  it.each(amountCases.map((c) => [`${c.name}: ${c.quantity} × ${c.unit_price}`, c] as const))(
    '%s',
    (_label, c) => {
      expect(vendorPoLineAmount(c.quantity, c.unit_price)).toBe(c.amount);
    },
  );

  it('the fixture covers half-cent ties and five-place prices, so the rule is actually pinned', () => {
    // Guards the fixture itself: without an exact half-cent product, half-up and half-even (or
    // a float Math.round) would all pass, and without a 5-place price nothing proves the
    // numeric(16,5) precision survives.
    const halfCent = amountCases.filter((c) => {
      const cents = c.quantity * c.unit_price * 100;
      return Math.abs(cents - Math.trunc(cents) - 0.5) < 1e-6;
    });
    expect(halfCent.length).toBeGreaterThanOrEqual(4);
    const fivePlace = amountCases.filter((c) => /\.\d{5}$/.test(String(c.unit_price)));
    expect(fivePlace.length).toBeGreaterThanOrEqual(3);
    // Every case is priced: the QuickBooks builder refuses an unpriced line, so a null case here
    // would break the Python runner. Null prices are tested in each runner's own file.
    expect(amountCases.every((c) => Object.keys(c).sort().join() === 'amount,name,quantity,unit_price')).toBe(true);
    expect(amountCases.every((c) => typeof c.unit_price === 'number' && typeof c.amount === 'number')).toBe(true);
    expect(new Set(amountCases.map((c) => c.name)).size).toBe(amountCases.length);
  });
});

describe('vendorPoLineAmount — beyond the fixture (P7, L2)', () => {
  it('has no amount while the price is to be confirmed', () => {
    expect(vendorPoLineAmount(5, null)).toBeNull();
    expect(vendorPoLineAmount(5, undefined)).toBeNull();
  });

  it('prices at the stored precision: a sixth decimal is rounded off before multiplying', () => {
    // numeric(16,5) stores 1.000005 as 1.00001, so the saved PO computes from that.
    expect(VENDOR_PO_UNIT_PRICE_PLACES).toBe(5);
    expect(vendorPoLineAmount(100000, 1.000005)).toBe(100001);
  });

  it('has no amount for a quantity that is not a number', () => {
    expect(vendorPoLineAmount(Number.NaN, 2)).toBeNull();
  });
});

describe('vendorPoTotal — the sum of the rounded line amounts (P7)', () => {
  it('adds rounded line amounts, not unrounded products', () => {
    // 3 × 0.335 = 1.005 → 1.01 per line; summing the raw products first would give 2.01.
    const total = vendorPoTotal([
      { quantity: 3, unitPrice: 0.335 },
      { quantity: 3, unitPrice: 0.335 },
    ]);
    expect(total.total).toBe(2.02);
    expect(total.pricedLineCount).toBe(2);
    expect(total.unpricedLineCount).toBe(0);
  });

  it('adds exactly, with no float noise in the cents', () => {
    expect(vendorPoTotal([{ quantity: 1, unitPrice: 0.1 }, { quantity: 1, unitPrice: 0.2 }]).total).toBe(0.3);
  });

  it('counts lines still to be confirmed separately instead of treating them as $0', () => {
    const total = vendorPoTotal([
      { quantity: 2, unitPrice: 10 },
      { quantity: 1, unitPrice: null },
    ]);
    expect(total.total).toBe(20);
    expect(total.unpricedLineCount).toBe(1);
  });

  it('is zero for no lines', () => {
    expect(vendorPoTotal([])).toEqual({ total: 0, pricedLineCount: 0, unpricedLineCount: 0 });
  });
});

describe('unit price entry and display (P7, L2)', () => {
  it('rounds a unit price to the five places the column stores', () => {
    expect(roundUnitPrice(1.234565)).toBe(1.23457);
    expect(roundUnitPrice(2)).toBe(2);
  });

  it('accepts up to five decimals while typing, and nothing signed or exponential', () => {
    expect(isValidUnitPriceInput('')).toBe(true);
    expect(isValidUnitPriceInput('12')).toBe(true);
    expect(isValidUnitPriceInput('12.')).toBe(true);
    expect(isValidUnitPriceInput('0.12345')).toBe(true);
    expect(isValidUnitPriceInput('.5')).toBe(true);
    expect(isValidUnitPriceInput('0.123456')).toBe(false);
    expect(isValidUnitPriceInput('-1')).toBe(false);
    expect(isValidUnitPriceInput('1e3')).toBe(false);
    expect(isValidUnitPriceInput('1,000')).toBe(false);
  });

  it('prints TBC for a price to be confirmed (L2)', () => {
    expect(TO_BE_CONFIRMED).toBe('TBC');
    expect(formatVendorPoUnitPrice(null)).toBe('TBC');
    expect(formatVendorPoAmount(null)).toBe('TBC');
    expect(formatVendorPoUnitPrice(0.0125)).toBe('$0.0125');
    expect(formatVendorPoAmount(12.5)).toBe('$12.50');
  });
});
