-- search_jobs_by_identifier stops re-deriving "overdue" and calls public.is_job_late.
--
-- Behaviour DOES change, in one direction and on purpose: a job whose production is
-- `completed` but which has not fully shipped is now overdue. The inline branch this
-- replaces required production_status IN ('not_started','in_progress'), so finished work
-- sitting on the bench dropped off the list; is_job_late excludes only 'cancelled'. See
-- 20260827114506 for why delivery is the promise, and expect the demo companies to go
-- from 6 overdue to 7 (the extra is J-0021 in each).
--
-- CREATE OR REPLACE, not DROP + CREATE: the signature and return type are identical, so
-- the ACL and the COMMENT that 20260809001523 had to re-issue after its own DROP both
-- survive untouched. Nothing else in the body is edited -- it is reproduced verbatim from
-- 20260809001523, which is still the newest definition of this function.
--
-- COALESCE(p_today, current_date) is kept exactly as it was. The app always sends
-- p_today; the coalesce is there so an omitted date falls back to the server's day
-- instead of comparing against NULL and reporting that nothing is overdue.

CREATE OR REPLACE FUNCTION public.search_jobs_by_identifier(
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
                OR public.is_job_late(j.due_date, j.production_status,
                                      j.fulfillment_status,
                                      COALESCE(p_today, current_date)))
    )
    -- count(*) OVER () is evaluated across the whole `filtered` set before LIMIT, so the
    -- total is exact no matter how much the cap cuts. Rush jobs first, then newest;
    -- job_id is the tiebreak so the retained set is deterministic when created_at ties.
    SELECT f.job_id, f.match_source, count(*) OVER ()::bigint
      FROM filtered f
     ORDER BY f.is_hot DESC, f.created_at DESC NULLS LAST, f.job_id
     LIMIT v_limit;
END $$;

