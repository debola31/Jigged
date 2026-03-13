-- Fix: Remove references to non-existent quantity_completed and quantity_scrapped
-- columns in job_operations table within seed_demo_data function.

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
    -- Insert parts (no customer_id — removed by simplify_operations)
    -- -----------------------------------------------------------------------
    IF v_template->'parts' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'parts')
        LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

            INSERT INTO parts (id, company_id, part_number, description, pricing, created_at)
            VALUES (v_new_id, p_company_id,
                    v_item->>'part_number',
                    v_item->>'description',
                    COALESCE(v_item->'pricing', '[]'::JSONB),
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
                                               run_time_per_unit, instructions, materials)
                    VALUES (v_new_id,
                            v_routing_id,
                            (v_ref_map->>(v_node->>'operation_type_ref'))::UUID,
                            (v_node->>'run_time_per_unit')::NUMERIC,
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
    -- Note: converted_to_job_id is set in a post-jobs UPDATE pass below
    -- No routing_id — removed by simplify_operations
    -- -----------------------------------------------------------------------
    IF v_template->'quotes' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'quotes')
        LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

            INSERT INTO quotes (id, company_id, quote_number, customer_id, part_id,
                                quantity, unit_price, total_price, status,
                                description, created_by, created_at, status_changed_at)
            VALUES (v_new_id, p_company_id,
                    v_item->>'quote_number',
                    (v_ref_map->>(v_item->>'customer_ref'))::UUID,
                    CASE WHEN v_item->>'part_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'part_ref'))::UUID
                         ELSE NULL END,
                    COALESCE((v_item->>'quantity')::INTEGER, 1),
                    (v_item->>'unit_price')::NUMERIC,
                    (v_item->>'total_price')::NUMERIC,
                    COALESCE(v_item->>'status', 'draft'),
                    v_item->>'description',
                    p_user_id,
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()),
                    (v_item->>'status_changed_at')::TIMESTAMPTZ);
        END LOOP;
    END IF;

    -- -----------------------------------------------------------------------
    -- Insert jobs + job_operations (depends on customers, parts, quotes)
    -- No routing_id — removed by simplify_operations
    -- -----------------------------------------------------------------------
    IF v_template->'jobs' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'jobs')
        LOOP
            v_new_id := gen_random_uuid();
            v_job_id := v_new_id;
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

            INSERT INTO jobs (id, company_id, job_number, customer_id, part_id,
                              quote_id, description, status, created_by,
                              created_at, started_at, completed_at, shipped_at, status_changed_at)
            VALUES (v_new_id, p_company_id,
                    v_item->>'job_number',
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

            -- Insert job_operations
            IF v_item->'operations' IS NOT NULL THEN
                FOR v_op IN SELECT * FROM jsonb_array_elements(v_item->'operations')
                LOOP
                    v_new_id := gen_random_uuid();
                    v_ref_map := jsonb_set(v_ref_map, ARRAY[v_op->>'_ref'], to_jsonb(v_new_id::TEXT));

                    INSERT INTO job_operations (id, job_id, sequence, operation_name,
                                                operation_type_id, estimated_setup_hours,
                                                estimated_run_hours_per_unit,
                                                actual_setup_hours, actual_run_hours,
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
                            COALESCE((v_op->>'estimated_setup_hours')::NUMERIC, 0),
                            COALESCE((v_op->>'estimated_run_hours_per_unit')::NUMERIC, 0),
                            (v_op->>'actual_setup_hours')::NUMERIC,
                            (v_op->>'actual_run_hours')::NUMERIC,
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
    -- (handles circular FK: quotes.converted_to_job_id -> jobs.id)
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
