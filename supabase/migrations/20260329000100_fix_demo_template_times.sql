-- ============================================================================
-- Fix demo template JSON: convert all time values from hours to minutes
-- ============================================================================
--
-- The demo_data_templates.template_data JSONB was authored with time values
-- in hours (e.g., run_time_per_unit: 0.69 meaning 0.69 hours = 41 minutes).
-- But the system stores time in minutes.
--
-- This migration:
-- 1. Converts routing_nodes run_time_per_unit values (* 60) in the template
-- 2. Converts job_operations estimated_run_hours_per_unit values (* 60) and
--    renames keys to estimated_run_minutes_per_unit
-- 3. Removes estimated_setup_hours from job operations (routing has no setup yet)
-- 4. Cleans up actual_setup_hours/actual_run_hours keys similarly
--
-- Also fixes existing demo company data directly.
-- ============================================================================

-- Fix the template JSON in-place using a PL/pgSQL block
DO $$
DECLARE
    v_template_id UUID;
    v_data JSONB;
    v_routings JSONB;
    v_jobs JSONB;
    v_routing JSONB;
    v_job JSONB;
    v_nodes JSONB;
    v_ops JSONB;
    v_node JSONB;
    v_op JSONB;
    v_new_routings JSONB := '[]'::JSONB;
    v_new_jobs JSONB := '[]'::JSONB;
    v_new_nodes JSONB;
    v_new_ops JSONB;
    v_val NUMERIC;
BEGIN
    FOR v_template_id, v_data IN
        SELECT id, template_data FROM demo_data_templates WHERE is_active = TRUE
    LOOP
        -- Fix routing nodes: convert run_time_per_unit from hours to minutes
        v_routings := v_data->'routings';
        v_new_routings := '[]'::JSONB;

        IF v_routings IS NOT NULL THEN
            FOR v_routing IN SELECT * FROM jsonb_array_elements(v_routings)
            LOOP
                v_nodes := v_routing->'nodes';
                v_new_nodes := '[]'::JSONB;

                IF v_nodes IS NOT NULL THEN
                    FOR v_node IN SELECT * FROM jsonb_array_elements(v_nodes)
                    LOOP
                        v_val := (v_node->>'run_time_per_unit')::NUMERIC;
                        -- Convert if value looks like hours (< 5 is suspicious for minutes)
                        IF v_val IS NOT NULL AND v_val > 0 AND v_val < 5 THEN
                            v_node := jsonb_set(v_node, '{run_time_per_unit}', to_jsonb(ROUND(v_val * 60, 2)));
                        END IF;
                        v_new_nodes := v_new_nodes || v_node;
                    END LOOP;
                END IF;

                v_routing := jsonb_set(v_routing, '{nodes}', v_new_nodes);
                v_new_routings := v_new_routings || v_routing;
            END LOOP;
        END IF;

        v_data := jsonb_set(v_data, '{routings}', v_new_routings);

        -- Fix job operations: convert hours keys to minutes, zero out setup
        v_jobs := v_data->'jobs';
        v_new_jobs := '[]'::JSONB;

        IF v_jobs IS NOT NULL THEN
            FOR v_job IN SELECT * FROM jsonb_array_elements(v_jobs)
            LOOP
                v_ops := v_job->'operations';
                v_new_ops := '[]'::JSONB;

                IF v_ops IS NOT NULL THEN
                    FOR v_op IN SELECT * FROM jsonb_array_elements(v_ops)
                    LOOP
                        -- Convert estimated_run_hours_per_unit to minutes
                        v_val := (v_op->>'estimated_run_hours_per_unit')::NUMERIC;
                        IF v_val IS NOT NULL AND v_val > 0 THEN
                            v_op := v_op - 'estimated_run_hours_per_unit';
                            v_op := jsonb_set(v_op, '{estimated_run_minutes_per_unit}', to_jsonb(ROUND(v_val * 60, 2)));
                        END IF;

                        -- Zero out / remove setup hours
                        v_op := v_op - 'estimated_setup_hours';
                        v_op := v_op - 'estimated_setup_minutes';

                        -- Convert actual hours to minutes
                        v_val := (v_op->>'actual_run_hours')::NUMERIC;
                        IF v_val IS NOT NULL AND v_val > 0 THEN
                            v_op := v_op - 'actual_run_hours';
                            v_op := jsonb_set(v_op, '{actual_run_minutes}', to_jsonb(ROUND(v_val * 60, 2)));
                        END IF;
                        v_op := v_op - 'actual_setup_hours';

                        v_new_ops := v_new_ops || v_op;
                    END LOOP;
                END IF;

                v_job := jsonb_set(v_job, '{operations}', v_new_ops);
                v_new_jobs := v_new_jobs || v_job;
            END LOOP;
        END IF;

        v_data := jsonb_set(v_data, '{jobs}', v_new_jobs);

        -- Save updated template
        UPDATE demo_data_templates SET template_data = v_data WHERE id = v_template_id;
    END LOOP;
END $$;

-- Also fix existing demo company data directly
-- (for companies that were already seeded with wrong values)

-- Fix routing_nodes: convert sub-5 values that look like hours
UPDATE routing_nodes rn
SET run_time_per_unit = ROUND(run_time_per_unit * 60, 2)
FROM routings r
JOIN companies c ON r.company_id = c.id
WHERE rn.routing_id = r.id
  AND c.name LIKE '% - Demo'
  AND rn.run_time_per_unit IS NOT NULL
  AND rn.run_time_per_unit > 0
  AND rn.run_time_per_unit < 5;

-- Fix job_operations: convert sub-5 run times that look like hours
UPDATE job_operations jo
SET estimated_run_minutes_per_unit = ROUND(estimated_run_minutes_per_unit * 60, 2)
FROM jobs j
JOIN companies c ON j.company_id = c.id
WHERE jo.job_id = j.id
  AND c.name LIKE '% - Demo'
  AND jo.estimated_run_minutes_per_unit > 0
  AND jo.estimated_run_minutes_per_unit < 5;

-- Zero out setup times for demo jobs
UPDATE job_operations jo
SET estimated_setup_minutes = 0
FROM jobs j
JOIN companies c ON j.company_id = c.id
WHERE jo.job_id = j.id
  AND c.name LIKE '% - Demo'
  AND jo.estimated_setup_minutes != 0;
