-- Hot-first ordering for the operator station dispatch queue.
--
-- get_ready_operations_for_station returned ready/active operations in
-- unspecified order (no ORDER BY); the caller
-- (utils/operatorAccess.ts::buildOperatorJobs) preserves that order 1:1. Now
-- that jobs carry an is_hot flag, hot jobs must float to the top of every
-- station's list so operators see rush work first.
--
-- Two changes vs 20260707001934:
--   1. Return the job's is_hot flag (new column in the RETURNS TABLE), carried
--      through the eligible_jobs CTE, so the UI can badge the row without a
--      second lookup.
--   2. ORDER BY is_hot DESC first (hot to top), then job_number for a stable,
--      deterministic secondary order.
--
-- Because the RETURNS TABLE shape gains a column, CREATE OR REPLACE cannot alter
-- the return type — DROP then CREATE. No views/other functions depend on it
-- (it's only reached via supabase.rpc), so the drop is safe.

DROP FUNCTION IF EXISTS public.get_ready_operations_for_station(uuid, uuid);

CREATE FUNCTION public.get_ready_operations_for_station(p_company_id uuid, p_work_center_id uuid)
 RETURNS TABLE(job_id uuid, job_part_id uuid, job_operation_id uuid, operation_name text, op_status text, job_number text, part_id uuid, part_name text, part_description text, part_quantity numeric, is_hot boolean)
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
    RETURN QUERY
    WITH eligible_jobs AS (
        SELECT j.id, j.job_number, j.is_hot FROM jobs j
        WHERE j.company_id = p_company_id
          AND j.production_status IN ('not_started', 'in_progress')
    ),
    station_ops AS (
        SELECT jo.id, jo.job_id, jo.job_part_id, jo.operation_name, jo.status, jo.sequence,
               ej.job_number, ej.is_hot
        FROM job_operations jo
        JOIN eligible_jobs ej ON ej.id = jo.job_id
        WHERE jo.work_center_id = p_work_center_id
          AND jo.status IN ('pending', 'in_progress')
    ),
    ready_or_active AS (
        SELECT so.id, so.job_id, so.job_part_id, so.operation_name, so.status,
               so.job_number, so.is_hot
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
        jp.quantity AS part_quantity,
        ra.is_hot
    FROM ready_or_active ra
    JOIN job_parts jp ON jp.id = ra.job_part_id
    JOIN parts p ON p.id = jp.part_id
    -- Hot jobs to the top; job_number for a deterministic secondary order.
    ORDER BY ra.is_hot DESC, ra.job_number;
END;
$function$;
