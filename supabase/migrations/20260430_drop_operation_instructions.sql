-- Drop the now-dead `instructions` column from routing_nodes and job_operations.
-- The field has no UI input — neither the routing builder nor any other
-- surface ever populates it — and the read-side card on the operator job-part
-- page is being removed in the same change set. Replaces the two procs that
-- still referenced it (create_job_part_operations_from_routing, seed_demo_data)
-- with bodies that omit the column.

BEGIN;

-- ============================================================================
-- 1. Drop the columns
-- ============================================================================

ALTER TABLE public.routing_nodes DROP COLUMN IF EXISTS instructions;
ALTER TABLE public.job_operations DROP COLUMN IF EXISTS instructions;

-- ============================================================================
-- 2. Re-create create_job_part_operations_from_routing without instructions
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_job_part_operations_from_routing(
  p_job_part_id uuid,
  p_routing_id uuid
)
RETURNS integer
LANGUAGE plpgsql
AS $function$
DECLARE
    v_count integer := 0;
    v_node record;
    v_seq integer := 10;
    v_job_id uuid;
    v_min_seq integer;
BEGIN
    SELECT job_id INTO v_job_id FROM job_parts WHERE id = p_job_part_id;
    IF v_job_id IS NULL THEN
        RAISE EXCEPTION 'job_part % not found', p_job_part_id;
    END IF;

    FOR v_node IN
        SELECT rn.*, ot.name AS operation_name
        FROM routing_nodes rn
        JOIN operation_types ot ON rn.operation_type_id = ot.id
        WHERE rn.routing_id = p_routing_id
        ORDER BY rn.sequence, rn.created_at
    LOOP
        INSERT INTO job_operations (
            job_id, job_part_id, sequence, operation_name, operation_type_id,
            estimated_setup_minutes, estimated_run_minutes_per_unit,
            status, routing_node_id
        ) VALUES (
            v_job_id, p_job_part_id, v_seq, v_node.operation_name, v_node.operation_type_id,
            COALESCE(v_node.setup_time, 0), v_node.run_time_per_unit,
            'pending', v_node.id
        );
        v_seq := v_seq + 10;
        v_count := v_count + 1;
    END LOOP;

    INSERT INTO job_materials (job_id, job_part_id, routing_material_id, inventory_item_id, expected_quantity, unit)
    SELECT v_job_id, p_job_part_id, rm.id, rm.inventory_item_id, rm.quantity, rm.unit
    FROM routing_materials rm
    WHERE rm.routing_id = p_routing_id
      AND NOT EXISTS (
          SELECT 1 FROM job_materials jm
          WHERE jm.job_part_id = p_job_part_id AND jm.routing_material_id = rm.id
      );

    SELECT MIN(sequence) INTO v_min_seq FROM job_operations WHERE job_part_id = p_job_part_id;
    IF v_min_seq IS NOT NULL THEN
        UPDATE job_parts SET current_operation_sequence = v_min_seq WHERE id = p_job_part_id;
    END IF;

    RETURN v_count;
END;
$function$;

-- ============================================================================
-- 3. Re-create seed_demo_data without instructions references
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
    v_template jsonb;
    v_ref_map jsonb := '{}'::jsonb;
    v_item jsonb;
    v_op jsonb;
    v_new_id uuid;
    v_job_id uuid;
    v_job_part_id uuid;
    v_part_id uuid;
BEGIN
    SELECT template INTO v_template
    FROM demo_data_templates
    WHERE name = p_template_name AND is_active = true
    LIMIT 1;

    IF v_template IS NULL THEN
        RAISE EXCEPTION 'No active demo template found with name: %', p_template_name;
    END IF;

    -- Customers
    IF v_template->'customers' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'customers') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO customers (id, company_id, name, contact_name, contact_email, contact_phone,
                                   address_line1, address_line2, city, state, postal_code, country, website,
                                   created_at, updated_at)
            VALUES (v_new_id, p_company_id,
                    v_item->>'name', v_item->>'contact_name', v_item->>'contact_email', v_item->>'contact_phone',
                    v_item->>'address_line1', v_item->>'address_line2',
                    v_item->>'city', v_item->>'state', v_item->>'postal_code',
                    COALESCE(v_item->>'country','USA'), v_item->>'website',
                    COALESCE((v_item->>'created_at')::timestamptz, now()),
                    COALESCE((v_item->>'updated_at')::timestamptz, now()));
        END LOOP;
    END IF;

    -- Operation types
    IF v_template->'operation_types' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'operation_types') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO operation_types (id, company_id, name, description, hourly_rate, created_at, updated_at)
            VALUES (v_new_id, p_company_id, v_item->>'name', v_item->>'description',
                    (v_item->>'hourly_rate')::numeric,
                    COALESCE((v_item->>'created_at')::timestamptz, now()),
                    COALESCE((v_item->>'updated_at')::timestamptz, now()));
        END LOOP;
    END IF;

    -- Inventory items
    IF v_template->'inventory_items' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'inventory_items') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO inventory_items (id, company_id, item_name, description, unit, current_stock,
                                          minimum_stock, cost_per_unit, location, created_at, updated_at)
            VALUES (v_new_id, p_company_id, v_item->>'item_name', v_item->>'description',
                    COALESCE(v_item->>'unit','each'),
                    COALESCE((v_item->>'current_stock')::numeric, 0),
                    COALESCE((v_item->>'minimum_stock')::numeric, 0),
                    COALESCE((v_item->>'cost_per_unit')::numeric, 0),
                    v_item->>'location',
                    COALESCE((v_item->>'created_at')::timestamptz, now()),
                    COALESCE((v_item->>'updated_at')::timestamptz, now()));
        END LOOP;
    END IF;

    -- Parts
    IF v_template->'parts' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'parts') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO parts (id, company_id, part_name, description, category_id,
                               created_by, created_at, updated_at)
            VALUES (v_new_id, p_company_id, v_item->>'part_name', v_item->>'description',
                    NULL, p_user_id,
                    COALESCE((v_item->>'created_at')::timestamptz, now()),
                    COALESCE((v_item->>'updated_at')::timestamptz, now()));
        END LOOP;
    END IF;

    -- Routings, routing_nodes, routing_materials
    IF v_template->'routings' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'routings') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO routings (id, company_id, part_id, name, description,
                                  created_by, created_at, updated_at)
            VALUES (v_new_id, p_company_id,
                    (v_ref_map->>(v_item->>'part_ref'))::uuid,
                    v_item->>'name', v_item->>'description',
                    p_user_id,
                    COALESCE((v_item->>'created_at')::timestamptz, now()),
                    COALESCE((v_item->>'updated_at')::timestamptz, now()));

            IF v_item->'nodes' IS NOT NULL THEN
                FOR v_op IN SELECT * FROM jsonb_array_elements(v_item->'nodes') LOOP
                    v_new_id := gen_random_uuid();
                    v_ref_map := jsonb_set(v_ref_map, ARRAY[v_op->>'_ref'], to_jsonb(v_new_id::text));
                    INSERT INTO routing_nodes (id, routing_id, operation_type_id, sequence,
                                               run_time_per_unit, setup_time,
                                               metadata, created_at, updated_at)
                    VALUES (v_new_id,
                            (v_ref_map->>(v_item->>'_ref'))::uuid,
                            (v_ref_map->>(v_op->>'operation_type_ref'))::uuid,
                            (v_op->>'sequence')::integer,
                            COALESCE((v_op->>'run_time_per_unit')::numeric, 0),
                            COALESCE((v_op->>'setup_time')::numeric, 0),
                            COALESCE((v_op->'metadata'), '{}'::jsonb),
                            COALESCE((v_op->>'created_at')::timestamptz, now()),
                            COALESCE((v_op->>'updated_at')::timestamptz, now()));
                END LOOP;
            END IF;

            IF v_item->'materials' IS NOT NULL THEN
                FOR v_op IN SELECT * FROM jsonb_array_elements(v_item->'materials') LOOP
                    INSERT INTO routing_materials (id, routing_id, inventory_item_id,
                                                   quantity, unit, sequence)
                    VALUES (gen_random_uuid(),
                            (v_ref_map->>(v_item->>'_ref'))::uuid,
                            (v_ref_map->>(v_op->>'inventory_item_ref'))::uuid,
                            (v_op->>'quantity')::numeric,
                            v_op->>'unit',
                            COALESCE((v_op->>'sequence')::integer, 0));
                END LOOP;
            END IF;
        END LOOP;
    END IF;

    IF v_template->'quotes' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'quotes') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO quotes (id, company_id, customer_id, status,
                                lead_time_days, expiration_date,
                                created_by, created_at, updated_at,
                                status_changed_at, converted_at)
            VALUES (v_new_id, p_company_id,
                    (v_ref_map->>(v_item->>'customer_ref'))::uuid,
                    COALESCE(v_item->>'status', 'active'),
                    (v_item->>'lead_time_days')::integer,
                    (v_item->>'expiration_date')::date,
                    p_user_id,
                    COALESCE((v_item->>'created_at')::timestamptz, now()),
                    COALESCE((v_item->>'updated_at')::timestamptz, now()),
                    (v_item->>'status_changed_at')::timestamptz,
                    (v_item->>'converted_at')::timestamptz);
        END LOOP;
    END IF;

    -- Jobs: insert one job + one job_parts per (job, part_ref). Operations and
    -- materials hang off the job_part.
    IF v_template->'jobs' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'jobs') LOOP
            v_new_id := gen_random_uuid();
            v_job_id := v_new_id;
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));

            INSERT INTO jobs (id, company_id, customer_id, quote_id,
                              job_number, status, created_by, created_at,
                              started_at, completed_at, shipped_at, status_changed_at)
            VALUES (v_new_id, p_company_id,
                    (v_ref_map->>(v_item->>'customer_ref'))::uuid,
                    CASE WHEN v_item->>'quote_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'quote_ref'))::uuid ELSE NULL END,
                    COALESCE(v_item->>'job_number', 'J-DEMO-' || substr(v_new_id::text, 1, 8)),
                    COALESCE(v_item->>'status', 'not_started'),
                    p_user_id,
                    COALESCE((v_item->>'created_at')::timestamptz, now()),
                    (v_item->>'started_at')::timestamptz,
                    (v_item->>'completed_at')::timestamptz,
                    (v_item->>'shipped_at')::timestamptz,
                    (v_item->>'status_changed_at')::timestamptz);

            IF v_item->>'part_ref' IS NOT NULL THEN
                v_part_id := (v_ref_map->>(v_item->>'part_ref'))::uuid;
                v_job_part_id := gen_random_uuid();

                INSERT INTO job_parts (id, job_id, company_id, part_id,
                                       sequence, quantity, status,
                                       status_changed_at, started_at, completed_at, shipped_at,
                                       created_at, updated_at)
                VALUES (v_job_part_id, v_job_id, p_company_id, v_part_id,
                        10,
                        COALESCE((v_item->>'quantity')::integer, 1),
                        COALESCE(v_item->>'status', 'not_started'),
                        (v_item->>'status_changed_at')::timestamptz,
                        (v_item->>'started_at')::timestamptz,
                        (v_item->>'completed_at')::timestamptz,
                        (v_item->>'shipped_at')::timestamptz,
                        COALESCE((v_item->>'created_at')::timestamptz, now()),
                        COALESCE((v_item->>'created_at')::timestamptz, now()));

                IF v_item->'operations' IS NOT NULL THEN
                    FOR v_op IN SELECT * FROM jsonb_array_elements(v_item->'operations') LOOP
                        v_new_id := gen_random_uuid();
                        v_ref_map := jsonb_set(v_ref_map, ARRAY[v_op->>'_ref'], to_jsonb(v_new_id::text));
                        INSERT INTO job_operations (id, job_id, job_part_id, sequence, operation_name,
                                                    operation_type_id, estimated_setup_minutes,
                                                    estimated_run_minutes_per_unit,
                                                    actual_setup_minutes, actual_run_minutes,
                                                    status, routing_node_id,
                                                    started_at, completed_at, created_at)
                        VALUES (v_new_id, v_job_id, v_job_part_id,
                                (v_op->>'sequence')::integer,
                                v_op->>'operation_name',
                                CASE WHEN v_op->>'operation_type_ref' IS NOT NULL
                                     THEN (v_ref_map->>(v_op->>'operation_type_ref'))::uuid ELSE NULL END,
                                COALESCE((v_op->>'estimated_setup_minutes')::numeric,
                                         (v_op->>'estimated_setup_hours')::numeric * 60, 0),
                                COALESCE((v_op->>'estimated_run_minutes_per_unit')::numeric,
                                         (v_op->>'estimated_run_hours_per_unit')::numeric * 60, 0),
                                COALESCE((v_op->>'actual_setup_minutes')::numeric,
                                         (v_op->>'actual_setup_hours')::numeric * 60),
                                COALESCE((v_op->>'actual_run_minutes')::numeric,
                                         (v_op->>'actual_run_hours')::numeric * 60),
                                COALESCE(v_op->>'status', 'pending'),
                                CASE WHEN v_op->>'routing_node_ref' IS NOT NULL
                                     THEN (v_ref_map->>(v_op->>'routing_node_ref'))::uuid ELSE NULL END,
                                (v_op->>'started_at')::timestamptz,
                                (v_op->>'completed_at')::timestamptz,
                                COALESCE((v_op->>'created_at')::timestamptz, now()));
                    END LOOP;
                END IF;

                INSERT INTO job_materials (job_id, job_part_id, routing_material_id,
                                           inventory_item_id, expected_quantity, unit)
                SELECT v_job_id, v_job_part_id, rm.id, rm.inventory_item_id, rm.quantity, rm.unit
                FROM routing_materials rm
                JOIN routings r ON r.id = rm.routing_id
                WHERE r.part_id = v_part_id;
            END IF;
        END LOOP;
    END IF;

    IF v_template->'quotes' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'quotes') LOOP
            IF v_item->>'converted_to_job_ref' IS NOT NULL THEN
                UPDATE quotes
                SET converted_at = (v_item->>'converted_at')::timestamptz
                WHERE id = (v_ref_map->>(v_item->>'_ref'))::uuid;
            END IF;
        END LOOP;
    END IF;
END;
$function$;

COMMIT;
