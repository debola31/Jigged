-- Fix: create_job_operations_from_routing() references removed setup_time column
-- The setup_time column was dropped from routing_nodes in migration 20260221000000
-- but this function was not updated, causing it to fail silently when creating jobs.

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
