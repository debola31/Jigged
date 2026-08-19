/**
 * The parts list's completeness verdict, as a pure function — because the thing
 * that broke in production was not the SQL, it was what the UI did when the SQL
 * did not answer.
 *
 * On 2026-08-19 `get_priceable_part_ids` hit the 8s statement timeout for a
 * whole afternoon. The page caught the rejection and substituted an EMPTY SET,
 * so every part in the shop rendered ⚠ Incomplete — a definitive negative
 * manufactured out of a failed read. CLAUDE.md names this exact failure:
 * "Couldn't check" is never "denied."
 *
 * So the verdict is deliberately three-valued, and `null` is load-bearing:
 *
 *   true  — priceable, ready to quote
 *   false — genuinely not priceable; show the ⚠
 *   null  — WE DO NOT KNOW (loading, or the RPC failed); show nothing
 *
 * Keeping this out of the component is what lets the null case be asserted
 * rather than described.
 */

export type CompletenessFilter = 'all' | 'complete' | 'incomplete';

/**
 * Stamp each row with its three-valued priceability.
 *
 * @param priceableIds the RPC's answer, or `null` when there isn't one yet.
 */
export function stampPriceability<T extends { id: string }>(
  rows: readonly T[],
  priceableIds: ReadonlySet<string> | null,
): (T & { is_priceable: boolean | null })[] {
  return rows.map((row) => ({
    ...row,
    is_priceable: priceableIds === null ? null : priceableIds.has(row.id),
  }));
}

/** Narrow stamped rows by the completeness filter. Only ever called with verdicts in hand. */
export function filterByCompleteness<T extends { is_priceable: boolean | null }>(
  rows: readonly T[],
  filter: CompletenessFilter,
): T[] {
  if (filter === 'complete') return rows.filter((r) => r.is_priceable === true);
  if (filter === 'incomplete') return rows.filter((r) => r.is_priceable === false);
  return [...rows];
}

/**
 * The whole decision: stamp, then narrow — but only narrow when there is
 * something to narrow ON.
 *
 * With no verdict the filter STANDS DOWN to "all" rather than partitioning rows
 * it has no answer for. The UI also disables the control in that state, but this
 * is the load-bearing half: a filter left on "Incomplete" from a previous render
 * would otherwise empty the grid the moment the RPC failed, and present that
 * emptiness as a fact about the shop's data.
 */
export function selectPartRows<T extends { id: string }>(
  rows: readonly T[],
  priceableIds: ReadonlySet<string> | null,
  filter: CompletenessFilter,
): (T & { is_priceable: boolean | null })[] {
  const stamped = stampPriceability(rows, priceableIds);
  if (priceableIds === null) return stamped;
  return filterByCompleteness(stamped, filter);
}
