-- Migration: Drop resource_groups + jobs.description.
--
-- Two independent field removals bundled into a single migration because
-- both need to re-emit seed_demo_data and reset_demo_company:
--
--   1. Resource groups (an organisational layer over operation_types) is
--      scrapped — operations become a flat list.
--   2. jobs.description was inherited from quotes but quote descriptions
--      were removed in April 2026. The job-side field is likewise gone.
--
-- Steps:
--   1. Replace seed_demo_data + reset_demo_company to stop touching
--      the resource_groups table, operation_types.resource_group_id,
--      and jobs.description.
--   2. Drop resource_group_id, resource_groups, and jobs.description.

BEGIN;

-- ============================================================================
-- 1. Replace seed_demo_data: drop resource_groups handling, stop writing
--    operation_types.resource_group_id. Every other section unchanged.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.seed_demo_data(
    p_company_id uuid,
    p_user_id uuid,
    p_template_name character varying DEFAULT 'default'::character varying
)
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
    v_op JSONB;
    v_routing_id UUID;
    v_job_id UUID;
    v_node_seq INTEGER;
BEGIN
    SELECT template_data INTO v_template
    FROM demo_data_templates
    WHERE name = p_template_name AND is_active = TRUE
    LIMIT 1;

    IF v_template IS NULL THEN
        RAISE EXCEPTION 'No active demo data template found for name: %', p_template_name;
    END IF;

    -- Customers
    IF v_template->'customers' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'customers') LOOP
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

    -- Operation types (resource_groups concept removed)
    IF v_template->'operation_types' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'operation_types') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));
            INSERT INTO operation_types (id, company_id, name, labor_rate, description, created_at)
            VALUES (v_new_id, p_company_id,
                    v_item->>'name', (v_item->>'labor_rate')::NUMERIC, v_item->>'description',
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));
        END LOOP;
    END IF;

    -- Part categories
    IF v_template->'part_categories' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'part_categories') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));
            INSERT INTO part_categories (id, company_id, name, default_markup_percent, description, created_at)
            VALUES (v_new_id, p_company_id, v_item->>'name',
                    (v_item->>'default_markup_percent')::NUMERIC,
                    v_item->>'description',
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));
        END LOOP;
    END IF;

    -- Parts
    IF v_template->'parts' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'parts') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));
            INSERT INTO parts (id, company_id, part_number, description,
                               category_id, manual_cost, cost_source, created_at)
            VALUES (v_new_id, p_company_id, v_item->>'part_number', v_item->>'description',
                    CASE WHEN v_item->>'category_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'category_ref'))::UUID ELSE NULL END,
                    (v_item->>'manual_cost')::NUMERIC,
                    v_item->>'cost_source',
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));
        END LOOP;
    END IF;

    -- Inventory items
    IF v_template->'inventory_items' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'inventory_items') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));
            INSERT INTO inventory_items (id, company_id, name, description, sku, primary_unit,
                                         quantity, cost_per_unit, reorder_point, created_at)
            VALUES (v_new_id, p_company_id, v_item->>'name', v_item->>'description',
                    v_item->>'sku', v_item->>'primary_unit',
                    COALESCE((v_item->>'quantity')::NUMERIC, 0),
                    (v_item->>'cost_per_unit')::NUMERIC,
                    (v_item->>'reorder_point')::NUMERIC,
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));
        END LOOP;
    END IF;

    -- Routings + nodes + materials
    IF v_template->'routings' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'routings') LOOP
            v_new_id := gen_random_uuid();
            v_routing_id := v_new_id;
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

            INSERT INTO routings (id, company_id, part_id, name, description, created_by, created_at)
            VALUES (v_new_id, p_company_id,
                    (v_ref_map->>(v_item->>'part_ref'))::UUID,
                    v_item->>'name', v_item->>'description',
                    p_user_id,
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));

            v_node_seq := 10;
            IF v_item->'nodes' IS NOT NULL THEN
                FOR v_node IN SELECT * FROM jsonb_array_elements(v_item->'nodes') LOOP
                    v_new_id := gen_random_uuid();
                    v_ref_map := jsonb_set(v_ref_map, ARRAY[v_node->>'_ref'], to_jsonb(v_new_id::TEXT));
                    INSERT INTO routing_nodes (id, routing_id, operation_type_id,
                                               run_time_per_unit, setup_time, instructions, sequence)
                    VALUES (v_new_id, v_routing_id,
                            (v_ref_map->>(v_node->>'operation_type_ref'))::UUID,
                            (v_node->>'run_time_per_unit')::NUMERIC,
                            COALESCE((v_node->>'setup_time')::NUMERIC, 0),
                            v_node->>'instructions',
                            v_node_seq);
                    v_node_seq := v_node_seq + 10;
                END LOOP;
            END IF;

            IF v_item->'materials' IS NOT NULL AND jsonb_typeof(v_item->'materials') = 'array' THEN
                INSERT INTO routing_materials (routing_id, inventory_item_id, quantity, unit, sequence)
                SELECT v_routing_id,
                       (v_ref_map->>(mat->>'inventory_item_ref'))::UUID,
                       (mat->>'quantity')::NUMERIC,
                       mat->>'unit',
                       (ord * 10)::INTEGER
                FROM jsonb_array_elements(v_item->'materials') WITH ORDINALITY AS arr(mat, ord)
                WHERE mat->>'inventory_item_ref' IS NOT NULL;
            ELSIF v_item->'nodes' IS NOT NULL THEN
                INSERT INTO routing_materials (routing_id, inventory_item_id, quantity, unit, sequence)
                SELECT
                    v_routing_id,
                    (v_ref_map->>agg.inv_ref)::UUID,
                    agg.qty,
                    agg.unit,
                    (ROW_NUMBER() OVER (ORDER BY agg.first_idx, agg.unit) * 10)::INTEGER
                FROM (
                    SELECT
                        mat->>'inventory_item_ref' AS inv_ref,
                        mat->>'unit' AS unit,
                        SUM((mat->>'quantity')::NUMERIC) AS qty,
                        MIN(node_pos.ord) AS first_idx
                    FROM jsonb_array_elements(v_item->'nodes') WITH ORDINALITY AS node_pos(node, ord)
                    CROSS JOIN LATERAL jsonb_array_elements(node_pos.node->'materials') AS mat
                    WHERE jsonb_typeof(node_pos.node->'materials') = 'array'
                      AND mat->>'inventory_item_ref' IS NOT NULL
                    GROUP BY mat->>'inventory_item_ref', mat->>'unit'
                ) agg;
            END IF;
        END LOOP;
    END IF;

    -- Quotes
    IF v_template->'quotes' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'quotes') LOOP
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
                         THEN (v_ref_map->>(v_item->>'part_ref'))::UUID ELSE NULL END,
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

    -- Jobs + job_operations + job_materials
    IF v_template->'jobs' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'jobs') LOOP
            v_new_id := gen_random_uuid();
            v_job_id := v_new_id;
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

            INSERT INTO jobs (id, company_id, customer_id, part_id, quote_id,
                              status, created_by, created_at,
                              started_at, completed_at, shipped_at, status_changed_at)
            VALUES (v_new_id, p_company_id,
                    (v_ref_map->>(v_item->>'customer_ref'))::UUID,
                    CASE WHEN v_item->>'part_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'part_ref'))::UUID ELSE NULL END,
                    CASE WHEN v_item->>'quote_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'quote_ref'))::UUID ELSE NULL END,
                    COALESCE(v_item->>'status', 'not_started'),
                    p_user_id,
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()),
                    (v_item->>'started_at')::TIMESTAMPTZ,
                    (v_item->>'completed_at')::TIMESTAMPTZ,
                    (v_item->>'shipped_at')::TIMESTAMPTZ,
                    (v_item->>'status_changed_at')::TIMESTAMPTZ);

            IF v_item->'operations' IS NOT NULL THEN
                FOR v_op IN SELECT * FROM jsonb_array_elements(v_item->'operations') LOOP
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
                                 THEN (v_ref_map->>(v_op->>'operation_type_ref'))::UUID ELSE NULL END,
                            COALESCE((v_op->>'estimated_setup_minutes')::NUMERIC,
                                     (v_op->>'estimated_setup_hours')::NUMERIC * 60, 0),
                            COALESCE((v_op->>'estimated_run_minutes_per_unit')::NUMERIC,
                                     (v_op->>'estimated_run_hours_per_unit')::NUMERIC * 60, 0),
                            COALESCE((v_op->>'actual_setup_minutes')::NUMERIC,
                                     (v_op->>'actual_setup_hours')::NUMERIC * 60),
                            COALESCE((v_op->>'actual_run_minutes')::NUMERIC,
                                     (v_op->>'actual_run_hours')::NUMERIC * 60),
                            COALESCE(v_op->>'status', 'pending'),
                            CASE WHEN v_op->>'routing_node_ref' IS NOT NULL
                                 THEN (v_ref_map->>(v_op->>'routing_node_ref'))::UUID ELSE NULL END,
                            v_op->>'instructions',
                            (v_op->>'started_at')::TIMESTAMPTZ,
                            (v_op->>'completed_at')::TIMESTAMPTZ,
                            COALESCE((v_op->>'created_at')::TIMESTAMPTZ, NOW()));
                END LOOP;
            END IF;

            IF v_item->>'part_ref' IS NOT NULL THEN
                INSERT INTO job_materials (job_id, routing_material_id, inventory_item_id, expected_quantity, unit)
                SELECT v_job_id, rm.id, rm.inventory_item_id, rm.quantity, rm.unit
                FROM routing_materials rm
                JOIN routings r ON r.id = rm.routing_id
                WHERE r.part_id = (v_ref_map->>(v_item->>'part_ref'))::UUID;
            END IF;
        END LOOP;
    END IF;

    -- Link converted quotes
    IF v_template->'quotes' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'quotes') LOOP
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

-- ============================================================================
-- 2. Replace reset_demo_company: drop the resource_groups DELETE.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reset_demo_company(p_source_company_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_demo_company_id UUID;
BEGIN
    IF p_user_id != auth.uid() THEN
        RAISE EXCEPTION 'Access denied';
    END IF;

    SELECT demo_company_id INTO v_demo_company_id
    FROM companies
    WHERE id = p_source_company_id;

    IF v_demo_company_id IS NULL THEN
        RAISE EXCEPTION 'No demo company exists for company: %', p_source_company_id;
    END IF;

    DELETE FROM operator_sessions WHERE company_id = v_demo_company_id;
    DELETE FROM inventory_transactions WHERE company_id = v_demo_company_id;
    DELETE FROM job_attachments WHERE company_id = v_demo_company_id;
    DELETE FROM quote_attachments WHERE company_id = v_demo_company_id;
    DELETE FROM job_materials WHERE job_id IN (SELECT id FROM jobs WHERE company_id = v_demo_company_id);
    DELETE FROM job_operations WHERE job_id IN (SELECT id FROM jobs WHERE company_id = v_demo_company_id);
    DELETE FROM jobs WHERE company_id = v_demo_company_id;
    DELETE FROM quotes WHERE company_id = v_demo_company_id;
    DELETE FROM routing_materials WHERE routing_id IN (SELECT id FROM routings WHERE company_id = v_demo_company_id);
    DELETE FROM routing_nodes WHERE routing_id IN (SELECT id FROM routings WHERE company_id = v_demo_company_id);
    DELETE FROM routings WHERE company_id = v_demo_company_id;
    DELETE FROM parts WHERE company_id = v_demo_company_id;
    DELETE FROM part_categories WHERE company_id = v_demo_company_id;
    DELETE FROM inventory_items WHERE company_id = v_demo_company_id;
    DELETE FROM operation_types WHERE company_id = v_demo_company_id;
    DELETE FROM customers WHERE company_id = v_demo_company_id;

    DELETE FROM ai_chat_queries WHERE company_id = v_demo_company_id;

    PERFORM seed_demo_data(v_demo_company_id, p_user_id);
END;
$function$;

-- ============================================================================
-- 3. Drop columns and tables.
-- ============================================================================

ALTER TABLE public.operation_types DROP COLUMN IF EXISTS resource_group_id;
DROP TABLE IF EXISTS public.resource_groups CASCADE;
ALTER TABLE public.jobs DROP COLUMN IF EXISTS description;

COMMIT;
