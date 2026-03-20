-- Returns job operations at a specific station that are "ready" to work on.
-- An operation is ready if:
--   1. It is already in_progress, OR
--   2. It is pending with no routing_node_id (no routing linked), OR
--   3. It is pending and all predecessor nodes (via routing_edges) are completed/skipped.
--
-- This enforces routing order in the operator view so operators only see
-- jobs where the operation at their station is actually next in the workflow.

CREATE OR REPLACE FUNCTION public.get_ready_operations_for_station(
  p_company_id uuid,
  p_operation_type_id uuid
)
RETURNS TABLE(
  job_id uuid,
  job_operation_id uuid,
  operation_name text,
  op_status text
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN QUERY
  WITH eligible_jobs AS (
    SELECT j.id
    FROM jobs j
    WHERE j.company_id = p_company_id
      AND j.status IN ('pending', 'in_progress', 'released')
  ),
  station_ops AS (
    SELECT jo.id, jo.job_id, jo.operation_name, jo.status, jo.routing_node_id
    FROM job_operations jo
    JOIN eligible_jobs ej ON ej.id = jo.job_id
    WHERE jo.operation_type_id = p_operation_type_id
      AND jo.status IN ('pending', 'in_progress')
  ),
  ready_or_active AS (
    SELECT so.id, so.job_id, so.operation_name, so.status
    FROM station_ops so
    WHERE so.status = 'in_progress'
       OR so.routing_node_id IS NULL
       OR NOT EXISTS (
         SELECT 1
         FROM routing_edges re
         WHERE re.target_node_id = so.routing_node_id
           AND EXISTS (
             SELECT 1
             FROM job_operations pred_jo
             WHERE pred_jo.job_id = so.job_id
               AND pred_jo.routing_node_id = re.source_node_id
               AND pred_jo.status NOT IN ('completed', 'skipped')
           )
       )
  )
  SELECT ra.job_id, ra.id AS job_operation_id, ra.operation_name, ra.status AS op_status
  FROM ready_or_active ra;
END;
$$;
