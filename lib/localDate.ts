/**
 * "Today", as the person looking at the screen would name it.
 *
 * WHY THIS EXISTS AS A MODULE. Postgres runs in UTC. For a shop in the Americas
 * that means UTC has already rolled into tomorrow for the last few hours of every
 * working day, so anything the server computes from its own clock disagrees with
 * the calendar on the wall — a job due Thursday goes "overdue" at 8pm Wednesday.
 * Every surface that compares a `date` column against today therefore has to send
 * the browser's date rather than let the database pick one.
 *
 * That rule was already understood; it just had four implementations. This is the
 * one, and the reason to import it rather than write `new Date()` inline is that
 * the obvious inline version is wrong in a way nothing catches:
 *
 *     new Date().toISOString().slice(0, 10)   // UTC — the exact bug
 *     `${y}-${m}-${d}` from getFullYear/getMonth/getDate   // local — correct
 *
 * `toISOString()` converts to UTC first, so it produces tomorrow's date all
 * evening. Building the string from the local getters never does.
 *
 * The matching rule on the SQL side: a query compares against a parameter, never
 * against CURRENT_DATE. `search_jobs_by_identifier` takes `p_today`, and the
 * insights SQL sandbox binds this value as `$2` — its validator refuses
 * CURRENT_DATE and now() outright so there is no second source of "today".
 */
export function todayLocalISODate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
