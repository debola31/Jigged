-- ============================================================================
-- Fix seed_demo_data(): convert hours→minutes when reading old template keys
-- ============================================================================
--
-- The seed_demo_data() function from the previous migration reads template
-- JSON with backward compat (falls back to old *_hours keys). But it was
-- inserting hour values directly into minute columns without converting.
-- This recreates the function with * 60 on the old-key fallbacks.
--
-- Also fixes existing demo company data that was seeded with wrong values.
-- ============================================================================

-- Fix existing demo data: zero out setup (routing has none) and convert
-- run times that look like hours (< 1 is suspicious for minutes).
UPDATE job_operations jo
SET estimated_setup_minutes = 0
FROM jobs j
JOIN companies c ON j.company_id = c.id
WHERE jo.job_id = j.id
  AND c.name LIKE '%(Demo)%'
  AND jo.estimated_setup_minutes != 0;

UPDATE job_operations jo
SET estimated_run_minutes_per_unit = estimated_run_minutes_per_unit * 60
FROM jobs j
JOIN companies c ON j.company_id = c.id
WHERE jo.job_id = j.id
  AND c.name LIKE '%(Demo)%'
  AND jo.estimated_run_minutes_per_unit > 0
  AND jo.estimated_run_minutes_per_unit < 1;

UPDATE routing_nodes rn
SET run_time_per_unit = run_time_per_unit * 60
FROM routings r
JOIN companies c ON r.company_id = c.id
WHERE rn.routing_id = r.id
  AND c.name LIKE '%(Demo)%'
  AND rn.run_time_per_unit IS NOT NULL
  AND rn.run_time_per_unit > 0
  AND rn.run_time_per_unit < 1;

-- Recreate seed_demo_data with * 60 conversion on old template keys.
-- (Full function body — same as previous migration but with the fix.)
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
    SELECT template_data INTO v_template
    FROM demo_data_templates
    WHERE name = p_template_name AND is_active = TRUE
    LIMIT 1;

    IF v_template IS NULL THEN
        RAISE EXCEPTION 'No active demo data template found for name: %', p_template_name;
    END IF;

    -- Insert customers
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

    -- Insert resource_groups
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

    -- Insert operation_types
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

    -- Insert part_categories
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

    -- Insert parts
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

    -- Insert inventory_items
    IF v_template->'inventory_items' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'inventory_items')
        LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));
            INSERT INTO inventory_items (id, company_id, name, description, sku, primary_unit,
                                         quantity, cost_per_unit, reorder_point, created_at)
            VALUES (v_new_id, p_company_id,
                    v_item->>'name', v_item->>'description', v_item->>'sku',
                    v_item->>'primary_unit',
                    COALESCE((v_item->>'quantity')::NUMERIC, 0),
                    (v_item->>'cost_per_unit')::NUMERIC,
                    (v_item->>'reorder_point')::NUMERIC,
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));
        END LOOP;
    END IF;

    -- Insert routings + routing_nodes + routing_edges
    IF v_template->'routings' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'routings')
        LOOP
            v_new_id := gen_random_uuid();
            v_routing_id := v_new_id;
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));
            INSERT INTO routings (id, company_id, part_id, name, description, created_by, created_at)
            VALUES (v_new_id, p_company_id,
                    (v_ref_map->>(v_item->>'part_ref'))::UUID,
                    v_item->>'name', v_item->>'description', p_user_id,
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));

            IF v_item->'nodes' IS NOT NULL THEN
                FOR v_node IN SELECT * FROM jsonb_array_elements(v_item->'nodes')
                LOOP
                    v_new_id := gen_random_uuid();
                    v_ref_map := jsonb_set(v_ref_map, ARRAY[v_node->>'_ref'], to_jsonb(v_new_id::TEXT));
                    INSERT INTO routing_nodes (id, routing_id, operation_type_id,
                                               run_time_per_unit, setup_time, instructions, materials)
                    VALUES (v_new_id, v_routing_id,
                            (v_ref_map->>(v_node->>'operation_type_ref'))::UUID,
                            (v_node->>'run_time_per_unit')::NUMERIC,
                            COALESCE((v_node->>'setup_time')::NUMERIC, 0),
                            v_node->>'instructions',
                            COALESCE(v_node->'materials', '[]'::JSONB));
                END LOOP;
            END IF;

            IF v_item->'edges' IS NOT NULL THEN
                FOR v_edge IN SELECT * FROM jsonb_array_elements(v_item->'edges')
                LOOP
                    INSERT INTO routing_edges (routing_id, source_node_id, target_node_id)
                    VALUES (v_routing_id,
                            (v_ref_map->>(v_edge->>'source_ref'))::UUID,
                            (v_ref_map->>(v_edge->>'target_ref'))::UUID);
                END LOOP;
            END IF;
        END LOOP;
    END IF;

    -- Insert quotes
    IF v_template->'quotes' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'quotes')
        LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));
            INSERT INTO quotes (id, company_id, customer_id, part_id, description,
                                quantity, unit_price, status, created_by,
                                base_cost, markup_percent, cost_source,
                                labor_cost_snapshot, material_cost_snapshot, created_at)
            VALUES (v_new_id, p_company_id,
                    (v_ref_map->>(v_item->>'customer_ref'))::UUID,
                    CASE WHEN v_item->>'part_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'part_ref'))::UUID ELSE NULL END,
                    v_item->>'description',
                    COALESCE((v_item->>'quantity')::INTEGER, 1),
                    (v_item->>'unit_price')::NUMERIC,
                    COALESCE(v_item->>'status', 'draft'), p_user_id,
                    (v_item->>'base_cost')::NUMERIC,
                    (v_item->>'markup_percent')::NUMERIC,
                    v_item->>'cost_source',
                    (v_item->>'labor_cost_snapshot')::NUMERIC,
                    (v_item->>'material_cost_snapshot')::NUMERIC,
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));
        END LOOP;
    END IF;

    -- Insert jobs + job_operations
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
                         THEN (v_ref_map->>(v_item->>'part_ref'))::UUID ELSE NULL END,
                    CASE WHEN v_item->>'quote_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'quote_ref'))::UUID ELSE NULL END,
                    v_item->>'description',
                    COALESCE(v_item->>'status', 'pending'), p_user_id,
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()),
                    (v_item->>'started_at')::TIMESTAMPTZ,
                    (v_item->>'completed_at')::TIMESTAMPTZ,
                    (v_item->>'shipped_at')::TIMESTAMPTZ,
                    (v_item->>'status_changed_at')::TIMESTAMPTZ);

            IF v_item->'operations' IS NOT NULL THEN
                FOR v_op IN SELECT * FROM jsonb_array_elements(v_item->'operations')
                LOOP
                    v_new_id := gen_random_uuid();
                    v_ref_map := jsonb_set(v_ref_map, ARRAY[v_op->>'_ref'], to_jsonb(v_new_id::TEXT));
                    INSERT INTO job_operations (id, job_id, sequence, operation_name,
                                                operation_type_id, estimated_setup_minutes,
                                                estimated_run_minutes_per_unit,
                                                actual_setup_minutes, actual_run_minutes,
                                                status, routing_node_id, instructions,
                                                started_at, completed_at, created_at)
                    VALUES (v_new_id, v_job_id,
                            (v_op->>'sequence')::INTEGER,
                            v_op->>'operation_name',
                            CASE WHEN v_op->>'operation_type_ref' IS NOT NULL
                                 THEN (v_ref_map->>(v_op->>'operation_type_ref'))::UUID
                                 ELSE NULL END,
                            -- New keys (minutes) take priority; old keys (hours) are converted * 60
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

    -- Link converted quotes to jobs
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
