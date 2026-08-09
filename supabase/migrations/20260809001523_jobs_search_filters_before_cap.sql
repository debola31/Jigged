-- #688 — the jobs-list search cap now applies to the FINAL set, in a meaningful order,
-- and reports how much it cut.
--
-- Three defects, one function:
--
--   1. ORDER BY m.job_id existed only to serve DISTINCT ON. It is not a ranking, so the
--      100 rows that survived LIMIT were a UUID lottery — not the newest, not the most
--      relevant, just whichever ids sorted first.
--   2. The status / customer / overdue filters were applied by the CALLER, on the main
--      query, AFTER this cap. The default jobs view hides closed jobs and a busy
--      customer's history is mostly closed, so the cap filled with closed jobs that were
--      then discarded and the handful of open ones left was a fraction of what existed.
--   3. deleted_at was never filtered here, so archived jobs consumed cap slots and were
--      then thrown away by the caller's .is('deleted_at', null) — making (2) worse, and a
--      live instance of the repo's most-violated rule.
--
-- The fix is not a bigger number. The caller round-trips these ids back through a
-- PostgREST GET as .in('id', …), and lib/queryLimits.ts records the measured cliff
-- (200 ids OK, 220 → 414 URI Too Long), so raising the cap past ~200 would trade a
-- silent truncation for a silent request failure. Instead the ~120 rows become the
-- RIGHT ~120 — every filter applied before the cap, ordered hot-then-newest — and
-- total_matches lets the UI say "showing 120 of 843" out loud.
--
-- The return type gains total_matches, so CREATE OR REPLACE is unavailable: this is a
-- DROP + CREATE. That destroys both the ACL and the COMMENT, which are re-issued at the
-- bottom.
--
-- The new parameters carry DEFAULTs, which is safe precisely because the DROP leaves no
-- second signature for a two-arg call to be ambiguous against (42725). It also earns
-- something at the call site: Supabase's type generator marks defaulted parameters
-- optional, so `filters.customerId` being undefined omits the key instead of forcing a
-- null through an argument type that is generated as non-nullable.

DROP FUNCTION IF EXISTS public.search_jobs_by_identifier(uuid, text);

CREATE FUNCTION public.search_jobs_by_identifier(
    p_company_id  uuid,
    p_query       text,
    -- Exact 'production:fulfillment' pairs for the selected lifecycle stages, built by
    -- stagesToStatusPairs() in types/job.ts. That helper enumerates the 12 combinations
    -- through getJobLifecycleStage itself rather than reading the hand-maintained
    -- STAGE_TO_JOB_FILTERS inverse: the latter ANDs two IN lists, which is exact for a
    -- single stage but a SUPERSET for a multi-select ({not_started, partially_shipped}
    -- would also admit in_progress+unshipped). A superset would make total_matches
    -- over-count and the on-screen "of N" lie, which is the whole thing we are fixing.
    -- NULL = no stage narrowing. '{}' = the user ticked nothing, which matches nothing.
    p_stage_pairs text[] DEFAULT NULL,
    p_customer_id uuid    DEFAULT NULL,
    p_overdue     boolean DEFAULT false,
    -- The CALLER's local date. Mirrors applyOverdueJobsFilter / todayLocalISODate in
    -- utils/jobsAccess.ts: the overdue day boundary is the shop's local midnight, not
    -- UTC's. Taking it as a parameter keeps the two definitions agreeing; current_date
    -- here would flip a job overdue in the search but not in the list for part of a day.
    p_today       date    DEFAULT NULL,
    p_limit       integer DEFAULT 100
) RETURNS TABLE("job_id" uuid, "match_source" text, "total_matches" bigint)
    LANGUAGE plpgsql STABLE SECURITY INVOKER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
    v_pattern text;
    -- Hard ceiling, enforced here so no caller can talk the function past the URL cliff
    -- described above. Clamped rather than rejected: a bad p_limit should not error out
    -- a search box.
    v_limit int := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 200);
BEGIN
    IF p_query IS NULL OR length(trim(p_query)) = 0 THEN
        RETURN;
    END IF;
    v_pattern := '%' || replace(replace(replace(trim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%';

    RETURN QUERY
    WITH deduped AS (
        -- One row per job, carrying its highest-priority match_source. The ORDER BY here
        -- is required by DISTINCT ON and is NOT the output order — see the final SELECT.
        SELECT DISTINCT ON (m.job_id) m.job_id, m.match_source
          FROM (
              SELECT j.id AS job_id, 'packing_slip'::text AS match_source, 1::int AS priority
                FROM public.jobs j
                JOIN public.job_parts jp ON jp.job_id = j.id
                JOIN public.shipment_line_items sli ON sli.job_part_id = jp.id
                JOIN public.shipments s ON s.id = sli.shipment_id
               WHERE j.company_id = p_company_id
                 AND j.deleted_at IS NULL
                 AND s.voided_at IS NULL
                 AND s.packing_slip_number ILIKE v_pattern
              UNION ALL
              SELECT j.id, 'job_number'::text, 2
                FROM public.jobs j
               WHERE j.company_id = p_company_id
                 AND j.deleted_at IS NULL
                 AND j.job_number ILIKE v_pattern
              UNION ALL
              SELECT j.id, 'customer_po'::text, 3
                FROM public.jobs j
               WHERE j.company_id = p_company_id
                 AND j.deleted_at IS NULL
                 AND j.customer_po_number ILIKE v_pattern
              UNION ALL
              -- customers.deleted_at and parts.deleted_at are deliberately NOT filtered.
              -- The jobs list renders an archived customer's and an archived part's name
              -- (retained-FK by-id reads, which architecture.md §16 exempts from the
              -- filter rule), so a name visible on screen has to stay searchable.
              SELECT j.id, 'customer'::text, 4
                FROM public.jobs j
                JOIN public.customers c ON c.id = j.customer_id
               WHERE j.company_id = p_company_id
                 AND j.deleted_at IS NULL
                 AND c.name ILIKE v_pattern
              UNION ALL
              SELECT j.id, 'part'::text, 5
                FROM public.jobs j
                JOIN public.job_parts jp ON jp.job_id = j.id
                JOIN public.parts p ON p.id = jp.part_id
               WHERE j.company_id = p_company_id
                 AND j.deleted_at IS NULL
                 AND p.part_name ILIKE v_pattern
          ) AS m
         ORDER BY m.job_id, m.priority
    ),
    filtered AS (
        -- Every filter the caller used to apply AFTER the cap now applies BEFORE it, so
        -- the rows that survive are rows the user would actually have seen.
        SELECT d.job_id, d.match_source, j.is_hot, j.created_at
          FROM deduped d
          JOIN public.jobs j ON j.id = d.job_id
         WHERE (p_stage_pairs IS NULL
                OR (j.production_status || ':' || j.fulfillment_status) = ANY (p_stage_pairs))
           AND (p_customer_id IS NULL OR j.customer_id = p_customer_id)
           -- COALESCE on p_today, not a bare comparison: `due_date < NULL` is NULL,
           -- so an omitted date would quietly report "nothing is overdue" rather
           -- than falling back to the server's idea of today. The app always sends
           -- it; this is about the default not being a trap.
           AND (NOT COALESCE(p_overdue, false)
                OR (j.due_date IS NOT NULL
                    AND j.due_date < COALESCE(p_today, current_date)
                    AND j.fulfillment_status <> 'fully_shipped'
                    AND j.production_status IN ('not_started', 'in_progress')))
    )
    -- count(*) OVER () is evaluated across the whole `filtered` set before LIMIT, so the
    -- total is exact no matter how much the cap cuts. Rush jobs first, then newest;
    -- job_id is the tiebreak so the retained set is deterministic when created_at ties.
    SELECT f.job_id, f.match_source, count(*) OVER ()::bigint
      FROM filtered f
     ORDER BY f.is_hot DESC, f.created_at DESC NULLS LAST, f.job_id
     LIMIT v_limit;
END $$;

ALTER FUNCTION public.search_jobs_by_identifier(uuid, text, text[], uuid, boolean, date, integer) OWNER TO postgres;

-- The DROP took the ACL with it. The baseline granted ALL to anon as well; that is not
-- re-issued. Under SECURITY INVOKER anon holds no user_company_access row and so already
-- saw zero rows — dropping the grant is hygiene, not a behaviour change.
REVOKE EXECUTE ON FUNCTION public.search_jobs_by_identifier(uuid, text, text[], uuid, boolean, date, integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.search_jobs_by_identifier(uuid, text, text[], uuid, boolean, date, integer) TO authenticated, service_role;

-- The DROP took the COMMENT too.
COMMENT ON FUNCTION public.search_jobs_by_identifier(uuid, text, text[], uuid, boolean, date, integer) IS
  'Extended jobs-list search across job_number, jobs.customer_po_number, customers.name, parts.part_name, shipments.packing_slip_number. Returns one row per matching non-archived job with its highest-priority match_source, plus total_matches — the exact count of matches AFTER every filter, so the UI can say "showing 120 of 843" instead of truncating silently (#688). Stage / customer / overdue filters are applied BEFORE the cap; they used to be applied by the caller after it, which cut into an arbitrary subset. Retained rows are hot first, then newest. p_limit is clamped to 200 because the caller round-trips these ids through a PostgREST .in() URL — see JOB_SEARCH_LIMIT in lib/queryLimits.ts; the escalation past that ceiling is a pager, not a bigger number. SECURITY INVOKER, so jobs/customers/parts RLS still enforces tenancy and p_company_id is only a narrowing filter.';
