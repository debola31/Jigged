-- ============================================================================
-- Remove 'draft' quote status: quotes now go directly to 'pending_approval'
-- ============================================================================
--
-- Previously, new quotes were created as 'draft' and then manually sent for
-- approval. This migration removes the draft status entirely — new quotes
-- are created directly as 'pending_approval'.
--
-- Changes:
-- 1. Migrate any existing draft quotes to pending_approval
-- 2. Update column default from 'draft' to 'pending_approval'
-- 3. Update CHECK constraint to remove 'draft'
-- 4. Update seed_demo_data function
-- 5. Update demo_data_templates JSONB
-- ============================================================================

-- 1. Migrate existing draft quotes
UPDATE quotes SET status = 'pending_approval', status_changed_at = NOW()
WHERE status = 'draft';

-- 2. Change column default
ALTER TABLE quotes ALTER COLUMN status SET DEFAULT 'pending_approval';

-- 3. Update CHECK constraint (remove 'draft')
ALTER TABLE quotes DROP CONSTRAINT IF EXISTS quotes_status_check;
ALTER TABLE quotes ADD CONSTRAINT quotes_status_check
  CHECK (status = ANY (ARRAY[
    'pending_approval'::text,
    'approved'::text,
    'rejected'::text,
    'accepted'::text,
    'expired'::text,
    'converted'::text
  ]));

-- 4. Update demo_data_templates: convert any "draft" status to "pending_approval"
UPDATE demo_data_templates
SET template_data = (
    SELECT jsonb_set(
        template_data,
        '{quotes}',
        (
            SELECT COALESCE(jsonb_agg(
                CASE
                    WHEN q->>'status' = 'draft'
                    THEN jsonb_set(q, '{status}', '"pending_approval"'::jsonb)
                    ELSE q
                END
            ), '[]'::jsonb)
            FROM jsonb_array_elements(template_data->'quotes') AS q
        )
    )
)
WHERE template_data->'quotes' IS NOT NULL;

-- 5. Update seed_demo_data function: change default status from 'draft' to 'pending_approval'
CREATE OR REPLACE FUNCTION public.seed_demo_data(
    p_company_id uuid,
    p_user_id uuid,
    p_template_name character varying DEFAULT 'default'::character varying
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_template JSONB;
    v_item JSONB;
    v_sub_item JSONB;
    v_new_id UUID;
    v_job_id UUID;
    v_ref_map JSONB := '{}'::JSONB;
    v_node_sequence INTEGER;
    v_op_sequence INTEGER;
BEGIN
    -- Get the active template
    SELECT template_data INTO v_template
    FROM demo_data_templates
    WHERE name = p_template_name AND is_active = TRUE
    LIMIT 1;

    IF v_template IS NULL THEN
        RAISE EXCEPTION 'No active template found with name: %', p_template_name;
    END IF;

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
                    v_item->>'name', v_item->>'email', v_item->>'phone',
                    v_item->>'address', v_item->>'notes',
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));
        END LOOP;
    END IF;

    -- -----------------------------------------------------------------------
    -- Insert operation types
    -- -----------------------------------------------------------------------
    IF v_template->'operation_types' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'operation_types')
        LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

            INSERT INTO operation_types (id, company_id, name, description, color, default_rate_per_hour, created_at)
            VALUES (v_new_id, p_company_id,
                    v_item->>'name', v_item->>'description', v_item->>'color',
                    (v_item->>'default_rate_per_hour')::NUMERIC,
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));
        END LOOP;
    END IF;

    -- -----------------------------------------------------------------------
    -- Insert resource groups
    -- -----------------------------------------------------------------------
    IF v_template->'resource_groups' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'resource_groups')
        LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

            INSERT INTO resource_groups (id, company_id, name, description, created_at)
            VALUES (v_new_id, p_company_id,
                    v_item->>'name', v_item->>'description',
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));
        END LOOP;
    END IF;

    -- -----------------------------------------------------------------------
    -- Insert resources
    -- -----------------------------------------------------------------------
    IF v_template->'resources' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'resources')
        LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

            INSERT INTO resources (id, company_id, name, type, status, group_id, hourly_rate, notes, created_at)
            VALUES (v_new_id, p_company_id,
                    v_item->>'name', v_item->>'type',
                    COALESCE(v_item->>'status', 'available'),
                    CASE WHEN v_item->>'group_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'group_ref'))::UUID
                         ELSE NULL END,
                    (v_item->>'hourly_rate')::NUMERIC,
                    v_item->>'notes',
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));
        END LOOP;
    END IF;

    -- -----------------------------------------------------------------------
    -- Insert part categories
    -- -----------------------------------------------------------------------
    IF v_template->'part_categories' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'part_categories')
        LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

            INSERT INTO part_categories (id, company_id, name, description, default_markup_percent, created_at)
            VALUES (v_new_id, p_company_id,
                    v_item->>'name', v_item->>'description',
                    (v_item->>'default_markup_percent')::NUMERIC,
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));
        END LOOP;
    END IF;

    -- -----------------------------------------------------------------------
    -- Insert parts (depends on part_categories)
    -- -----------------------------------------------------------------------
    IF v_template->'parts' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'parts')
        LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

            INSERT INTO parts (id, company_id, part_number, name, description, material, category_id, created_at)
            VALUES (v_new_id, p_company_id,
                    v_item->>'part_number', v_item->>'name', v_item->>'description',
                    v_item->>'material',
                    CASE WHEN v_item->>'category_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'category_ref'))::UUID
                         ELSE NULL END,
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));
        END LOOP;
    END IF;

    -- -----------------------------------------------------------------------
    -- Insert routings (depends on parts)
    -- -----------------------------------------------------------------------
    IF v_template->'routings' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'routings')
        LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::TEXT));

            INSERT INTO routings (id, company_id, part_id, name, description, is_active, created_at)
            VALUES (v_new_id, p_company_id,
                    (v_ref_map->>(v_item->>'part_ref'))::UUID,
                    v_item->>'name', v_item->>'description',
                    COALESCE((v_item->>'is_active')::BOOLEAN, TRUE),
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));

            -- Insert routing nodes
            IF v_item->'nodes' IS NOT NULL THEN
                v_node_sequence := 0;
                FOR v_sub_item IN SELECT * FROM jsonb_array_elements(v_item->'nodes')
                LOOP
                    v_node_sequence := v_node_sequence + 1;

                    INSERT INTO routing_nodes (
                        routing_id, operation_type_id, resource_group_id,
                        sequence_number, name, description,
                        setup_time_minutes, run_time_per_unit,
                        created_at
                    )
                    VALUES (
                        v_new_id,
                        CASE WHEN v_sub_item->>'operation_type_ref' IS NOT NULL
                             THEN (v_ref_map->>(v_sub_item->>'operation_type_ref'))::UUID
                             ELSE NULL END,
                        CASE WHEN v_sub_item->>'resource_group_ref' IS NOT NULL
                             THEN (v_ref_map->>(v_sub_item->>'resource_group_ref'))::UUID
                             ELSE NULL END,
                        COALESCE((v_sub_item->>'sequence_number')::INTEGER, v_node_sequence),
                        v_sub_item->>'name',
                        v_sub_item->>'description',
                        COALESCE((v_sub_item->>'setup_time_minutes')::NUMERIC, 0),
                        (v_sub_item->>'run_time_per_unit')::NUMERIC,
                        COALESCE((v_sub_item->>'created_at')::TIMESTAMPTZ, NOW())
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
                    COALESCE(v_item->>'status', 'pending_approval'),
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
                              quantity, priority, status, notes, due_date,
                              created_by, created_at)
            VALUES (v_new_id, p_company_id,
                    CASE WHEN v_item->>'customer_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'customer_ref'))::UUID
                         ELSE NULL END,
                    CASE WHEN v_item->>'part_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'part_ref'))::UUID
                         ELSE NULL END,
                    CASE WHEN v_item->>'quote_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'quote_ref'))::UUID
                         ELSE NULL END,
                    COALESCE((v_item->>'quantity')::INTEGER, 1),
                    COALESCE(v_item->>'priority', 'medium'),
                    COALESCE(v_item->>'status', 'pending'),
                    v_item->>'notes',
                    (v_item->>'due_date')::DATE,
                    p_user_id,
                    COALESCE((v_item->>'created_at')::TIMESTAMPTZ, NOW()));

            -- Insert job operations
            IF v_item->'operations' IS NOT NULL THEN
                v_op_sequence := 0;
                FOR v_sub_item IN SELECT * FROM jsonb_array_elements(v_item->'operations')
                LOOP
                    v_op_sequence := v_op_sequence + 1;

                    INSERT INTO job_operations (
                        job_id, operation_type_id, resource_id,
                        sequence_number, status,
                        estimated_setup_minutes,
                        estimated_run_minutes_per_unit,
                        actual_setup_minutes,
                        actual_run_minutes,
                        notes, created_at
                    )
                    VALUES (
                        v_job_id,
                        CASE WHEN v_sub_item->>'operation_type_ref' IS NOT NULL
                             THEN (v_ref_map->>(v_sub_item->>'operation_type_ref'))::UUID
                             ELSE NULL END,
                        CASE WHEN v_sub_item->>'resource_ref' IS NOT NULL
                             THEN (v_ref_map->>(v_sub_item->>'resource_ref'))::UUID
                             ELSE NULL END,
                        COALESCE((v_sub_item->>'sequence_number')::INTEGER, v_op_sequence),
                        COALESCE(v_sub_item->>'status', 'pending'),
                        COALESCE((v_sub_item->>'estimated_setup_minutes')::NUMERIC, 0),
                        (v_sub_item->>'estimated_run_minutes_per_unit')::NUMERIC,
                        (v_sub_item->>'actual_setup_minutes')::NUMERIC,
                        (v_sub_item->>'actual_run_minutes')::NUMERIC,
                        v_sub_item->>'notes',
                        COALESCE((v_sub_item->>'created_at')::TIMESTAMPTZ, NOW())
                    );
                END LOOP;
            END IF;
        END LOOP;
    END IF;
END;
$function$;
