-- ============================================================================
-- ONE definition of "open quote", called by the quotes list, the dashboard tile
-- AND the insights AI.
-- ============================================================================
-- The bug this closes, and it is is_job_late() all over again. Asked "how many
-- open quotes do we have?", the assistant answered 16, then 6 in the next breath,
-- and 11 in another thread. ai_chat_messages.tool_trace holds all three queries,
-- so none of it was invented -- there were simply three readings of "open" and
-- nothing that preferred one:
--
--   16   status = 'active'
--   11   the full filter set, but COUNT(*) over a JOIN to quote_line_items,
--        so it counted line-item rows rather than quotes
--    6   status = 'active' AND expiration_date >= $2 AND NOT EXISTS (job)
--
-- And the dashboard tile ALSO said 6, by a third route again -- status='active'
-- AND converted_at IS NULL, with no expiry test at all (20260902..., the fix for
-- a tile that read 25 where 11 were live). The tile and the assistant agreed on
-- that screen BY COINCIDENCE, on data where the two readings happen to coincide.
-- Two numbers agreeing for different reasons is not agreement; it is the same
-- bug waiting for a quote to expire.
--
-- RESOLVED IN FAVOUR OF THREE CONDITIONS: active, not won, not lapsed.
--
--   * `converted_at IS NULL`, not `NOT EXISTS (SELECT 1 FROM jobs ...)`. Winning
--     a quote stamps converted_at; the jobs lookup is a second way of asking the
--     same question that also drags in a table and can differ if a job is later
--     archived. One column, on the row being judged.
--   * `expiration_date < today` is NOT open, which CHANGES THE TILE'S NUMBER.
--     A lapsed quote is not work you can still win -- it is work you must re-quote
--     -- and a pipeline count that includes it overstates what is in play. This is
--     the reading semantics.md already used for "Quote pipeline worth", so it also
--     makes the count and the value agree, which they did not before.
--   * A quote with NO expiration_date never lapses. The column is nullable and a
--     shop that does not date its quotes has not thereby closed them.
--
-- deleted_at IS NOT PART OF THIS. Archived is not a reading of "open" -- it is
-- whether the row is on the books at all, and every list, count and picker
-- applies it separately (and for the AI it is applied by the ai_readonly_select
-- policy, which is why semantics.md must not restate it).
--
-- IMMUTABLE and taking p_today rather than reading CURRENT_DATE, for the reason
-- is_job_late() gives: Postgres is UTC and a shop in Halifax rolls over three
-- hours later, so the caller's day boundary is a parameter everywhere here. It is
-- also the only form the AI can call -- the SQL validator rejects CURRENT_DATE
-- and every other clock function outright.
--
-- STRICT is deliberately NOT used, same as is_job_late(): a NULL expiration_date
-- must yield TRUE/FALSE on the other conditions, not NULL, or a quote with no
-- date silently vanishes from a count of open AND a count of closed.

CREATE OR REPLACE FUNCTION public.is_quote_open(
    p_status          text,
    p_converted_at    timestamptz,
    p_expiration_date date,
    p_today           date
) RETURNS boolean
    LANGUAGE sql
    IMMUTABLE
    PARALLEL SAFE
AS $$
    SELECT p_status = 'active'
       AND p_converted_at IS NULL
       AND (p_expiration_date IS NULL OR p_today IS NULL OR p_expiration_date >= p_today)
$$;

COMMENT ON FUNCTION public.is_quote_open(text, timestamptz, date, date) IS
  'The single definition of an open quote: still genuinely winnable. Active, not '
  'already won (converted_at IS NULL -- winning stamps it and leaves status alone, '
  'which is what made a tile read 25 where 11 were live), and not lapsed '
  '(expiration_date in the future, or absent -- an undated quote never expires). '
  'Archived rows are NOT this function''s business: deleted_at is whether the row is '
  'on the books, applied separately by every list and, for the AI, by the '
  'ai_readonly_select policy. p_today is the CALLER''s local date, never CURRENT_DATE: '
  'the database is UTC, and the insights SQL validator rejects clock functions outright. '
  'Called by the insights AI as public.is_quote_open(status, converted_at, '
  'expiration_date, $2) per the "Open quote" section of api/services/ai/semantics.md, '
  'and mirrored in TypeScript by isQuoteOpen() in utils/quoteStatus.ts -- the mirror is '
  'pinned to this function by a shared golden-case fixture, '
  '__tests__/fixtures/openQuoteCases.json, fed to both by two suites.';

-- Browser roles need EXECUTE (the quotes list and the dashboard tile reach it
-- through the mirror today, but a future RPC or view would call it directly), and
-- so does the insights sandbox, which writes it into its own SELECT. REVOKE FROM
-- PUBLIC takes jigged_ai_readonly with it -- it is a member of PUBLIC like every
-- other role -- so that grant is not optional decoration.
--
-- Deliberately reachable from the browser, and that is the justification
-- function_execute_leaks() should read: this is a pure scalar over four values the
-- caller already supplied. It touches no table, so it is not SECURITY DEFINER, it
-- reads nothing it was not handed, and calling it discloses nothing.
REVOKE EXECUTE ON FUNCTION public.is_quote_open(text, timestamptz, date, date) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.is_quote_open(text, timestamptz, date, date)
    TO authenticated, service_role, jigged_ai_readonly;
