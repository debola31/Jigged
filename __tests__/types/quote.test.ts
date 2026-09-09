import {
  calculateUnitPriceFromMarkup,
  calculateMarkupFromUnitPrice,
  calculateTotalPrice,
  isQuoteOpen,
  quoteToFormData,
} from '@/types/quote';
import type { Quote, QuoteWithRelations } from '@/types/quote';
import openQuoteCases from '../fixtures/openQuoteCases.json';

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

  it('rounds to 6 decimal places (matches numeric(10,6) markup column)', () => {
    // $139.39 from $103.25 = ((139.39 - 103.25) / 103.25) * 100 = 35.002421...
    expect(calculateMarkupFromUnitPrice(103.25, 139.39)).toBe(35.002421);
  });
});

describe('unit-price ⇄ markup round-trip', () => {
  // A unit price the user types must survive the back-solve-to-markup →
  // store-as-numeric(10,6) → recompute-price path and land back on the exact
  // cent. The old numeric(5,2) (2-dp markup) quantized achievable prices ~1.4¢
  // apart near a typical base, so $140.00 on a $139.98 base snapped to $139.99.
  // numeric(10,6) (6-dp markup) round-trips exactly for any base < $1,000,000.
  const cases: Array<[base: number, typedPrice: number]> = [
    [139.98, 140], // the reported bug: base just over the old $100 safe limit
    [139.98, 140.01],
    [103.25, 139.39],
    [100.01, 137.77],
    [1000.0, 1234.56],
    [9999.99, 12500.0], // large base — still well under the $1M limit
  ];

  it.each(cases)('base $%s, typed price $%s round-trips to the cent', (base, typedPrice) => {
    const markup = calculateMarkupFromUnitPrice(base, typedPrice);
    expect(markup).not.toBeNull();
    expect(calculateUnitPriceFromMarkup(base, markup as number)).toBe(typedPrice);
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

describe('quoteToFormData — customer note', () => {
  // The form binds this to a TextField, which cannot hold null. If the mapping ever leaks a null
  // through, React flips the input from controlled to uncontrolled on the first quote that has no
  // note — every one of them, on the edit path.
  function quoteWithNote(note: string | null): QuoteWithRelations {
    return {
      id: 'quote-1',
      company_id: 'company-1',
      quote_number: 'Q-0001',
      customer_id: 'customer-1',
      billing_address_id: 'addr-1',
      shipping_address_id: 'addr-1',
      contact_id: 'contact-1',
      lead_time_text: '14 days',
      payment_terms: 'Net 30',
      customer_note: note,
      expiration_date: '2099-12-31',
      status: 'active',
      status_changed_at: null,
      converted_at: null,
      created_by: null,
      created_at: '2026-06-01T00:00:00Z',
      updated_at: '2026-06-01T00:00:00Z',
      line_items: [],
    } as unknown as QuoteWithRelations;
  }

  it('round-trips a note the shop wrote', () => {
    expect(quoteToFormData(quoteWithNote('Prices exclude freight.')).customer_note).toBe(
      'Prices exclude freight.',
    );
  });

  it("maps a quote with no note to '' rather than null", () => {
    expect(quoteToFormData(quoteWithNote(null)).customer_note).toBe('');
  });

  it("preserves the shop's own line breaks", () => {
    expect(quoteToFormData(quoteWithNote('One.\nTwo.')).customer_note).toBe('One.\nTwo.');
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
      lead_time_text: '14 days',
      payment_terms: 'Net 30',
      customer_note: null,
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

  it('carries each line’s per-item lead time through to its form entry', () => {
    const quote = makeQuote([
      { ...baseLine, id: 'li-1', sequence: 10, quantity: 5, lead_time_text: '2–3 weeks' },
      { ...baseLine, id: 'li-2', sequence: 20, quantity: 25, lead_time_text: '2–3 weeks' },
    ]);

    const form = quoteToFormData(quote);

    expect(form.parts[0].lead_time_text).toBe('2–3 weeks');
    expect(form.parts[1].lead_time_text).toBe('2–3 weeks');
  });

  it('maps a null per-item lead time through as null (line uses the quote default)', () => {
    const quote = makeQuote([
      { ...baseLine, id: 'li-1', sequence: 10, quantity: 5, lead_time_text: null },
    ]);

    const form = quoteToFormData(quote);

    expect(form.parts[0].lead_time_text).toBeNull();
  });
});


describe('isQuoteOpen', () => {
  // THE CASES LIVE IN A FILE THAT SQL ALSO READS.
  // __tests__/fixtures/openQuoteCases.json is fed to isQuoteOpen() here and to
  // public.is_quote_open() by api/tests/integration/test_open_quote_parity.py, so
  // the TypeScript mirror cannot drift from the definition the database and the
  // insights AI use. Add a case there, not here.
  //
  // The fixture pins `today`; isQuoteOpen reads the machine clock, so each case is
  // re-anchored to the same OFFSET from the real today. That keeps the boundary
  // cases (expires today / yesterday) meaningful on any machine, on any day.
  const fixtureToday = Date.parse(`${openQuoteCases.today}T00:00:00Z`);

  function reanchor(date: string | null): string | null {
    if (date === null) return null;
    const offsetDays = Math.round((Date.parse(`${date}T00:00:00Z`) - fixtureToday) / 86_400_000);
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + offsetDays);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  it.each(openQuoteCases.cases.map((c) => [c.name, c] as const))(
    'golden case: %s',
    (_name, c) => {
      expect(
        isQuoteOpen({
          status: c.status as Quote['status'],
          converted_at: c.converted_at,
          expiration_date: reanchor(c.expiration_date),
        }),
      ).toBe(c.open);
    },
  );

  it('covers both sides of the day boundary, so a strict < is actually pinned', () => {
    // Guards the fixture itself: a case list that never exercises "expires today"
    // and "expired yesterday" would let < and <= both pass, and that one character
    // is a whole day of quotes -- the last day a shop can still win the work.
    const dates = openQuoteCases.cases.map((c) => c.expiration_date);
    expect(dates).toContain(openQuoteCases.today);
    expect(dates).toContain('2026-09-08');
    expect(openQuoteCases.cases.find((c) => c.expiration_date === openQuoteCases.today)?.open).toBe(
      true,
    );
    expect(openQuoteCases.cases.find((c) => c.expiration_date === '2026-09-08')?.open).toBe(false);
  });

  it('separates "won" from "expired", which is the bug that produced 16 and 6', () => {
    // A converted quote keeps status 'active' forever. If this ever passes with
    // the converted_at condition deleted, the fixture has stopped isolating it.
    expect(
      isQuoteOpen({
        status: 'active',
        converted_at: '2026-09-01T12:00:00+00:00',
        expiration_date: reanchor('2026-10-01'),
      }),
    ).toBe(false);
  });
});
