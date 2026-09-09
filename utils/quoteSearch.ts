import type { QuoteWithRelations } from '@/types/quote';

/**
 * Client-side text match for the Quotes list.
 *
 * Quote search is deliberately NOT a database filter. The list query already
 * loads every quote for the company with its customer and line-item part names
 * joined, so matching in memory is instant and costs no round-trip per
 * keystroke — and it can reach fields the server-side shape can't search in one
 * query (a line item's part name and description).
 *
 * It lives here, apart from the page, so the behaviour the product actually has
 * is directly testable. A dead `filters.search` ILIKE on `quote_number` used to
 * sit in quotesAccess and no caller ever passed it, which made the access layer
 * read as though quote number were the only searchable field (#691).
 */
export function quoteMatchesSearch(quote: QuoteWithRelations, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;

  if (quote.quote_number?.toLowerCase().includes(q)) return true;
  if (quote.customers?.name?.toLowerCase().includes(q)) return true;

  return (quote.line_items ?? []).some(
    (li) =>
      li.parts?.part_name?.toLowerCase().includes(q) ||
      li.parts?.description?.toLowerCase().includes(q),
  );
}

/** Filter a quotes list by the search box text. Empty/blank query returns all. */
export function filterQuotesBySearch(
  quotes: QuoteWithRelations[],
  query: string,
): QuoteWithRelations[] {
  if (!query.trim()) return quotes;
  return quotes.filter((quote) => quoteMatchesSearch(quote, query));
}
