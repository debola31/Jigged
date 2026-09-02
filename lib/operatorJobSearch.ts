/**
 * Narrowing the operator dispatch list to one job.
 *
 * Extracted from the jobs page so it can be asserted without mounting a client page that needs
 * Supabase, a station context and a router — the same reason `operatorNav.ts` lives here. It is a
 * pure predicate over rows already in memory: the list arrives fully materialized and unpaginated
 * (one readiness RPC per station, then one enrichment pass), so narrowing it costs a `useMemo` and
 * never a round trip.
 *
 * **It matches identity, not category.** Job number, part name, customer — the three things that
 * say WHICH job this is. `operation_name` is deliberately absent even though it sits right there on
 * the row: "what is running at Deburr" is already answered by switching stations or by the All
 * Stations lens, which groups by station. Adding it would duplicate that control and make this one
 * worse — typing `mill` would return every milling step in the plant, so a query aimed at one job
 * would answer with a category. There is a test pinning the absence.
 */
import type { OperatorJob } from '@/types/operator';

/** The row fields a query is matched against. Identity only — see the note above. */
function haystack(row: OperatorJob): Array<string | null | undefined> {
  return [row.job_number, row.part_name, row.customer_name];
}

/**
 * Case-insensitive substring match across a row's identifiers.
 *
 * `query` is expected pre-normalized (trimmed and lowercased) — `filterOperatorJobs` does that once
 * for the whole list rather than once per row. A blank query matches everything.
 */
export function jobMatchesQuery(row: OperatorJob, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  return haystack(row).some((field) => !!field && field.toLowerCase().includes(normalizedQuery));
}

/**
 * Narrow a dispatch list to the rows matching `query`.
 *
 * Returns the input array BY REFERENCE when the query is blank, so the overwhelmingly common
 * no-filter path allocates nothing and the `useMemo` downstream of it stays referentially stable.
 * Generic over the row type so the whole-plant list keeps its `work_center_*` fields — the caller
 * groups by station AFTER filtering, which is what stops empty station headers rendering.
 */
export function filterOperatorJobs<T extends OperatorJob>(rows: T[], query: string): T[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return rows;
  return rows.filter((row) => jobMatchesQuery(row, normalized));
}
