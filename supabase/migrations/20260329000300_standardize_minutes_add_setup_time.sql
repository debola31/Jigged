-- ============================================================================
-- Migration: Standardize all time columns to minutes + add setup_time
-- ============================================================================
--
-- Problem 1: job_operations has columns named *_hours but some actually store
-- minutes (estimated_run_hours_per_unit is copied from routing_nodes.run_time_per_unit
-- which stores minutes). This migration standardizes everything to minutes.
--
-- Problem 2: routing_nodes has no setup_time column. Setup time is a one-time
-- per-batch cost that's critical for accurate quoting in manufacturing shops.
-- This migration adds it to routing_nodes and wires it through to job_operations.
-- ============================================================================

-- ============================================================================
-- Step 1: Convert actual hours to minutes (these are genuinely in hours)
-- ============================================================================

-- actual_setup_hours and actual_run_hours are entered by operators in hours.
-- Multiply by 60 to convert to minutes.
UPDATE job_operations
SET actual_setup_hours = actual_setup_hours * 60
WHERE actual_setup_hours IS NOT NULL AND actual_setup_hours != 0;

UPDATE job_operations
SET actual_run_hours = actual_run_hours * 60
WHERE actual_run_hours IS NOT NULL AND actual_run_hours != 0;

-- estimated_setup_hours may have non-zero values from demo data (also in hours).
UPDATE job_operations
SET estimated_setup_hours = estimated_setup_hours * 60
WHERE estimated_setup_hours != 0;

-- NOTE: estimated_run_hours_per_unit is NOT converted. Despite the column name,
-- values are already in minutes — they are copied directly from
-- routing_nodes.run_time_per_unit (which stores minutes) by the
-- create_job_operations_from_routing() function.

-- ============================================================================
-- Step 2: Add setup_time to routing_nodes
-- ============================================================================

-- setup_time is in minutes. Default 0 means "no setup required" (distinct from
-- run_time_per_unit which is nullable meaning "not set"). Setup of 0 is a valid
-- semantic value, not missing data.
ALTER TABLE routing_nodes ADD COLUMN IF NOT EXISTS setup_time numeric DEFAULT 0;

COMMENT ON COLUMN routing_nodes.setup_time
    IS 'One-time setup/changeover time in minutes. Applies once per batch, not per unit.';

-- ============================================================================
-- Step 3: Rename job_operations columns from *_hours to *_minutes
-- ============================================================================

ALTER TABLE job_operations RENAME COLUMN estimated_setup_hours TO estimated_setup_minutes;
ALTER TABLE job_operations RENAME COLUMN estimated_run_hours_per_unit TO estimated_run_minutes_per_unit;
ALTER TABLE job_operations RENAME COLUMN actual_setup_hours TO actual_setup_minutes;
ALTER TABLE job_operations RENAME COLUMN actual_run_hours TO actual_run_minutes;

-- Update column comments
COMMENT ON COLUMN job_operations.estimated_setup_minutes
    IS 'Estimated one-time setup minutes from routing (per batch, not per unit).';
COMMENT ON COLUMN job_operations.estimated_run_minutes_per_unit
    IS 'Estimated run minutes per unit from routing.';
COMMENT ON COLUMN job_operations.actual_setup_minutes
    IS 'Actual setup minutes recorded by operator.';
COMMENT ON COLUMN job_operations.actual_run_minutes
    IS 'Actual total run minutes recorded by operator.';

-- ============================================================================
-- Step 4: Recreate create_job_operations_from_routing() with new column names
-- ============================================================================

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
              instructions, estimated_setup_minutes, estimated_run_minutes_per_unit, status,
              routing_node_id
          ) VALUES (
              p_job_id, v_sequence, v_node.operation_name, v_node.operation_type_id,
              v_node.instructions, COALESCE(v_node.setup_time, 0), v_node.run_time_per_unit, 'pending',
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

-- ============================================================================
-- Step 5: Recreate seed_demo_data() with new column names
-- ============================================================================

CREATE OR REPLACE FUNCTION public.seed_demo_data(p_company_id uuid, p_user_id uuid, p_template_name character varying DEFAULT 'default'::character varying)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_template JSONB;
    v_ref_map JSONB := '{}';
    v_item JSONB;
    v_new_id UUID;
    v_node JSONB;
    v_edge JSONB;
    v_op JSONB;
    v_routing_id UUID;
    v_job_id UUID;
BEGIN
    -- Get active template data
    SELECT template_data INTO v_template
    FROM demo_data_templates
    WHERE name = p_template_name AND is_active = TRUE
    LIMIT 1;

    IF v_template IS NULL THEN
        RAISE EXCEPTION 'No active demo data template found for name: %', p_template_name;
    END IF;

    -- -----------------------------------------------------------------------
    -- Insert customers
    -- -----------------------------------------------------------------------
    IF v_template->'customers' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'customers')
        LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

            INSERT INTO customers (id, company_id, name, contact_name, contact_email,
                                   contact_phone, city, state, country, created_at)
            VALUES (v_new_id, p_company_id,
                    v_item->>'name', v_item->>'contact_name', v_item->>'contact_email',
                    v_item->>'contact_phone', v_item->>'city', v_item->>'state',
                    COALESCE(v_item->>'country', 'USA'),
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));
        END LOOP;
    END IF;

    -- -----------------------------------------------------------------------
    -- Insert resource_groups
    -- -----------------------------------------------------------------------
    IF v_template->'resource_groups' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'resource_groups')
        LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

            INSERT INTO resource_groups (id, company_id, name, description, created_at)
            VALUES (v_new_id, p_company_id, v_item->>'name', v_item->>'description',
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));
        END LOOP;
    END IF;

    -- -----------------------------------------------------------------------
    -- Insert operation_types (depends on resource_groups)
    -- -----------------------------------------------------------------------
    IF v_template->'operation_types' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'operation_types')
        LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

            INSERT INTO operation_types (id, company_id, resource_group_id, name, labor_rate, description, created_at)
            VALUES (v_new_id, p_company_id,
                    (v_ref_map->>(v_item->>'resource_group_ref'))::UUID,
                    v_item->>'name',
                    (v_item->>'labor_rate')::NUMERIC,
                    v_item->>'description',
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));
        END LOOP;
    END IF;

    -- -----------------------------------------------------------------------
    -- Insert part_categories (NEW — supports cost-plus model)
    -- -----------------------------------------------------------------------
    IF v_template->'part_categories' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'part_categories')
        LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

            INSERT INTO part_categories (id, company_id, name, default_markup_percent, description, created_at)
            VALUES (v_new_id, p_company_id,
                    v_item->>'name',
                    (v_item->>'default_markup_percent')::NUMERIC,
                    v_item->>'description',
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));
        END LOOP;
    END IF;

    -- -----------------------------------------------------------------------
    -- Insert parts
    -- -----------------------------------------------------------------------
    IF v_template->'parts' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'parts')
        LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

            INSERT INTO parts (id, company_id, part_number, description,
                               category_id, manual_cost, cost_source, created_at)
            VALUES (v_new_id, p_company_id,
                    v_item->>'part_number',
                    v_item->>'description',
                    CASE WHEN v_item->>'category_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'category_ref'))::UUID
                         ELSE NULL END,
                    (v_item->>'manual_cost')::NUMERIC,
                    v_item->>'cost_source',
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));
        END LOOP;
    END IF;

    -- -----------------------------------------------------------------------
    -- Insert inventory_items
    -- -----------------------------------------------------------------------
    IF v_template->'inventory_items' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'inventory_items')
        LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

            INSERT INTO inventory_items (id, company_id, name, description, sku, primary_unit,
                                         quantity, cost_per_unit, reorder_point, created_at)
            VALUES (v_new_id, p_company_id,
                    v_item->>'name',
                    v_item->>'description',
                    v_item->>'sku',
                    v_item->>'primary_unit',
                    COALESCE((v_item->>'quantity')::NUMERIC, 0),
                    (v_item->>'cost_per_unit')::NUMERIC,
                    (v_item->>'reorder_point')::NUMERIC,
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));
        END LOOP;
    END IF;

    -- -----------------------------------------------------------------------
    -- Insert routings + routing_nodes + routing_edges (1:1 with parts)
    -- -----------------------------------------------------------------------
    IF v_template->'routings' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'routings')
        LOOP
            v_new_id := gen_random_uuid();
            v_routing_id := v_new_id;
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

            INSERT INTO routings (id, company_id, part_id, name, description, created_by, created_at)
            VALUES (v_new_id, p_company_id,
                    (v_ref_map->>(v_item->>'part_ref'))::UUID,
                    v_item->>'name',
                    v_item->>'description',
                    p_user_id,
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));

            -- Insert nodes for this routing
            IF v_item->'nodes' IS NOT NULL THEN
                FOR v_node IN SELECT * FROM jsonb_array_elements(v_item->'nodes')
                LOOP
                    v_new_id := gen_random_uuid();
                    v_ref_map := jsonb_set(v_ref_map, ARRAY[v_node->>'_ref'], to_jsonb(v_new_id::TEXT));

                    INSERT INTO routing_nodes (id, routing_id, operation_type_id,
                                               run_time_per_unit, setup_time, instructions, materials)
                    VALUES (v_new_id,
                            v_routing_id,
                            (v_ref_map->>(v_node->>'operation_type_ref'))::UUID,
                            (v_node->>'run_time_per_unit')::NUMERIC,
                            COALESCE((v_node->>'setup_time')::NUMERIC, 0),
                            v_node->>'instructions',
                            COALESCE(v_node->'materials', '[]'::JSONB));
                END LOOP;
            END IF;

            -- Insert edges for this routing
            IF v_item->'edges' IS NOT NULL THEN
                FOR v_edge IN SELECT * FROM jsonb_array_elements(v_item->'edges')
                LOOP
                    INSERT INTO routing_edges (routing_id, source_node_id, target_node_id)
                    VALUES (
                        v_routing_id,
                        (v_ref_map->>(v_edge->>'source_ref'))::UUID,
                        (v_ref_map->>(v_edge->>'target_ref'))::UUID
                    );
                END LOOP;
            END IF;
        END LOOP;
    END IF;

    -- -----------------------------------------------------------------------
    -- Insert quotes (depends on customers, parts)
    -- Now includes cost-plus snapshot fields
    -- -----------------------------------------------------------------------
    IF v_template->'quotes' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'quotes')
        LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

            INSERT INTO quotes (id, company_id, customer_id, part_id, description,
                                quantity, unit_price, status, created_by,
                                base_cost, markup_percent, cost_source,
                                labor_cost_snapshot, material_cost_snapshot,
                                created_at)
            VALUES (v_new_id, p_company_id,
                    (v_ref_map->>(v_item->>'customer_ref'))::UUID,
                    CASE WHEN v_item->>'part_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'part_ref'))::UUID
                         ELSE NULL END,
                    v_item->>'description',
                    COALESCE((v_item->>'quantity')::INTEGER, 1),
                    (v_item->>'unit_price')::NUMERIC,
                    COALESCE(v_item->>'status', 'draft'),
                    p_user_id,
                    (v_item->>'base_cost')::NUMERIC,
                    (v_item->>'markup_percent')::NUMERIC,
                    v_item->>'cost_source',
                    (v_item->>'labor_cost_snapshot')::NUMERIC,
                    (v_item->>'material_cost_snapshot')::NUMERIC,
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));
        END LOOP;
    END IF;

    -- -----------------------------------------------------------------------
    -- Insert jobs (depends on customers, parts, quotes)
    -- -----------------------------------------------------------------------
    IF v_template->'jobs' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'jobs')
        LOOP
            v_new_id := gen_random_uuid();
            v_job_id := v_new_id;
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

            INSERT INTO jobs (id, company_id, customer_id, part_id, quote_id,
                              description, status, created_by, created_at,
                              started_at, completed_at, shipped_at, status_changed_at)
            VALUES (v_new_id, p_company_id,
                    (v_ref_map->>(v_item->>'customer_ref'))::UUID,
                    CASE WHEN v_item->>'part_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'part_ref'))::UUID
                         ELSE NULL END,
                    CASE WHEN v_item->>'quote_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'quote_ref'))::UUID
                         ELSE NULL END,
                    v_item->>'description',
                    COALESCE(v_item->>'status', 'pending'),
                    p_user_id,
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()),
                    (v_item->>'started_at')::TIMESTAMPTZ,
                    (v_item->>'completed_at')::TIMESTAMPTZ,
                    (v_item->>'shipped_at')::TIMESTAMPTZ,
                    (v_item->>'status_changed_at')::TIMESTAMPTZ);

            -- Insert job_operations (column names updated to *_minutes)
            -- Template JSON keys still use the old names for backward compat
            -- with existing templates; new templates should use *_minutes keys.
            IF v_item->'operations' IS NOT NULL THEN
                FOR v_op IN SELECT * FROM jsonb_array_elements(v_item->'operations')
                LOOP
                    v_new_id := gen_random_uuid();
                    v_ref_map := jsonb_set(v_ref_map, ARRAY[v_op->>'_ref'], to_jsonb(v_new_id::TEXT));

                    INSERT INTO job_operations (id, job_id, sequence, operation_name,
                                                operation_type_id, estimated_setup_minutes,
                                                estimated_run_minutes_per_unit,
                                                actual_setup_minutes, actual_run_minutes,
                                                status,
                                                routing_node_id, instructions,
                                                started_at, completed_at, created_at)
                    VALUES (v_new_id,
                            v_job_id,
                            (v_op->>'sequence')::INTEGER,
                            v_op->>'operation_name',
                            CASE WHEN v_op->>'operation_type_ref' IS NOT NULL
                                 THEN (v_ref_map->>(v_op->>'operation_type_ref'))::UUID
                                 ELSE NULL END,
                            -- Support both old (hours) and new (minutes) template keys.
                            -- Old keys are in hours — multiply by 60 to convert to minutes.
                            COALESCE(
                                (v_op->>'estimated_setup_minutes')::NUMERIC,
                                (v_op->>'estimated_setup_hours')::NUMERIC * 60,
                                0
                            ),
                            COALESCE(
                                (v_op->>'estimated_run_minutes_per_unit')::NUMERIC,
                                (v_op->>'estimated_run_hours_per_unit')::NUMERIC * 60,
                                0
                            ),
                            COALESCE(
                                (v_op->>'actual_setup_minutes')::NUMERIC,
                                (v_op->>'actual_setup_hours')::NUMERIC * 60
                            ),
                            COALESCE(
                                (v_op->>'actual_run_minutes')::NUMERIC,
                                (v_op->>'actual_run_hours')::NUMERIC * 60
                            ),
                            COALESCE(v_op->>'status', 'pending'),
                            CASE WHEN v_op->>'routing_node_ref' IS NOT NULL
                                 THEN (v_ref_map->>(v_op->>'routing_node_ref'))::UUID
                                 ELSE NULL END,
                            v_op->>'instructions',
                            (v_op->>'started_at')::TIMESTAMPTZ,
                            (v_op->>'completed_at')::TIMESTAMPTZ,
                            COALESCE((v_op->>'created_at')::TIMESTAMPTZ, NOW()));
                END LOOP;
            END IF;
        END LOOP;
    END IF;

    -- -----------------------------------------------------------------------
    -- Post-insert: link converted quotes to their jobs
    -- -----------------------------------------------------------------------
    IF v_template->'quotes' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'quotes')
        LOOP
            IF v_item->>'converted_to_job_ref' IS NOT NULL THEN
                UPDATE quotes
                SET converted_to_job_id = (v_ref_map->>(v_item->>'converted_to_job_ref'))::UUID,
                    converted_at = (v_item->>'converted_at')::TIMESTAMPTZ
                WHERE id = (v_ref_map->>(v_item->>'_ref'))::UUID;
            END IF;
        END LOOP;
    END IF;
END;
$function$;
