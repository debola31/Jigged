// Single source of truth for escaping user-supplied search terms before they go
// into a Supabase/PostgREST query. Two shapes exist in this codebase, and each
// needs different handling — pick the function that matches the call:
//
//   - `.ilike(column, `%${escapeIlikePattern(term)}%`)`  → escapeIlikePattern
//   - `.or(`col.ilike.${orIlikeValue(term)}`)`           → orIlikeValue
//
// Do NOT interpolate a raw term into a `.or()` string: PostgREST parses that
// string, so a term containing `)`/`,`/`.` (e.g. a part named `F40750-1 (REX-76)`)
// corrupts the filter and silently returns zero rows.

const MAX_SEARCH_LEN = 100;

/**
 * Escape ILIKE wildcards so a user's `% _ \` match literally. Use for the
 * `.ilike(column, `%${escapeIlikePattern(term)}%`)` shape, where postgrest-js
 * sends the value as its own query-param (reserved chars are already safe).
 */
export function escapeIlikePattern(search: string): string {
  return search
    .substring(0, MAX_SEARCH_LEN)
    .replace(/\\/g, '\\\\') // escape backslash first
    .replace(/%/g, '\\%') // literal %
    .replace(/_/g, '\\_'); // literal _
}

/**
 * Build a PostgREST-safe, double-quoted ILIKE value for use inside a `.or()`
 * filter string, e.g. `part_name.ilike.${orIlikeValue(term)}`.
 *
 * Double-quoting makes PostgREST treat reserved chars (`,` `.` `(` `)` `:`)
 * literally instead of parsing them as filter syntax — this is what fixes
 * searches for names like `F40750-1 (REX-76)`. Built on escapeIlikePattern
 * (wildcards), then escaped again for the double-quoted-value layer.
 */
export function orIlikeValue(search: string): string {
  const pattern = `%${escapeIlikePattern(search)}%`;
  // PostgREST double-quoted value layer: escape backslash and double-quote.
  const forQuotes = pattern.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${forQuotes}"`;
}
