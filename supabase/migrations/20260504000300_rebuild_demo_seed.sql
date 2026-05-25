-- ============================================================================
-- Rebuild demo seed against the unified parts/work_centers/vendors schema
-- ============================================================================
--
-- Context. The 20260502 unify-parts-inventory migration dropped the old
-- seed_demo_data, reset_demo_company, and create_demo_company functions
-- (along with operation_types, inventory_items, routing_nodes, and
-- routing_materials). Per the no-tech-debt rule, the migration also rewrote
-- demo_data_templates.template_data to a minimal known-good seed (1 vendor,
-- 2 work_centers, 3 parts, 1 routing op, 1 BOM line) and intentionally left
-- the seed/reset/create functions broken — meaning create_demo_company has
-- raised "function does not exist" since 20260502 landed.
--
-- This migration restores the three demo-mode SQL functions against the new
-- schema, AND replaces the active demo template with a richer dataset that
-- exercises every PartKind, internal + external work_centers (with
-- labor_rate_override on most internal ops to mirror the 98.6% Contour
-- pattern), BOM edges, customers, quotes with line items, and one job
-- materialized from a quote via create_job_part_operations_from_routing.
--
-- The DemoModeProvider depends on these functions for the demo-company
-- onboarding flow; once this migration runs, "Enter Demo Mode" works again.
--
-- Phase 1: Replace the active template_data with the richer seed.
-- Phase 2: Rewrite seed_demo_data() against the new schema (vendors,
--          work_centers, parts, parts_bom, routings/routing_operations,
--          customers, quotes/quote_line_items, jobs/job_parts that
--          materialize ops + materials via the new
--          create_job_part_operations_from_routing function).
-- Phase 3: Rewrite reset_demo_company() to wipe the new tables and re-seed.
-- Phase 4: Rewrite create_demo_company() to mirror the prior auth +
--          idempotency contract.

BEGIN;

-- ============================================================================
-- Phase 1: Expand demo_data_templates.template_data
-- ============================================================================
--
-- The template uses the same `_ref` ref-map pattern as the prior version
-- (each item carries _ref; sibling items reference each other via *_ref
-- fields like vendor_ref, part_ref, work_center_ref). seed_demo_data
-- resolves these into real UUIDs as it inserts.
--
-- Coverage targets (from PR 3 chunk-10 spec):
--   - 3 vendors
--   - 5 work_centers (3 internal, 2 external — one per vendor + 1 shared
--     for the EDM partner)
--   - 8 parts spanning all 4 PartKind buckets:
--       * raw stockable      (is_stockable=true,  is_manufacturable=false)
--       * raw stockable      (is_stockable=true,  is_manufacturable=false)
--       * sub-assembly       (is_stockable=true,  is_manufacturable=true)
--       * sub-assembly       (is_stockable=true,  is_manufacturable=true)
--       * manufactured       (is_stockable=false, is_manufacturable=true)
--       * manufactured       (is_stockable=false, is_manufacturable=true)
--       * manufactured       (is_stockable=false, is_manufacturable=true)
--       * unclassified       (is_stockable=false, is_manufacturable=false)
--   - 3 routings with 3-5 operations each (mixed internal/external; most
--     internal ops carry a labor_rate_override)
--   - 6 BOM edges across the manufactured + sub-assembly parents
--   - 3 customers
--   - 2 quotes with line items (one with multiple parts)
--   - 1 job materialized from the first quote

UPDATE public.demo_data_templates
   SET template_data = jsonb_build_object(
        'note', 'Rebuilt in 20260504_rebuild_demo_seed.sql against the unified parts/work_centers/vendors schema. Exercises every PartKind, mixed internal/external work_centers, labor_rate_override on most internal ops, BOM edges, and one job materialized from a quote.',

        'vendors', jsonb_build_array(
            jsonb_build_object(
                '_ref', 'vendor_steel_supply',
                'name', 'Midwest Steel Supply',
                'contact_name', 'Pat Reyes',
                'contact_email', 'orders@midweststeel.example.com',
                'contact_phone', '555-0142',
                'city', 'Chicago',
                'state', 'IL'
            ),
            jsonb_build_object(
                '_ref', 'vendor_coating',
                'name', 'PerformCoat Finishing',
                'contact_name', 'Sam Lee',
                'contact_email', 'jobs@performcoat.example.com',
                'contact_phone', '555-0177',
                'city', 'Cleveland',
                'state', 'OH'
            ),
            jsonb_build_object(
                '_ref', 'vendor_edm',
                'name', 'Precision EDM Partners',
                'contact_name', 'Jamie Quinn',
                'contact_email', 'rfq@precisionedm.example.com',
                'contact_phone', '555-0198',
                'city', 'Milwaukee',
                'state', 'WI'
            )
        ),

        'work_centers', jsonb_build_array(
            jsonb_build_object(
                '_ref', 'wc_lathe',
                'name', 'Mazak Lathe',
                'kind', 'internal',
                'labor_rate', 95.00,
                'description', 'Internal turning cell (Mazak QT-200)'
            ),
            jsonb_build_object(
                '_ref', 'wc_mill',
                'name', 'HURCO Mill',
                'kind', 'internal',
                'labor_rate', 110.00,
                'description', '3-axis VMC, mid-volume parts'
            ),
            jsonb_build_object(
                '_ref', 'wc_qc',
                'name', 'QC Bench',
                'kind', 'internal',
                'labor_rate', 75.00,
                'description', 'CMM + manual gauging'
            ),
            jsonb_build_object(
                '_ref', 'wc_coating',
                'name', 'PerformCoat',
                'kind', 'external',
                'vendor_ref', 'vendor_coating',
                'description', 'Outside black-oxide / anodize partner'
            ),
            jsonb_build_object(
                '_ref', 'wc_edm',
                'name', 'Precision EDM',
                'kind', 'external',
                'vendor_ref', 'vendor_edm',
                'description', 'Outside wire EDM, tight-tol features'
            )
        ),

        'parts', jsonb_build_array(
            -- Raw stockables (vendor-supplied bar stock + plate)
            jsonb_build_object(
                '_ref', 'part_raw_bar',
                'part_name', '1018-BAR-1IN',
                'description', '1018 cold-rolled steel bar, 1in dia',
                'is_manufacturable', false,
                'is_stockable', true,
                'primary_unit', 'in',
                'quantity', 240,
                'cost_per_unit', 0.85,
                'reorder_point', 60,
                'preferred_vendor_ref', 'vendor_steel_supply'
            ),
            jsonb_build_object(
                '_ref', 'part_raw_plate',
                'part_name', '6061-PLATE-0.25',
                'description', '6061-T6 aluminum plate, 0.25in thick',
                'is_manufacturable', false,
                'is_stockable', true,
                'primary_unit', 'sqin',
                'quantity', 1800,
                'cost_per_unit', 0.12,
                'reorder_point', 600,
                'preferred_vendor_ref', 'vendor_steel_supply'
            ),
            -- Sub-assemblies (manufactured AND stocked — children for the
            -- finished parts below)
            jsonb_build_object(
                '_ref', 'part_sub_blank',
                'part_name', 'SUB-BLANK-001',
                'description', 'Turned blank, used in WIDGET-100',
                'is_manufacturable', true,
                'is_stockable', true,
                'primary_unit', 'each',
                'quantity', 18,
                'cost_per_unit', 6.50
            ),
            jsonb_build_object(
                '_ref', 'part_sub_bracket',
                'part_name', 'SUB-BRACKET-002',
                'description', 'Milled bracket sub-assy, used in BRACKET-300',
                'is_manufacturable', true,
                'is_stockable', true,
                'primary_unit', 'each',
                'quantity', 24,
                'cost_per_unit', 11.20
            ),
            -- Finished manufactured parts (the ones that get quoted/jobbed)
            jsonb_build_object(
                '_ref', 'part_widget',
                'part_name', 'WIDGET-100',
                'description', 'Finished widget assembly',
                'is_manufacturable', true,
                'is_stockable', false
            ),
            jsonb_build_object(
                '_ref', 'part_bracket',
                'part_name', 'BRACKET-300',
                'description', 'Mounting bracket, anodized',
                'is_manufacturable', true,
                'is_stockable', false
            ),
            jsonb_build_object(
                '_ref', 'part_pin',
                'part_name', 'PIN-200',
                'description', 'Hardened pin with EDM keyway',
                'is_manufacturable', true,
                'is_stockable', false
            ),
            -- Unclassified part (neither stockable nor manufacturable — UI
            -- needs to render this case without crashing)
            jsonb_build_object(
                '_ref', 'part_misc',
                'part_name', 'MISC-NOTE-001',
                'description', 'Reference / scratch part, not built or stocked',
                'is_manufacturable', false,
                'is_stockable', false
            )
        ),

        -- BOM edges (parent → child). Children must already exist in the
        -- ref-map by the time seed_demo_data processes parts_bom (parts are
        -- inserted before parts_bom).
        'parts_bom', jsonb_build_array(
            jsonb_build_object(
                'parent_ref', 'part_widget',
                'child_ref', 'part_sub_blank',
                'quantity', 1,
                'unit', 'each',
                'sequence', 10
            ),
            jsonb_build_object(
                'parent_ref', 'part_widget',
                'child_ref', 'part_raw_bar',
                'quantity', 0.75,
                'unit', 'in',
                'sequence', 20
            ),
            jsonb_build_object(
                'parent_ref', 'part_bracket',
                'child_ref', 'part_sub_bracket',
                'quantity', 1,
                'unit', 'each',
                'sequence', 10
            ),
            jsonb_build_object(
                'parent_ref', 'part_bracket',
                'child_ref', 'part_raw_plate',
                'quantity', 12,
                'unit', 'sqin',
                'sequence', 20
            ),
            jsonb_build_object(
                'parent_ref', 'part_pin',
                'child_ref', 'part_raw_bar',
                'quantity', 1.25,
                'unit', 'in',
                'sequence', 10
            ),
            -- Sub-assembly draws from raw bar
            jsonb_build_object(
                'parent_ref', 'part_sub_blank',
                'child_ref', 'part_raw_bar',
                'quantity', 1,
                'unit', 'in',
                'sequence', 10
            )
        ),

        'routings', jsonb_build_array(
            jsonb_build_object(
                '_ref', 'routing_widget',
                'part_ref', 'part_widget',
                'name', 'WIDGET-100 routing',
                'description', 'Turn → mill → coat → inspect',
                'operations', jsonb_build_array(
                    jsonb_build_object(
                        'work_center_ref', 'wc_lathe',
                        'sequence', 10,
                        'setup_minutes', 30,
                        'cycle_minutes_per_unit', 4.5,
                        'labor_rate_override', 100.00
                    ),
                    jsonb_build_object(
                        'work_center_ref', 'wc_mill',
                        'sequence', 20,
                        'setup_minutes', 25,
                        'cycle_minutes_per_unit', 3.75,
                        'labor_rate_override', 115.00
                    ),
                    jsonb_build_object(
                        'work_center_ref', 'wc_coating',
                        'sequence', 30,
                        'external_unit_price', 4.50,
                        'external_setup_cost', 75.00
                    ),
                    jsonb_build_object(
                        'work_center_ref', 'wc_qc',
                        'sequence', 40,
                        'setup_minutes', 5,
                        'cycle_minutes_per_unit', 0.5
                        -- no override — exercises the wc.labor_rate fallback
                    )
                )
            ),
            jsonb_build_object(
                '_ref', 'routing_bracket',
                'part_ref', 'part_bracket',
                'name', 'BRACKET-300 routing',
                'description', 'Mill → anodize → inspect',
                'operations', jsonb_build_array(
                    jsonb_build_object(
                        'work_center_ref', 'wc_mill',
                        'sequence', 10,
                        'setup_minutes', 20,
                        'cycle_minutes_per_unit', 5.0,
                        'labor_rate_override', 120.00
                    ),
                    jsonb_build_object(
                        'work_center_ref', 'wc_coating',
                        'sequence', 20,
                        'external_unit_price', 3.25,
                        'external_setup_cost', 50.00
                    ),
                    jsonb_build_object(
                        'work_center_ref', 'wc_qc',
                        'sequence', 30,
                        'setup_minutes', 5,
                        'cycle_minutes_per_unit', 0.4,
                        'labor_rate_override', 80.00
                    )
                )
            ),
            jsonb_build_object(
                '_ref', 'routing_pin',
                'part_ref', 'part_pin',
                'name', 'PIN-200 routing',
                'description', 'Turn → outside EDM → inspect',
                'operations', jsonb_build_array(
                    jsonb_build_object(
                        'work_center_ref', 'wc_lathe',
                        'sequence', 10,
                        'setup_minutes', 22,
                        'cycle_minutes_per_unit', 2.8,
                        'labor_rate_override', 105.00
                    ),
                    jsonb_build_object(
                        'work_center_ref', 'wc_edm',
                        'sequence', 20,
                        'external_unit_price', 8.75,
                        'external_setup_cost', 110.00
                    ),
                    jsonb_build_object(
                        'work_center_ref', 'wc_qc',
                        'sequence', 30,
                        'setup_minutes', 5,
                        'cycle_minutes_per_unit', 0.3,
                        'labor_rate_override', 78.00
                    )
                )
            ),
            -- Sub-assembly routing: turning blanks from raw bar
            jsonb_build_object(
                '_ref', 'routing_sub_blank',
                'part_ref', 'part_sub_blank',
                'name', 'SUB-BLANK-001 routing',
                'description', 'Turn from 1018 bar',
                'operations', jsonb_build_array(
                    jsonb_build_object(
                        'work_center_ref', 'wc_lathe',
                        'sequence', 10,
                        'setup_minutes', 18,
                        'cycle_minutes_per_unit', 1.8,
                        'labor_rate_override', 95.00
                    )
                )
            ),
            jsonb_build_object(
                '_ref', 'routing_sub_bracket',
                'part_ref', 'part_sub_bracket',
                'name', 'SUB-BRACKET-002 routing',
                'description', 'Mill bracket from 6061 plate',
                'operations', jsonb_build_array(
                    jsonb_build_object(
                        'work_center_ref', 'wc_mill',
                        'sequence', 10,
                        'setup_minutes', 15,
                        'cycle_minutes_per_unit', 2.4,
                        'labor_rate_override', 110.00
                    )
                )
            )
        ),

        'customers', jsonb_build_array(
            jsonb_build_object(
                '_ref', 'cust_aerospace',
                'name', 'Apex Aerospace',
                'contact_name', 'Morgan Lee',
                'contact_email', 'purchasing@apexaero.example.com',
                'city', 'Wichita',
                'state', 'KS'
            ),
            jsonb_build_object(
                '_ref', 'cust_robotics',
                'name', 'Helix Robotics',
                'contact_name', 'Riley Park',
                'contact_email', 'po@helixrobotics.example.com',
                'city', 'Pittsburgh',
                'state', 'PA'
            ),
            jsonb_build_object(
                '_ref', 'cust_medical',
                'name', 'Northstar Medical',
                'contact_name', 'Casey Singh',
                'contact_email', 'orders@northstarmed.example.com',
                'city', 'Minneapolis',
                'state', 'MN'
            )
        ),

        'quotes', jsonb_build_array(
            jsonb_build_object(
                '_ref', 'quote_apex_widgets',
                'customer_ref', 'cust_aerospace',
                'status', 'active',
                'lead_time_days', 21,
                'line_items', jsonb_build_array(
                    jsonb_build_object(
                        'part_ref', 'part_widget',
                        'sequence', 10,
                        'quantity', 25,
                        'unit_price', 145.00,
                        'total_price', 3625.00
                    ),
                    jsonb_build_object(
                        'part_ref', 'part_pin',
                        'sequence', 20,
                        'quantity', 50,
                        'unit_price', 38.50,
                        'total_price', 1925.00
                    )
                )
            ),
            jsonb_build_object(
                '_ref', 'quote_helix_brackets',
                'customer_ref', 'cust_robotics',
                'status', 'active',
                'lead_time_days', 14,
                'line_items', jsonb_build_array(
                    jsonb_build_object(
                        'part_ref', 'part_bracket',
                        'sequence', 10,
                        'quantity', 100,
                        'unit_price', 62.00,
                        'total_price', 6200.00
                    )
                )
            )
        ),

        'jobs', jsonb_build_array(
            jsonb_build_object(
                '_ref', 'job_apex',
                'quote_ref', 'quote_apex_widgets',
                'customer_ref', 'cust_aerospace',
                'job_number', 'J-DEMO-0001',
                'status', 'in_progress',
                'parts', jsonb_build_array(
                    jsonb_build_object(
                        'part_ref', 'part_widget',
                        'routing_ref', 'routing_widget',
                        'sequence', 10,
                        'quantity', 25,
                        'status', 'in_progress'
                    )
                )
            )
        )
   )
 WHERE is_active = true;


-- ============================================================================
-- Phase 2: Recreate seed_demo_data() against the new schema
-- ============================================================================
--
-- Walks the template_data jsonb and inserts in dependency order:
--   vendors → work_centers → parts → parts_bom → routings + routing_operations
--   → customers → quotes + quote_line_items → jobs + job_parts
-- A jsonb ref-map (`v_ref_map`) maps each item's `_ref` to its newly-minted
-- UUID so sibling/dependent items can resolve foreign keys via *_ref fields.
--
-- For each job_part, calls create_job_part_operations_from_routing(...) to
-- materialize job_operations + job_materials from the routing + parts_bom.

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

    -- ── Vendors ───────────────────────────────────────────────────────────
    IF v_template->'vendors' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'vendors') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO vendors (id, company_id, name,
                                 contact_name, contact_email, contact_phone,
                                 address_line1, address_line2, city, state, postal_code, country,
                                 notes, legacy_id)
            VALUES (v_new_id, p_company_id, v_item->>'name',
                    v_item->>'contact_name', v_item->>'contact_email', v_item->>'contact_phone',
                    v_item->>'address_line1', v_item->>'address_line2',
                    v_item->>'city', v_item->>'state', v_item->>'postal_code',
                    COALESCE(v_item->>'country', 'USA'),
                    v_item->>'notes', v_item->>'legacy_id');
        END LOOP;
    END IF;

    -- ── Work centers ──────────────────────────────────────────────────────
    -- Resolves vendor_ref via the ref-map for external work_centers.
    -- The CHECK constraints on work_centers enforce internal/external ↔ vendor.
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
    -- Inserted before parts_bom so child refs resolve. preferred_vendor_ref
    -- resolves through the ref-map.
    IF v_template->'parts' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'parts') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO parts (id, company_id, part_name, description,
                               is_manufacturable, is_stockable,
                               primary_unit, quantity, cost_per_unit,
                               reorder_point, preferred_vendor_id, legacy_id)
            VALUES (v_new_id, p_company_id,
                    v_item->>'part_name', v_item->>'description',
                    COALESCE((v_item->>'is_manufacturable')::boolean, true),
                    COALESCE((v_item->>'is_stockable')::boolean, false),
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
    -- Both parent and child must already be in the ref-map (parts loop above).
    -- The enforce_no_bom_cycles trigger guards against accidental cycles in
    -- the template data — if the template defines one, this insert raises.
    IF v_template->'parts_bom' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'parts_bom') LOOP
            INSERT INTO parts_bom (parent_part_id, child_part_id, quantity, unit, sequence, notes)
            VALUES ((v_ref_map->>(v_item->>'parent_ref'))::uuid,
                    (v_ref_map->>(v_item->>'child_ref'))::uuid,
                    (v_item->>'quantity')::numeric,
                    v_item->>'unit',
                    COALESCE((v_item->>'sequence')::integer, 0),
                    v_item->>'notes');
        END LOOP;
    END IF;

    -- ── Routings + nested routing_operations ──────────────────────────────
    -- Each routing is keyed by its part_ref (1:1 with the part). Operations
    -- pull work_center_id from the ref-map.
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
    -- quote_number is auto-generated by the set_quote_number trigger when
    -- left null, so we don't pass it in.
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
    -- For each job_part with a routing_ref, materialize ops + materials via
    -- create_job_part_operations_from_routing — exactly the path Convert-to-
    -- Job uses in the UI, so the demo job mirrors a realistic snapshot.
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

                    -- Materialize ops + materials from the routing, exactly
                    -- as Convert-to-Job does in the UI.
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
    IS 'Seeds a company from the active demo_data_templates row. Walks vendors → work_centers → parts → parts_bom → routings/routing_operations → customers → quotes/line_items → jobs/job_parts (materializing ops + materials via create_job_part_operations_from_routing). Uses a jsonb ref-map to resolve _ref → uuid across the template.';


-- ============================================================================
-- Phase 3: Recreate reset_demo_company()
-- ============================================================================
--
-- Wipes every per-company table touched by seed_demo_data (in FK-respecting
-- order) for the demo company, then re-seeds. Same auth contract as the
-- prior version: caller must be the requesting user.

CREATE OR REPLACE FUNCTION public.reset_demo_company(
    p_source_company_id uuid,
    p_user_id uuid
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_demo_company_id uuid;
BEGIN
    IF p_user_id != auth.uid() THEN
        RAISE EXCEPTION 'Access denied';
    END IF;

    SELECT demo_company_id INTO v_demo_company_id
    FROM companies WHERE id = p_source_company_id;

    IF v_demo_company_id IS NULL THEN
        RAISE EXCEPTION 'No demo company exists for company: %', p_source_company_id;
    END IF;

    -- Delete in FK-respecting order. job_materials/job_operations live under
    -- jobs (not company-scoped directly), so we pivot through jobs first.
    DELETE FROM operator_sessions WHERE company_id = v_demo_company_id;
    DELETE FROM inventory_transactions WHERE company_id = v_demo_company_id;
    DELETE FROM job_materials WHERE job_id IN (SELECT id FROM jobs WHERE company_id = v_demo_company_id);
    DELETE FROM job_operations WHERE job_id IN (SELECT id FROM jobs WHERE company_id = v_demo_company_id);
    DELETE FROM job_parts WHERE company_id = v_demo_company_id;
    DELETE FROM jobs WHERE company_id = v_demo_company_id;
    DELETE FROM quote_line_items WHERE company_id = v_demo_company_id;
    DELETE FROM quote_materials WHERE company_id = v_demo_company_id;
    DELETE FROM quote_operations WHERE company_id = v_demo_company_id;
    DELETE FROM quotes WHERE company_id = v_demo_company_id;
    -- routing_operations cascades from routings (FK ON DELETE CASCADE), but
    -- being explicit makes the order obvious.
    DELETE FROM routing_operations
        WHERE routing_id IN (SELECT id FROM routings WHERE company_id = v_demo_company_id);
    DELETE FROM routings WHERE company_id = v_demo_company_id;
    -- parts_bom rows have no company_id; pivot through the parent part.
    DELETE FROM parts_bom
        WHERE parent_part_id IN (SELECT id FROM parts WHERE company_id = v_demo_company_id);
    DELETE FROM part_pricing_tiers WHERE company_id = v_demo_company_id;
    -- parts_unit_conversions also has no company_id; pivot through part.
    DELETE FROM parts_unit_conversions
        WHERE part_id IN (SELECT id FROM parts WHERE company_id = v_demo_company_id);
    DELETE FROM parts WHERE company_id = v_demo_company_id;
    DELETE FROM work_centers WHERE company_id = v_demo_company_id;
    DELETE FROM vendors WHERE company_id = v_demo_company_id;
    DELETE FROM customers WHERE company_id = v_demo_company_id;
    DELETE FROM ai_chat_queries WHERE company_id = v_demo_company_id;

    PERFORM seed_demo_data(v_demo_company_id, p_user_id);
END;
$function$;

COMMENT ON FUNCTION public.reset_demo_company(uuid, uuid)
    IS 'Wipes every per-company table on the demo company linked to p_source_company_id, then re-seeds from the active demo template. Caller must be the requesting user (auth.uid() check).';


-- ============================================================================
-- Phase 4: Recreate create_demo_company()
-- ============================================================================
--
-- Idempotent: returns the existing demo company if one is already linked.
-- Otherwise creates "<source name> - Demo", links it back to the source via
-- companies.demo_company_id, mirrors user_company_access, and seeds.
--
-- Auth contract (preserved from the old version):
--   1. p_user_id must equal auth.uid()
--   2. Caller must be admin of source company

CREATE OR REPLACE FUNCTION public.create_demo_company(
    p_source_company_id uuid,
    p_user_id uuid,
    p_template_name varchar DEFAULT 'default'
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_source_name TEXT;
    v_demo_company_id UUID;
    v_existing_demo_id UUID;
BEGIN
    IF p_user_id != auth.uid() THEN
        RAISE EXCEPTION 'Access denied: cannot create demo company for another user';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM user_company_access
        WHERE user_id = p_user_id
          AND company_id = p_source_company_id
          AND role = 'admin'
    ) THEN
        RAISE EXCEPTION 'Access denied: must be admin of source company';
    END IF;

    -- Idempotency: return existing demo if linked
    SELECT demo_company_id INTO v_existing_demo_id
    FROM companies
    WHERE id = p_source_company_id;

    IF v_existing_demo_id IS NOT NULL THEN
        RETURN v_existing_demo_id;
    END IF;

    SELECT name INTO v_source_name FROM companies WHERE id = p_source_company_id;
    IF v_source_name IS NULL THEN
        RAISE EXCEPTION 'Source company not found: %', p_source_company_id;
    END IF;

    INSERT INTO companies (name, is_demo)
    VALUES (v_source_name || ' - Demo', TRUE)
    RETURNING id INTO v_demo_company_id;

    UPDATE companies SET demo_company_id = v_demo_company_id
    WHERE id = p_source_company_id;

    -- Mirror access (operator/user/admin all preserved)
    INSERT INTO user_company_access (user_id, company_id, role, name)
    SELECT uca.user_id, v_demo_company_id, uca.role, uca.name
    FROM user_company_access uca
    WHERE uca.company_id = p_source_company_id;

    PERFORM seed_demo_data(v_demo_company_id, p_user_id, p_template_name::text);

    RETURN v_demo_company_id;
END;
$function$;

COMMENT ON FUNCTION public.create_demo_company(uuid, uuid, varchar)
    IS 'Creates (or returns existing) demo company for the source company, mirrors user_company_access, and seeds via seed_demo_data. Idempotent: returns existing demo_company_id if companies.demo_company_id is already set. Caller must be admin of source company.';

COMMIT;
