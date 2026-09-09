import { describe, it, expect } from 'vitest';
import { filterQuotesBySearch, quoteMatchesSearch } from '@/utils/quoteSearch';
import type { QuoteWithRelations } from '@/types/quote';

// Only the fields the matcher reads are meaningful here; the rest of
// QuoteWithRelations is irrelevant to search and would be noise.
function quote(overrides: Partial<QuoteWithRelations>): QuoteWithRelations {
  return {
    id: 'quote-1',
    quote_number: 'Q-0001',
    ...overrides,
  } as QuoteWithRelations;
}

describe('quoteMatchesSearch', () => {
  it('matches on quote number', () => {
    expect(quoteMatchesSearch(quote({ quote_number: 'Q-0042' }), '0042')).toBe(true);
  });

  it('matches on customer name — the case the access layer never could', () => {
    const q = quote({ customers: { id: 'c1', name: 'Acme Aerospace' } });
    expect(quoteMatchesSearch(q, 'acme')).toBe(true);
  });

  it("matches on a line item's part name", () => {
    const q = quote({
      line_items: [{ parts: { part_name: 'F40750-1', description: 'Bracket' } }],
    } as Partial<QuoteWithRelations>);
    expect(quoteMatchesSearch(q, 'f40750')).toBe(true);
  });

  it("matches on a line item's part description", () => {
    const q = quote({
      line_items: [{ parts: { part_name: 'F40750-1', description: 'Titanium bracket' } }],
    } as Partial<QuoteWithRelations>);
    expect(quoteMatchesSearch(q, 'titanium')).toBe(true);
  });

  it('matches any line item, not just the first', () => {
    const q = quote({
      line_items: [
        { parts: { part_name: 'AAA-1', description: null } },
        { parts: { part_name: 'ZZZ-9', description: null } },
      ],
    } as Partial<QuoteWithRelations>);
    expect(quoteMatchesSearch(q, 'zzz')).toBe(true);
  });

  it('is case-insensitive and ignores surrounding whitespace', () => {
    const q = quote({ customers: { id: 'c1', name: 'Acme Aerospace' } });
    expect(quoteMatchesSearch(q, '  AEROSPACE  ')).toBe(true);
  });

  it('does not match when the term appears in no searched field', () => {
    const q = quote({
      quote_number: 'Q-0001',
      customers: { id: 'c1', name: 'Acme' },
      line_items: [{ parts: { part_name: 'AAA-1', description: 'Bracket' } }],
    } as Partial<QuoteWithRelations>);
    expect(quoteMatchesSearch(q, 'nothing-here')).toBe(false);
  });

  it('treats a blank query as matching everything', () => {
    expect(quoteMatchesSearch(quote({}), '   ')).toBe(true);
  });

  it('survives a quote with no customer and no line items', () => {
    const q = quote({ customers: undefined, line_items: undefined });
    expect(() => quoteMatchesSearch(q, 'acme')).not.toThrow();
    expect(quoteMatchesSearch(q, 'acme')).toBe(false);
  });

  it('treats ILIKE wildcards as literal text, not patterns', () => {
    // The deleted server-side path had to escape these before they reached
    // Postgres. In memory they are ordinary characters, so a term of '%' must
    // NOT behave as "match anything".
    const q = quote({ quote_number: 'Q-0001', customers: { id: 'c1', name: 'Acme' } });
    expect(quoteMatchesSearch(q, '%')).toBe(false);
    expect(quoteMatchesSearch(q, '_')).toBe(false);
    expect(quoteMatchesSearch(quote({ quote_number: 'Q_100%' }), '_100%')).toBe(true);
  });
});

describe('filterQuotesBySearch', () => {
  const quotes = [
    quote({ id: 'a', quote_number: 'Q-0001', customers: { id: 'c1', name: 'Acme' } }),
    quote({ id: 'b', quote_number: 'Q-0002', customers: { id: 'c2', name: 'Boeing' } }),
  ];

  it('returns only the matching quotes', () => {
    expect(filterQuotesBySearch(quotes, 'boeing').map((q) => q.id)).toEqual(['b']);
  });

  it('returns the original list unchanged for a blank query', () => {
    expect(filterQuotesBySearch(quotes, '')).toBe(quotes);
    expect(filterQuotesBySearch(quotes, '   ')).toBe(quotes);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterQuotesBySearch(quotes, 'lockheed')).toEqual([]);
  });
});
