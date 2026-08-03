/**
 * Limits imposed by the transport rather than by the domain.
 *
 * One home, because four files had independently picked the same wrong number and would have
 * been fixed one at a time.
 */

/**
 * How many ids fit in one PostgREST `.in()` before the URL is too long.
 *
 * **Measured, not guessed** — against the local gateway on 2026-08-01, with real UUIDs:
 * 200 ids → 200 OK, 220 ids → **414 URI Too Long**. The previous value of 500 therefore did not
 * "keep the IN () list well inside PostgREST's URL limits" as its comment claimed; it was over
 * the line by more than double, and a shop with more than ~200 stocked parts got a hard 414 on
 * every chunk rather than a truncated result.
 *
 * 120 leaves headroom for the rest of the query string (select lists, extra filters, the
 * `location_id` term some callers add) rather than sitting just under the cliff.
 */
export const ID_CHUNK = 120;
