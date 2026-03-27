-- Fix demo template: add part categories, assign category_refs to parts,
-- add materials to routing nodes, set cost_source on parts.
-- Also update seed_demo_data() to resolve inventory_item_ref in materials.

-- -----------------------------------------------------------------------
-- 1. Update seed_demo_data() to resolve inventory_item_ref in materials
-- -----------------------------------------------------------------------
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
    v_mat JSONB;
    v_resolved_materials JSONB;
    v_resolved_mat JSONB;
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
    -- Insert part_categories (supports cost-plus model)
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
    -- Insert parts (uses category_id, manual_cost, cost_source)
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

                    -- Resolve inventory_item_ref in materials to inventory_item_id UUIDs
                    v_resolved_materials := '[]'::JSONB;
                    IF v_node->'materials' IS NOT NULL AND jsonb_array_length(v_node->'materials') > 0 THEN
                        FOR v_mat IN SELECT * FROM jsonb_array_elements(v_node->'materials')
                        LOOP
                            v_resolved_mat := jsonb_build_object(
                                'inventory_item_id',
                                CASE WHEN v_mat->>'inventory_item_ref' IS NOT NULL
                                     THEN v_ref_map->>(v_mat->>'inventory_item_ref')
                                     ELSE v_mat->>'inventory_item_id'
                                END,
                                'quantity', (v_mat->>'quantity')::NUMERIC,
                                'unit', v_mat->>'unit'
                            );
                            v_resolved_materials := v_resolved_materials || jsonb_build_array(v_resolved_mat);
                        END LOOP;
                    END IF;

                    INSERT INTO routing_nodes (id, routing_id, operation_type_id,
                                               run_time_per_unit, instructions, materials)
                    VALUES (v_new_id,
                            v_routing_id,
                            (v_ref_map->>(v_node->>'operation_type_ref'))::UUID,
                            (v_node->>'run_time_per_unit')::NUMERIC,
                            v_node->>'instructions',
                            v_resolved_materials);
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
    -- Includes cost-plus snapshot fields
    -- -----------------------------------------------------------------------
    IF v_template->'quotes' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'quotes')
        LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

            INSERT INTO quotes (id, company_id, quote_number, customer_id, part_id,
                                quantity, unit_price, total_price, status,
                                description, created_by, created_at, status_changed_at,
                                base_cost, cost_source, markup_percent,
                                estimated_labor_cost, estimated_material_cost)
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
                    (v_item->>'status_changed_at')::TIMESTAMPTZ,
                    (v_item->>'base_cost')::NUMERIC,
                    v_item->>'cost_source',
                    (v_item->>'markup_percent')::NUMERIC,
                    (v_item->>'estimated_labor_cost')::NUMERIC,
                    (v_item->>'estimated_material_cost')::NUMERIC);
        END LOOP;
    END IF;

    -- -----------------------------------------------------------------------
    -- Insert jobs + job_operations (depends on customers, parts, quotes)
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


-- -----------------------------------------------------------------------
-- 2. Transform the active demo template: add categories, materials, cost_source
-- -----------------------------------------------------------------------
DO $$
DECLARE
    v_template JSONB;
    v_template_id UUID;
    v_parts JSONB;
    v_routings JSONB;
    v_new_parts JSONB := '[]'::JSONB;
    v_new_routings JSONB := '[]'::JSONB;
    v_part JSONB;
    v_routing JSONB;
    v_node JSONB;
    v_new_nodes JSONB;
    v_part_number TEXT;
    v_prefix TEXT;
    v_variant INT;
    v_category_ref TEXT;
    v_op_ref TEXT;
    v_mill_inv TEXT;
    v_turn_inv TEXT;
    v_mill_unit TEXT;
    v_turn_unit TEXT;
    v_mill_qty NUMERIC;
    v_turn_qty NUMERIC;
    v_materials JSONB;
    v_part_ref TEXT;
    v_part_idx INT;
    v_categories JSONB;
BEGIN
    -- Get active template
    SELECT id, template_data INTO v_template_id, v_template
    FROM demo_data_templates
    WHERE name = 'default' AND is_active = TRUE
    LIMIT 1;

    IF v_template_id IS NULL THEN
        RAISE NOTICE 'No active default template found, skipping transform';
        RETURN;
    END IF;

    -- -----------------------------------------------------------------------
    -- A. Add part_categories
    -- -----------------------------------------------------------------------
    v_categories := '[
        {"_ref": "cat-brackets", "name": "Brackets & Mounts", "default_markup_percent": 35, "description": "Structural brackets and mounting blocks"},
        {"_ref": "cat-shafts", "name": "Shafts & Rods", "default_markup_percent": 40, "description": "Turned shafts, spacer rods, and pins"},
        {"_ref": "cat-housings", "name": "Housings & Covers", "default_markup_percent": 45, "description": "Housing plates, covers, and cap panels"},
        {"_ref": "cat-flanges", "name": "Flanges & Adapters", "default_markup_percent": 38, "description": "Flange rings and adapter bars"}
    ]'::JSONB;

    -- -----------------------------------------------------------------------
    -- B. Assign category_ref + cost_source to each part
    -- -----------------------------------------------------------------------
    v_parts := v_template->'parts';
    FOR v_part_idx IN 0 .. jsonb_array_length(v_parts) - 1
    LOOP
        v_part := v_parts->v_part_idx;
        v_part_number := v_part->>'part_number';
        v_prefix := split_part(v_part_number, '-', 1);

        -- Map prefix to category
        v_category_ref := CASE v_prefix
            WHEN 'BRK' THEN 'cat-brackets'
            WHEN 'MNT' THEN 'cat-brackets'
            WHEN 'SFT' THEN 'cat-shafts'
            WHEN 'SPC' THEN 'cat-shafts'
            WHEN 'PIN' THEN 'cat-shafts'
            WHEN 'HSG' THEN 'cat-housings'
            WHEN 'CVR' THEN 'cat-housings'
            WHEN 'CAP' THEN 'cat-housings'
            WHEN 'FLG' THEN 'cat-flanges'
            WHEN 'ADP' THEN 'cat-flanges'
            ELSE NULL
        END;

        -- Set category_ref and cost_source
        v_part := v_part || jsonb_build_object('category_ref', v_category_ref, 'cost_source', 'routing');
        v_new_parts := v_new_parts || jsonb_build_array(v_part);
    END LOOP;

    -- -----------------------------------------------------------------------
    -- C. Add materials to routing nodes
    -- -----------------------------------------------------------------------
    v_routings := v_template->'routings';
    FOR v_part_idx IN 0 .. jsonb_array_length(v_routings) - 1
    LOOP
        v_routing := v_routings->v_part_idx;
        v_part_ref := v_routing->>'part_ref';

        -- Determine variant (1-5) from part ref suffix
        v_variant := COALESCE(
            NULLIF(regexp_replace(v_part_ref, '^part-(\d+)$', '\1'), v_part_ref)::INT / 10 + 1,
            1
        );
        -- Clamp: parts 1-10 → variant 1, 11-20 → 2, etc.
        v_variant := LEAST(GREATEST(
            CEIL(COALESCE(NULLIF(regexp_replace(v_part_ref, '^part-(\d+)$', '\1'), v_part_ref)::NUMERIC, 1) / 10.0)::INT,
            1
        ), 5);

        -- Set raw material based on variant
        CASE v_variant
            WHEN 1 THEN v_mill_inv := 'inv-1';  v_turn_inv := 'inv-1';  v_mill_unit := 'inches'; v_turn_unit := 'inches'; v_mill_qty := 4.0; v_turn_qty := 3.5;
            WHEN 2 THEN v_mill_inv := 'inv-5';  v_turn_inv := 'inv-5';  v_mill_unit := 'inches'; v_turn_unit := 'inches'; v_mill_qty := 3.5; v_turn_qty := 3.0;
            WHEN 3 THEN v_mill_inv := 'inv-4';  v_turn_inv := 'inv-8';  v_mill_unit := 'inches'; v_turn_unit := 'inches'; v_mill_qty := 5.0; v_turn_qty := 4.5;
            WHEN 4 THEN v_mill_inv := 'inv-7';  v_turn_inv := 'inv-9';  v_mill_unit := 'inches'; v_turn_unit := 'inches'; v_mill_qty := 3.0; v_turn_qty := 4.0;
            WHEN 5 THEN v_mill_inv := 'inv-10'; v_turn_inv := 'inv-11'; v_mill_unit := 'inches'; v_turn_unit := 'inches'; v_mill_qty := 3.5; v_turn_qty := 3.0;
        END CASE;

        -- Process each node in the routing
        v_new_nodes := '[]'::JSONB;
        FOR v_node IN SELECT * FROM jsonb_array_elements(v_routing->'nodes')
        LOOP
            v_op_ref := v_node->>'operation_type_ref';
            v_materials := '[]'::JSONB;

            -- First machining operation gets raw material
            IF v_op_ref = 'op-mill' AND NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements(v_new_nodes) n
                WHERE (n->>'operation_type_ref' IN ('op-mill', 'op-turn'))
                  AND jsonb_array_length(n->'materials') > 0
            ) THEN
                v_materials := jsonb_build_array(jsonb_build_object(
                    'inventory_item_ref', v_mill_inv,
                    'quantity', v_mill_qty,
                    'unit', v_mill_unit
                ));
            ELSIF v_op_ref = 'op-turn' AND NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements(v_new_nodes) n
                WHERE (n->>'operation_type_ref' IN ('op-mill', 'op-turn'))
                  AND jsonb_array_length(n->'materials') > 0
            ) THEN
                v_materials := jsonb_build_array(jsonb_build_object(
                    'inventory_item_ref', v_turn_inv,
                    'quantity', v_turn_qty,
                    'unit', v_turn_unit
                ));
            -- Finishing operations get finishing materials
            ELSIF v_op_ref = 'op-anodize' THEN
                v_materials := jsonb_build_array(jsonb_build_object(
                    'inventory_item_ref', CASE WHEN v_variant % 2 = 1 THEN 'inv-38' ELSE 'inv-39' END,
                    'quantity', CASE WHEN v_variant % 2 = 1 THEN 0.15 ELSE 0.12 END,
                    'unit', 'gallons'
                ));
            ELSIF v_op_ref = 'op-powder' THEN
                v_materials := jsonb_build_array(jsonb_build_object(
                    'inventory_item_ref', CASE WHEN v_variant % 2 = 1 THEN 'inv-41' ELSE 'inv-42' END,
                    'quantity', 0.25,
                    'unit', 'pounds'
                ));
            ELSIF v_op_ref = 'op-assembly' THEN
                v_materials := jsonb_build_array(
                    jsonb_build_object('inventory_item_ref', 'inv-46', 'quantity', 0.5, 'unit', 'packs'),
                    jsonb_build_object('inventory_item_ref', 'inv-48', 'quantity', 2, 'unit', 'each')
                );
            ELSIF v_op_ref = 'op-weld' THEN
                -- Welding uses cutting fluid for prep
                v_materials := jsonb_build_array(jsonb_build_object(
                    'inventory_item_ref', 'inv-36',
                    'quantity', 0.1,
                    'unit', 'each'
                ));
            END IF;

            -- Update node with materials
            v_node := jsonb_set(v_node, '{materials}', v_materials);
            v_new_nodes := v_new_nodes || jsonb_build_array(v_node);
        END LOOP;

        -- Update routing with new nodes
        v_routing := jsonb_set(v_routing, '{nodes}', v_new_nodes);
        v_new_routings := v_new_routings || jsonb_build_array(v_routing);
    END LOOP;

    -- -----------------------------------------------------------------------
    -- D. Write updated template
    -- -----------------------------------------------------------------------
    v_template := jsonb_set(v_template, '{part_categories}', v_categories);
    v_template := jsonb_set(v_template, '{parts}', v_new_parts);
    v_template := jsonb_set(v_template, '{routings}', v_new_routings);

    UPDATE demo_data_templates
    SET template_data = v_template
    WHERE id = v_template_id;

    RAISE NOTICE 'Demo template updated: added 4 categories, assigned category_refs to % parts, added materials to % routings',
        jsonb_array_length(v_new_parts), jsonb_array_length(v_new_routings);
END;
$$;
