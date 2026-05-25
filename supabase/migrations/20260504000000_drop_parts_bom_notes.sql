-- ============================================================================
-- Drop parts_bom.notes column
-- ============================================================================
--
-- Iteration-2 chunk 16. Per usability review on the Materials panel: the
-- notes field on a BOM line is unused noise. Drop it from the schema and
-- the UI in one pass.
--
-- The seed_demo_data function from 20260504_vendor_contacts_and_drop_notes
-- still references the dropped column in its parts_bom INSERT block. Without
-- a function rewrite here the next call would raise (column does not exist).
-- We CREATE OR REPLACE seed_demo_data with the parts_bom INSERT updated;
-- the rest of the function body is unchanged.
--
-- The active demo template's parts_bom array does not carry a `notes` field
-- (template was authored without one), so no template_data UPDATE is needed.
-- The BOM importer's `notes` column-mapping is dropped in this chunk's app
-- code; the BOM_SCHEMA on the backend drops the field too.

BEGIN;

ALTER TABLE public.parts_bom DROP COLUMN notes;


-- Recreate seed_demo_data with the parts_bom INSERT no longer writing notes.
-- All other blocks are unchanged from 20260504_vendor_contacts_and_drop_notes.

CREATE OR REPLACE FUNCTION public.seed_demo_data(
    p_company_id uuid,
    p_user_id uuid,
    p_template_name text DEFAULT 'default'
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
    v_inner jsonb;
    v_contact jsonb;
    v_new_id uuid;
    v_routing_id uuid;
    v_quote_id uuid;
    v_job_id uuid;
    v_job_part_id uuid;
    v_part_id uuid;
BEGIN
    SELECT template_data INTO v_template
    FROM demo_data_templates
    WHERE name = p_template_name AND is_active = true
    LIMIT 1;

    IF v_template IS NULL THEN
        RAISE EXCEPTION 'No active demo template found with name: %', p_template_name;
    END IF;

    -- ── Vendors + vendor_contacts ─────────────────────────────────────────
    IF v_template->'vendors' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'vendors') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO vendors (id, company_id, name,
                                 address_line1, address_line2, city, state, postal_code, country,
                                 legacy_id)
            VALUES (v_new_id, p_company_id, v_item->>'name',
                    v_item->>'address_line1', v_item->>'address_line2',
                    v_item->>'city', v_item->>'state', v_item->>'postal_code',
                    COALESCE(v_item->>'country', 'USA'),
                    v_item->>'legacy_id');

            IF v_item->'contacts' IS NOT NULL THEN
                FOR v_contact IN SELECT * FROM jsonb_array_elements(v_item->'contacts') LOOP
                    INSERT INTO vendor_contacts (vendor_id, name, role, role_label,
                                                 email, phone, is_primary)
                    VALUES (v_new_id,
                            v_contact->>'name',
                            COALESCE(v_contact->>'role', 'sales'),
                            v_contact->>'role_label',
                            v_contact->>'email',
                            v_contact->>'phone',
                            COALESCE((v_contact->>'is_primary')::boolean, false));
                END LOOP;
            END IF;
        END LOOP;
    END IF;

    -- ── Work centers ──────────────────────────────────────────────────────
    IF v_template->'work_centers' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'work_centers') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO work_centers (id, company_id, name, kind, vendor_id,
                                      labor_rate, description)
            VALUES (v_new_id, p_company_id,
                    v_item->>'name',
                    COALESCE(v_item->>'kind', 'internal'),
                    CASE WHEN v_item->>'vendor_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'vendor_ref'))::uuid
                         ELSE NULL END,
                    NULLIF(v_item->>'labor_rate', '')::numeric,
                    v_item->>'description');
        END LOOP;
    END IF;

    -- ── Parts ─────────────────────────────────────────────────────────────
    IF v_template->'parts' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'parts') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO parts (id, company_id, part_name, description,
                               source, is_stocked,
                               primary_unit, quantity, cost_per_unit,
                               reorder_point, preferred_vendor_id, legacy_id)
            VALUES (v_new_id, p_company_id,
                    v_item->>'part_name', v_item->>'description',
                    COALESCE(v_item->>'source', 'made'),
                    COALESCE((v_item->>'is_stocked')::boolean, false),
                    v_item->>'primary_unit',
                    COALESCE((v_item->>'quantity')::numeric, 0),
                    NULLIF(v_item->>'cost_per_unit', '')::numeric,
                    NULLIF(v_item->>'reorder_point', '')::numeric,
                    CASE WHEN v_item->>'preferred_vendor_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'preferred_vendor_ref'))::uuid
                         ELSE NULL END,
                    v_item->>'legacy_id');
        END LOOP;
    END IF;

    -- ── parts_bom edges ───────────────────────────────────────────────────
    -- notes column dropped in 20260504_drop_parts_bom_notes.
    IF v_template->'parts_bom' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'parts_bom') LOOP
            INSERT INTO parts_bom (parent_part_id, child_part_id, quantity, unit, sequence)
            VALUES ((v_ref_map->>(v_item->>'parent_ref'))::uuid,
                    (v_ref_map->>(v_item->>'child_ref'))::uuid,
                    (v_item->>'quantity')::numeric,
                    v_item->>'unit',
                    COALESCE((v_item->>'sequence')::integer, 0));
        END LOOP;
    END IF;

    -- ── Routings + nested routing_operations ──────────────────────────────
    IF v_template->'routings' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'routings') LOOP
            v_routing_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_routing_id::text));
            INSERT INTO routings (id, company_id, part_id, name, description, created_by)
            VALUES (v_routing_id, p_company_id,
                    (v_ref_map->>(v_item->>'part_ref'))::uuid,
                    v_item->>'name', v_item->>'description', p_user_id);

            IF v_item->'operations' IS NOT NULL THEN
                FOR v_inner IN SELECT * FROM jsonb_array_elements(v_item->'operations') LOOP
                    INSERT INTO routing_operations (
                        routing_id, work_center_id, sequence,
                        setup_minutes, cycle_minutes_per_unit,
                        labor_rate_override,
                        external_unit_price, external_setup_cost,
                        instructions
                    ) VALUES (
                        v_routing_id,
                        (v_ref_map->>(v_inner->>'work_center_ref'))::uuid,
                        COALESCE((v_inner->>'sequence')::integer, 10),
                        NULLIF(v_inner->>'setup_minutes', '')::numeric,
                        NULLIF(v_inner->>'cycle_minutes_per_unit', '')::numeric,
                        NULLIF(v_inner->>'labor_rate_override', '')::numeric,
                        NULLIF(v_inner->>'external_unit_price', '')::numeric,
                        NULLIF(v_inner->>'external_setup_cost', '')::numeric,
                        v_inner->>'instructions'
                    );
                END LOOP;
            END IF;
        END LOOP;
    END IF;

    -- ── Customers ─────────────────────────────────────────────────────────
    IF v_template->'customers' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'customers') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO customers (id, company_id, name,
                                   contact_name, contact_email, contact_phone,
                                   address_line1, address_line2, city, state, postal_code, country,
                                   website)
            VALUES (v_new_id, p_company_id,
                    v_item->>'name',
                    v_item->>'contact_name', v_item->>'contact_email', v_item->>'contact_phone',
                    v_item->>'address_line1', v_item->>'address_line2',
                    v_item->>'city', v_item->>'state', v_item->>'postal_code',
                    COALESCE(v_item->>'country', 'USA'),
                    v_item->>'website');
        END LOOP;
    END IF;

    -- ── Quotes + nested line_items ────────────────────────────────────────
    IF v_template->'quotes' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'quotes') LOOP
            v_quote_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_quote_id::text));
            INSERT INTO quotes (id, company_id, customer_id, status,
                                lead_time_days, expiration_date, created_by)
            VALUES (v_quote_id, p_company_id,
                    CASE WHEN v_item->>'customer_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'customer_ref'))::uuid
                         ELSE NULL END,
                    COALESCE(v_item->>'status', 'active'),
                    NULLIF(v_item->>'lead_time_days', '')::integer,
                    NULLIF(v_item->>'expiration_date', '')::date,
                    p_user_id);

            IF v_item->'line_items' IS NOT NULL THEN
                FOR v_inner IN SELECT * FROM jsonb_array_elements(v_item->'line_items') LOOP
                    INSERT INTO quote_line_items (
                        quote_id, company_id, part_id,
                        sequence, quantity, unit_price, total_price
                    ) VALUES (
                        v_quote_id, p_company_id,
                        (v_ref_map->>(v_inner->>'part_ref'))::uuid,
                        COALESCE((v_inner->>'sequence')::integer, 10),
                        (v_inner->>'quantity')::integer,
                        (v_inner->>'unit_price')::numeric,
                        NULLIF(v_inner->>'total_price', '')::numeric
                    );
                END LOOP;
            END IF;
        END LOOP;
    END IF;

    -- ── Jobs + job_parts ──────────────────────────────────────────────────
    IF v_template->'jobs' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'jobs') LOOP
            v_job_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_job_id::text));

            INSERT INTO jobs (id, company_id, customer_id, quote_id,
                              job_number, status, created_by)
            VALUES (v_job_id, p_company_id,
                    CASE WHEN v_item->>'customer_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'customer_ref'))::uuid
                         ELSE NULL END,
                    CASE WHEN v_item->>'quote_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'quote_ref'))::uuid
                         ELSE NULL END,
                    COALESCE(v_item->>'job_number',
                             'J-DEMO-' || substr(v_job_id::text, 1, 8)),
                    COALESCE(v_item->>'status', 'not_started'),
                    p_user_id);

            IF v_item->'parts' IS NOT NULL THEN
                FOR v_inner IN SELECT * FROM jsonb_array_elements(v_item->'parts') LOOP
                    v_part_id := (v_ref_map->>(v_inner->>'part_ref'))::uuid;
                    v_job_part_id := gen_random_uuid();

                    INSERT INTO job_parts (id, job_id, company_id, part_id,
                                           sequence, quantity, status)
                    VALUES (v_job_part_id, v_job_id, p_company_id, v_part_id,
                            COALESCE((v_inner->>'sequence')::integer, 10),
                            COALESCE((v_inner->>'quantity')::integer, 1),
                            COALESCE(v_inner->>'status', 'not_started'));

                    IF v_inner->>'routing_ref' IS NOT NULL THEN
                        PERFORM create_job_part_operations_from_routing(
                            v_job_part_id,
                            (v_ref_map->>(v_inner->>'routing_ref'))::uuid
                        );
                    END IF;
                END LOOP;
            END IF;
        END LOOP;
    END IF;
END;
$function$;

COMMENT ON FUNCTION public.seed_demo_data(uuid, uuid, text)
    IS 'Seeds a company from the active demo_data_templates row. Walks vendors (+ vendor_contacts) → work_centers → parts → parts_bom → routings/routing_operations → customers → quotes/line_items → jobs/job_parts. Uses a jsonb ref-map to resolve _ref → uuid across the template. parts_bom.notes was dropped in 20260504_drop_parts_bom_notes.';

COMMIT;
