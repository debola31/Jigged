-- ═══════════════════════════════════════════════════════════════════════════════
-- A vendor gets many addresses, the way a customer already does.
-- ═══════════════════════════════════════════════════════════════════════════════
-- A vendor's address lived in six columns on the row, so a vendor had exactly
-- one. That is wrong for the same reason it was wrong for customers: a plater
-- with two plants, or a remit-to that differs from the dock you ship parts to,
-- has no way to say so.
--
-- Nothing consumes a second address YET, and the model is built anyway — the
-- shape is what stops a shop entering the wrong thing in the meantime.
--
-- ── One default flag, not two ───────────────────────────────────────────────
--
-- customer_addresses carries `default_billing` AND `default_shipping`, because
-- an invoice and a pallet genuinely go to different places. The equivalent
-- split for a vendor would be "where we send parts" vs "where we send payment",
-- and nothing in the product distinguishes those today. Shipping two flags now
-- would be inventing two use cases to hold one fact, and a flag nothing reads
-- is a flag nobody keeps true. One `is_default` until a second use exists.

CREATE TABLE public.vendor_addresses (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_id     uuid NOT NULL REFERENCES public.vendors(id) ON DELETE CASCADE,
    address_line1 text,
    address_line2 text,
    city          text,
    state         text,
    postal_code   text,
    country       text DEFAULT 'USA'::text,
    -- The ATTN: line, same as customers. A vendor's dock often needs a person
    -- or a department on the box.
    attention_to  text,
    is_default    boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.vendor_addresses IS
  'Postal addresses for a vendor, 1-to-many, ON DELETE CASCADE like vendor_contacts. Replaces the six address columns that used to sit on the vendors row. Hard-deleted rather than archived, matching customer_addresses: an address is a field of its parent, not a document anything references by id.';

COMMENT ON COLUMN public.vendor_addresses.is_default IS
  'True for the one address the UI offers first. At most one row per vendor can be true (idx_vendor_addresses_one_default). Deliberately ONE flag, not the default_billing/default_shipping pair customers carry — nothing in the product yet distinguishes where parts go from where payment goes, and a flag nothing reads is a flag nobody keeps true.';

CREATE INDEX idx_vendor_addresses_vendor ON public.vendor_addresses (vendor_id);

-- At most one default per vendor, enforced rather than promised — the lesson of
-- 20260802013846, where customer_addresses' column comments cited two indexes
-- that had never existed.
CREATE UNIQUE INDEX idx_vendor_addresses_one_default
    ON public.vendor_addresses (vendor_id)
    WHERE is_default;

CREATE TRIGGER vendor_addresses_updated_at
    BEFORE UPDATE ON public.vendor_addresses
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ═══════════════════════════════════════════════════════════════════════════════
-- GRANTS, RLS, BILLING GATE
-- ═══════════════════════════════════════════════════════════════════════════════
-- Nothing in public is exposed to the Data API automatically. anon needs
-- nothing: a vendor's addresses are tenant data behind a login.

GRANT SELECT, INSERT, UPDATE, DELETE ON public.vendor_addresses TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vendor_addresses TO service_role;
GRANT SELECT                          ON public.vendor_addresses TO jigged_ai_readonly;

ALTER TABLE public.vendor_addresses ENABLE ROW LEVEL SECURITY;

-- Scoped through the parent, exactly like vendor_contacts and
-- customer_addresses: this table has no company_id of its own, and adding one
-- would be a second place for the same fact to live.
CREATE POLICY "Company members manage their vendor addresses" ON public.vendor_addresses
    USING (
      EXISTS (
        SELECT 1 FROM public.vendors v
         WHERE v.id = vendor_addresses.vendor_id
           AND v.company_id IN (SELECT public.get_user_company_ids())
      )
    );

CREATE POLICY ai_readonly_select ON public.vendor_addresses
    FOR SELECT TO jigged_ai_readonly
    USING (
      EXISTS (
        SELECT 1 FROM public.vendors v
         WHERE v.id = vendor_addresses.vendor_id
           AND v.company_id = (current_setting('jigged.company_id', true))::uuid
      )
    );

-- NOT gated by apply_billing_write_gate, and the reason is the same one that
-- exempts vendor_contacts and customer_addresses: the gate keys on a
-- company_id column this table does not have. The write is still gated in
-- practice — a row is unreachable without its vendor, and `vendors` IS gated —
-- so a lapsed shop cannot create the parent to hang one on.

-- ═══════════════════════════════════════════════════════════════════════════════
-- MOVE THE EXISTING ADDRESS, THEN DROP THE COLUMNS
-- ═══════════════════════════════════════════════════════════════════════════════
-- Every vendor that has ANY address data gets exactly one row, marked default.
-- A vendor with six NULLs gets nothing rather than a row of blanks, which would
-- read in the UI as "an address exists" and be worse than the empty state.

INSERT INTO public.vendor_addresses
    (vendor_id, address_line1, address_line2, city, state, postal_code, country, is_default)
SELECT id, address_line1, address_line2, city, state, postal_code, country, true
  FROM public.vendors
 WHERE COALESCE(address_line1, '') <> ''
    OR COALESCE(address_line2, '') <> ''
    OR COALESCE(city, '')          <> ''
    OR COALESCE(state, '')         <> ''
    OR COALESCE(postal_code, '')   <> '';

-- `country` alone is NOT enough to qualify above: it defaults to 'USA' on every
-- vendor row, so including it would give every vendor in the system an address
-- consisting of the word USA.

DO $check$
DECLARE
    v_expected bigint;
    v_actual   bigint;
BEGIN
    SELECT count(*) INTO v_expected
      FROM public.vendors
     WHERE COALESCE(address_line1, '') <> ''
        OR COALESCE(address_line2, '') <> ''
        OR COALESCE(city, '')          <> ''
        OR COALESCE(state, '')         <> ''
        OR COALESCE(postal_code, '')   <> '';

    SELECT count(*) INTO v_actual FROM public.vendor_addresses;

    IF v_actual <> v_expected THEN
        RAISE EXCEPTION
            'vendor address backfill lost rows: expected %, moved %. Refusing to drop the source columns.',
            v_expected, v_actual
            USING ERRCODE = 'check_violation';
    END IF;

    RAISE NOTICE 'vendor_addresses: moved % address(es) off the vendors row', v_actual;
END
$check$;

ALTER TABLE public.vendors
    DROP COLUMN address_line1,
    DROP COLUMN address_line2,
    DROP COLUMN city,
    DROP COLUMN state,
    DROP COLUMN postal_code,
    DROP COLUMN country;

COMMENT ON TABLE public.vendors IS
  'A supplier or outside-process provider. Identity is (company_id, name), FULL not partial — the importer upserts on it. Addresses live in vendor_addresses and contacts in vendor_contacts; neither is on this row, so neither is limited to one.';


-- ── The demo path learns about vendor_addresses ─────────────────────────────
-- seed_demo_data wrote a vendor's address onto the vendors row, so creating or
-- resetting a demo company fails outright once those columns are gone. Both
-- functions are rebuilt from their NEWEST definitions (20260823172300) — never
-- from the migration that created them, which silently reverts every fix
-- applied since.
--
-- reset_demo_company needs no new DELETE: vendor_addresses.vendor_id is
-- ON DELETE CASCADE, like vendor_contacts, so deleting the vendor takes its
-- addresses with it. (vendor_services is RESTRICT and DID need its own line —
-- the difference is deliberate: a service is referenced by routing operations,
-- an address is referenced by nothing.)
CREATE OR REPLACE FUNCTION public.seed_demo_data(p_company_id uuid, p_user_id uuid, p_template_name text DEFAULT 'default'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_template   jsonb;
    v_ref_map    jsonb := '{}'::jsonb;
    v_service_refs  jsonb := '[]'::jsonb;
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
            INSERT INTO vendors (id, company_id, name)
            VALUES (v_new_id, p_company_id, v_item->>'name');

            -- The address is its own row now. The TEMPLATE keeps its flat
            -- address_* keys — they still describe one address, which is all a
            -- demo vendor needs — so only the destination changed. A template
            -- entry with no street and no city produces no row at all, rather
            -- than a blank address the UI would render as "an address exists".
            IF COALESCE(v_item->>'address_line1', '') <> ''
               OR COALESCE(v_item->>'city', '') <> '' THEN
                INSERT INTO vendor_addresses (vendor_id, address_line1, address_line2,
                                              city, state, postal_code, country, is_default)
                VALUES (v_new_id, v_item->>'address_line1', v_item->>'address_line2',
                        v_item->>'city', v_item->>'state', v_item->>'postal_code',
                        COALESCE(v_item->>'country', 'USA'), true);
            END IF;

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'contacts', '[]'::jsonb)) LOOP
                INSERT INTO vendor_contacts (vendor_id, name, role, role_label, email, phone, is_primary)
                VALUES (v_new_id, v_inner->>'name',
                        COALESCE(v_inner->>'role', 'sales'), v_inner->>'role_label',
                        v_inner->>'email', v_inner->>'phone',
                        COALESCE((v_inner->>'is_primary')::boolean, false));
            END LOOP;
        END LOOP;
    END IF;

    -- ---- work centers and vendor services ------------------------------
    -- One template array still feeds both, because the template's own shape is
    -- fine: an entry with kind='external' and a vendor_ref has always described
    -- a vendor's service rather than a station. Only the destination changed,
    -- so no template row needs rewriting.
    --
    -- v_service_refs records which _refs became services, so the routing loop
    -- below knows which of the two target columns to fill. The _ref -> uuid map
    -- stays shared, so a template's work_center_ref keeps resolving either way.
    IF v_template->'work_centers' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'work_centers') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));

            IF COALESCE(v_item->>'kind', 'internal') = 'external' THEN
                v_service_refs := v_service_refs || jsonb_build_array(v_item->>'_ref');
                INSERT INTO vendor_services (id, company_id, vendor_id, name, description, unit_price)
                VALUES (v_new_id, p_company_id,
                        (v_ref_map->>(v_item->>'vendor_ref'))::uuid,
                        v_item->>'name',
                        v_item->>'description',
                        NULLIF(v_item->>'unit_price', '')::numeric);
            ELSE
                INSERT INTO work_centers (id, company_id, name, labor_rate, description,
                                          make, model, serial_number, year_built, purchased_on)
                VALUES (v_new_id, p_company_id, v_item->>'name',
                        NULLIF(v_item->>'labor_rate', '')::numeric,
                        v_item->>'description',
                        v_item->>'make', v_item->>'model', v_item->>'serial_number',
                        NULLIF(v_item->>'year_built', '')::integer,
                        CASE WHEN v_item->>'purchased_years_ago' IS NOT NULL
                             THEN (CURRENT_DATE - make_interval(years =>
                                      (v_item->>'purchased_years_ago')::integer))::date END);
            END IF;
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
            -- `seed_new_part_balance` parks it at Unassigned. Never write both
            -- — that is how a part ends up counted twice.
            INSERT INTO parts (id, company_id, part_name, description, source,
                               primary_unit, quantity, reorder_point,
                               costing_batch_quantity, preferred_vendor_id)
            VALUES (v_new_id, p_company_id, v_item->>'part_name', v_item->>'description',
                    v_source,
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
                -- Exactly one target, per routing_operations_exactly_one_target.
                INSERT INTO routing_operations (routing_id, work_center_id, vendor_service_id, sequence,
                                                setup_minutes, cycle_minutes_per_unit,
                                                labor_rate_override, external_unit_price, instructions)
                VALUES (v_routing_id,
                        CASE WHEN NOT (v_service_refs ? (v_inner->>'work_center_ref'))
                             THEN (v_ref_map->>(v_inner->>'work_center_ref'))::uuid END,
                        CASE WHEN v_service_refs ? (v_inner->>'work_center_ref')
                             THEN (v_ref_map->>(v_inner->>'work_center_ref'))::uuid END,
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
                                   credit_status, credit_hold_note)
            VALUES (v_cust_id, p_company_id, v_item->>'name',
                    v_item->>'default_payment_terms',
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
                                lead_time_text, payment_terms,
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
    -- Before vendors: vendor_services.vendor_id is ON DELETE RESTRICT, so a
    -- demo reset would fail on the first vendor that performs a service.
    DELETE FROM vendor_services         WHERE company_id = v_demo_company_id;

    -- parties
    DELETE FROM customer_carrier_accounts WHERE company_id = v_demo_company_id;
    DELETE FROM customers WHERE company_id = v_demo_company_id;  -- contacts/addresses CASCADE
    DELETE FROM vendors   WHERE company_id = v_demo_company_id;  -- vendor_contacts + vendor_addresses CASCADE

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

    -- Flags are not data the reset wipes — they are re-mirrored from the source,
    -- so Reset restores the demo's product surface as well as its rows.
    PERFORM sync_demo_features(p_source_company_id, v_demo_company_id);

    PERFORM seed_demo_data(v_demo_company_id, p_user_id);
END;
$function$;
