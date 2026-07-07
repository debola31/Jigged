-- Fix: the operator dispatch RPC filtered on a nonexistent column.
--
-- get_ready_operations_for_station's eligible_jobs CTE filtered
--   jobs.status IN ('not_started', 'in_progress')
-- but the jobs table has no `status` column — the real column is
-- `production_status` (CHECK: not_started/in_progress/completed/cancelled).
-- Referencing the missing column made the function raise
-- `column j.status does not exist`; the app-side caller
-- (utils/operatorAccess.ts::getReadyOperationsForStation) swallowed that error
-- and returned [], so operators saw an empty job list with no visible error.
-- Both operator lenses ("My Station" and "All Stations") call this RPC, so this
-- one-line correction repairs both.
--
-- Signature is unchanged from the current definition (part_quantity is already
-- numeric, widened in 20260623143220), so a plain CREATE OR REPLACE suffices —
-- no DROP needed. Body is byte-identical to today's except the filter column.

CREATE OR REPLACE FUNCTION public.get_ready_operations_for_station(p_company_id uuid, p_work_center_id uuid)
 RETURNS TABLE(job_id uuid, job_part_id uuid, job_operation_id uuid, operation_name text, op_status text, job_number text, part_id uuid, part_name text, part_description text, part_quantity numeric)
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
    RETURN QUERY
    WITH eligible_jobs AS (
        SELECT j.id, j.job_number FROM jobs j
        WHERE j.company_id = p_company_id
          AND j.production_status IN ('not_started', 'in_progress')  -- was j.status (nonexistent column)
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
