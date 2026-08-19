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

/**
 * How many jobs the jobs-list search may return.
 *
 * `search_jobs_by_identifier` resolves the matching ids, and `getAllJobs` then sends them
 * back as one un-chunked `.in('id', …)` — so this is a URL budget, not a product decision.
 *
 * **Measured, not guessed** — against the local gateway on 2026-08-08, with the real
 * `getAllJobs` select string (the `customers` / `quotes` / `job_parts` / `parts` embed block,
 * ~250 chars before any ids) and real UUIDs: 200 ids → **200 OK** at 7,791 bytes of URL,
 * 220 ids → **414 URI Too Long** at 8,531. The gateway's ceiling is 8 KB, and it does not
 * care that this query is longer than the ones `ID_CHUNK` was measured against — the cliff
 * lands in the same place.
 *
 * 120 (4,831 bytes) keeps the same headroom `ID_CHUNK` does, which the jobs query needs:
 * status, customer and overdue filters all add terms to the same URL.
 *
 * **Raising this is not free.** Past the ceiling the failure mode changes from a truncated
 * list — which the UI now admits to, see JobsPage.total — to a hard 414 that reads as
 * "no jobs". If the cap ever genuinely constrains a shop, the answer is a pager, not a
 * bigger number: `app/dashboard/[companyId]/inventory/count/page.tsx` documents that
 * escalation and the debounce/page-reset guard it needs.
 */
export const JOB_SEARCH_LIMIT = ID_CHUNK;

/**
 * How many parts the shop-wide count picker offers at once.
 *
 * A product limit wearing a transport limit's clothes, and it lives here so a test that mocks
 * the count access layer can still read it — the page renders the "showing the first N" hint
 * from this number, and importing it from the module under mock made the hint unrenderable.
 *
 * The picker used to be unbounded and filtered in the browser, which `parts.is_stocked` kept
 * honest: the biggest real list was ~722 rows. Dropping that column made every part stockable
 * and the same code would have loaded an 8,451-part catalogue unvirtualised, then fanned
 * `getBalancesForParts` out over ~71 `ID_CHUNK` pages instead of ~6.
 *
 * 200 is chosen against `ID_CHUNK`, not against the URL: the balances read that follows chunks
 * at 120, so this is two round trips, and it is comfortably more rows than anyone ticks in one
 * counting session. The page MUST say when it is capped — a capped list's one failure mode is
 * that the part you wanted is silently not on it.
 */
export const COUNT_PICKER_LIMIT = 200;
