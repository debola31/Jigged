-- Rebuild demo mode against the schema as it actually is in August 2026.
--
-- WHY: "Reset demo" failed with
--   new row for relation "parts" violates check constraint "parts_requires_unit"
-- and that CHECK was only the first wall the seeder hit. The active template
-- (`default` v2, authored 2026-03-03) and `seed_demo_data()` were both written
-- against a schema that has since moved underneath them. Asked of Postgres
-- directly, the seeder referenced FIVE columns that no longer exist:
--
--   parts.primary_unit        -- template omitted it on 4 of 8 parts  -> the reported error
--   customers.contact_name    -- + contact_email/contact_phone/address_*/website, all dropped
--                                when customer_contacts / customer_addresses landed
--   quotes.lead_time_days     -- replaced by quotes.lead_time_text (20260713060545)
--   jobs.status               -- split into production_/fulfillment_/invoicing_status
--   job_parts.status          -- same split
--
-- and the template still spoke the pre-unification vocabulary (`is_stockable` /
-- `is_manufacturable` instead of `source`), so every part seeded as 'made' and
-- every template `cost_per_unit` was silently dropped on the floor — the tier
-- insert is gated on source = 'bought'.
--
-- The practical consequence is worse than a broken Reset: `create_demo_company`
-- calls the same seeder, so demo mode has been unenterable for any company that
-- did not already have one. This is not a patch — the function is rewritten.
--
-- Three things land together, and they have to be one migration: a new template
-- under the old seeder is as broken as the old template under the new one.
--   1. seed_demo_data()      — rewritten against the live schema, and taught the
--                              surfaces built since March: storage locations and
--                              per-location balances, customer contacts and
--                              addresses, procurement + pricing tiers, unit
--                              conversions, the notes/activity feed, shipments,
--                              and operation completions.
--   2. reset_demo_company()  — now wipes every table the demo owns. It missed 15
--                              (#675); six of those are RESTRICT parents, so on a
--                              demo that had shipped anything the whole
--                              transaction aborted and Reset deleted NOTHING.
--   3. template `default` v3 — the graph itself, and much bigger: 8 parts -> 42,
--                              1 job -> 16, 3 customers -> 8. Committed here
--                              rather than hand-inserted in prod, which also
--                              closes #550: a fresh local or preview stack now
--                              has an active template and can enter demo mode.
--
-- Every optional field is COALESCE'd / NULLIF'd, so a template that predates a
-- future column still loads. `_ref` keys resolve through one jsonb map, exactly
-- as before — that part of the design was fine.

-- ============================================================================
-- 1. seed_demo_data
-- ============================================================================

CREATE OR REPLACE FUNCTION public.seed_demo_data(p_company_id uuid, p_user_id uuid, p_template_name text DEFAULT 'default'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_template   jsonb;
    v_ref_map    jsonb := '{}'::jsonb;
    v_item       jsonb;
    v_inner      jsonb;
    v_leaf       jsonb;
    v_new_id     uuid;
    v_routing_id uuid;
    v_quote_id   uuid;
    v_job_id     uuid;
    v_job_part_id uuid;
    v_ship_id    uuid;
    v_note_id    uuid;
    v_op_id      uuid;
    v_part_id    uuid;
    v_cust_id    uuid;
    v_loc_id     uuid;
    v_source     text;
    v_qty        numeric;
    v_unit_price numeric;
    v_job_number text;
    v_base       text;
    v_seq        integer;
    v_members    uuid[];   -- user_company_access.id
    v_users      uuid[];   -- auth.users.id
    v_author     uuid;
    v_n_authors  integer;
BEGIN
    SELECT template_data INTO v_template
    FROM demo_data_templates
    WHERE name = p_template_name AND is_active = true
    LIMIT 1;

    IF v_template IS NULL THEN
        RAISE EXCEPTION 'No active demo template found with name: %', p_template_name;
    END IF;

    -- Two author pools, because the schema names actors two different ways and
    -- getting them backwards is a FK error at best and the wrong name on screen
    -- at worst:
    --   notes.author_id / note_reactions.reactor_id -> user_company_access.id
    --       (the MEMBERSHIP row — a note belongs to someone's membership of this
    --        company, so removing them from the company detaches it)
    --   job_operation_completions.completed_by, inventory_transactions.created_by,
    --   jobs/quotes/shipments.created_by                    -> auth.users.id
    -- Both are built in one pass ordered by user_id, so `author_index: 2` is the
    -- same person in a note and in a completion, and stays that person across
    -- resets. create_demo_company mirrors user_company_access BEFORE seeding, so
    -- the demo already has the real company's team — which is what makes the
    -- activity feed read like a shop rather than one person talking to themselves.
    SELECT COALESCE(array_agg(id      ORDER BY user_id), ARRAY[]::uuid[]),
           COALESCE(array_agg(user_id ORDER BY user_id), ARRAY[]::uuid[])
      INTO v_members, v_users
      FROM user_company_access WHERE company_id = p_company_id;
    IF array_length(v_users, 1) IS NULL THEN
        v_members := ARRAY[]::uuid[];      -- no membership row to point a note at
        v_users   := ARRAY[p_user_id];
    END IF;
    v_n_authors := array_length(v_users, 1);

    -- ---- custom units -------------------------------------------------
    IF v_template->'custom_units' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'custom_units') LOOP
            INSERT INTO company_custom_units (company_id, unit_name)
            VALUES (p_company_id, v_item#>>'{}')
            ON CONFLICT (company_id, unit_name) DO NOTHING;
        END LOOP;
    END IF;

    -- ---- storage locations --------------------------------------------
    -- Parents must be listed before their children; `parent_ref` resolves
    -- through the same map as everything else.
    IF v_template->'locations' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'locations') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO inventory_locations (id, company_id, parent_id, name, kind, sort_order)
            VALUES (v_new_id, p_company_id,
                    CASE WHEN v_item->>'parent_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'parent_ref'))::uuid END,
                    v_item->>'name',
                    v_item->>'kind',
                    COALESCE((v_item->>'sort_order')::integer, 0));
        END LOOP;
    END IF;

    -- ---- vendors + contacts -------------------------------------------
    IF v_template->'vendors' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'vendors') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO vendors (id, company_id, name,
                                 address_line1, address_line2, city, state, postal_code, country)
            VALUES (v_new_id, p_company_id, v_item->>'name',
                    v_item->>'address_line1', v_item->>'address_line2',
                    v_item->>'city', v_item->>'state', v_item->>'postal_code',
                    COALESCE(v_item->>'country', 'USA'));

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'contacts', '[]'::jsonb)) LOOP
                INSERT INTO vendor_contacts (vendor_id, name, role, role_label, email, phone, is_primary)
                VALUES (v_new_id, v_inner->>'name',
                        COALESCE(v_inner->>'role', 'sales'), v_inner->>'role_label',
                        v_inner->>'email', v_inner->>'phone',
                        COALESCE((v_inner->>'is_primary')::boolean, false));
            END LOOP;
        END LOOP;
    END IF;

    -- ---- work centers --------------------------------------------------
    IF v_template->'work_centers' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'work_centers') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO work_centers (id, company_id, name, kind, vendor_id, labor_rate, description,
                                      make, model, serial_number, year_built, purchased_on)
            VALUES (v_new_id, p_company_id, v_item->>'name',
                    COALESCE(v_item->>'kind', 'internal'),
                    CASE WHEN v_item->>'vendor_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'vendor_ref'))::uuid END,
                    NULLIF(v_item->>'labor_rate', '')::numeric,
                    v_item->>'description',
                    v_item->>'make', v_item->>'model', v_item->>'serial_number',
                    NULLIF(v_item->>'year_built', '')::integer,
                    CASE WHEN v_item->>'purchased_years_ago' IS NOT NULL
                         THEN (CURRENT_DATE - make_interval(years =>
                                  (v_item->>'purchased_years_ago')::integer))::date END);
        END LOOP;
    END IF;

    -- ---- parts, with their tiers, conversions and shelf balances -------
    IF v_template->'parts' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'parts') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            v_source := COALESCE(v_item->>'source', 'made');

            -- quantity is DERIVED from part_location_stock by trigger. When the
            -- template places stock on named shelves we insert the part at 0 and
            -- let `recompute_part_quantity_from_locations` do the arithmetic;
            -- with no `stock` array we pass the quantity through and
            -- `auto_track_stocked_part` parks it at Unassigned. Never write both
            -- — that is how a part ends up counted twice.
            INSERT INTO parts (id, company_id, part_name, description, source, is_stocked,
                               primary_unit, quantity, reorder_point,
                               costing_batch_quantity, preferred_vendor_id)
            VALUES (v_new_id, p_company_id, v_item->>'part_name', v_item->>'description',
                    v_source,
                    COALESCE((v_item->>'is_stocked')::boolean, false),
                    COALESCE(v_item->>'primary_unit', 'each'),
                    CASE WHEN v_item->'stock' IS NOT NULL THEN 0
                         ELSE COALESCE((v_item->>'quantity')::numeric, 0) END,
                    NULLIF(v_item->>'reorder_point', '')::numeric,
                    COALESCE((v_item->>'costing_batch_quantity')::numeric, 1),
                    CASE WHEN v_item->>'preferred_vendor_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'preferred_vendor_ref'))::uuid END);

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'stock', '[]'::jsonb)) LOOP
                v_qty := (v_inner->>'quantity')::numeric;
                CONTINUE WHEN v_qty IS NULL OR v_qty <= 0;  -- CHECK: quantity > 0
                INSERT INTO part_location_stock (company_id, part_id, location_id, quantity)
                VALUES (p_company_id, v_new_id,
                        (v_ref_map->>(v_inner->>'location_ref'))::uuid, v_qty);
            END LOOP;

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'procurement_tiers', '[]'::jsonb)) LOOP
                INSERT INTO part_procurement_tiers (part_id, min_quantity, cost_per_unit,
                                                    quoted_at, expires_at, notes)
                VALUES (v_new_id,
                        (v_inner->>'min_quantity')::numeric,
                        (v_inner->>'cost_per_unit')::numeric,
                        CASE WHEN v_inner->>'quoted_days_ago' IS NOT NULL
                             THEN (CURRENT_DATE - (v_inner->>'quoted_days_ago')::integer) END,
                        CASE WHEN v_inner->>'expires_in_days' IS NOT NULL
                             THEN (CURRENT_DATE + (v_inner->>'expires_in_days')::integer) END,
                        v_inner->>'notes');
            END LOOP;

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'pricing_tiers', '[]'::jsonb)) LOOP
                INSERT INTO part_pricing_tiers (part_id, company_id, sequence, quantity, markup_percent)
                VALUES (v_new_id, p_company_id,
                        (v_inner->>'sequence')::integer,
                        (v_inner->>'quantity')::numeric,
                        NULLIF(v_inner->>'markup_percent', '')::numeric);
            END LOOP;

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'unit_conversions', '[]'::jsonb)) LOOP
                INSERT INTO parts_unit_conversions (part_id, from_unit, to_primary_factor)
                VALUES (v_new_id, v_inner->>'from_unit', (v_inner->>'to_primary_factor')::numeric);
            END LOOP;
        END LOOP;
    END IF;

    -- ---- BOM ------------------------------------------------------------
    IF v_template->'parts_bom' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'parts_bom') LOOP
            INSERT INTO parts_bom (parent_part_id, child_part_id, quantity, unit, sequence,
                                   notes, consume_whole_units)
            VALUES ((v_ref_map->>(v_item->>'parent_ref'))::uuid,
                    (v_ref_map->>(v_item->>'child_ref'))::uuid,
                    (v_item->>'quantity')::numeric,
                    v_item->>'unit',
                    COALESCE((v_item->>'sequence')::integer, 0),
                    v_item->>'notes',
                    COALESCE((v_item->>'consume_whole_units')::boolean, false));
        END LOOP;
    END IF;

    -- ---- routings --------------------------------------------------------
    IF v_template->'routings' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'routings') LOOP
            v_routing_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_routing_id::text));
            INSERT INTO routings (id, company_id, part_id, name, description, created_by)
            VALUES (v_routing_id, p_company_id,
                    (v_ref_map->>(v_item->>'part_ref'))::uuid,
                    v_item->>'name', v_item->>'description', p_user_id);

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'operations', '[]'::jsonb)) LOOP
                INSERT INTO routing_operations (routing_id, work_center_id, sequence,
                                                setup_minutes, cycle_minutes_per_unit,
                                                labor_rate_override, external_unit_price, instructions)
                VALUES (v_routing_id,
                        (v_ref_map->>(v_inner->>'work_center_ref'))::uuid,
                        COALESCE((v_inner->>'sequence')::integer, 10),
                        NULLIF(v_inner->>'setup_minutes', '')::numeric,
                        NULLIF(v_inner->>'cycle_minutes_per_unit', '')::numeric,
                        NULLIF(v_inner->>'labor_rate_override', '')::numeric,
                        NULLIF(v_inner->>'external_unit_price', '')::numeric,
                        v_inner->>'instructions');
            END LOOP;
        END LOOP;
    END IF;

    -- ---- customers, contacts, addresses ---------------------------------
    -- The embedded contact_*/address_* columns were dropped from `customers`;
    -- both are now child tables, and `jobs`/`quotes` reference them by id.
    IF v_template->'customers' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'customers') LOOP
            v_cust_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_cust_id::text));
            INSERT INTO customers (id, company_id, name, default_payment_terms,
                                   default_fob_point, credit_status, credit_hold_note)
            VALUES (v_cust_id, p_company_id, v_item->>'name',
                    v_item->>'default_payment_terms',
                    v_item->>'default_fob_point',
                    COALESCE(v_item->>'credit_status', 'open'),
                    v_item->>'credit_hold_note');

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'contacts', '[]'::jsonb)) LOOP
                v_new_id := gen_random_uuid();
                IF v_inner->>'_ref' IS NOT NULL THEN
                    v_ref_map := jsonb_set(v_ref_map, ARRAY[v_inner->>'_ref'], to_jsonb(v_new_id::text));
                END IF;
                INSERT INTO customer_contacts (id, customer_id, name, role, role_label,
                                               email, phone, is_primary, is_billing_default)
                VALUES (v_new_id, v_cust_id, v_inner->>'name',
                        COALESCE(v_inner->>'role', 'buyer'), v_inner->>'role_label',
                        v_inner->>'email', v_inner->>'phone',
                        COALESCE((v_inner->>'is_primary')::boolean, false),
                        COALESCE((v_inner->>'is_billing_default')::boolean, false));
            END LOOP;

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'addresses', '[]'::jsonb)) LOOP
                v_new_id := gen_random_uuid();
                IF v_inner->>'_ref' IS NOT NULL THEN
                    v_ref_map := jsonb_set(v_ref_map, ARRAY[v_inner->>'_ref'], to_jsonb(v_new_id::text));
                END IF;
                INSERT INTO customer_addresses (id, customer_id, address_line1, address_line2,
                                                city, state, postal_code, country, attention_to,
                                                default_billing, default_shipping)
                VALUES (v_new_id, v_cust_id, v_inner->>'address_line1', v_inner->>'address_line2',
                        v_inner->>'city', v_inner->>'state', v_inner->>'postal_code',
                        COALESCE(v_inner->>'country', 'USA'), v_inner->>'attention_to',
                        COALESCE((v_inner->>'default_billing')::boolean, false),
                        COALESCE((v_inner->>'default_shipping')::boolean, false));
            END LOOP;
        END LOOP;
    END IF;

    -- ---- quotes ----------------------------------------------------------
    -- quote_number is minted by the set_quote_number trigger off the shared
    -- per-company counter, exactly as the app gets it. Reset clears that counter
    -- so a re-seeded demo starts at Q-0001 again instead of drifting upward.
    IF v_template->'quotes' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'quotes') LOOP
            v_quote_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_quote_id::text));
            INSERT INTO quotes (id, company_id, customer_id, status, expiration_date,
                                lead_time_text, payment_terms, fob_point,
                                billing_address_id, shipping_address_id, contact_id,
                                created_by, created_at)
            VALUES (v_quote_id, p_company_id,
                    CASE WHEN v_item->>'customer_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'customer_ref'))::uuid END,
                    COALESCE(v_item->>'status', 'active'),
                    CASE WHEN v_item->>'expires_in_days' IS NOT NULL
                         THEN (CURRENT_DATE + (v_item->>'expires_in_days')::integer) END,
                    v_item->>'lead_time_text',
                    v_item->>'payment_terms',
                    v_item->>'fob_point',
                    CASE WHEN v_item->>'billing_address_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'billing_address_ref'))::uuid END,
                    CASE WHEN v_item->>'shipping_address_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'shipping_address_ref'))::uuid END,
                    CASE WHEN v_item->>'contact_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'contact_ref'))::uuid END,
                    p_user_id,
                    now() - make_interval(days => COALESCE((v_item->>'created_days_ago')::integer, 0)));

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'line_items', '[]'::jsonb)) LOOP
                v_qty := (v_inner->>'quantity')::numeric;
                v_unit_price := (v_inner->>'unit_price')::numeric;
                INSERT INTO quote_line_items (quote_id, company_id, part_id, sequence, quantity,
                                              unit_price, total_price, markup_percent,
                                              base_cost_per_unit, lead_time_text)
                VALUES (v_quote_id, p_company_id,
                        (v_ref_map->>(v_inner->>'part_ref'))::uuid,
                        COALESCE((v_inner->>'sequence')::integer, 10),
                        v_qty, v_unit_price,
                        COALESCE(NULLIF(v_inner->>'total_price', '')::numeric,
                                 round(v_qty * v_unit_price, 4)),
                        NULLIF(v_inner->>'markup_percent', '')::numeric,
                        NULLIF(v_inner->>'base_cost_per_unit', '')::numeric,
                        v_inner->>'lead_time_text');
            END LOOP;
        END LOOP;
    END IF;

    -- ---- jobs -------------------------------------------------------------
    IF v_template->'jobs' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'jobs') LOOP
            v_job_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_job_id::text));
            v_job_number := COALESCE(v_item->>'job_number', generate_direct_job_number(p_company_id));

            INSERT INTO jobs (id, company_id, customer_id, quote_id, job_number,
                              production_status, fulfillment_status, invoicing_status,
                              due_date, customer_po_number, is_hot,
                              payment_terms, freight_terms, ship_via, shipping_instructions,
                              billing_address_id, shipping_address_id, contact_id,
                              created_by, created_at)
            VALUES (v_job_id, p_company_id,
                    CASE WHEN v_item->>'customer_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'customer_ref'))::uuid END,
                    CASE WHEN v_item->>'quote_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'quote_ref'))::uuid END,
                    v_job_number,
                    'not_started', 'unshipped', 'uninvoiced',
                    CASE WHEN v_item->>'due_in_days' IS NOT NULL
                         THEN (CURRENT_DATE + (v_item->>'due_in_days')::integer) END,
                    v_item->>'customer_po_number',
                    COALESCE((v_item->>'is_hot')::boolean, false),
                    v_item->>'payment_terms', v_item->>'freight_terms',
                    v_item->>'ship_via', v_item->>'shipping_instructions',
                    CASE WHEN v_item->>'billing_address_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'billing_address_ref'))::uuid END,
                    CASE WHEN v_item->>'shipping_address_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'shipping_address_ref'))::uuid END,
                    CASE WHEN v_item->>'contact_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'contact_ref'))::uuid END,
                    p_user_id,
                    now() - make_interval(days => COALESCE((v_item->>'created_days_ago')::integer, 0)));

            -- A quote that produced a job is converted, by definition.
            IF v_item->>'quote_ref' IS NOT NULL THEN
                UPDATE quotes SET converted_at = COALESCE(converted_at, now())
                 WHERE id = (v_ref_map->>(v_item->>'quote_ref'))::uuid;
            END IF;

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'parts', '[]'::jsonb)) LOOP
                v_job_part_id := gen_random_uuid();
                IF v_inner->>'_ref' IS NOT NULL THEN
                    v_ref_map := jsonb_set(v_ref_map, ARRAY[v_inner->>'_ref'], to_jsonb(v_job_part_id::text));
                END IF;
                v_part_id := (v_ref_map->>(v_inner->>'part_ref'))::uuid;
                v_qty := COALESCE((v_inner->>'quantity')::numeric, 1);
                v_unit_price := NULLIF(v_inner->>'unit_price', '')::numeric;

                -- A bought part has no operations to run, so createJobFromPO
                -- lands it 'completed' on creation. Mirror that, and let made
                -- parts be driven entirely by their completions below.
                v_source := COALESCE(v_inner->>'source', 'made');
                INSERT INTO job_parts (id, job_id, company_id, part_id, sequence, quantity,
                                       unit_price, total_price,
                                       production_status, fulfillment_status, invoicing_status,
                                       started_at, completed_at)
                VALUES (v_job_part_id, v_job_id, p_company_id, v_part_id,
                        COALESCE((v_inner->>'sequence')::integer, 10), v_qty,
                        v_unit_price,
                        CASE WHEN v_unit_price IS NOT NULL THEN round(v_qty * v_unit_price, 4) END,
                        CASE WHEN v_source = 'bought' THEN 'completed' ELSE 'not_started' END,
                        'unshipped', 'uninvoiced',
                        CASE WHEN v_source = 'bought' THEN now() END,
                        CASE WHEN v_source = 'bought' THEN now() END);

                IF v_inner->>'routing_ref' IS NOT NULL THEN
                    PERFORM create_job_part_operations_from_routing(
                        v_job_part_id, (v_ref_map->>(v_inner->>'routing_ref'))::uuid);
                END IF;

                -- Progress is expressed the way the shop floor expresses it: a
                -- completion event per operation. The triggers then derive the
                -- operation status, the job_part's, and the job's — so the demo
                -- can never hold a status combination the app cannot produce.
                FOR v_leaf IN SELECT * FROM jsonb_array_elements(COALESCE(v_inner->'operations', '[]'::jsonb)) LOOP
                    SELECT id INTO v_op_id FROM job_operations
                     WHERE job_part_id = v_job_part_id
                       AND sequence = (v_leaf->>'sequence')::integer;
                    CONTINUE WHEN v_op_id IS NULL;

                    -- Outside ops are driven by the send/receive lifecycle, not
                    -- by quantity events (compute_job_operation_status returns
                    -- their stored status untouched), so they are set directly.
                    IF v_leaf->>'status' IS NOT NULL THEN
                        UPDATE job_operations
                           SET status = v_leaf->>'status',
                               sent_at = CASE WHEN v_leaf->>'status' IN ('sent', 'completed')
                                              THEN now() - make_interval(days =>
                                                   COALESCE((v_leaf->>'days_ago')::integer, 1)) END,
                               sent_by = CASE WHEN v_leaf->>'status' IN ('sent', 'completed')
                                              THEN p_user_id END,
                               completed_at = CASE WHEN v_leaf->>'status' = 'completed'
                                              THEN now() - make_interval(days =>
                                                   COALESCE((v_leaf->>'days_ago')::integer, 0)) END
                         WHERE id = v_op_id;
                    END IF;

                    IF v_leaf->>'completed_quantity' IS NOT NULL THEN
                        v_author := v_users[1 + (COALESCE((v_leaf->>'author_index')::integer, 0)
                                                 % v_n_authors)];
                        INSERT INTO job_operation_completions
                            (company_id, job_operation_id, job_part_id, quantity_good,
                             completed_by, completed_at, note)
                        VALUES (p_company_id, v_op_id, v_job_part_id,
                                (v_leaf->>'completed_quantity')::numeric,
                                v_author,
                                now() - make_interval(days =>
                                        COALESCE((v_leaf->>'days_ago')::integer, 0)),
                                v_leaf->>'note');
                    END IF;
                END LOOP;

                -- External ops set above bypass the completion trigger, so roll
                -- the job_part up explicitly; that UPDATE fires the part->job
                -- sync in turn.
                UPDATE job_parts jp
                   SET production_status = compute_job_part_production_status(jp.id),
                       current_operation_sequence = COALESCE(
                           (SELECT min(o.sequence) FROM job_operations o
                             WHERE o.job_part_id = jp.id AND o.status <> 'completed'),
                           (SELECT max(o.sequence) FROM job_operations o
                             WHERE o.job_part_id = jp.id))
                 WHERE jp.id = v_job_part_id
                   AND jp.production_status IS DISTINCT FROM compute_job_part_production_status(jp.id);
            END LOOP;
        END LOOP;
    END IF;

    -- ---- shipments --------------------------------------------------------
    -- Inserted directly rather than through create_shipment_with_line_items:
    -- that RPC gates on auth.uid()'s company access, which is not a dependency a
    -- seeder should carry. The packing-slip formula is the RPC's, verbatim
    -- (PS-{job_number minus alpha prefix}-{nth shipment on that job}).
    IF v_template->'shipments' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'shipments') LOOP
            v_ship_id := gen_random_uuid();
            v_job_id  := (v_ref_map->>(v_item->>'job_ref'))::uuid;
            SELECT job_number INTO v_job_number FROM jobs WHERE id = v_job_id;
            v_base := regexp_replace(v_job_number, '^[A-Za-z]+-?', '');
            SELECT count(*) + 1 INTO v_seq FROM shipments WHERE job_id = v_job_id;

            INSERT INTO shipments (id, company_id, customer_id, job_id, shipping_address_id,
                                   packing_slip_number, ship_date, carrier, shipping_method,
                                   freight_terms, created_by, created_at)
            VALUES (v_ship_id, p_company_id,
                    (v_ref_map->>(v_item->>'customer_ref'))::uuid, v_job_id,
                    CASE WHEN v_item->>'shipping_address_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'shipping_address_ref'))::uuid END,
                    'PS-' || v_base || '-' || v_seq::text,
                    CURRENT_DATE - COALESCE((v_item->>'ship_days_ago')::integer, 0),
                    v_item->>'carrier',
                    COALESCE(v_item->>'shipping_method', 'shipment'),
                    v_item->>'freight_terms', p_user_id,
                    now() - make_interval(days => COALESCE((v_item->>'ship_days_ago')::integer, 0)));

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'line_items', '[]'::jsonb)) LOOP
                v_qty := (v_inner->>'quantity')::numeric;
                CONTINUE WHEN v_qty IS NULL OR v_qty <= 0;
                INSERT INTO shipment_line_items (shipment_id, job_part_id, quantity)
                VALUES (v_ship_id, (v_ref_map->>(v_inner->>'job_part_ref'))::uuid, v_qty);
            END LOOP;
        END LOOP;
    END IF;

    -- ---- notes / activity feed -------------------------------------------
    IF v_template->'notes' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'notes') LOOP
            v_note_id := gen_random_uuid();
            IF v_item->>'_ref' IS NOT NULL THEN
                v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_note_id::text));
            END IF;
            -- NULL author when the company somehow has no membership rows: an
            -- unattributed note is a real state the UI renders, a dangling FK is not.
            v_author := CASE WHEN array_length(v_members, 1) IS NULL THEN NULL
                        ELSE v_members[1 + (COALESCE((v_item->>'author_index')::integer, 0)
                                            % array_length(v_members, 1))] END;

            INSERT INTO notes (id, company_id, subject_kind, note_type, body, author_id,
                               job_id, job_part_id, job_operation_id,
                               part_id, work_center_id, maintenance_kind, resolves_note_id,
                               created_at)
            VALUES (v_note_id, p_company_id,
                    v_item->>'subject_kind',
                    COALESCE(v_item->>'note_type', 'user'),
                    v_item->>'body', v_author,
                    CASE WHEN v_item->>'job_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'job_ref'))::uuid END,
                    CASE WHEN v_item->>'job_part_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'job_part_ref'))::uuid END,
                    CASE WHEN v_item->>'job_part_ref' IS NOT NULL
                          AND v_item->>'operation_sequence' IS NOT NULL
                         THEN (SELECT id FROM job_operations
                                WHERE job_part_id = (v_ref_map->>(v_item->>'job_part_ref'))::uuid
                                  AND sequence = (v_item->>'operation_sequence')::integer) END,
                    CASE WHEN v_item->>'part_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'part_ref'))::uuid END,
                    CASE WHEN v_item->>'work_center_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'work_center_ref'))::uuid END,
                    v_item->>'maintenance_kind',
                    CASE WHEN v_item->>'resolves_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'resolves_ref'))::uuid END,
                    now() - make_interval(days => COALESCE((v_item->>'days_ago')::integer, 0)));

            CONTINUE WHEN array_length(v_members, 1) IS NULL;  -- reactor_id is NOT NULL
            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'reactions', '[]'::jsonb)) LOOP
                v_author := v_members[1 + (COALESCE((v_inner->>'reactor_index')::integer, 0)
                                           % array_length(v_members, 1))];
                INSERT INTO note_reactions (company_id, note_id, reactor_id, kind)
                VALUES (p_company_id, v_note_id, v_author, COALESCE(v_inner->>'kind', 'helpful'))
                ON CONFLICT DO NOTHING;
            END LOOP;
        END LOOP;
    END IF;

    -- ---- inventory movement history --------------------------------------
    -- The ledger only; balances already come from part_location_stock above.
    -- Writing both is deliberate: the transaction rows are what the Storage
    -- history reads, and they are a log, not a source of truth for quantity.
    IF v_template->'inventory_transactions' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'inventory_transactions') LOOP
            v_part_id := (v_ref_map->>(v_item->>'part_ref'))::uuid;
            v_loc_id  := CASE WHEN v_item->>'location_ref' IS NOT NULL
                              THEN (v_ref_map->>(v_item->>'location_ref'))::uuid END;
            v_qty     := (v_item->>'quantity')::numeric;
            v_author  := v_users[1 + (COALESCE((v_item->>'author_index')::integer, 0) % v_n_authors)];

            INSERT INTO inventory_transactions (company_id, part_id, item_name, type, quantity,
                                                unit, converted_quantity, location_id,
                                                job_id, notes, created_by, created_at)
            SELECT p_company_id, v_part_id, p.part_name, v_item->>'type', v_qty,
                   COALESCE(v_item->>'unit', p.primary_unit),
                   COALESCE(NULLIF(v_item->>'converted_quantity', '')::numeric, v_qty),
                   v_loc_id,
                   CASE WHEN v_item->>'job_ref' IS NOT NULL
                        THEN (v_ref_map->>(v_item->>'job_ref'))::uuid END,
                   v_item->>'notes', v_author,
                   now() - make_interval(days => COALESCE((v_item->>'days_ago')::integer, 0))
              FROM parts p WHERE p.id = v_part_id;
        END LOOP;
    END IF;
END;
$function$;

COMMENT ON FUNCTION public.seed_demo_data(uuid, uuid, text) IS
'Seeds a company from the active demo_data_templates row, resolving _ref keys to UUIDs through one jsonb map. Order: custom units -> locations -> vendors(+contacts) -> work_centers -> parts(+stock/procurement tiers/pricing tiers/unit conversions) -> parts_bom -> routings(+operations) -> customers(+contacts/addresses) -> quotes(+line items) -> jobs(+parts, routing snapshot, operation completions) -> shipments(+line items) -> notes(+reactions) -> inventory_transactions. Derived columns are left to their triggers: parts.quantity from part_location_stock, job/job_part statuses from completions and shipment lines, quote_number from the shared order counter. Every optional field is COALESCE''d so a template predating a column still loads.';

-- ============================================================================
-- 2. reset_demo_company
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reset_demo_company(p_source_company_id uuid, p_user_id uuid)
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

    -- Delete leaves-first. The order is not cosmetic: six of these are RESTRICT
    -- parents (shipment_line_items -> job_parts, part_location_stock -> parts,
    -- work_center_attachments -> work_centers, quickbooks_invoice_line_items ->
    -- job_parts, notes -> work_centers, job_materials -> parts), and because the
    -- whole body is one transaction a single RESTRICT violation rolled the
    -- entire reset back — deleting nothing, permanently, for any demo that had
    -- shipped something. That was #675.

    -- notes and their children (notes RESTRICTs work_centers; note_* CASCADE
    -- from notes, but explicit beats relying on it)
    DELETE FROM note_reactions WHERE company_id = v_demo_company_id;
    DELETE FROM note_views     WHERE company_id = v_demo_company_id;
    DELETE FROM note_media     WHERE company_id = v_demo_company_id;
    DELETE FROM notes          WHERE company_id = v_demo_company_id;

    -- fulfillment + invoicing edges, above job_parts
    DELETE FROM job_fulfillment_audit WHERE company_id = v_demo_company_id;
    DELETE FROM shipment_line_items
        WHERE shipment_id IN (SELECT id FROM shipments WHERE company_id = v_demo_company_id);
    DELETE FROM shipments      WHERE company_id = v_demo_company_id;
    DELETE FROM quickbooks_invoice_line_items WHERE company_id = v_demo_company_id;
    DELETE FROM quickbooks_invoice_links      WHERE company_id = v_demo_company_id;

    -- inventory ledger and balances (part_location_stock RESTRICTs parts)
    DELETE FROM inventory_transactions WHERE company_id = v_demo_company_id;
    DELETE FROM part_location_stock    WHERE company_id = v_demo_company_id;

    -- jobs
    DELETE FROM job_operation_completions WHERE company_id = v_demo_company_id;
    DELETE FROM job_materials  WHERE job_id IN (SELECT id FROM jobs WHERE company_id = v_demo_company_id);
    DELETE FROM job_operations WHERE job_id IN (SELECT id FROM jobs WHERE company_id = v_demo_company_id);
    DELETE FROM job_attachments WHERE company_id = v_demo_company_id;
    DELETE FROM job_parts      WHERE company_id = v_demo_company_id;
    DELETE FROM jobs           WHERE company_id = v_demo_company_id;

    -- quotes
    DELETE FROM quote_line_items WHERE company_id = v_demo_company_id;
    DELETE FROM quote_materials  WHERE company_id = v_demo_company_id;
    DELETE FROM quote_operations WHERE company_id = v_demo_company_id;
    DELETE FROM quotes           WHERE company_id = v_demo_company_id;

    -- routings, then parts and their children
    DELETE FROM routing_operations
        WHERE routing_id IN (SELECT id FROM routings WHERE company_id = v_demo_company_id);
    DELETE FROM routings WHERE company_id = v_demo_company_id;
    DELETE FROM parts_bom
        WHERE parent_part_id IN (SELECT id FROM parts WHERE company_id = v_demo_company_id)
           OR child_part_id  IN (SELECT id FROM parts WHERE company_id = v_demo_company_id);
    DELETE FROM part_procurement_tiers
        WHERE part_id IN (SELECT id FROM parts WHERE company_id = v_demo_company_id);
    DELETE FROM part_pricing_tiers WHERE company_id = v_demo_company_id;
    DELETE FROM parts_unit_conversions
        WHERE part_id IN (SELECT id FROM parts WHERE company_id = v_demo_company_id);
    DELETE FROM part_attachments WHERE company_id = v_demo_company_id;
    DELETE FROM part_comments    WHERE company_id = v_demo_company_id;
    DELETE FROM parts            WHERE company_id = v_demo_company_id;

    -- storage locations, now that nothing holds a balance in one
    DELETE FROM inventory_locations WHERE company_id = v_demo_company_id;

    -- work centers (work_center_attachments RESTRICTs them)
    DELETE FROM work_center_attachments WHERE company_id = v_demo_company_id;
    DELETE FROM work_centers            WHERE company_id = v_demo_company_id;

    -- parties
    DELETE FROM customer_carrier_accounts WHERE company_id = v_demo_company_id;
    DELETE FROM customers WHERE company_id = v_demo_company_id;  -- contacts/addresses CASCADE
    DELETE FROM vendors   WHERE company_id = v_demo_company_id;  -- vendor_contacts CASCADE

    -- odds and ends the demo owns
    DELETE FROM operator_events  WHERE company_id = v_demo_company_id;
    DELETE FROM ai_chat_queries  WHERE company_id = v_demo_company_id;
    DELETE FROM saved_insights   WHERE company_id = v_demo_company_id;
    DELETE FROM company_custom_units WHERE company_id = v_demo_company_id;

    -- Reset the shared Q-/J- counter so the re-seeded demo reads Q-0001 / J-0009
    -- again rather than climbing on every reset.
    DELETE FROM company_order_counters WHERE company_id = v_demo_company_id;

    -- Deliberately KEPT: user_company_access (the membership Reset is documented
    -- to preserve), company_billing, invitations, quickbooks_connections,
    -- ai_config, auth_audit_log, feedback.

    PERFORM seed_demo_data(v_demo_company_id, p_user_id);
END;
$function$;

COMMENT ON FUNCTION public.reset_demo_company(uuid, uuid) IS
'Wipes every table the demo company owns, then re-seeds from the active template. Caller must be the requesting user (auth.uid() check). Deletion is leaves-first because six child tables are ON DELETE RESTRICT against parts/job_parts/work_centers; the body is one transaction, so a single violation rolls the whole reset back (#675). Keeps user_company_access, company_billing, invitations, quickbooks_connections, ai_config, auth_audit_log and feedback; clears company_order_counters so quote/job numbering restarts.';

-- ============================================================================
-- 3. template `default` v3
-- ============================================================================
--
-- Committed rather than hand-inserted into prod. The old row was authored in the
-- prod console and lived nowhere else, so it could not be reviewed, could not be
-- replayed onto a fresh stack (#550 — `create_demo_company` raised "No active
-- demo template found" on every local and preview database), and drifted out of
-- step with the schema for five months without anything noticing.
--
-- Shape of the graph, all of it exercised by the seeder above:
--   19 storage locations (3 levels)   45 parts (24 bought / 21 made)
--    6 vendors + 13 contacts          28 per-location stock balances
--   12 work centers (9 in / 3 out)    38 BOM edges, 3 levels deep
--   21 routings / 69 operations        8 customers + 13 contacts + 11 addresses
--   10 quotes / 17 line items         16 jobs / 24 job parts / 35 completions
--    6 shipments                      29 notes (job, part and machine subjects)
--   21 inventory transactions
--
-- Jobs deliberately span every status the app can show: not_started, in_progress
-- and completed production; unshipped, partially_shipped and fully_shipped
-- fulfillment; two hot jobs, several overdue, one on a credit-held customer, one
-- resold bought part, and outside operations both sent and received. Dates are
-- all relative (`days_ago` / `due_in_days`), so the demo reads as current
-- whenever it is seeded rather than ageing into a museum.

UPDATE public.demo_data_templates SET is_active = false
 WHERE name = 'default' AND is_active;

INSERT INTO public.demo_data_templates (name, version, is_active, template_data)
VALUES ('default', 3, true, $json$
{
  "schema_version": "2026-08-04",
  "note": "Demo template v3. Rebuilt against the August 2026 schema (source/is_stocked parts, split job statuses, customer_contacts + customer_addresses, storage locations with per-location balances, procurement/pricing tiers, notes feed, shipments). Roughly a 40-person-week of shop history for a 12-machine precision shop: 42 parts, 18 routings, 8 customers, 10 quotes, 16 jobs across every status, 6 shipments, 28 notes.",

  "custom_units": ["stick", "sheet", "gal"],

  "locations": [
    { "_ref": "loc_raw",        "name": "Raw Material Rack", "kind": "rack",    "sort_order": 10 },
    { "_ref": "loc_raw_a",      "name": "Bay A",   "kind": "bay",   "parent_ref": "loc_raw", "sort_order": 10 },
    { "_ref": "loc_raw_b",      "name": "Bay B",   "kind": "bay",   "parent_ref": "loc_raw", "sort_order": 20 },
    { "_ref": "loc_raw_c",      "name": "Bay C",   "kind": "bay",   "parent_ref": "loc_raw", "sort_order": 30 },
    { "_ref": "loc_shelf1",     "name": "Shelving Unit 1", "kind": "cabinet", "sort_order": 20 },
    { "_ref": "loc_shelf1_a",   "name": "Shelf 1-A", "kind": "shelf", "parent_ref": "loc_shelf1", "sort_order": 10 },
    { "_ref": "loc_shelf1_b",   "name": "Shelf 1-B", "kind": "shelf", "parent_ref": "loc_shelf1", "sort_order": 20 },
    { "_ref": "loc_shelf1_c",   "name": "Shelf 1-C", "kind": "shelf", "parent_ref": "loc_shelf1", "sort_order": 30 },
    { "_ref": "loc_shelf2",     "name": "Shelving Unit 2", "kind": "cabinet", "sort_order": 30 },
    { "_ref": "loc_shelf2_a",   "name": "Shelf 2-A", "kind": "shelf", "parent_ref": "loc_shelf2", "sort_order": 10 },
    { "_ref": "loc_shelf2_b",   "name": "Shelf 2-B", "kind": "shelf", "parent_ref": "loc_shelf2", "sort_order": 20 },
    { "_ref": "loc_hw",         "name": "Hardware Cabinet", "kind": "cabinet", "sort_order": 40 },
    { "_ref": "loc_hw_1",       "name": "Bin H1", "kind": "bin", "parent_ref": "loc_hw", "sort_order": 10 },
    { "_ref": "loc_hw_2",       "name": "Bin H2", "kind": "bin", "parent_ref": "loc_hw", "sort_order": 20 },
    { "_ref": "loc_hw_3",       "name": "Bin H3", "kind": "bin", "parent_ref": "loc_hw", "sort_order": 30 },
    { "_ref": "loc_fg",         "name": "Finished Goods", "kind": "area", "sort_order": 50 },
    { "_ref": "loc_fg_1",       "name": "FG Pallet 1", "kind": "pallet", "parent_ref": "loc_fg", "sort_order": 10 },
    { "_ref": "loc_fg_2",       "name": "FG Pallet 2", "kind": "pallet", "parent_ref": "loc_fg", "sort_order": 20 },
    { "_ref": "loc_crib",       "name": "Tool Crib", "kind": "cabinet", "sort_order": 60 }
  ],

  "vendors": [
    { "_ref": "v_steel", "name": "Midwest Steel Supply", "address_line1": "4200 W Cermak Rd", "city": "Chicago", "state": "IL", "postal_code": "60623",
      "contacts": [
        { "name": "Pat Reyes",  "role": "sales", "email": "orders@midweststeel.example.com", "phone": "312-555-0142", "is_primary": true },
        { "name": "Dana Whitlock", "role": "accounts_payable", "email": "ap@midweststeel.example.com", "phone": "312-555-0143" }
      ] },
    { "_ref": "v_alloy", "name": "Alloy Metals Direct", "address_line1": "1180 Industrial Pkwy", "city": "Cleveland", "state": "OH", "postal_code": "44135",
      "contacts": [ { "name": "Chris Boland", "role": "sales", "email": "sales@alloymetals.example.com", "phone": "216-555-0188", "is_primary": true } ] },
    { "_ref": "v_coating", "name": "PerformCoat Finishing", "address_line1": "77 Foundry St", "city": "Cleveland", "state": "OH", "postal_code": "44113",
      "contacts": [
        { "name": "Sam Lee", "role": "sales", "email": "jobs@performcoat.example.com", "phone": "216-555-0177", "is_primary": true },
        { "name": "Toni Alvarez", "role": "quality", "email": "qa@performcoat.example.com", "phone": "216-555-0179" }
      ] },
    { "_ref": "v_edm", "name": "Precision EDM Partners", "address_line1": "915 Canal St", "city": "Milwaukee", "state": "WI", "postal_code": "53233",
      "contacts": [ { "name": "Jamie Quinn", "role": "sales", "email": "rfq@precisionedm.example.com", "phone": "414-555-0198", "is_primary": true } ] },
    { "_ref": "v_fast", "name": "Fastener Depot", "address_line1": "2255 Arthur Ave", "city": "Elk Grove Village", "state": "IL", "postal_code": "60007",
      "contacts": [ { "name": "Robin Cho", "role": "customer_service", "email": "service@fastenerdepot.example.com", "phone": "847-555-0121", "is_primary": true } ] },
    { "_ref": "v_heat", "name": "Great Lakes Heat Treat", "address_line1": "500 Buchanan St", "city": "Gary", "state": "IN", "postal_code": "46402",
      "contacts": [ { "name": "Alex Moreau", "role": "sales", "email": "scheduling@glheattreat.example.com", "phone": "219-555-0164", "is_primary": true } ] }
  ],

  "work_centers": [
    { "_ref": "wc_saw",     "name": "Marvel Saw",      "kind": "internal", "labor_rate": 62.00,  "description": "Horizontal bandsaw, raw stock cutoff", "make": "Marvel", "model": "Series 8 Mark II", "serial_number": "MV-88214", "year_built": 2014, "purchased_years_ago": 8 },
    { "_ref": "wc_lathe1",  "name": "Mazak QT-200",    "kind": "internal", "labor_rate": 95.00,  "description": "CNC turning cell, bar feed", "make": "Mazak", "model": "Quick Turn 200MY", "serial_number": "MZ-200-4471", "year_built": 2018, "purchased_years_ago": 5 },
    { "_ref": "wc_lathe2",  "name": "Haas ST-30",      "kind": "internal", "labor_rate": 92.00,  "description": "CNC turning, larger envelope", "make": "Haas", "model": "ST-30Y", "serial_number": "HS-30Y-1192", "year_built": 2021, "purchased_years_ago": 3 },
    { "_ref": "wc_mill1",   "name": "HURCO VM10",      "kind": "internal", "labor_rate": 110.00, "description": "3-axis VMC, mid-volume parts", "make": "HURCO", "model": "VM10i", "serial_number": "HU-VM10-3320", "year_built": 2016, "purchased_years_ago": 7 },
    { "_ref": "wc_mill2",   "name": "Haas VF-4SS",     "kind": "internal", "labor_rate": 118.00, "description": "4-axis VMC, high-speed spindle", "make": "Haas", "model": "VF-4SS", "serial_number": "HS-VF4-8804", "year_built": 2022, "purchased_years_ago": 2 },
    { "_ref": "wc_mill3",   "name": "Bridgeport Manual","kind": "internal", "labor_rate": 78.00, "description": "Manual knee mill, one-offs and fixtures", "make": "Bridgeport", "model": "Series I", "serial_number": "BP-S1-0442", "year_built": 1998, "purchased_years_ago": 19 },
    { "_ref": "wc_deburr",  "name": "Deburr Bench",    "kind": "internal", "labor_rate": 55.00,  "description": "Hand deburr and edge break" },
    { "_ref": "wc_assy",    "name": "Assembly Bench",  "kind": "internal", "labor_rate": 68.00,  "description": "Sub-assembly and hardware install" },
    { "_ref": "wc_qc",      "name": "QC Bench",        "kind": "internal", "labor_rate": 75.00,  "description": "CMM plus manual gauging", "make": "Brown & Sharpe", "model": "Global S 7.10.7", "serial_number": "BS-GS-2207", "year_built": 2019, "purchased_years_ago": 4 },
    { "_ref": "wc_coating", "name": "PerformCoat Anodize", "kind": "external", "vendor_ref": "v_coating", "description": "Outside anodize and black oxide" },
    { "_ref": "wc_edm",     "name": "Precision Wire EDM",  "kind": "external", "vendor_ref": "v_edm",     "description": "Outside wire EDM, tight-tolerance features" },
    { "_ref": "wc_heat",    "name": "Great Lakes Heat Treat", "kind": "external", "vendor_ref": "v_heat", "description": "Outside through-hardening and stress relief" }
  ],

  "parts": [
    { "_ref": "p_bar1018_1", "part_name": "1018-BAR-1.000", "description": "1018 cold-rolled steel bar, 1.000 in dia, 12 ft sticks", "source": "bought", "is_stocked": true, "primary_unit": "in", "reorder_point": 240, "preferred_vendor_ref": "v_steel",
      "stock": [ { "location_ref": "loc_raw_a", "quantity": 864 }, { "location_ref": "loc_raw_b", "quantity": 288 } ],
      "unit_conversions": [ { "from_unit": "stick", "to_primary_factor": 144 } ],
      "procurement_tiers": [ { "min_quantity": 1, "cost_per_unit": 0.92, "quoted_days_ago": 40, "expires_in_days": 50 }, { "min_quantity": 720, "cost_per_unit": 0.81, "quoted_days_ago": 40, "expires_in_days": 50, "notes": "Full-bundle price" } ] },
    { "_ref": "p_bar1018_075", "part_name": "1018-BAR-0.750", "description": "1018 cold-rolled steel bar, 0.750 in dia", "source": "bought", "is_stocked": true, "primary_unit": "in", "reorder_point": 200, "preferred_vendor_ref": "v_steel",
      "stock": [ { "location_ref": "loc_raw_a", "quantity": 576 } ],
      "unit_conversions": [ { "from_unit": "stick", "to_primary_factor": 144 } ],
      "procurement_tiers": [ { "min_quantity": 1, "cost_per_unit": 0.64, "quoted_days_ago": 40, "expires_in_days": 50 } ] },
    { "_ref": "p_bar4140", "part_name": "4140-BAR-1.250", "description": "4140 pre-hard alloy bar, 1.250 in dia", "source": "bought", "is_stocked": true, "primary_unit": "in", "reorder_point": 180, "preferred_vendor_ref": "v_steel",
      "stock": [ { "location_ref": "loc_raw_b", "quantity": 432 } ],
      "unit_conversions": [ { "from_unit": "stick", "to_primary_factor": 144 } ],
      "procurement_tiers": [ { "min_quantity": 1, "cost_per_unit": 1.85, "quoted_days_ago": 25, "expires_in_days": 65 } ] },
    { "_ref": "p_bar303", "part_name": "303-BAR-0.625", "description": "303 stainless bar, 0.625 in dia, free-machining", "source": "bought", "is_stocked": true, "primary_unit": "in", "reorder_point": 150, "preferred_vendor_ref": "v_steel",
      "stock": [ { "location_ref": "loc_raw_b", "quantity": 288 } ],
      "procurement_tiers": [ { "min_quantity": 1, "cost_per_unit": 2.40, "quoted_days_ago": 25, "expires_in_days": 65 } ] },
    { "_ref": "p_plate6061_25", "part_name": "6061-PLATE-0.250", "description": "6061-T6 aluminum plate, 0.250 in thick", "source": "bought", "is_stocked": true, "primary_unit": "sqin", "reorder_point": 600, "preferred_vendor_ref": "v_alloy",
      "stock": [ { "location_ref": "loc_raw_c", "quantity": 2880 } ],
      "unit_conversions": [ { "from_unit": "sheet", "to_primary_factor": 1728 } ],
      "procurement_tiers": [ { "min_quantity": 1, "cost_per_unit": 0.14, "quoted_days_ago": 18, "expires_in_days": 72 }, { "min_quantity": 1728, "cost_per_unit": 0.115, "quoted_days_ago": 18, "expires_in_days": 72, "notes": "Full sheet" } ] },
    { "_ref": "p_plate6061_50", "part_name": "6061-PLATE-0.500", "description": "6061-T6 aluminum plate, 0.500 in thick", "source": "bought", "is_stocked": true, "primary_unit": "sqin", "reorder_point": 400, "preferred_vendor_ref": "v_alloy",
      "stock": [ { "location_ref": "loc_raw_c", "quantity": 1440 } ],
      "unit_conversions": [ { "from_unit": "sheet", "to_primary_factor": 1728 } ],
      "procurement_tiers": [ { "min_quantity": 1, "cost_per_unit": 0.26, "quoted_days_ago": 18, "expires_in_days": 72 } ] },
    { "_ref": "p_plate7075", "part_name": "7075-PLATE-0.375", "description": "7075-T651 aluminum plate, 0.375 in thick", "source": "bought", "is_stocked": true, "primary_unit": "sqin", "reorder_point": 300, "preferred_vendor_ref": "v_alloy",
      "stock": [ { "location_ref": "loc_raw_c", "quantity": 864 } ],
      "procurement_tiers": [ { "min_quantity": 1, "cost_per_unit": 0.48, "quoted_days_ago": 12, "expires_in_days": 78 } ] },
    { "_ref": "p_sheet304", "part_name": "304-SHEET-0.125", "description": "304 stainless sheet, 0.125 in thick", "source": "bought", "is_stocked": true, "primary_unit": "sqin", "reorder_point": 400, "preferred_vendor_ref": "v_alloy",
      "stock": [ { "location_ref": "loc_raw_c", "quantity": 1152 } ],
      "procurement_tiers": [ { "min_quantity": 1, "cost_per_unit": 0.31, "quoted_days_ago": 12, "expires_in_days": 78 } ] },
    { "_ref": "p_tube6061", "part_name": "6061-TUBE-2.00OD", "description": "6061 aluminum round tube, 2.00 in OD x 0.125 wall", "source": "bought", "is_stocked": true, "primary_unit": "in", "reorder_point": 120, "preferred_vendor_ref": "v_alloy",
      "stock": [ { "location_ref": "loc_raw_a", "quantity": 288 } ],
      "procurement_tiers": [ { "min_quantity": 1, "cost_per_unit": 1.10, "quoted_days_ago": 30, "expires_in_days": 60 } ] },
    { "_ref": "p_delrin", "part_name": "DELRIN-BAR-1.500", "description": "Delrin acetal bar, 1.500 in dia, natural", "source": "bought", "is_stocked": true, "primary_unit": "in", "reorder_point": 96, "preferred_vendor_ref": "v_alloy",
      "stock": [ { "location_ref": "loc_raw_b", "quantity": 216 } ],
      "procurement_tiers": [ { "min_quantity": 1, "cost_per_unit": 0.72, "quoted_days_ago": 55, "expires_in_days": 35 } ] },

    { "_ref": "p_shcs14", "part_name": "SHCS-0.250-20X1.00", "description": "Socket head cap screw, 1/4-20 x 1.00, black oxide", "source": "bought", "is_stocked": true, "primary_unit": "each", "reorder_point": 250, "preferred_vendor_ref": "v_fast",
      "stock": [ { "location_ref": "loc_hw_1", "quantity": 1400 } ],
      "procurement_tiers": [ { "min_quantity": 1, "cost_per_unit": 0.22, "quoted_days_ago": 60, "expires_in_days": 30 }, { "min_quantity": 1000, "cost_per_unit": 0.16, "quoted_days_ago": 60, "expires_in_days": 30 } ] },
    { "_ref": "p_shcs10", "part_name": "SHCS-10-32X0.75", "description": "Socket head cap screw, 10-32 x 0.75, stainless", "source": "bought", "is_stocked": true, "primary_unit": "each", "reorder_point": 200, "preferred_vendor_ref": "v_fast",
      "stock": [ { "location_ref": "loc_hw_1", "quantity": 960 } ],
      "procurement_tiers": [ { "min_quantity": 1, "cost_per_unit": 0.18, "quoted_days_ago": 60, "expires_in_days": 30 } ] },
    { "_ref": "p_dowel", "part_name": "DOWEL-0.250X1.00", "description": "Hardened dowel pin, 0.2500 x 1.00", "source": "bought", "is_stocked": true, "primary_unit": "each", "reorder_point": 150, "preferred_vendor_ref": "v_fast",
      "stock": [ { "location_ref": "loc_hw_2", "quantity": 620 } ],
      "procurement_tiers": [ { "min_quantity": 1, "cost_per_unit": 0.34, "quoted_days_ago": 60, "expires_in_days": 30 } ] },
    { "_ref": "p_oring", "part_name": "ORING-2-014", "description": "O-ring, Buna-N 70A, AS568-014", "source": "bought", "is_stocked": true, "primary_unit": "each", "reorder_point": 200, "preferred_vendor_ref": "v_fast",
      "stock": [ { "location_ref": "loc_hw_2", "quantity": 880 } ],
      "procurement_tiers": [ { "min_quantity": 1, "cost_per_unit": 0.11, "quoted_days_ago": 60, "expires_in_days": 30 } ] },
    { "_ref": "p_bushing", "part_name": "BUSHING-OIL-0.500", "description": "Oil-impregnated bronze bushing, 0.500 ID", "source": "bought", "is_stocked": true, "primary_unit": "each", "reorder_point": 80, "preferred_vendor_ref": "v_fast",
      "stock": [ { "location_ref": "loc_hw_2", "quantity": 240 } ],
      "procurement_tiers": [ { "min_quantity": 1, "cost_per_unit": 1.45, "quoted_days_ago": 45, "expires_in_days": 45 } ] },
    { "_ref": "p_springpin", "part_name": "SPRING-PIN-0.125", "description": "Slotted spring pin, 0.125 x 0.750", "source": "bought", "is_stocked": true, "primary_unit": "each", "reorder_point": 150, "preferred_vendor_ref": "v_fast",
      "stock": [ { "location_ref": "loc_hw_3", "quantity": 540 } ],
      "procurement_tiers": [ { "min_quantity": 1, "cost_per_unit": 0.09, "quoted_days_ago": 45, "expires_in_days": 45 } ] },
    { "_ref": "p_insert", "part_name": "THREADINSERT-0.250-20", "description": "Helical thread insert, 1/4-20 x 1.5D", "source": "bought", "is_stocked": true, "primary_unit": "each", "reorder_point": 100, "preferred_vendor_ref": "v_fast",
      "stock": [ { "location_ref": "loc_hw_3", "quantity": 310 } ],
      "procurement_tiers": [ { "min_quantity": 1, "cost_per_unit": 0.55, "quoted_days_ago": 45, "expires_in_days": 45 } ] },
    { "_ref": "p_washer", "part_name": "WASHER-FLAT-0.250", "description": "Flat washer, 1/4, stainless", "source": "bought", "is_stocked": true, "primary_unit": "each", "reorder_point": 200, "preferred_vendor_ref": "v_fast",
      "stock": [ { "location_ref": "loc_hw_3", "quantity": 1250 } ],
      "procurement_tiers": [ { "min_quantity": 1, "cost_per_unit": 0.04, "quoted_days_ago": 45, "expires_in_days": 45 } ] },
    { "_ref": "p_coolant", "part_name": "COOLANT-CONC-5GAL", "description": "Semi-synthetic coolant concentrate, 5 gal pail", "source": "bought", "is_stocked": true, "primary_unit": "gal", "reorder_point": 10, "preferred_vendor_ref": "v_fast",
      "stock": [ { "location_ref": "loc_crib", "quantity": 25 } ],
      "procurement_tiers": [ { "min_quantity": 1, "cost_per_unit": 38.50, "quoted_days_ago": 70, "expires_in_days": 20 } ] },
    { "_ref": "p_endmill", "part_name": "ENDMILL-0.500-4FL", "description": "0.500 in 4-flute carbide end mill, AlTiN", "source": "bought", "is_stocked": true, "primary_unit": "each", "reorder_point": 6, "preferred_vendor_ref": "v_fast",
      "stock": [ { "location_ref": "loc_crib", "quantity": 14 } ],
      "procurement_tiers": [ { "min_quantity": 1, "cost_per_unit": 42.00, "quoted_days_ago": 70, "expires_in_days": 20 } ] },

    { "_ref": "p_sub_blank",   "part_name": "SUB-BLANK-001",   "description": "Turned blank for WIDGET-100 family", "source": "made", "is_stocked": true, "primary_unit": "each", "reorder_point": 20, "costing_batch_quantity": 25,
      "stock": [ { "location_ref": "loc_shelf1_a", "quantity": 62 } ] },
    { "_ref": "p_sub_bracket", "part_name": "SUB-BRACKET-002", "description": "Milled bracket sub-assembly for BRACKET-300", "source": "made", "is_stocked": true, "primary_unit": "each", "reorder_point": 24, "costing_batch_quantity": 50,
      "stock": [ { "location_ref": "loc_shelf1_a", "quantity": 48 } ] },
    { "_ref": "p_sub_shaft",   "part_name": "SUB-SHAFT-003",   "description": "Rough-turned shaft blank, pre heat-treat", "source": "made", "is_stocked": true, "primary_unit": "each", "reorder_point": 15, "costing_batch_quantity": 30,
      "stock": [ { "location_ref": "loc_shelf1_b", "quantity": 34 } ] },
    { "_ref": "p_sub_housing", "part_name": "SUB-HOUSING-004", "description": "Housing body, second-op ready", "source": "made", "is_stocked": true, "primary_unit": "each", "reorder_point": 10, "costing_batch_quantity": 20,
      "stock": [ { "location_ref": "loc_shelf1_b", "quantity": 22 } ] },
    { "_ref": "p_sub_plate",   "part_name": "SUB-PLATE-005",   "description": "Waterjet-profile plate blank, milled flat", "source": "made", "is_stocked": true, "primary_unit": "each", "reorder_point": 20, "costing_batch_quantity": 40,
      "stock": [ { "location_ref": "loc_shelf1_c", "quantity": 55 } ] },

    { "_ref": "p_widget100",  "part_name": "WIDGET-100",  "description": "Finished widget assembly, anodized", "source": "made", "is_stocked": false, "primary_unit": "each", "costing_batch_quantity": 25,
      "pricing_tiers": [ { "sequence": 10, "quantity": 1, "markup_percent": 65 }, { "sequence": 20, "quantity": 25, "markup_percent": 48 }, { "sequence": 30, "quantity": 100, "markup_percent": 38 } ] },
    { "_ref": "p_widget150",  "part_name": "WIDGET-150",  "description": "Widget assembly, extended body variant", "source": "made", "is_stocked": false, "primary_unit": "each", "costing_batch_quantity": 25,
      "pricing_tiers": [ { "sequence": 10, "quantity": 1, "markup_percent": 65 }, { "sequence": 20, "quantity": 25, "markup_percent": 50 } ] },
    { "_ref": "p_bracket300", "part_name": "BRACKET-300", "description": "Mounting bracket, black anodized", "source": "made", "is_stocked": false, "primary_unit": "each", "costing_batch_quantity": 50,
      "pricing_tiers": [ { "sequence": 10, "quantity": 1, "markup_percent": 60 }, { "sequence": 20, "quantity": 50, "markup_percent": 42 }, { "sequence": 30, "quantity": 250, "markup_percent": 33 } ] },
    { "_ref": "p_bracket350", "part_name": "BRACKET-350", "description": "Mounting bracket, heavy-duty variant", "source": "made", "is_stocked": false, "primary_unit": "each", "costing_batch_quantity": 50,
      "pricing_tiers": [ { "sequence": 10, "quantity": 1, "markup_percent": 60 }, { "sequence": 20, "quantity": 50, "markup_percent": 44 } ] },
    { "_ref": "p_pin200",     "part_name": "PIN-200",     "description": "Hardened locating pin with EDM keyway", "source": "made", "is_stocked": false, "primary_unit": "each", "costing_batch_quantity": 50,
      "pricing_tiers": [ { "sequence": 10, "quantity": 1, "markup_percent": 70 }, { "sequence": 20, "quantity": 50, "markup_percent": 52 } ] },
    { "_ref": "p_shaft400",   "part_name": "SHAFT-400",   "description": "Drive shaft, through-hardened and ground", "source": "made", "is_stocked": false, "primary_unit": "each", "costing_batch_quantity": 30,
      "pricing_tiers": [ { "sequence": 10, "quantity": 1, "markup_percent": 62 }, { "sequence": 20, "quantity": 30, "markup_percent": 45 } ] },
    { "_ref": "p_housing500", "part_name": "HOUSING-500", "description": "Pump housing, 6061, o-ring groove", "source": "made", "is_stocked": false, "primary_unit": "each", "costing_batch_quantity": 20,
      "pricing_tiers": [ { "sequence": 10, "quantity": 1, "markup_percent": 58 }, { "sequence": 20, "quantity": 20, "markup_percent": 44 } ] },
    { "_ref": "p_manifold600","part_name": "MANIFOLD-600","description": "Hydraulic manifold block, 7075", "source": "made", "is_stocked": false, "primary_unit": "each", "costing_batch_quantity": 10,
      "pricing_tiers": [ { "sequence": 10, "quantity": 1, "markup_percent": 55 }, { "sequence": 20, "quantity": 10, "markup_percent": 42 } ] },
    { "_ref": "p_flange700",  "part_name": "FLANGE-700",  "description": "Stainless mounting flange, 304", "source": "made", "is_stocked": false, "primary_unit": "each", "costing_batch_quantity": 40,
      "pricing_tiers": [ { "sequence": 10, "quantity": 1, "markup_percent": 60 }, { "sequence": 20, "quantity": 40, "markup_percent": 45 } ] },
    { "_ref": "p_spacer800",  "part_name": "SPACER-800",  "description": "Precision spacer, Delrin", "source": "made", "is_stocked": false, "primary_unit": "each", "costing_batch_quantity": 100,
      "pricing_tiers": [ { "sequence": 10, "quantity": 1, "markup_percent": 75 }, { "sequence": 20, "quantity": 100, "markup_percent": 50 } ] },
    { "_ref": "p_cover900",   "part_name": "COVER-900",   "description": "Access cover, 6061, anodized clear", "source": "made", "is_stocked": false, "primary_unit": "each", "costing_batch_quantity": 50 },
    { "_ref": "p_gear1000",   "part_name": "GEAR-BLANK-1000", "description": "Gear blank, 4140, pre-hobbing", "source": "made", "is_stocked": false, "primary_unit": "each", "costing_batch_quantity": 25 },
    { "_ref": "p_valve1100",  "part_name": "VALVE-BODY-1100", "description": "Valve body, 303 stainless", "source": "made", "is_stocked": false, "primary_unit": "each", "costing_batch_quantity": 20,
      "pricing_tiers": [ { "sequence": 10, "quantity": 1, "markup_percent": 58 }, { "sequence": 20, "quantity": 20, "markup_percent": 44 } ] },
    { "_ref": "p_adapter1200","part_name": "ADAPTER-1200","description": "Tube adapter, 6061, both ends threaded", "source": "made", "is_stocked": false, "primary_unit": "each", "costing_batch_quantity": 50,
      "pricing_tiers": [ { "sequence": 10, "quantity": 1, "markup_percent": 64 }, { "sequence": 20, "quantity": 50, "markup_percent": 46 } ] },
    { "_ref": "p_roller1300", "part_name": "ROLLER-1300", "description": "Conveyor roller shaft with bushings", "source": "made", "is_stocked": false, "primary_unit": "each", "costing_batch_quantity": 40 },
    { "_ref": "p_clamp1400",  "part_name": "CLAMP-1400",  "description": "Toggle clamp body, 1018", "source": "made", "is_stocked": false, "primary_unit": "each", "costing_batch_quantity": 60 },
    { "_ref": "p_plateassy",  "part_name": "PLATE-ASSY-1500", "description": "Plate assembly with inserts and dowels", "source": "made", "is_stocked": false, "primary_unit": "each", "costing_batch_quantity": 25 },
    { "_ref": "p_shim1600",   "part_name": "SHIM-1600",   "description": "Laminated shim, 304, 0.125 stack", "source": "made", "is_stocked": false, "primary_unit": "each", "costing_batch_quantity": 100 },
    { "_ref": "p_bought_knob","part_name": "KNOB-STAR-M8","description": "Star knob, M8 threaded insert — resold as-is", "source": "bought", "is_stocked": true, "primary_unit": "each", "reorder_point": 40, "preferred_vendor_ref": "v_fast",
      "stock": [ { "location_ref": "loc_shelf2_a", "quantity": 120 } ],
      "procurement_tiers": [ { "min_quantity": 1, "cost_per_unit": 3.10, "quoted_days_ago": 20, "expires_in_days": 70 }, { "min_quantity": 100, "cost_per_unit": 2.55, "quoted_days_ago": 20, "expires_in_days": 70 } ],
      "pricing_tiers": [ { "sequence": 10, "quantity": 1, "markup_percent": 80 }, { "sequence": 20, "quantity": 100, "markup_percent": 55 } ] },
    { "_ref": "p_bought_handle","part_name": "HANDLE-REVOLVING-90","description": "Revolving handle, 90 mm — resold as-is", "source": "bought", "is_stocked": true, "primary_unit": "each", "reorder_point": 25, "preferred_vendor_ref": "v_fast",
      "stock": [ { "location_ref": "loc_shelf2_a", "quantity": 75 } ],
      "procurement_tiers": [ { "min_quantity": 1, "cost_per_unit": 5.40, "quoted_days_ago": 20, "expires_in_days": 70 } ],
      "pricing_tiers": [ { "sequence": 10, "quantity": 1, "markup_percent": 75 } ] }
  ],

  "parts_bom": [
    { "parent_ref": "p_sub_blank",   "child_ref": "p_bar1018_1",   "quantity": 1.10, "unit": "in",   "sequence": 10, "notes": "Includes cutoff allowance" },
    { "parent_ref": "p_sub_bracket", "child_ref": "p_plate6061_25","quantity": 14,   "unit": "sqin", "sequence": 10 },
    { "parent_ref": "p_sub_shaft",   "child_ref": "p_bar4140",     "quantity": 4.25, "unit": "in",   "sequence": 10 },
    { "parent_ref": "p_sub_housing", "child_ref": "p_plate6061_50","quantity": 22,   "unit": "sqin", "sequence": 10 },
    { "parent_ref": "p_sub_plate",   "child_ref": "p_plate7075",   "quantity": 18,   "unit": "sqin", "sequence": 10 },

    { "parent_ref": "p_widget100",  "child_ref": "p_sub_blank",   "quantity": 1, "unit": "each", "sequence": 10, "consume_whole_units": true },
    { "parent_ref": "p_widget100",  "child_ref": "p_shcs14",      "quantity": 4, "unit": "each", "sequence": 20, "consume_whole_units": true },
    { "parent_ref": "p_widget100",  "child_ref": "p_oring",       "quantity": 1, "unit": "each", "sequence": 30, "consume_whole_units": true },

    { "parent_ref": "p_widget150",  "child_ref": "p_sub_blank",   "quantity": 1, "unit": "each", "sequence": 10, "consume_whole_units": true },
    { "parent_ref": "p_widget150",  "child_ref": "p_bar1018_1",   "quantity": 0.85, "unit": "in", "sequence": 20 },
    { "parent_ref": "p_widget150",  "child_ref": "p_shcs14",      "quantity": 6, "unit": "each", "sequence": 30, "consume_whole_units": true },

    { "parent_ref": "p_bracket300", "child_ref": "p_sub_bracket", "quantity": 1, "unit": "each", "sequence": 10, "consume_whole_units": true },
    { "parent_ref": "p_bracket300", "child_ref": "p_insert",      "quantity": 2, "unit": "each", "sequence": 20, "consume_whole_units": true },
    { "parent_ref": "p_bracket350", "child_ref": "p_sub_bracket", "quantity": 1, "unit": "each", "sequence": 10, "consume_whole_units": true },
    { "parent_ref": "p_bracket350", "child_ref": "p_plate6061_50","quantity": 9, "unit": "sqin", "sequence": 20 },
    { "parent_ref": "p_bracket350", "child_ref": "p_shcs10",      "quantity": 4, "unit": "each", "sequence": 30, "consume_whole_units": true },

    { "parent_ref": "p_pin200",     "child_ref": "p_bar1018_075", "quantity": 1.35, "unit": "in", "sequence": 10 },
    { "parent_ref": "p_shaft400",   "child_ref": "p_sub_shaft",   "quantity": 1, "unit": "each", "sequence": 10, "consume_whole_units": true },
    { "parent_ref": "p_shaft400",   "child_ref": "p_bushing",     "quantity": 2, "unit": "each", "sequence": 20, "consume_whole_units": true },
    { "parent_ref": "p_housing500", "child_ref": "p_sub_housing", "quantity": 1, "unit": "each", "sequence": 10, "consume_whole_units": true },
    { "parent_ref": "p_housing500", "child_ref": "p_oring",       "quantity": 2, "unit": "each", "sequence": 20, "consume_whole_units": true },
    { "parent_ref": "p_manifold600","child_ref": "p_plate7075",   "quantity": 36,   "unit": "sqin", "sequence": 10 },
    { "parent_ref": "p_manifold600","child_ref": "p_oring",       "quantity": 4, "unit": "each", "sequence": 20, "consume_whole_units": true },
    { "parent_ref": "p_flange700",  "child_ref": "p_sheet304",    "quantity": 20,   "unit": "sqin", "sequence": 10 },
    { "parent_ref": "p_spacer800",  "child_ref": "p_delrin",      "quantity": 0.45, "unit": "in", "sequence": 10 },
    { "parent_ref": "p_cover900",   "child_ref": "p_plate6061_25","quantity": 24,   "unit": "sqin", "sequence": 10 },
    { "parent_ref": "p_gear1000",   "child_ref": "p_bar4140",     "quantity": 1.60, "unit": "in", "sequence": 10 },
    { "parent_ref": "p_valve1100",  "child_ref": "p_bar303",      "quantity": 2.80, "unit": "in", "sequence": 10 },
    { "parent_ref": "p_valve1100",  "child_ref": "p_oring",       "quantity": 2, "unit": "each", "sequence": 20, "consume_whole_units": true },
    { "parent_ref": "p_adapter1200","child_ref": "p_tube6061",    "quantity": 2.20, "unit": "in", "sequence": 10 },
    { "parent_ref": "p_roller1300", "child_ref": "p_bar1018_1",   "quantity": 6.50, "unit": "in", "sequence": 10 },
    { "parent_ref": "p_roller1300", "child_ref": "p_bushing",     "quantity": 2, "unit": "each", "sequence": 20, "consume_whole_units": true },
    { "parent_ref": "p_clamp1400",  "child_ref": "p_bar1018_075", "quantity": 2.10, "unit": "in", "sequence": 10 },
    { "parent_ref": "p_clamp1400",  "child_ref": "p_springpin",   "quantity": 2, "unit": "each", "sequence": 20, "consume_whole_units": true },
    { "parent_ref": "p_plateassy",  "child_ref": "p_sub_plate",   "quantity": 1, "unit": "each", "sequence": 10, "consume_whole_units": true },
    { "parent_ref": "p_plateassy",  "child_ref": "p_insert",      "quantity": 4, "unit": "each", "sequence": 20, "consume_whole_units": true },
    { "parent_ref": "p_plateassy",  "child_ref": "p_dowel",       "quantity": 2, "unit": "each", "sequence": 30, "consume_whole_units": true },
    { "parent_ref": "p_shim1600",   "child_ref": "p_sheet304",    "quantity": 6,    "unit": "sqin", "sequence": 10 }
  ],

  "routings": [
    { "_ref": "r_sub_blank", "part_ref": "p_sub_blank", "name": "SUB-BLANK-001 routing", "description": "Saw then turn from 1018 bar",
      "operations": [
        { "sequence": 10, "work_center_ref": "wc_saw",    "setup_minutes": 8,  "cycle_minutes_per_unit": 0.6, "instructions": "Cut 1.10 in blanks, deburr ends." },
        { "sequence": 20, "work_center_ref": "wc_lathe1", "setup_minutes": 18, "cycle_minutes_per_unit": 1.8, "labor_rate_override": 95.00, "instructions": "Turn OD to 0.980, face both ends." }
      ] },
    { "_ref": "r_sub_bracket", "part_ref": "p_sub_bracket", "name": "SUB-BRACKET-002 routing", "description": "Mill bracket blank from 6061 plate",
      "operations": [
        { "sequence": 10, "work_center_ref": "wc_mill1", "setup_minutes": 15, "cycle_minutes_per_unit": 2.4, "labor_rate_override": 110.00, "instructions": "Profile and drill per DWG rev C." },
        { "sequence": 20, "work_center_ref": "wc_deburr", "setup_minutes": 2, "cycle_minutes_per_unit": 0.5 }
      ] },
    { "_ref": "r_sub_shaft", "part_ref": "p_sub_shaft", "name": "SUB-SHAFT-003 routing", "description": "Saw, rough turn, stress relieve",
      "operations": [
        { "sequence": 10, "work_center_ref": "wc_saw",    "setup_minutes": 8,  "cycle_minutes_per_unit": 0.8 },
        { "sequence": 20, "work_center_ref": "wc_lathe2", "setup_minutes": 22, "cycle_minutes_per_unit": 3.2, "labor_rate_override": 92.00, "instructions": "Rough to 0.020 over finish size." },
        { "sequence": 30, "work_center_ref": "wc_heat",   "external_unit_price": 3.80, "instructions": "Stress relieve, 1100F, 2 hr." }
      ] },
    { "_ref": "r_sub_housing", "part_ref": "p_sub_housing", "name": "SUB-HOUSING-004 routing", "description": "Mill housing body from 0.500 plate",
      "operations": [
        { "sequence": 10, "work_center_ref": "wc_mill2", "setup_minutes": 30, "cycle_minutes_per_unit": 5.5, "labor_rate_override": 118.00, "instructions": "Op 1: profile, pocket, drill." },
        { "sequence": 20, "work_center_ref": "wc_deburr", "setup_minutes": 2, "cycle_minutes_per_unit": 0.8 }
      ] },
    { "_ref": "r_sub_plate", "part_ref": "p_sub_plate", "name": "SUB-PLATE-005 routing", "description": "Mill plate blank flat and square",
      "operations": [
        { "sequence": 10, "work_center_ref": "wc_mill1", "setup_minutes": 12, "cycle_minutes_per_unit": 1.9, "labor_rate_override": 110.00 }
      ] },

    { "_ref": "r_widget100", "part_ref": "p_widget100", "name": "WIDGET-100 routing", "description": "Turn, mill, anodize, assemble, inspect",
      "operations": [
        { "sequence": 10, "work_center_ref": "wc_lathe1", "setup_minutes": 30, "cycle_minutes_per_unit": 4.5, "labor_rate_override": 100.00, "instructions": "Finish turn OD and bore. Check 0.9995/0.9990." },
        { "sequence": 20, "work_center_ref": "wc_mill1",  "setup_minutes": 25, "cycle_minutes_per_unit": 3.75, "labor_rate_override": 115.00, "instructions": "Mill flats and cross-drill." },
        { "sequence": 30, "work_center_ref": "wc_coating","external_unit_price": 4.50, "instructions": "Type II clear anodize, mask bore." },
        { "sequence": 40, "work_center_ref": "wc_assy",   "setup_minutes": 10, "cycle_minutes_per_unit": 2.2, "instructions": "Install o-ring and 4x SHCS." },
        { "sequence": 50, "work_center_ref": "wc_qc",     "setup_minutes": 5,  "cycle_minutes_per_unit": 0.5, "instructions": "CMM first article, then 1 in 10." }
      ] },
    { "_ref": "r_widget150", "part_ref": "p_widget150", "name": "WIDGET-150 routing", "description": "Extended body variant of the WIDGET-100 flow",
      "operations": [
        { "sequence": 10, "work_center_ref": "wc_lathe1", "setup_minutes": 32, "cycle_minutes_per_unit": 5.2, "labor_rate_override": 100.00 },
        { "sequence": 20, "work_center_ref": "wc_mill2",  "setup_minutes": 28, "cycle_minutes_per_unit": 4.1, "labor_rate_override": 118.00 },
        { "sequence": 30, "work_center_ref": "wc_coating","external_unit_price": 5.10 },
        { "sequence": 40, "work_center_ref": "wc_assy",   "setup_minutes": 10, "cycle_minutes_per_unit": 2.6 },
        { "sequence": 50, "work_center_ref": "wc_qc",     "setup_minutes": 5,  "cycle_minutes_per_unit": 0.6 }
      ] },
    { "_ref": "r_bracket300", "part_ref": "p_bracket300", "name": "BRACKET-300 routing", "description": "Mill, anodize, insert, inspect",
      "operations": [
        { "sequence": 10, "work_center_ref": "wc_mill1",  "setup_minutes": 20, "cycle_minutes_per_unit": 5.0, "labor_rate_override": 120.00, "instructions": "Second op: tap 2x 1/4-20 for inserts." },
        { "sequence": 20, "work_center_ref": "wc_coating","external_unit_price": 3.25, "instructions": "Black anodize per MIL-A-8625 Type II Class 2." },
        { "sequence": 30, "work_center_ref": "wc_assy",   "setup_minutes": 6,  "cycle_minutes_per_unit": 1.1, "instructions": "Install 2x helical inserts." },
        { "sequence": 40, "work_center_ref": "wc_qc",     "setup_minutes": 5,  "cycle_minutes_per_unit": 0.4, "labor_rate_override": 80.00 }
      ] },
    { "_ref": "r_bracket350", "part_ref": "p_bracket350", "name": "BRACKET-350 routing", "description": "Heavy-duty bracket, two milling ops",
      "operations": [
        { "sequence": 10, "work_center_ref": "wc_mill1",  "setup_minutes": 22, "cycle_minutes_per_unit": 5.4, "labor_rate_override": 120.00 },
        { "sequence": 20, "work_center_ref": "wc_mill3",  "setup_minutes": 15, "cycle_minutes_per_unit": 3.0, "instructions": "Manual: relieve back face." },
        { "sequence": 30, "work_center_ref": "wc_coating","external_unit_price": 3.60 },
        { "sequence": 40, "work_center_ref": "wc_qc",     "setup_minutes": 5,  "cycle_minutes_per_unit": 0.5 }
      ] },
    { "_ref": "r_pin200", "part_ref": "p_pin200", "name": "PIN-200 routing", "description": "Turn, outside EDM keyway, harden, inspect",
      "operations": [
        { "sequence": 10, "work_center_ref": "wc_lathe1", "setup_minutes": 22, "cycle_minutes_per_unit": 2.8, "labor_rate_override": 105.00 },
        { "sequence": 20, "work_center_ref": "wc_edm",    "external_unit_price": 8.75, "instructions": "Wire keyway 0.125 wide x 0.060 deep." },
        { "sequence": 30, "work_center_ref": "wc_heat",   "external_unit_price": 2.90, "instructions": "Through-harden to 58-62 HRC." },
        { "sequence": 40, "work_center_ref": "wc_qc",     "setup_minutes": 5,  "cycle_minutes_per_unit": 0.3, "labor_rate_override": 78.00 }
      ] },
    { "_ref": "r_shaft400", "part_ref": "p_shaft400", "name": "SHAFT-400 routing", "description": "Finish turn after heat treat, press bushings",
      "operations": [
        { "sequence": 10, "work_center_ref": "wc_lathe2", "setup_minutes": 25, "cycle_minutes_per_unit": 4.0, "labor_rate_override": 92.00 },
        { "sequence": 20, "work_center_ref": "wc_heat",   "external_unit_price": 4.20 },
        { "sequence": 30, "work_center_ref": "wc_lathe2", "setup_minutes": 15, "cycle_minutes_per_unit": 2.5, "instructions": "Finish journals to print after HT." },
        { "sequence": 40, "work_center_ref": "wc_assy",   "setup_minutes": 8,  "cycle_minutes_per_unit": 1.5, "instructions": "Press 2x oil bushings." },
        { "sequence": 50, "work_center_ref": "wc_qc",     "setup_minutes": 6,  "cycle_minutes_per_unit": 0.7 }
      ] },
    { "_ref": "r_housing500", "part_ref": "p_housing500", "name": "HOUSING-500 routing", "description": "Second op, anodize, o-ring fit",
      "operations": [
        { "sequence": 10, "work_center_ref": "wc_mill2",  "setup_minutes": 35, "cycle_minutes_per_unit": 6.8, "labor_rate_override": 118.00, "instructions": "Op 2: bore and o-ring groove." },
        { "sequence": 20, "work_center_ref": "wc_deburr", "setup_minutes": 2,  "cycle_minutes_per_unit": 1.0 },
        { "sequence": 30, "work_center_ref": "wc_coating","external_unit_price": 6.20 },
        { "sequence": 40, "work_center_ref": "wc_qc",     "setup_minutes": 8,  "cycle_minutes_per_unit": 1.2, "instructions": "CMM every part, groove depth critical." }
      ] },
    { "_ref": "r_manifold600", "part_ref": "p_manifold600", "name": "MANIFOLD-600 routing", "description": "Four-side manifold, deburr critical",
      "operations": [
        { "sequence": 10, "work_center_ref": "wc_mill2",  "setup_minutes": 55, "cycle_minutes_per_unit": 22.0, "labor_rate_override": 118.00, "instructions": "Cross-drilled ports, watch burr at intersections." },
        { "sequence": 20, "work_center_ref": "wc_deburr", "setup_minutes": 5,  "cycle_minutes_per_unit": 6.0, "instructions": "Scope every port intersection." },
        { "sequence": 30, "work_center_ref": "wc_qc",     "setup_minutes": 10, "cycle_minutes_per_unit": 3.0 }
      ] },
    { "_ref": "r_flange700", "part_ref": "p_flange700", "name": "FLANGE-700 routing", "description": "Stainless flange, mill and passivate",
      "operations": [
        { "sequence": 10, "work_center_ref": "wc_mill1",  "setup_minutes": 18, "cycle_minutes_per_unit": 4.2, "labor_rate_override": 110.00 },
        { "sequence": 20, "work_center_ref": "wc_coating","external_unit_price": 2.40, "instructions": "Passivate per ASTM A967." },
        { "sequence": 30, "work_center_ref": "wc_qc",     "setup_minutes": 5,  "cycle_minutes_per_unit": 0.5 }
      ] },
    { "_ref": "r_spacer800", "part_ref": "p_spacer800", "name": "SPACER-800 routing", "description": "Single-op turned Delrin spacer",
      "operations": [
        { "sequence": 10, "work_center_ref": "wc_lathe1", "setup_minutes": 12, "cycle_minutes_per_unit": 0.9, "labor_rate_override": 95.00, "instructions": "Run dry, no coolant on Delrin." }
      ] },
    { "_ref": "r_cover900", "part_ref": "p_cover900", "name": "COVER-900 routing", "description": "Mill and anodize clear",
      "operations": [
        { "sequence": 10, "work_center_ref": "wc_mill1",  "setup_minutes": 14, "cycle_minutes_per_unit": 2.8, "labor_rate_override": 110.00 },
        { "sequence": 20, "work_center_ref": "wc_coating","external_unit_price": 2.80 },
        { "sequence": 30, "work_center_ref": "wc_qc",     "setup_minutes": 4,  "cycle_minutes_per_unit": 0.3 }
      ] },
    { "_ref": "r_valve1100", "part_ref": "p_valve1100", "name": "VALVE-BODY-1100 routing", "description": "Turn-mill stainless valve body",
      "operations": [
        { "sequence": 10, "work_center_ref": "wc_lathe1", "setup_minutes": 28, "cycle_minutes_per_unit": 6.5, "labor_rate_override": 100.00 },
        { "sequence": 20, "work_center_ref": "wc_mill2",  "setup_minutes": 24, "cycle_minutes_per_unit": 4.8, "labor_rate_override": 118.00 },
        { "sequence": 30, "work_center_ref": "wc_deburr", "setup_minutes": 3,  "cycle_minutes_per_unit": 1.4 },
        { "sequence": 40, "work_center_ref": "wc_qc",     "setup_minutes": 6,  "cycle_minutes_per_unit": 0.9 }
      ] },
    { "_ref": "r_adapter1200", "part_ref": "p_adapter1200", "name": "ADAPTER-1200 routing", "description": "Turn tube adapter both ends",
      "operations": [
        { "sequence": 10, "work_center_ref": "wc_saw",    "setup_minutes": 6,  "cycle_minutes_per_unit": 0.5 },
        { "sequence": 20, "work_center_ref": "wc_lathe2", "setup_minutes": 20, "cycle_minutes_per_unit": 3.4, "labor_rate_override": 92.00, "instructions": "Thread both ends, 1-1/16-12 UN." },
        { "sequence": 30, "work_center_ref": "wc_qc",     "setup_minutes": 4,  "cycle_minutes_per_unit": 0.4 }
      ] },
    { "_ref": "r_gear1000", "part_ref": "p_gear1000", "name": "GEAR-BLANK-1000 routing", "description": "Saw, turn, stress relieve",
      "operations": [
        { "sequence": 10, "work_center_ref": "wc_saw",    "setup_minutes": 8,  "cycle_minutes_per_unit": 0.9 },
        { "sequence": 20, "work_center_ref": "wc_lathe2", "setup_minutes": 24, "cycle_minutes_per_unit": 3.8, "labor_rate_override": 92.00, "instructions": "Leave 0.030 on the OD for the hobber." },
        { "sequence": 30, "work_center_ref": "wc_heat",   "external_unit_price": 3.40 },
        { "sequence": 40, "work_center_ref": "wc_qc",     "setup_minutes": 5,  "cycle_minutes_per_unit": 0.4 }
      ] },
    { "_ref": "r_plateassy", "part_ref": "p_plateassy", "name": "PLATE-ASSY-1500 routing", "description": "Install inserts and dowels into the plate blank",
      "operations": [
        { "sequence": 10, "work_center_ref": "wc_mill1", "setup_minutes": 16, "cycle_minutes_per_unit": 2.2, "labor_rate_override": 110.00, "instructions": "Tap 4x 1/4-20, ream 2x dowel holes." },
        { "sequence": 20, "work_center_ref": "wc_assy",  "setup_minutes": 8,  "cycle_minutes_per_unit": 3.0, "instructions": "Install 4x inserts, press 2x dowels." },
        { "sequence": 30, "work_center_ref": "wc_qc",    "setup_minutes": 5,  "cycle_minutes_per_unit": 0.6 }
      ] },
    { "_ref": "r_clamp1400", "part_ref": "p_clamp1400", "name": "CLAMP-1400 routing", "description": "Saw, turn, cross-drill, pin",
      "operations": [
        { "sequence": 10, "work_center_ref": "wc_saw",    "setup_minutes": 6,  "cycle_minutes_per_unit": 0.4 },
        { "sequence": 20, "work_center_ref": "wc_lathe1", "setup_minutes": 18, "cycle_minutes_per_unit": 2.1, "labor_rate_override": 95.00 },
        { "sequence": 30, "work_center_ref": "wc_mill3",  "setup_minutes": 12, "cycle_minutes_per_unit": 1.8, "instructions": "Cross-drill 0.125 for the spring pins." },
        { "sequence": 40, "work_center_ref": "wc_deburr", "setup_minutes": 2,  "cycle_minutes_per_unit": 0.6 }
      ] }
  ],

  "customers": [
    { "_ref": "c_apex", "name": "Apex Aerospace", "default_payment_terms": "Net 30", "default_fob_point": "Origin", "credit_status": "open",
      "contacts": [
        { "_ref": "ct_apex_buy", "name": "Morgan Lee", "role": "buyer", "email": "purchasing@apexaero.example.com", "phone": "316-555-0110", "is_primary": true },
        { "_ref": "ct_apex_ap",  "name": "Jordan Fields", "role": "accounts_payable", "email": "ap@apexaero.example.com", "phone": "316-555-0111", "is_billing_default": true },
        { "name": "Priya Raman", "role": "quality", "email": "quality@apexaero.example.com", "phone": "316-555-0112" }
      ],
      "addresses": [
        { "_ref": "ad_apex_bill", "address_line1": "3300 Airport Rd", "address_line2": "Building 4", "city": "Wichita", "state": "KS", "postal_code": "67209", "attention_to": "Accounts Payable", "default_billing": true },
        { "_ref": "ad_apex_ship", "address_line1": "3300 Airport Rd", "address_line2": "Dock 7", "city": "Wichita", "state": "KS", "postal_code": "67209", "attention_to": "Receiving", "default_shipping": true }
      ] },
    { "_ref": "c_helix", "name": "Helix Robotics", "default_payment_terms": "Net 45", "default_fob_point": "Destination", "credit_status": "open",
      "contacts": [
        { "_ref": "ct_helix_buy", "name": "Riley Park", "role": "buyer", "email": "po@helixrobotics.example.com", "phone": "412-555-0130", "is_primary": true },
        { "name": "Devin Oyelaran", "role": "engineering", "email": "eng@helixrobotics.example.com", "phone": "412-555-0131" }
      ],
      "addresses": [
        { "_ref": "ad_helix_bill", "address_line1": "50 Innovation Dr", "city": "Pittsburgh", "state": "PA", "postal_code": "15219", "default_billing": true },
        { "_ref": "ad_helix_ship", "address_line1": "50 Innovation Dr", "address_line2": "Receiving, Rear Entrance", "city": "Pittsburgh", "state": "PA", "postal_code": "15219", "default_shipping": true }
      ] },
    { "_ref": "c_north", "name": "Northstar Medical", "default_payment_terms": "Net 30", "default_fob_point": "Origin", "credit_status": "open",
      "contacts": [
        { "_ref": "ct_north_buy", "name": "Casey Singh", "role": "buyer", "email": "orders@northstarmed.example.com", "phone": "612-555-0155", "is_primary": true },
        { "name": "Alexis Trudeau", "role": "quality", "email": "qa@northstarmed.example.com", "phone": "612-555-0156" }
      ],
      "addresses": [
        { "_ref": "ad_north_bill", "address_line1": "1400 Riverside Ave", "city": "Minneapolis", "state": "MN", "postal_code": "55454", "default_billing": true, "default_shipping": true }
      ] },
    { "_ref": "c_cascade", "name": "Cascade Hydraulics", "default_payment_terms": "Net 30", "default_fob_point": "Origin", "credit_status": "open",
      "contacts": [
        { "_ref": "ct_cascade_buy", "name": "Sam Okafor", "role": "buyer", "email": "buying@cascadehyd.example.com", "phone": "503-555-0170", "is_primary": true }
      ],
      "addresses": [
        { "_ref": "ad_cascade_bill", "address_line1": "8800 SE Foster Rd", "city": "Portland", "state": "OR", "postal_code": "97266", "default_billing": true, "default_shipping": true }
      ] },
    { "_ref": "c_ironclad", "name": "Ironclad Defense Systems", "default_payment_terms": "Net 60", "default_fob_point": "Destination", "credit_status": "open",
      "contacts": [
        { "_ref": "ct_iron_buy", "name": "Terry Vaughn", "role": "buyer", "email": "procurement@ironcladds.example.com", "phone": "256-555-0182", "is_primary": true },
        { "name": "Noor Haddad", "role": "quality", "email": "qms@ironcladds.example.com", "phone": "256-555-0183" }
      ],
      "addresses": [
        { "_ref": "ad_iron_bill", "address_line1": "620 Redstone Blvd", "city": "Huntsville", "state": "AL", "postal_code": "35808", "attention_to": "AP Dept", "default_billing": true },
        { "_ref": "ad_iron_ship", "address_line1": "620 Redstone Blvd", "address_line2": "Gate 3 Receiving", "city": "Huntsville", "state": "AL", "postal_code": "35808", "default_shipping": true }
      ] },
    { "_ref": "c_lakeshore", "name": "Lakeshore Packaging Equipment", "default_payment_terms": "Net 30", "default_fob_point": "Origin", "credit_status": "open",
      "contacts": [
        { "_ref": "ct_lake_buy", "name": "Bev Ostrowski", "role": "buyer", "email": "purchasing@lakeshorepack.example.com", "phone": "414-555-0144", "is_primary": true }
      ],
      "addresses": [
        { "_ref": "ad_lake_bill", "address_line1": "2100 S 1st St", "city": "Milwaukee", "state": "WI", "postal_code": "53207", "default_billing": true, "default_shipping": true }
      ] },
    { "_ref": "c_vertex", "name": "Vertex Energy Controls", "default_payment_terms": "Net 30", "default_fob_point": "Origin", "credit_status": "open",
      "contacts": [
        { "_ref": "ct_vertex_buy", "name": "Ade Balogun", "role": "buyer", "email": "supply@vertexenergy.example.com", "phone": "713-555-0191", "is_primary": true }
      ],
      "addresses": [
        { "_ref": "ad_vertex_bill", "address_line1": "9010 Katy Fwy", "city": "Houston", "state": "TX", "postal_code": "77024", "default_billing": true, "default_shipping": true }
      ] },
    { "_ref": "c_summit", "name": "Summit Ag Equipment", "default_payment_terms": "Net 30", "default_fob_point": "Origin", "credit_status": "hold", "credit_hold_note": "Two invoices past 60 days. Release requires a check before the next release to production.",
      "contacts": [
        { "_ref": "ct_summit_buy", "name": "Dale Hoffmann", "role": "buyer", "email": "parts@summitag.example.com", "phone": "515-555-0128", "is_primary": true }
      ],
      "addresses": [
        { "_ref": "ad_summit_bill", "address_line1": "455 SE 30th St", "city": "Des Moines", "state": "IA", "postal_code": "50317", "default_billing": true, "default_shipping": true }
      ] }
  ],

  "quotes": [
    { "_ref": "q_apex_widgets", "customer_ref": "c_apex", "status": "active", "created_days_ago": 46, "expires_in_days": 14,
      "contact_ref": "ct_apex_buy", "billing_address_ref": "ad_apex_bill", "shipping_address_ref": "ad_apex_ship",
      "lead_time_text": "3-4 weeks ARO", "payment_terms": "Net 30", "fob_point": "Origin",
      "line_items": [
        { "part_ref": "p_widget100", "sequence": 10, "quantity": 25, "unit_price": 145.00, "markup_percent": 48, "base_cost_per_unit": 97.97 },
        { "part_ref": "p_pin200",    "sequence": 20, "quantity": 50, "unit_price": 38.50,  "markup_percent": 52, "base_cost_per_unit": 25.33 }
      ] },
    { "_ref": "q_helix_brackets", "customer_ref": "c_helix", "status": "active", "created_days_ago": 38, "expires_in_days": 22,
      "contact_ref": "ct_helix_buy", "billing_address_ref": "ad_helix_bill", "shipping_address_ref": "ad_helix_ship",
      "lead_time_text": "2 weeks ARO", "payment_terms": "Net 45", "fob_point": "Destination",
      "line_items": [
        { "part_ref": "p_bracket300", "sequence": 10, "quantity": 100, "unit_price": 62.00, "markup_percent": 42, "base_cost_per_unit": 43.66 }
      ] },
    { "_ref": "q_north_housings", "customer_ref": "c_north", "status": "active", "created_days_ago": 30, "expires_in_days": 30,
      "contact_ref": "ct_north_buy", "billing_address_ref": "ad_north_bill",
      "lead_time_text": "5 weeks ARO, first article at week 3", "payment_terms": "Net 30", "fob_point": "Origin",
      "line_items": [
        { "part_ref": "p_housing500", "sequence": 10, "quantity": 20, "unit_price": 218.00, "markup_percent": 44, "base_cost_per_unit": 151.39 },
        { "part_ref": "p_cover900",   "sequence": 20, "quantity": 20, "unit_price": 46.00 }
      ] },
    { "_ref": "q_cascade_manifolds", "customer_ref": "c_cascade", "status": "active", "created_days_ago": 21, "expires_in_days": 39,
      "contact_ref": "ct_cascade_buy", "billing_address_ref": "ad_cascade_bill",
      "lead_time_text": "6 weeks ARO", "payment_terms": "Net 30", "fob_point": "Origin",
      "line_items": [
        { "part_ref": "p_manifold600", "sequence": 10, "quantity": 10, "unit_price": 640.00, "markup_percent": 42, "base_cost_per_unit": 450.70 }
      ] },
    { "_ref": "q_iron_shafts", "customer_ref": "c_ironclad", "status": "active", "created_days_ago": 26, "expires_in_days": 34,
      "contact_ref": "ct_iron_buy", "billing_address_ref": "ad_iron_bill", "shipping_address_ref": "ad_iron_ship",
      "lead_time_text": "8 weeks ARO", "payment_terms": "Net 60", "fob_point": "Destination",
      "line_items": [
        { "part_ref": "p_shaft400", "sequence": 10, "quantity": 30, "unit_price": 196.00, "markup_percent": 45, "base_cost_per_unit": 135.17 },
        { "part_ref": "p_pin200",   "sequence": 20, "quantity": 60, "unit_price": 36.75 }
      ] },
    { "_ref": "q_lake_valves", "customer_ref": "c_lakeshore", "status": "active", "created_days_ago": 12, "expires_in_days": 48,
      "contact_ref": "ct_lake_buy", "billing_address_ref": "ad_lake_bill",
      "lead_time_text": "4 weeks ARO", "payment_terms": "Net 30", "fob_point": "Origin",
      "line_items": [
        { "part_ref": "p_valve1100", "sequence": 10, "quantity": 20, "unit_price": 284.00, "markup_percent": 44, "base_cost_per_unit": 197.22 },
        { "part_ref": "p_flange700", "sequence": 20, "quantity": 40, "unit_price": 52.00 },
        { "part_ref": "p_spacer800", "sequence": 30, "quantity": 100, "unit_price": 8.40 }
      ] },
    { "_ref": "q_vertex_adapters", "customer_ref": "c_vertex", "status": "active", "created_days_ago": 8, "expires_in_days": 52,
      "contact_ref": "ct_vertex_buy", "billing_address_ref": "ad_vertex_bill",
      "lead_time_text": "3 weeks ARO", "payment_terms": "Net 30", "fob_point": "Origin",
      "line_items": [
        { "part_ref": "p_adapter1200", "sequence": 10, "quantity": 50, "unit_price": 74.00, "markup_percent": 46, "base_cost_per_unit": 50.68 },
        { "part_ref": "p_bought_knob", "sequence": 20, "quantity": 100, "unit_price": 4.60 }
      ] },
    { "_ref": "q_lake_rollers", "customer_ref": "c_lakeshore", "status": "active", "created_days_ago": 4, "expires_in_days": 56,
      "contact_ref": "ct_lake_buy", "billing_address_ref": "ad_lake_bill",
      "lead_time_text": "Quoted 3 weeks, can pull in to 2 if released this week",
      "line_items": [
        { "part_ref": "p_roller1300", "sequence": 10, "quantity": 40, "unit_price": 88.00 },
        { "part_ref": "p_bought_handle", "sequence": 20, "quantity": 40, "unit_price": 9.45 }
      ] },
    { "_ref": "q_summit_clamps", "customer_ref": "c_summit", "status": "expired", "created_days_ago": 96, "expires_in_days": -6,
      "contact_ref": "ct_summit_buy", "billing_address_ref": "ad_summit_bill",
      "lead_time_text": "4 weeks ARO", "payment_terms": "Net 30",
      "line_items": [
        { "part_ref": "p_clamp1400", "sequence": 10, "quantity": 60, "unit_price": 41.00 }
      ] },
    { "_ref": "q_apex_widget150", "customer_ref": "c_apex", "status": "expired", "created_days_ago": 118, "expires_in_days": -28,
      "contact_ref": "ct_apex_buy", "billing_address_ref": "ad_apex_bill", "shipping_address_ref": "ad_apex_ship",
      "lead_time_text": "4 weeks ARO", "payment_terms": "Net 30",
      "line_items": [
        { "part_ref": "p_widget150", "sequence": 10, "quantity": 25, "unit_price": 162.00 }
      ] }
  ],

  "jobs": [
    { "_ref": "j_apex_widgets", "customer_ref": "c_apex", "quote_ref": "q_apex_widgets", "created_days_ago": 40, "due_in_days": 6,
      "customer_po_number": "APX-77412", "payment_terms": "Net 30", "freight_terms": "prepaid", "ship_via": "UPS Ground",
      "contact_ref": "ct_apex_buy", "billing_address_ref": "ad_apex_bill", "shipping_address_ref": "ad_apex_ship",
      "parts": [
        { "_ref": "jp_apex_widget", "part_ref": "p_widget100", "sequence": 10, "quantity": 25, "unit_price": 145.00, "routing_ref": "r_widget100",
          "operations": [
            { "sequence": 10, "completed_quantity": 25, "days_ago": 12, "author_index": 1, "note": "Ran clean, no tool changes." },
            { "sequence": 20, "completed_quantity": 25, "days_ago": 9,  "author_index": 2 },
            { "sequence": 30, "status": "completed", "days_ago": 4 },
            { "sequence": 40, "completed_quantity": 18, "days_ago": 1, "author_index": 1 },
            { "sequence": 50, "completed_quantity": 10, "days_ago": 1, "author_index": 3, "note": "First ten through the CMM, released to ship." }
          ] },
        { "_ref": "jp_apex_pin", "part_ref": "p_pin200", "sequence": 20, "quantity": 50, "unit_price": 38.50, "routing_ref": "r_pin200",
          "operations": [
            { "sequence": 10, "completed_quantity": 50, "days_ago": 11, "author_index": 2 },
            { "sequence": 20, "status": "sent", "days_ago": 3 }
          ] }
      ] },

    { "_ref": "j_helix_brackets", "customer_ref": "c_helix", "quote_ref": "q_helix_brackets", "created_days_ago": 34, "due_in_days": -2,
      "customer_po_number": "HLX-2026-0451", "payment_terms": "Net 45", "freight_terms": "collect", "ship_via": "Customer carrier",
      "is_hot": true, "shipping_instructions": "Call Riley 24 hr before the truck.",
      "contact_ref": "ct_helix_buy", "billing_address_ref": "ad_helix_bill", "shipping_address_ref": "ad_helix_ship",
      "parts": [
        { "_ref": "jp_helix_bracket", "part_ref": "p_bracket300", "sequence": 10, "quantity": 100, "unit_price": 62.00, "routing_ref": "r_bracket300",
          "operations": [
            { "sequence": 10, "completed_quantity": 100, "days_ago": 16, "author_index": 1 },
            { "sequence": 20, "status": "completed", "days_ago": 6 },
            { "sequence": 30, "completed_quantity": 62, "days_ago": 2, "author_index": 2, "note": "Inserts running slow, driver keeps stalling." }
          ] }
      ] },

    { "_ref": "j_north_housings", "customer_ref": "c_north", "quote_ref": "q_north_housings", "created_days_ago": 24, "due_in_days": 18,
      "customer_po_number": "NSM-90233", "payment_terms": "Net 30", "freight_terms": "prepaid", "ship_via": "FedEx Ground",
      "contact_ref": "ct_north_buy", "billing_address_ref": "ad_north_bill", "shipping_address_ref": "ad_north_bill",
      "parts": [
        { "_ref": "jp_north_housing", "part_ref": "p_housing500", "sequence": 10, "quantity": 20, "unit_price": 218.00, "routing_ref": "r_housing500",
          "operations": [
            { "sequence": 10, "completed_quantity": 20, "days_ago": 8, "author_index": 1 },
            { "sequence": 20, "completed_quantity": 12, "days_ago": 2, "author_index": 3 }
          ] },
        { "_ref": "jp_north_cover", "part_ref": "p_cover900", "sequence": 20, "quantity": 20, "unit_price": 46.00, "routing_ref": "r_cover900",
          "operations": [
            { "sequence": 10, "completed_quantity": 20, "days_ago": 5, "author_index": 2 }
          ] }
      ] },

    { "_ref": "j_cascade_manifolds", "customer_ref": "c_cascade", "quote_ref": "q_cascade_manifolds", "created_days_ago": 16, "due_in_days": 26,
      "customer_po_number": "CH-5580", "payment_terms": "Net 30", "freight_terms": "prepaid", "ship_via": "UPS Ground",
      "contact_ref": "ct_cascade_buy", "billing_address_ref": "ad_cascade_bill", "shipping_address_ref": "ad_cascade_bill",
      "parts": [
        { "_ref": "jp_cascade_manifold", "part_ref": "p_manifold600", "sequence": 10, "quantity": 10, "unit_price": 640.00, "routing_ref": "r_manifold600",
          "operations": [
            { "sequence": 10, "completed_quantity": 4, "days_ago": 1, "author_index": 3, "note": "Two hours a piece on the cross-drills. Slower than quoted." }
          ] }
      ] },

    { "_ref": "j_iron_shafts", "customer_ref": "c_ironclad", "quote_ref": "q_iron_shafts", "created_days_ago": 20, "due_in_days": 34,
      "customer_po_number": "ICD-4400-77", "payment_terms": "Net 60", "freight_terms": "third_party", "ship_via": "Customer freight account",
      "contact_ref": "ct_iron_buy", "billing_address_ref": "ad_iron_bill", "shipping_address_ref": "ad_iron_ship",
      "parts": [
        { "_ref": "jp_iron_shaft", "part_ref": "p_shaft400", "sequence": 10, "quantity": 30, "unit_price": 196.00, "routing_ref": "r_shaft400",
          "operations": [
            { "sequence": 10, "completed_quantity": 30, "days_ago": 9, "author_index": 1 },
            { "sequence": 20, "status": "sent", "days_ago": 5 }
          ] },
        { "_ref": "jp_iron_pin", "part_ref": "p_pin200", "sequence": 20, "quantity": 60, "unit_price": 36.75, "routing_ref": "r_pin200" }
      ] },

    { "_ref": "j_lake_valves", "customer_ref": "c_lakeshore", "quote_ref": "q_lake_valves", "created_days_ago": 9, "due_in_days": 21,
      "customer_po_number": "LPE-30119", "payment_terms": "Net 30", "freight_terms": "prepaid", "ship_via": "UPS Ground",
      "contact_ref": "ct_lake_buy", "billing_address_ref": "ad_lake_bill", "shipping_address_ref": "ad_lake_bill",
      "parts": [
        { "_ref": "jp_lake_valve",  "part_ref": "p_valve1100", "sequence": 10, "quantity": 20, "unit_price": 284.00, "routing_ref": "r_valve1100" },
        { "_ref": "jp_lake_flange", "part_ref": "p_flange700", "sequence": 20, "quantity": 40, "unit_price": 52.00, "routing_ref": "r_flange700",
          "operations": [ { "sequence": 10, "completed_quantity": 40, "days_ago": 2, "author_index": 2 } ] },
        { "_ref": "jp_lake_spacer", "part_ref": "p_spacer800", "sequence": 30, "quantity": 100, "unit_price": 8.40, "routing_ref": "r_spacer800" }
      ] },

    { "_ref": "j_vertex_adapters", "customer_ref": "c_vertex", "quote_ref": "q_vertex_adapters", "created_days_ago": 5, "due_in_days": 16,
      "customer_po_number": "VEC-8891", "payment_terms": "Net 30", "freight_terms": "prepaid", "ship_via": "FedEx Ground",
      "contact_ref": "ct_vertex_buy", "billing_address_ref": "ad_vertex_bill", "shipping_address_ref": "ad_vertex_bill",
      "parts": [
        { "_ref": "jp_vertex_adapter", "part_ref": "p_adapter1200", "sequence": 10, "quantity": 50, "unit_price": 74.00, "routing_ref": "r_adapter1200" },
        { "_ref": "jp_vertex_knob", "part_ref": "p_bought_knob", "source": "bought", "sequence": 20, "quantity": 100, "unit_price": 4.60 }
      ] },

    { "_ref": "j_apex_repeat", "customer_ref": "c_apex", "created_days_ago": 72, "due_in_days": -30,
      "customer_po_number": "APX-76980", "payment_terms": "Net 30", "freight_terms": "prepaid", "ship_via": "UPS Ground",
      "contact_ref": "ct_apex_buy", "billing_address_ref": "ad_apex_bill", "shipping_address_ref": "ad_apex_ship",
      "parts": [
        { "_ref": "jp_apex_repeat_widget", "part_ref": "p_widget100", "sequence": 10, "quantity": 40, "unit_price": 138.00, "routing_ref": "r_widget100",
          "operations": [
            { "sequence": 10, "completed_quantity": 40, "days_ago": 60, "author_index": 1 },
            { "sequence": 20, "completed_quantity": 40, "days_ago": 56, "author_index": 2 },
            { "sequence": 30, "status": "completed", "days_ago": 50 },
            { "sequence": 40, "completed_quantity": 40, "days_ago": 46, "author_index": 1 },
            { "sequence": 50, "completed_quantity": 40, "days_ago": 44, "author_index": 3 }
          ] }
      ] },

    { "_ref": "j_helix_repeat", "customer_ref": "c_helix", "created_days_ago": 64, "due_in_days": -24,
      "customer_po_number": "HLX-2026-0388", "payment_terms": "Net 45", "freight_terms": "collect",
      "contact_ref": "ct_helix_buy", "billing_address_ref": "ad_helix_bill", "shipping_address_ref": "ad_helix_ship",
      "parts": [
        { "_ref": "jp_helix_repeat_bracket", "part_ref": "p_bracket350", "sequence": 10, "quantity": 60, "unit_price": 71.00, "routing_ref": "r_bracket350",
          "operations": [
            { "sequence": 10, "completed_quantity": 60, "days_ago": 55, "author_index": 2 },
            { "sequence": 20, "completed_quantity": 60, "days_ago": 51, "author_index": 1 },
            { "sequence": 30, "status": "completed", "days_ago": 45 },
            { "sequence": 40, "completed_quantity": 60, "days_ago": 42, "author_index": 3 }
          ] }
      ] },

    { "_ref": "j_north_repeat", "customer_ref": "c_north", "created_days_ago": 55, "due_in_days": -18,
      "customer_po_number": "NSM-89877", "payment_terms": "Net 30", "freight_terms": "prepaid",
      "contact_ref": "ct_north_buy", "billing_address_ref": "ad_north_bill", "shipping_address_ref": "ad_north_bill",
      "parts": [
        { "_ref": "jp_north_repeat_flange", "part_ref": "p_flange700", "sequence": 10, "quantity": 40, "unit_price": 54.00, "routing_ref": "r_flange700",
          "operations": [
            { "sequence": 10, "completed_quantity": 40, "days_ago": 48, "author_index": 1 },
            { "sequence": 20, "status": "completed", "days_ago": 42 },
            { "sequence": 30, "completed_quantity": 40, "days_ago": 40, "author_index": 2 }
          ] }
      ] },

    { "_ref": "j_cascade_repeat", "customer_ref": "c_cascade", "created_days_ago": 47, "due_in_days": -12,
      "customer_po_number": "CH-5402", "payment_terms": "Net 30", "freight_terms": "prepaid",
      "contact_ref": "ct_cascade_buy", "billing_address_ref": "ad_cascade_bill", "shipping_address_ref": "ad_cascade_bill",
      "parts": [
        { "_ref": "jp_cascade_repeat_spacer", "part_ref": "p_spacer800", "sequence": 10, "quantity": 200, "unit_price": 7.90, "routing_ref": "r_spacer800",
          "operations": [ { "sequence": 10, "completed_quantity": 200, "days_ago": 40, "author_index": 3 } ] },
        { "_ref": "jp_cascade_repeat_cover", "part_ref": "p_cover900", "sequence": 20, "quantity": 30, "unit_price": 44.00, "routing_ref": "r_cover900",
          "operations": [
            { "sequence": 10, "completed_quantity": 30, "days_ago": 39, "author_index": 1 },
            { "sequence": 20, "status": "completed", "days_ago": 34 },
            { "sequence": 30, "completed_quantity": 30, "days_ago": 32, "author_index": 2 }
          ] }
      ] },

    { "_ref": "j_lake_rollers", "customer_ref": "c_lakeshore", "created_days_ago": 3, "due_in_days": 24,
      "customer_po_number": "LPE-30204", "payment_terms": "Net 30", "freight_terms": "prepaid",
      "contact_ref": "ct_lake_buy", "billing_address_ref": "ad_lake_bill", "shipping_address_ref": "ad_lake_bill",
      "parts": [
        { "_ref": "jp_lake_handle", "part_ref": "p_bought_handle", "source": "bought", "sequence": 10, "quantity": 40, "unit_price": 9.45 }
      ] },

    { "_ref": "j_vertex_plates", "customer_ref": "c_vertex", "created_days_ago": 2, "due_in_days": 30,
      "customer_po_number": "VEC-8903", "payment_terms": "Net 30", "freight_terms": "prepaid",
      "contact_ref": "ct_vertex_buy", "billing_address_ref": "ad_vertex_bill", "shipping_address_ref": "ad_vertex_bill",
      "parts": [
        { "_ref": "jp_vertex_plate", "part_ref": "p_sub_plate", "sequence": 10, "quantity": 40, "unit_price": 39.00, "routing_ref": "r_sub_plate" }
      ] },

    { "_ref": "j_iron_widget150", "customer_ref": "c_ironclad", "created_days_ago": 11, "due_in_days": 9, "is_hot": true,
      "customer_po_number": "ICD-4400-91", "payment_terms": "Net 60", "freight_terms": "third_party",
      "shipping_instructions": "Certs required with shipment. No partials.",
      "contact_ref": "ct_iron_buy", "billing_address_ref": "ad_iron_bill", "shipping_address_ref": "ad_iron_ship",
      "parts": [
        { "_ref": "jp_iron_widget150", "part_ref": "p_widget150", "sequence": 10, "quantity": 25, "unit_price": 162.00, "routing_ref": "r_widget150",
          "operations": [
            { "sequence": 10, "completed_quantity": 25, "days_ago": 6, "author_index": 2 },
            { "sequence": 20, "completed_quantity": 11, "days_ago": 1, "author_index": 1, "note": "Fixture is walking, re-indicating every 4 parts." }
          ] }
      ] },

    { "_ref": "j_summit_clamps", "customer_ref": "c_summit", "created_days_ago": 6, "due_in_days": 20,
      "customer_po_number": "SAG-1174", "payment_terms": "Net 30",
      "contact_ref": "ct_summit_buy", "billing_address_ref": "ad_summit_bill", "shipping_address_ref": "ad_summit_bill",
      "parts": [
        { "_ref": "jp_summit_clamp", "part_ref": "p_clamp1400", "sequence": 10, "quantity": 60, "unit_price": 41.00, "routing_ref": "r_clamp1400" }
      ] },

    { "_ref": "j_apex_gears", "customer_ref": "c_apex", "created_days_ago": 13, "due_in_days": 11,
      "customer_po_number": "APX-77501", "payment_terms": "Net 30", "freight_terms": "prepaid",
      "contact_ref": "ct_apex_buy", "billing_address_ref": "ad_apex_bill", "shipping_address_ref": "ad_apex_ship",
      "parts": [
        { "_ref": "jp_apex_gear", "part_ref": "p_gear1000", "sequence": 10, "quantity": 25, "unit_price": 96.00, "routing_ref": "r_gear1000" },
        { "_ref": "jp_apex_plateassy", "part_ref": "p_plateassy", "sequence": 20, "quantity": 25, "unit_price": 118.00, "routing_ref": "r_plateassy" }
      ] }
  ],

  "shipments": [
    { "_ref": "s_apex_repeat_1", "job_ref": "j_apex_repeat", "customer_ref": "c_apex", "shipping_address_ref": "ad_apex_ship",
      "ship_days_ago": 42, "carrier": "UPS", "shipping_method": "shipment", "freight_terms": "prepaid",
      "line_items": [ { "job_part_ref": "jp_apex_repeat_widget", "quantity": 40 } ] },
    { "_ref": "s_helix_repeat_1", "job_ref": "j_helix_repeat", "customer_ref": "c_helix", "shipping_address_ref": "ad_helix_ship",
      "ship_days_ago": 40, "carrier": "Customer carrier", "shipping_method": "shipment", "freight_terms": "collect",
      "line_items": [ { "job_part_ref": "jp_helix_repeat_bracket", "quantity": 60 } ] },
    { "_ref": "s_north_repeat_1", "job_ref": "j_north_repeat", "customer_ref": "c_north", "shipping_address_ref": "ad_north_bill",
      "ship_days_ago": 38, "carrier": "FedEx", "shipping_method": "shipment", "freight_terms": "prepaid",
      "line_items": [ { "job_part_ref": "jp_north_repeat_flange", "quantity": 40 } ] },
    { "_ref": "s_cascade_repeat_1", "job_ref": "j_cascade_repeat", "customer_ref": "c_cascade", "shipping_address_ref": "ad_cascade_bill",
      "ship_days_ago": 36, "carrier": "UPS", "shipping_method": "shipment", "freight_terms": "prepaid",
      "line_items": [ { "job_part_ref": "jp_cascade_repeat_spacer", "quantity": 200 } ] },
    { "_ref": "s_cascade_repeat_2", "job_ref": "j_cascade_repeat", "customer_ref": "c_cascade", "shipping_address_ref": "ad_cascade_bill",
      "ship_days_ago": 30, "carrier": "UPS", "shipping_method": "shipment", "freight_terms": "prepaid",
      "line_items": [ { "job_part_ref": "jp_cascade_repeat_cover", "quantity": 18 } ] },
    { "_ref": "s_apex_partial", "job_ref": "j_apex_widgets", "customer_ref": "c_apex", "shipping_address_ref": "ad_apex_ship",
      "ship_days_ago": 1, "carrier": "UPS", "shipping_method": "shipment", "freight_terms": "prepaid",
      "line_items": [ { "job_part_ref": "jp_apex_widget", "quantity": 10 } ] }
  ],

  "notes": [
    { "subject_kind": "job", "job_ref": "j_apex_widgets", "job_part_ref": "jp_apex_widget", "operation_sequence": 20,
      "body": "Print calls out 0.9995/0.9990 on the bore. Anything over 0.9993 and the o-ring will not seat — check every fifth part.",
      "days_ago": 10, "author_index": 1, "reactions": [ { "kind": "helpful", "reactor_index": 2 }, { "kind": "helpful", "reactor_index": 0 } ] },
    { "subject_kind": "job", "job_ref": "j_apex_widgets", "job_part_ref": "jp_apex_widget", "operation_sequence": 40,
      "body": "Ten went out on the first truck, the rest go when assembly finishes. Morgan knows.", "days_ago": 1, "author_index": 0 },
    { "subject_kind": "job", "job_ref": "j_apex_widgets",
      "body": "Apex moved the need-by in a week. Not a new PO, just a phone call — confirmed with Morgan on the 2nd.", "days_ago": 5, "author_index": 0 },
    { "subject_kind": "job", "job_ref": "j_helix_brackets", "job_part_ref": "jp_helix_bracket", "operation_sequence": 30,
      "body": "Insert driver keeps stalling on the second hole. Slower feed fixes it. Roughly 3 minutes a part instead of 1.",
      "days_ago": 2, "author_index": 2, "reactions": [ { "kind": "confirmed", "reactor_index": 1 } ] },
    { "subject_kind": "job", "job_ref": "j_helix_brackets",
      "body": "This one is late and Riley has called twice. Anodize came back on time, we lost the days at assembly.", "days_ago": 1, "author_index": 0 },
    { "subject_kind": "job", "job_ref": "j_cascade_manifolds", "job_part_ref": "jp_cascade_manifold", "operation_sequence": 10,
      "body": "Cross-drills are taking about two hours a piece. We quoted 22 minutes of cycle. Worth a look before the next order.",
      "days_ago": 1, "author_index": 3, "reactions": [ { "kind": "confirmed", "reactor_index": 0 } ] },
    { "subject_kind": "job", "job_ref": "j_iron_widget150", "job_part_ref": "jp_iron_widget150", "operation_sequence": 20,
      "body": "Fixture is walking. Re-indicating every four parts until we get a proper stop made.", "days_ago": 1, "author_index": 1 },
    { "subject_kind": "job", "job_ref": "j_iron_widget150",
      "body": "Ironclad needs certs in the box. No partial shipments on this PO.", "days_ago": 10, "author_index": 0 },
    { "subject_kind": "job", "job_ref": "j_north_housings", "job_part_ref": "jp_north_housing", "operation_sequence": 20,
      "body": "Groove depth is the whole part on these. Every one gets scoped, not a sample.", "days_ago": 3, "author_index": 3 },
    { "subject_kind": "job", "job_ref": "j_summit_clamps",
      "body": "Summit is on credit hold. Do not release to the floor until accounting clears the check.", "days_ago": 6, "author_index": 0,
      "reactions": [ { "kind": "helpful", "reactor_index": 1 } ] },
    { "subject_kind": "job", "job_ref": "j_lake_valves", "job_part_ref": "jp_lake_flange", "operation_sequence": 10,
      "body": "304 work-hardens fast. Keep the feed up and do not dwell.", "days_ago": 2, "author_index": 2 },
    { "subject_kind": "job", "job_ref": "j_apex_repeat",
      "body": "Shipped complete on the 40. Clean run start to finish — use this one as the reference next time we quote WIDGET-100.",
      "days_ago": 42, "author_index": 0, "reactions": [ { "kind": "helpful", "reactor_index": 2 } ] },

    { "subject_kind": "part", "part_ref": "p_widget100",
      "body": "Standard setup lives in the blue binder, tab 4. Soft jaws are in the drawer under the Mazak, labelled W-100.",
      "days_ago": 30, "author_index": 1, "reactions": [ { "kind": "helpful", "reactor_index": 2 }, { "kind": "helpful", "reactor_index": 3 } ] },
    { "subject_kind": "part", "part_ref": "p_widget100",
      "body": "Anodize masks the bore. If it comes back with colour in the bore it is a reject, not a rework.", "days_ago": 22, "author_index": 3 },
    { "subject_kind": "part", "part_ref": "p_manifold600",
      "body": "Deburring the port intersections is most of the labour on this part. Scope every one, a missed burr comes back as a warranty claim.",
      "days_ago": 18, "author_index": 3, "reactions": [ { "kind": "confirmed", "reactor_index": 1 } ] },
    { "subject_kind": "part", "part_ref": "p_spacer800",
      "body": "Run Delrin dry. Coolant swells it and the OD reads 0.002 big an hour later.", "days_ago": 26, "author_index": 2,
      "reactions": [ { "kind": "helpful", "reactor_index": 0 } ] },
    { "subject_kind": "part", "part_ref": "p_pin200",
      "body": "EDM keyway goes out before heat treat, never after. We learned that the expensive way in March.", "days_ago": 35, "author_index": 1 },
    { "subject_kind": "part", "part_ref": "p_bar4140",
      "body": "Last two bundles from Midwest ran hard on the saw. Blade life is about half what we normally see.", "days_ago": 14, "author_index": 2 },
    { "subject_kind": "part", "part_ref": "p_housing500",
      "body": "Fixture for op 2 is in the rack by the VF-4. It is marked H-500 rev B — rev A is scrapped, do not use it.", "days_ago": 20, "author_index": 1 },
    { "subject_kind": "part", "part_ref": "p_valve1100",
      "body": "303 chips nest badly in the sub-spindle. Peck the deep hole or you will be picking it out.", "days_ago": 9, "author_index": 2 },
    { "subject_kind": "part", "part_ref": "p_sub_blank",
      "body": "We keep about 60 of these on Shelf 1-A. Below 20 is when we start a new batch of 25.", "days_ago": 45, "author_index": 0 },

    { "_ref": "n_mill1_noticed", "subject_kind": "work_center", "work_center_ref": "wc_mill1", "maintenance_kind": "noticed",
      "body": "Way oil is weeping at the front of the X axis. Small puddle by the end of the shift.", "days_ago": 16, "author_index": 2,
      "reactions": [ { "kind": "confirmed", "reactor_index": 1 } ] },
    { "subject_kind": "work_center", "work_center_ref": "wc_mill1", "maintenance_kind": "repaired", "resolves_ref": "n_mill1_noticed",
      "body": "Replaced the X-axis way wiper and topped up the lube reservoir. Dry after two days of running.", "days_ago": 12, "author_index": 1 },
    { "_ref": "n_lathe1_noticed", "subject_kind": "work_center", "work_center_ref": "wc_lathe1", "maintenance_kind": "noticed",
      "body": "Chip conveyor jams about once a shift on long stringy stock. Clears by hand.", "days_ago": 8, "author_index": 1 },
    { "subject_kind": "work_center", "work_center_ref": "wc_lathe2", "maintenance_kind": "cleaned",
      "body": "Pulled and cleaned the coolant tank. It was well past due.", "days_ago": 5, "author_index": 2 },
    { "subject_kind": "work_center", "work_center_ref": "wc_mill2", "maintenance_kind": "adjusted",
      "body": "Re-tuned the 4th axis brake pressure. Was slipping on heavy cuts in 7075.", "days_ago": 11, "author_index": 3 },
    { "subject_kind": "work_center", "work_center_ref": "wc_saw", "maintenance_kind": "replaced",
      "body": "New blade fitted. Old one had maybe 40 cuts left in it, not worth the risk on the 4140.", "days_ago": 3, "author_index": 2 },
    { "subject_kind": "work_center", "work_center_ref": "wc_qc",
      "body": "CMM calibration is due next month. Certificate is in the office file, expires on the 12th.", "days_ago": 7, "author_index": 3,
      "reactions": [ { "kind": "helpful", "reactor_index": 0 } ] },
    { "subject_kind": "work_center", "work_center_ref": "wc_mill3",
      "body": "Bridgeport is the one to use for one-off fixtures. Do not tie up the VMCs for a soft jaw.", "days_ago": 28, "author_index": 0 }
  ],

  "inventory_transactions": [
    { "part_ref": "p_bar1018_1",   "type": "addition",   "quantity": 576, "location_ref": "loc_raw_a", "days_ago": 34, "author_index": 0, "notes": "Received 4 sticks, PO to Midwest Steel." },
    { "part_ref": "p_bar1018_1",   "type": "depletion",  "quantity": 46,  "location_ref": "loc_raw_a", "days_ago": 12, "author_index": 1, "job_ref": "j_apex_widgets", "notes": "Cut blanks for WIDGET-100." },
    { "part_ref": "p_bar4140",     "type": "addition",   "quantity": 432, "location_ref": "loc_raw_b", "days_ago": 30, "author_index": 0 },
    { "part_ref": "p_plate6061_25","type": "addition",   "quantity": 1728,"location_ref": "loc_raw_c", "days_ago": 28, "author_index": 0, "notes": "One full sheet." },
    { "part_ref": "p_plate6061_25","type": "depletion",  "quantity": 1400,"location_ref": "loc_raw_c", "days_ago": 16, "author_index": 2, "job_ref": "j_helix_brackets", "notes": "Bracket blanks, 100 off." },
    { "part_ref": "p_plate7075",   "type": "addition",   "quantity": 864, "location_ref": "loc_raw_c", "days_ago": 22, "author_index": 0 },
    { "part_ref": "p_sub_blank",   "type": "addition",   "quantity": 25,  "location_ref": "loc_shelf1_a", "days_ago": 20, "author_index": 1, "notes": "Batch of 25 off the Mazak." },
    { "part_ref": "p_sub_blank",   "type": "depletion",  "quantity": 25,  "location_ref": "loc_shelf1_a", "days_ago": 12, "author_index": 1, "job_ref": "j_apex_widgets" },
    { "part_ref": "p_sub_bracket", "type": "addition",   "quantity": 50,  "location_ref": "loc_shelf1_a", "days_ago": 18, "author_index": 2 },
    { "part_ref": "p_sub_shaft",   "type": "addition",   "quantity": 30,  "location_ref": "loc_shelf1_b", "days_ago": 15, "author_index": 1 },
    { "part_ref": "p_sub_shaft",   "type": "depletion",  "quantity": 30,  "location_ref": "loc_shelf1_b", "days_ago": 9,  "author_index": 1, "job_ref": "j_iron_shafts" },
    { "part_ref": "p_shcs14",      "type": "addition",   "quantity": 1000,"location_ref": "loc_hw_1", "days_ago": 26, "author_index": 0, "notes": "Box of 1000, Fastener Depot." },
    { "part_ref": "p_shcs14",      "type": "depletion",  "quantity": 100, "location_ref": "loc_hw_1", "days_ago": 2,  "author_index": 1, "job_ref": "j_apex_widgets", "notes": "4 per widget, 25 widgets." },
    { "part_ref": "p_oring",       "type": "depletion",  "quantity": 25,  "location_ref": "loc_hw_2", "days_ago": 2,  "author_index": 1, "job_ref": "j_apex_widgets" },
    { "part_ref": "p_insert",      "type": "depletion",  "quantity": 124, "location_ref": "loc_hw_3", "days_ago": 2,  "author_index": 2, "job_ref": "j_helix_brackets", "notes": "2 per bracket, 62 done." },
    { "part_ref": "p_bushing",     "type": "addition",   "quantity": 240, "location_ref": "loc_hw_2", "days_ago": 24, "author_index": 0 },
    { "part_ref": "p_endmill",     "type": "depletion",  "quantity": 2,   "location_ref": "loc_crib", "days_ago": 6,  "author_index": 3, "notes": "Two chipped on the 7075 manifold." },
    { "part_ref": "p_coolant",     "type": "depletion",  "quantity": 5,   "location_ref": "loc_crib", "days_ago": 5,  "author_index": 2, "notes": "Refilled the ST-30 tank." },
    { "part_ref": "p_bar303",      "type": "addition",   "quantity": 288, "location_ref": "loc_raw_b", "days_ago": 19, "author_index": 0 },
    { "part_ref": "p_bought_knob", "type": "addition",   "quantity": 120, "location_ref": "loc_shelf2_a", "days_ago": 7, "author_index": 0, "notes": "Stocked for the Vertex order." },
    { "part_ref": "p_sub_blank",   "type": "adjustment", "quantity": 2,   "location_ref": "loc_shelf1_a", "days_ago": 4, "author_index": 1, "notes": "Cycle count found two extra behind the bin." }
  ]
}
$json$::jsonb)
ON CONFLICT (name, version) DO UPDATE
   SET is_active = EXCLUDED.is_active,
       template_data = EXCLUDED.template_data;
