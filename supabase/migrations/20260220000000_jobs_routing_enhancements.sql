-- Migration: Jobs Routing Enhancements
-- 1. Add routing_node_id to job_operations (trace back to routing DAG)
-- 2. Update create_job_operations_from_routing() to populate routing_node_id
-- 3. Create get_ready_operations_batch() for Current Op column

-- ============================================================
-- 1. Add routing_node_id column to job_operations
-- ============================================================
ALTER TABLE public.job_operations
  ADD COLUMN IF NOT EXISTS routing_node_id uuid;

ALTER TABLE public.job_operations
  ADD CONSTRAINT job_operations_routing_node_id_fkey
  FOREIGN KEY (routing_node_id) REFERENCES routing_nodes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_job_ops_routing_node
  ON public.job_operations USING btree (routing_node_id)
  WHERE (routing_node_id IS NOT NULL);

COMMENT ON COLUMN public.job_operations.routing_node_id
  IS 'FK to routing_nodes. Links this job operation back to the specific node in the routing DAG it was created from. NULL for operations created before this migration or ad-hoc operations.';

-- ============================================================
-- 2. Update create_job_operations_from_routing()
--    Now also inserts routing_node_id for DAG tracing
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_job_operations_from_routing(p_job_id uuid, p_routing_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
  DECLARE
      v_count integer := 0;
      v_node record;
      v_sequence integer := 10;
  BEGIN
      FOR v_node IN
          SELECT rn.*, ot.name as operation_name
          FROM routing_nodes rn
          JOIN operation_types ot ON rn.operation_type_id = ot.id
          WHERE rn.routing_id = p_routing_id
          ORDER BY rn.created_at
      LOOP
          INSERT INTO job_operations (
              job_id, sequence, operation_name, operation_type_id,
              instructions, estimated_setup_hours, estimated_run_hours_per_unit, status,
              routing_node_id
          ) VALUES (
              p_job_id, v_sequence, v_node.operation_name, v_node.operation_type_id,
              v_node.instructions, 0, v_node.run_time_per_unit, 'pending',
              v_node.id
          );
          v_sequence := v_sequence + 10;
          v_count := v_count + 1;
      END LOOP;
      IF v_count > 0 THEN
          UPDATE jobs SET current_operation_sequence = 10 WHERE id = p_job_id;
      END IF;
      RETURN v_count;
  END;
  $function$;

-- ============================================================
-- 3. Create get_ready_operations_batch()
--    Returns the current/next operation for a batch of jobs
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_ready_operations_batch(p_job_ids uuid[])
 RETURNS TABLE(job_id uuid, operation_name text, ready_count integer)
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
  RETURN QUERY
  WITH
  -- First check: any in_progress operation takes priority
  in_progress_ops AS (
    SELECT
      jo.job_id,
      jo.operation_name,
      COUNT(*)::integer AS cnt
    FROM job_operations jo
    WHERE jo.job_id = ANY(p_job_ids)
      AND jo.status = 'in_progress'
    GROUP BY jo.job_id, jo.operation_name
  ),
  -- Jobs that have in_progress operations (exclude from ready calculation)
  jobs_with_in_progress AS (
    SELECT DISTINCT ip.job_id FROM in_progress_ops ip
  ),
  -- For remaining jobs: find pending operations whose predecessors are all done
  -- A predecessor is a routing_node connected via routing_edges where
  -- source_node_id -> target_node_id (target depends on source)
  ready_ops AS (
    SELECT
      jo.job_id,
      jo.operation_name,
      jo.routing_node_id
    FROM job_operations jo
    WHERE jo.job_id = ANY(p_job_ids)
      AND jo.job_id NOT IN (SELECT jwi.job_id FROM jobs_with_in_progress jwi)
      AND jo.status = 'pending'
      AND jo.routing_node_id IS NOT NULL
      -- All predecessor nodes must have corresponding completed/skipped job_operations
      AND NOT EXISTS (
        -- Find edges where this node is the target (i.e., predecessors)
        SELECT 1
        FROM routing_edges re
        WHERE re.target_node_id = jo.routing_node_id
          -- Check if the predecessor's job_operation is NOT completed/skipped
          AND EXISTS (
            SELECT 1
            FROM job_operations pred_jo
            WHERE pred_jo.job_id = jo.job_id
              AND pred_jo.routing_node_id = re.source_node_id
              AND pred_jo.status NOT IN ('completed', 'skipped')
          )
      )
  ),
  -- Aggregate ready ops per job: pick first alphabetically, count total
  ready_agg AS (
    SELECT
      ro.job_id,
      MIN(ro.operation_name) AS operation_name,
      COUNT(*)::integer AS ready_count
    FROM ready_ops ro
    GROUP BY ro.job_id
  )
  -- Return in_progress ops first, then ready ops
  SELECT ip.job_id, ip.operation_name, ip.cnt AS ready_count
  FROM in_progress_ops ip
  UNION ALL
  SELECT ra.job_id, ra.operation_name, ra.ready_count
  FROM ready_agg ra;
END;
$function$;

COMMENT ON FUNCTION public.get_ready_operations_batch(uuid[])
  IS 'Batch function returning the current/next operation for multiple jobs. Returns in_progress operations first, then DAG-aware ready (pending with all predecessors completed/skipped) operations. Used by the jobs list Current Op column.';
