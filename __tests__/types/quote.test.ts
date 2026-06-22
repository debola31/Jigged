import {
  calculateUnitPriceFromMarkup,
  calculateMarkupFromUnitPrice,
  calculateTotalPrice,
  quoteToFormData,
  leadTimeToDays,
  formatLeadTime,
} from '@/types/quote';
import type { QuoteWithRelations } from '@/types/quote';

describe('calculateUnitPriceFromMarkup', () => {
  it('calculates 0% markup correctly', () => {
    expect(calculateUnitPriceFromMarkup(100, 0)).toBe(100);
  });

  it('calculates 40% markup correctly', () => {
    // $100 at 40% markup = $140
    expect(calculateUnitPriceFromMarkup(100, 40)).toBe(140);
  });

  it('calculates 100% markup correctly', () => {
    // $50 at 100% markup = $100
    expect(calculateUnitPriceFromMarkup(50, 100)).toBe(100);
  });

  it('handles negative markup', () => {
    // $100 at -20% markup = $80
    expect(calculateUnitPriceFromMarkup(100, -20)).toBe(80);
  });

  it('returns null for NaN base cost', () => {
    expect(calculateUnitPriceFromMarkup(NaN, 40)).toBeNull();
  });

  it('returns null for negative base cost', () => {
    expect(calculateUnitPriceFromMarkup(-10, 40)).toBeNull();
  });

  it('returns null for NaN markup', () => {
    expect(calculateUnitPriceFromMarkup(100, NaN)).toBeNull();
  });

  it('handles 0 base cost', () => {
    expect(calculateUnitPriceFromMarkup(0, 40)).toBe(0);
  });

  it('rounds to 2 decimal places', () => {
    // $103.25 at 35% markup = 103.25 * 1.35 = 139.3875 → 139.39
    expect(calculateUnitPriceFromMarkup(103.25, 35)).toBe(139.39);
  });
});

describe('calculateMarkupFromUnitPrice', () => {
  it('back-calculates correctly for 40% markup', () => {
    // $140 from $100 base = 40%
    expect(calculateMarkupFromUnitPrice(100, 140)).toBe(40);
  });

  it('back-calculates correctly for 100% markup', () => {
    // $200 from $100 base = 100%
    expect(calculateMarkupFromUnitPrice(100, 200)).toBe(100);
  });

  it('returns null for 0 base cost', () => {
    expect(calculateMarkupFromUnitPrice(0, 100)).toBeNull();
  });

  it('returns null for negative base cost', () => {
    expect(calculateMarkupFromUnitPrice(-10, 100)).toBeNull();
  });

  it('returns null for NaN unit price', () => {
    expect(calculateMarkupFromUnitPrice(100, NaN)).toBeNull();
  });

  it('returns null for negative unit price', () => {
    expect(calculateMarkupFromUnitPrice(100, -50)).toBeNull();
  });

  it('handles price less than cost (negative markup)', () => {
    // $80 from $100 base = -20%
    expect(calculateMarkupFromUnitPrice(100, 80)).toBe(-20);
  });

  it('handles price equal to cost (0% markup)', () => {
    expect(calculateMarkupFromUnitPrice(100, 100)).toBe(0);
  });

  it('rounds to 2 decimal places', () => {
    // $139.39 from $103.25 = ((139.39 - 103.25) / 103.25) * 100 = 35.0024...
    expect(calculateMarkupFromUnitPrice(103.25, 139.39)).toBeCloseTo(35, 0);
  });
});

describe('calculateTotalPrice', () => {
  it('calculates total correctly', () => {
    expect(calculateTotalPrice(10, 25.50)).toBe(255);
  });

  it('returns null for null unit price', () => {
    expect(calculateTotalPrice(10, null)).toBeNull();
  });

  it('returns null for NaN unit price', () => {
    expect(calculateTotalPrice(10, NaN)).toBeNull();
  });

  it('returns null for 0 quantity', () => {
    expect(calculateTotalPrice(0, 25)).toBeNull();
  });

  it('returns null for negative quantity', () => {
    expect(calculateTotalPrice(-1, 25)).toBeNull();
  });
});

describe('leadTimeToDays', () => {
  it('passes calendar days through unchanged', () => {
    expect(leadTimeToDays(10, 'calendar_days')).toBe(10);
  });

  it('multiplies weeks by 7', () => {
    expect(leadTimeToDays(6, 'weeks')).toBe(42);
  });

  it('converts business days to calendar days (7/5, rounded up)', () => {
    // 10 business days → 14 calendar days
    expect(leadTimeToDays(10, 'business_days')).toBe(14);
    // 1 business day → ceil(1.4) = 2
    expect(leadTimeToDays(1, 'business_days')).toBe(2);
  });

  it('returns null for null/invalid/negative values', () => {
    expect(leadTimeToDays(null, 'weeks')).toBeNull();
    expect(leadTimeToDays(undefined, 'weeks')).toBeNull();
    expect(leadTimeToDays(NaN, 'weeks')).toBeNull();
    expect(leadTimeToDays(-1, 'weeks')).toBeNull();
  });
});

describe('formatLeadTime', () => {
  it('formats plural and singular by unit label', () => {
    expect(formatLeadTime(6, 'weeks')).toBe('6 weeks');
    expect(formatLeadTime(1, 'weeks')).toBe('1 week');
    expect(formatLeadTime(10, 'business_days')).toBe('10 business days');
    expect(formatLeadTime(1, 'business_days')).toBe('1 business day');
  });

  it('returns null when no value is set', () => {
    expect(formatLeadTime(null, 'weeks')).toBeNull();
    expect(formatLeadTime(undefined, null)).toBeNull();
  });

  it('falls back to the default unit when unit is missing', () => {
    expect(formatLeadTime(3, null)).toBe('3 business days');
  });
});

describe('quoteToFormData', () => {
  function makeQuote(lineItems: QuoteWithRelations['line_items']): QuoteWithRelations {
    return {
      id: 'quote-1',
      company_id: 'company-1',
      quote_number: 'Q-0001',
      customer_id: 'customer-1',
      billing_address_id: 'addr-1',
      shipping_address_id: 'addr-1',
      contact_id: 'contact-1',
      lead_time_days: 14,
      lead_time_value: 14,
      lead_time_unit: 'calendar_days',
      payment_terms: 'Net 30',
      expiration_date: '2099-12-31',
      status: 'active',
      status_changed_at: null,
      converted_at: null,
      created_by: null,
      created_at: '2026-06-01T00:00:00Z',
      updated_at: '2026-06-01T00:00:00Z',
      line_items: lineItems,
    };
  }

  const baseLine = {
    quote_id: 'quote-1',
    company_id: 'company-1',
    part_id: 'part-A',
    source_tier_id: 't1',
    unit_price: 100,
    total_price: 1000,
    markup_percent: 50,
    base_cost_per_unit: 66.67,
    is_quote_override: false,
    pricing_basis_snapshot: null,
    basis_unknown: false,
    created_at: '2026-06-01T00:00:00Z',
  };

  it('emits one entry per line item, sorted by sequence (multiple per part for options quotes)', () => {
    const quote = makeQuote([
      { ...baseLine, id: 'li-2', sequence: 20, quantity: 25 },
      { ...baseLine, id: 'li-1', sequence: 10, quantity: 5 },
    ]);

    const form = quoteToFormData(quote);

    // Both entries share the same part_id; order follows sequence.
    expect(form.parts).toHaveLength(2);
    expect(form.parts[0]).toMatchObject({ part_id: 'part-A', order_quantity: 5, line_item_id: 'li-1' });
    expect(form.parts[1]).toMatchObject({ part_id: 'part-A', order_quantity: 25, line_item_id: 'li-2' });
  });

  it('carries the override block through for override lines', () => {
    const quote = makeQuote([
      {
        ...baseLine,
        id: 'li-1',
        sequence: 10,
        quantity: 10,
        is_quote_override: true,
        unit_price: 999,
        markup_percent: null,
      },
    ]);

    const form = quoteToFormData(quote);

    expect(form.parts).toHaveLength(1);
    expect(form.parts[0].override).toEqual({ unit_price: 999, markup_percent: null });
  });
});
