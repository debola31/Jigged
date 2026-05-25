-- Migration: Remove cost_source and manual_cost fields
-- Parts now only have an optional routing for cost. No manual_cost or cost_source tracking.
-- Quotes are immutable cost snapshots — no cost_source tracking or refresh.

-- Remove cost_source from quotes table
ALTER TABLE quotes DROP COLUMN IF EXISTS cost_source;

-- Remove cost_source and manual_cost from parts table
ALTER TABLE parts DROP COLUMN IF EXISTS cost_source;
ALTER TABLE parts DROP COLUMN IF EXISTS manual_cost;

-- Update seed_demo_data function to remove dropped columns from INSERT statements
CREATE OR REPLACE FUNCTION seed_demo_data(p_company_id UUID, p_user_id UUID, p_template JSONB)
RETURNS VOID AS $$
DECLARE
    v_item        JSONB;
    v_node        JSONB;
    v_edge        JSONB;
    v_op_item     JSONB;
    v_new_id      UUID;
    v_routing_id  UUID;
    v_ref_map     JSONB := '{}'::JSONB;
BEGIN
    -- -----------------------------------------------------------------------
    -- Insert customers
    -- -----------------------------------------------------------------------
    IF v_template->'customers' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'customers')
        LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

            INSERT INTO customers (id, company_id, name, email, phone, address, notes, created_at)
            VALUES (v_new_id, p_company_id,
                    v_item->>'name',
                    v_item->>'email',
                    v_item->>'phone',
                    v_item->>'address',
                    v_item->>'notes',
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));
        END LOOP;
    END IF;

    -- -----------------------------------------------------------------------
    -- Insert operation_types
    -- -----------------------------------------------------------------------
    IF v_template->'operation_types' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'operation_types')
        LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

            INSERT INTO operation_types (id, company_id, name, default_labor_rate_per_minute, created_at)
            VALUES (v_new_id, p_company_id,
                    v_item->>'name',
                    COALESCE((v_item->>'default_labor_rate_per_minute')::NUMERIC, 0),
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));
        END LOOP;
    END IF;

    -- -----------------------------------------------------------------------
    -- Insert part_categories
    -- -----------------------------------------------------------------------
    IF v_template->'part_categories' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'part_categories')
        LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

            INSERT INTO part_categories (id, company_id, name, default_markup_percent, created_at)
            VALUES (v_new_id, p_company_id,
                    v_item->>'name',
                    (v_item->>'default_markup_percent')::NUMERIC,
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));
        END LOOP;
    END IF;

    -- -----------------------------------------------------------------------
    -- Insert parts (no more manual_cost or cost_source)
    -- -----------------------------------------------------------------------
    IF v_template->'parts' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'parts')
        LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

            INSERT INTO parts (id, company_id, part_number, description,
                               category_id, created_at)
            VALUES (v_new_id, p_company_id,
                    v_item->>'part_number',
                    v_item->>'description',
                    CASE WHEN v_item->>'category_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'category_ref'))::UUID
                         ELSE NULL END,
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
    -- Insert quotes (no more cost_source)
    -- -----------------------------------------------------------------------
    IF v_template->'quotes' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'quotes')
        LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

            INSERT INTO quotes (id, company_id, customer_id, part_id, description,
                                quantity, unit_price, status, created_by,
                                base_cost, markup_percent,
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
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

            INSERT INTO jobs (id, company_id, customer_id, part_id, quote_id,
                              quantity, priority, status, due_date, notes, created_by, created_at)
            VALUES (v_new_id, p_company_id,
                    (v_ref_map->>(v_item->>'customer_ref'))::UUID,
                    CASE WHEN v_item->>'part_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'part_ref'))::UUID
                         ELSE NULL END,
                    CASE WHEN v_item->>'quote_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'quote_ref'))::UUID
                         ELSE NULL END,
                    COALESCE((v_item->>'quantity')::INTEGER, 1),
                    COALESCE(v_item->>'priority', 'medium'),
                    COALESCE(v_item->>'status', 'not_started'),
                    (v_item->>'due_date')::DATE,
                    v_item->>'notes',
                    p_user_id,
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));
        END LOOP;
    END IF;

    -- -----------------------------------------------------------------------
    -- Insert job_operations (depends on jobs, operation_types)
    -- -----------------------------------------------------------------------
    IF v_template->'job_operations' IS NOT NULL THEN
        FOR v_op_item IN SELECT * FROM jsonb_array_elements(v_template->'job_operations')
        LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_op_item->>'_ref'], to_jsonb(v_new_id::TEXT));

            INSERT INTO job_operations (id, job_id, operation_type_id, sequence_order,
                                         status, setup_time, run_time_per_unit, notes, created_at)
            VALUES (v_new_id,
                    (v_ref_map->>(v_op_item->>'job_ref'))::UUID,
                    (v_ref_map->>(v_op_item->>'operation_type_ref'))::UUID,
                    COALESCE((v_op_item->>'sequence_order')::INTEGER, 1),
                    COALESCE(v_op_item->>'status', 'not_started'),
                    COALESCE((v_op_item->>'setup_time')::NUMERIC, 0),
                    COALESCE((v_op_item->>'run_time_per_unit')::NUMERIC, 0),
                    v_op_item->>'notes',
                    COALESCE((v_op_item->>'created_at')::TIMESTAMPTZ, NOW()));
        END LOOP;
    END IF;

END;
$$ LANGUAGE plpgsql;
