-- ============================================================================
-- Remove 'skipped' from job_operations.status
-- ============================================================================
--
-- The admin Job Detail page used to expose a "skip operation" control that
-- wrote 'skipped' to job_operations.status, letting an admin move past a step
-- without completing it. That control was unapproved. Operations must now be
-- completed sequentially in both the admin and operator views.
--
-- This migration pulls 'skipped' from the entire stack at the DB level:
--   1. Backfills any existing 'skipped' rows to 'completed' (the old
--      aggregation already treated them equivalently, so no parent
--      job_part/job status flips occur).
--   2. Tightens the CHECK constraint on job_operations.status.
--   3. Rewrites the two readiness functions that referenced 'skipped' as a
--      terminal predecessor state so the only "done" state is 'completed'.
--
-- job_materials.status keeps its own ('pending'|'consumed'|'skipped') enum —
-- that table is unrelated and not touched here.

BEGIN;

-- 1. Backfill skipped → completed. Synthesize completed_at from updated_at
--    for any row that was skipped without a completion timestamp, so the new
--    inline "Completed {time}" UI doesn't render blank.
UPDATE job_operations
SET
    status = 'completed',
    completed_at = COALESCE(completed_at, updated_at),
    updated_at = NOW()
WHERE status = 'skipped';

-- 2. Replace the CHECK constraint.
ALTER TABLE job_operations DROP CONSTRAINT IF EXISTS job_operations_status_check;
ALTER TABLE job_operations
    ADD CONSTRAINT job_operations_status_check
    CHECK (status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'completed'::text]));

-- 3. Rewrite get_ready_operations_for_station: only 'completed' predecessors
--    unblock a successor. Signature unchanged.
CREATE OR REPLACE FUNCTION public.get_ready_operations_for_station(
    p_company_id uuid,
    p_work_center_id uuid
)
RETURNS TABLE (
    job_id uuid,
    job_part_id uuid,
    job_operation_id uuid,
    operation_name text,
    op_status text,
    job_number text,
    part_id uuid,
    part_name text,
    part_description text,
    part_quantity integer
)
LANGUAGE plpgsql
STABLE
AS $function$
BEGIN
    RETURN QUERY
    WITH eligible_jobs AS (
        SELECT j.id, j.job_number FROM jobs j
        WHERE j.company_id = p_company_id
          AND j.status IN ('not_started', 'in_progress')
    ),
    station_ops AS (
        SELECT jo.id, jo.job_id, jo.job_part_id, jo.operation_name, jo.status, jo.sequence, ej.job_number
        FROM job_operations jo
        JOIN eligible_jobs ej ON ej.id = jo.job_id
        WHERE jo.work_center_id = p_work_center_id
          AND jo.status IN ('pending', 'in_progress')
    ),
    ready_or_active AS (
        SELECT so.id, so.job_id, so.job_part_id, so.operation_name, so.status, so.job_number
        FROM station_ops so
        WHERE so.status = 'in_progress'
           OR NOT EXISTS (
               SELECT 1 FROM job_operations prev
               WHERE prev.job_part_id = so.job_part_id
                 AND prev.sequence < so.sequence
                 AND prev.status <> 'completed'
           )
    )
    SELECT
        ra.job_id,
        ra.job_part_id,
        ra.id AS job_operation_id,
        ra.operation_name,
        ra.status AS op_status,
        ra.job_number,
        jp.part_id,
        p.part_name,
        p.description AS part_description,
        jp.quantity AS part_quantity
    FROM ready_or_active ra
    JOIN job_parts jp ON jp.id = ra.job_part_id
    JOIN parts p ON p.id = jp.part_id;
END;
$function$;

COMMENT ON FUNCTION public.get_ready_operations_for_station(uuid, uuid)
    IS 'Operator-station readiness query: returns ops at the given work_center that are ready (no incomplete predecessors in the same job_part) or currently in_progress, scoped to the company.';

-- 4. Rewrite get_ready_operations_batch: same predecessor-completion edit.
CREATE OR REPLACE FUNCTION public.get_ready_operations_batch(p_job_ids uuid[])
RETURNS TABLE (
    job_id uuid,
    operation_name text,
    ready_count integer
)
LANGUAGE plpgsql
STABLE
AS $function$
BEGIN
    RETURN QUERY
    WITH
    in_progress_ops AS (
        SELECT jo.job_id, jo.operation_name, COUNT(*)::integer AS cnt
        FROM job_operations jo
        WHERE jo.job_id = ANY(p_job_ids)
          AND jo.status = 'in_progress'
        GROUP BY jo.job_id, jo.operation_name
    ),
    jobs_with_in_progress AS (
        SELECT DISTINCT ip.job_id FROM in_progress_ops ip
    ),
    ready_ops AS (
        SELECT jo.job_id, jo.operation_name
        FROM job_operations jo
        WHERE jo.job_id = ANY(p_job_ids)
          AND jo.job_id NOT IN (SELECT jwi.job_id FROM jobs_with_in_progress jwi)
          AND jo.status = 'pending'
          AND NOT EXISTS (
              SELECT 1 FROM job_operations prev
              WHERE prev.job_part_id = jo.job_part_id
                AND prev.sequence < jo.sequence
                AND prev.status <> 'completed'
          )
    ),
    ready_agg AS (
        SELECT ro.job_id, MIN(ro.operation_name) AS operation_name, COUNT(*)::integer AS ready_count
        FROM ready_ops ro
        GROUP BY ro.job_id
    )
    SELECT ip.job_id, ip.operation_name, ip.cnt AS ready_count
    FROM in_progress_ops ip
    UNION ALL
    SELECT ra.job_id, ra.operation_name, ra.ready_count
    FROM ready_agg ra;
END;
$function$;

COMMENT ON FUNCTION public.get_ready_operations_batch(uuid[])
    IS 'Returns per-job summary of ready or in-progress operations across the given job IDs. Used by alerts/dashboard.';

COMMIT;
