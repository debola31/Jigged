-- ============================================================================
-- HEAT NUMBERS ON MATERIAL
-- ============================================================================
-- Resolves #642 at the grain the founder chose (2026-09-03/04), and ONLY that
-- grain. Traceability was cut on 2026-07-27 and re-confirmed 2026-08-01
-- (docs/modules/inventory.md §5.6); a new customer now requires the heat number
-- of the material on what they receive. Five decisions shape everything below:
--
--   1. HEAT ON THE PACKING SLIP. Captured at stock-in, carried through the job,
--      printed for the shipped parts.
--   2. THE OPERATOR READS IT OFF THE BAR. Stock stays "a quantity of an item at
--      a place". There is NO lot key on part_location_stock, no per-lot balance,
--      and count / put-away / transfer / the importer are untouched. The heat is
--      text on the movement that received the bar and the movement that took it
--      to a job -- inventory_transactions, nothing else.
--   3. HEAT NUMBER ONLY. No cert PDF. A later receipt/attachment concept can hang
--      off the same column; nothing here forecloses it.
--   4. ON FOR EVERYONE, OPTIONAL, HIDDEN WHEN ABSENT. No company setting, no
--      flag. NULL is the explicit "not recorded" state -- true today for every
--      existing row and for every shop that does not record heats -- and the read
--      path has one shape: render the heat when there is one, nothing otherwise.
--   5. MATERIAL IS ALWAYS RECEIVED, STOCKED AND CONSUMED, even in quick series.
--      So the ledger is the only source: a job's heats are the distinct heats on
--      the depletion rows tagged to it. No job-side hand entry.
--
-- WHAT STAYS CUT: the lot layer (§5.6), certs, and Certificate-of-Conformance
-- text on the slip (built, then dropped by 20260621161856).
--
-- THE SNAPSHOT. A packing slip that left the building must print the same heat a
-- year later even if the office corrects a typo on the ledger afterwards
-- (Document Snapshot Standard, docs/architecture.md §15) -- so the shipment
-- freezes what it printed, exactly as it freezes the redacted freight account.
-- ============================================================================


-- ============================================================================
-- 1. inventory_transactions.heat_number -- the heat rides on the movement
-- ============================================================================
ALTER TABLE public.inventory_transactions
    ADD COLUMN IF NOT EXISTS heat_number text;

COMMENT ON COLUMN public.inventory_transactions.heat_number IS
  'Mill heat / lot number of the material this movement received (addition) or took to a job (depletion), as read off the bar''s tag. NULL = not recorded, which is the normal state for shops that do not track heats. Normalised to upper-case, trimmed by trg_normalize_heat_number. Deliberately MUTABLE (like notes, and unlike every other column): it is a transcription, not a balance fact, and a typo must be correctable from the part''s history. A slip already created keeps its own frozen copy (shipments.heat_numbers_snapshot). NOT a lot key -- stock stays a quantity of an item at a place (inventory.md §5.6).';

ALTER TABLE public.inventory_transactions
    DROP CONSTRAINT IF EXISTS inventory_transactions_heat_number_shape;
ALTER TABLE public.inventory_transactions
    ADD CONSTRAINT inventory_transactions_heat_number_shape
    CHECK (
        heat_number IS NULL
        OR (heat_number = btrim(heat_number) AND heat_number <> '' AND length(heat_number) <= 64)
    );

-- Normalisation lives in ONE place, for every writer -- the two RPCs today, a PO
-- receipt or an importer tomorrow, and the office correcting a typo through
-- PostgREST. `NULLIF(.., '')` is what turns a cleared field back into "not
-- recorded" rather than an empty string that would print as a blank heat.
CREATE OR REPLACE FUNCTION public.normalize_heat_number()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    NEW.heat_number := NULLIF(upper(btrim(NEW.heat_number)), '');
    RETURN NEW;
END;
$function$;

-- Trigger function: permission is checked when the trigger is created, never
-- when it fires, so revoking from the browser costs nothing and closes a door.
REVOKE EXECUTE ON FUNCTION public.normalize_heat_number() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.normalize_heat_number() IS
  'BEFORE INSERT OR UPDATE OF heat_number on inventory_transactions: upper-case, trim, and turn an empty string into NULL, so every writer stores the same shape and "" can never print as a blank heat.';

DROP TRIGGER IF EXISTS trg_normalize_heat_number ON public.inventory_transactions;
CREATE TRIGGER trg_normalize_heat_number
    BEFORE INSERT OR UPDATE OF heat_number ON public.inventory_transactions
    FOR EACH ROW EXECUTE FUNCTION public.normalize_heat_number();

-- The slip's snapshot query reads (job_id, type, heat_number IS NOT NULL); the
-- partial index keeps it a lookup on the tiny subset of rows that carry a heat.
CREATE INDEX IF NOT EXISTS inventory_transactions_job_heat_idx
    ON public.inventory_transactions (job_id)
    WHERE heat_number IS NOT NULL;

-- The ledger-immutability trigger is an allowlist BY OMISSION (its own COMMENT
-- says so): a column it does not name is mutable. heat_number is mutable on
-- purpose, so the function body is NOT touched -- rebuilding it "to add the new
-- column" is the rebuild that has silently reverted entries four times in this
-- repo. Only the COMMENT changes, so the decision is recorded where the next
-- reader will look.
COMMENT ON FUNCTION public.restrict_transaction_update_to_notes() IS
  'Ledger immutability: only `notes` and `heat_number` may be UPDATEd on inventory_transactions -- both are transcriptions, not balance facts (heat_number added 20260904063844; a typo on a mill tag must be correctable, and a slip already created keeps its own frozen copy). An allowlist BY OMISSION -- anything not named here is mutable -- so a rebuild that "restores" a missing column can break a cascade. `location_id` is omitted ON PURPOSE: its FK is ON DELETE SET NULL, and naming it here breaks delete_location for any location that has ever been transacted (regression 20260731235450 -> 20260815192344). `location_name` carries the durable snapshot instead.';


-- ============================================================================
-- 2. shipments.heat_numbers_snapshot -- the slip freezes what it printed
-- ============================================================================
-- jsonb array of {"heat_number": "4471", "material_name": "1.25 4140 BAR"}.
-- material_name is the depletion row's item_name, itself already a snapshot.
-- NOT NULL DEFAULT '[]': every existing slip printed no heat, so an empty
-- array is the truth at rest for all of them, not a fallback the reader has to
-- special-case. The slip prints the line only when the array is non-empty.
ALTER TABLE public.shipments
    ADD COLUMN IF NOT EXISTS heat_numbers_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.shipments
    DROP CONSTRAINT IF EXISTS shipments_heat_numbers_snapshot_is_array;
ALTER TABLE public.shipments
    ADD CONSTRAINT shipments_heat_numbers_snapshot_is_array
    CHECK (jsonb_typeof(heat_numbers_snapshot) = 'array');

COMMENT ON COLUMN public.shipments.heat_numbers_snapshot IS
  'Frozen at creation by create_shipment_with_line_items: the DISTINCT (heat_number, item_name) pairs on the job''s depletion rows, as [{"heat_number","material_name"}] ordered by material then heat. A later correction on the ledger never rewrites a slip in a customer''s hands -- void and reissue (Document Snapshot Standard, architecture.md §15). [] = no heat was recorded for this job when the slip was created.';


-- ============================================================================
-- 3. add_stock_at_location -- the receipt carries the heat
-- ============================================================================
-- Adding a parameter is a NEW signature. Postgres keeps the old overload alive
-- and PostgREST resolves by the names supplied, so the old one is DROPped by its
-- exact live signature (guarded at the end of this file) and the ACL that DROP
-- destroys is re-issued by naming the roles -- no migration ever granted these
-- two functions to the browser; they were reachable only through PUBLIC's
-- built-in default (20260801024552 explains why that still works). Explicit
-- is the discipline CLAUDE.md asks for.
--
-- Body verbatim from 20260802015837 (the newest definition), plus heat_number.
DROP FUNCTION IF EXISTS public.add_stock_at_location(
    uuid, uuid, numeric, text, numeric, text, uuid, text);

CREATE FUNCTION public.add_stock_at_location(
    p_part_id uuid,
    p_location_id uuid,
    p_quantity numeric,
    p_unit text,
    p_converted_quantity numeric,
    p_notes text DEFAULT NULL::text,
    p_operator_id uuid DEFAULT NULL::uuid,
    p_photo_path text DEFAULT NULL::text,
    p_heat_number text DEFAULT NULL::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company uuid; v_item_name text;
    v_new_balance numeric; v_rollup numeric;
BEGIN
    IF p_quantity <= 0 OR p_converted_quantity <= 0 THEN
        RAISE EXCEPTION 'Quantity must be positive' USING ERRCODE = 'check_violation';
    END IF;

    SELECT company_id, part_name
      INTO v_company, v_item_name
      FROM public.parts WHERE id = p_part_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'part % not found', p_part_id USING ERRCODE = 'no_data_found';
    END IF;
    -- DEFINER bypasses RLS, so this guard is the ONLY tenant boundary in the function.
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Entitlement. Membership says WHO you are; this says whether the shop may still write.
    PERFORM public.inv_assert_can_write(v_company);
    PERFORM public.inv_assert_location_in_company(p_location_id, v_company);

    INSERT INTO public.part_location_stock AS pls (company_id, part_id, location_id, quantity)
    VALUES (v_company, p_part_id, p_location_id, p_converted_quantity)
    ON CONFLICT (part_id, location_id)
        DO UPDATE SET quantity = pls.quantity + EXCLUDED.quantity
    RETURNING pls.quantity INTO v_new_balance;

    -- heat_number is normalised by trg_normalize_heat_number on the way in.
    INSERT INTO public.inventory_transactions
        (company_id, part_id, item_name, type, quantity, unit, converted_quantity,
         location_id, notes, operator_id, photo_path, heat_number, created_by)
    VALUES
        (v_company, p_part_id, v_item_name, 'addition', p_quantity, p_unit, p_converted_quantity,
         p_location_id, p_notes, p_operator_id, p_photo_path, p_heat_number, auth.uid());

    SELECT quantity INTO v_rollup FROM public.parts WHERE id = p_part_id;
    RETURN jsonb_build_object('location_balance', v_new_balance, 'part_quantity', v_rollup);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.add_stock_at_location(uuid, uuid, numeric, text, numeric, text, uuid, text, text)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_stock_at_location(uuid, uuid, numeric, text, numeric, text, uuid, text, text)
    TO authenticated, service_role;

COMMENT ON FUNCTION public.add_stock_at_location(uuid, uuid, numeric, text, numeric, text, uuid, text, text) IS
  'Stock a part into a location: upsert the balance and write an ''addition'' ledger row. Browser-callable on purpose (allowlisted in function_execute_leaks by name). p_heat_number (20260904063844) is the mill heat read off the bar''s tag at receiving -- optional, and the only place a heat first enters Jigged.';


-- ============================================================================
-- 4. deplete_stock_at_location -- the take to a job carries the heat
-- ============================================================================
-- Body verbatim from 20260802144310 (the newest definition), plus heat_number.
DROP FUNCTION IF EXISTS public.deplete_stock_at_location(
    uuid, uuid, numeric, text, numeric, boolean, text, uuid, uuid, uuid);

CREATE FUNCTION public.deplete_stock_at_location(
    p_part_id uuid,
    p_location_id uuid,
    p_quantity numeric,
    p_unit text,
    p_converted_quantity numeric,
    p_graceful boolean DEFAULT false,
    p_notes text DEFAULT NULL::text,
    p_job_id uuid DEFAULT NULL::uuid,
    p_job_operation_id uuid DEFAULT NULL::uuid,
    p_operator_id uuid DEFAULT NULL::uuid,
    p_heat_number text DEFAULT NULL::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company uuid; v_item_name text; v_primary_unit text;
    v_current numeric; v_new numeric; v_rollup numeric;
    v_discrepancy boolean := false; v_shortfall numeric := 0;
    v_notes text; v_disc_note text;
BEGIN
    IF p_quantity <= 0 OR p_converted_quantity <= 0 THEN
        RAISE EXCEPTION 'Quantity must be positive' USING ERRCODE = 'check_violation';
    END IF;

    SELECT company_id, part_name, primary_unit
      INTO v_company, v_item_name, v_primary_unit
      FROM public.parts WHERE id = p_part_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'part % not found', p_part_id USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Entitlement. Membership says WHO you are; this says whether the shop may still write.
    PERFORM public.inv_assert_can_write(v_company);
    PERFORM public.inv_assert_location_in_company(p_location_id, v_company);

    -- Lock the balance row (treat a missing row as 0 on hand).
    SELECT quantity INTO v_current
      FROM public.part_location_stock
     WHERE part_id = p_part_id AND location_id = p_location_id
       FOR UPDATE;
    v_current := COALESCE(v_current, 0);

    v_new := v_current - p_converted_quantity;
    v_notes := p_notes;

    IF v_new < 0 THEN
        IF p_graceful THEN
            v_shortfall := p_converted_quantity - v_current;
            v_new := 0;
            v_discrepancy := true;
            v_disc_note := format(
                '[DISCREPANCY: Confirmed %s %s, but only %s %s was available. Shortfall: %s %s]',
                p_converted_quantity, v_primary_unit, v_current, v_primary_unit, v_shortfall, v_primary_unit);
            v_notes := CASE WHEN v_notes IS NULL OR v_notes = '' THEN v_disc_note
                            ELSE v_notes || ' ' || v_disc_note END;
        ELSE
            RAISE EXCEPTION 'Insufficient stock at location (have %, need %)', v_current, p_converted_quantity
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    -- Emptying a bin removes its row rather than parking a zero there. `v_new = 0` is reachable
    -- both by depleting the exact balance and by the graceful over-removal path above.
    IF v_new = 0 THEN
        DELETE FROM public.part_location_stock
         WHERE part_id = p_part_id AND location_id = p_location_id;
    ELSE
        INSERT INTO public.part_location_stock (company_id, part_id, location_id, quantity)
        VALUES (v_company, p_part_id, p_location_id, v_new)
        ON CONFLICT (part_id, location_id) DO UPDATE SET quantity = EXCLUDED.quantity;
    END IF;

    -- heat_number is normalised by trg_normalize_heat_number on the way in.
    INSERT INTO public.inventory_transactions
        (company_id, part_id, item_name, type, quantity, unit, converted_quantity,
         location_id, job_id, job_operation_id, operator_id, notes, has_discrepancy,
         heat_number, created_by)
    VALUES
        (v_company, p_part_id, v_item_name, 'depletion', p_quantity, p_unit, p_converted_quantity,
         p_location_id, p_job_id, p_job_operation_id, p_operator_id, v_notes, v_discrepancy,
         p_heat_number, auth.uid());

    SELECT quantity INTO v_rollup FROM public.parts WHERE id = p_part_id;
    RETURN jsonb_build_object(
        'location_balance', v_new, 'part_quantity', v_rollup,
        'has_discrepancy', v_discrepancy, 'shortfall', v_shortfall);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.deplete_stock_at_location(uuid, uuid, numeric, text, numeric, boolean, text, uuid, uuid, uuid, text)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.deplete_stock_at_location(uuid, uuid, numeric, text, numeric, boolean, text, uuid, uuid, uuid, text)
    TO authenticated, service_role;

COMMENT ON FUNCTION public.deplete_stock_at_location(uuid, uuid, numeric, text, numeric, boolean, text, uuid, uuid, uuid, text) IS
  'Take stock out of a location: decrement the balance (deleting the row at zero), write a ''depletion'' ledger row tagged with the job when it is a take (J7). Browser-callable on purpose (allowlisted in function_execute_leaks by name). p_heat_number (20260904063844) is the mill heat read off the bar being taken -- optional; the packing slip prints the distinct heats on a job''s depletions.';


-- ============================================================================
-- 5. create_shipment_with_line_items -- freeze the job's heats onto the slip
-- ============================================================================
-- Same signature as 20260801030048, so CREATE OR REPLACE keeps the ACL and the
-- allowlist entry. Body verbatim, plus the snapshot (step 4b).
CREATE OR REPLACE FUNCTION public.create_shipment_with_line_items(
    p_company_id uuid,
    p_customer_id uuid,
    p_shipping_address_id uuid,
    p_one_time_address jsonb,
    p_ship_date date,
    p_carrier text,
    p_shipping_method text,
    p_line_items jsonb,
    p_notes text DEFAULT NULL::text,
    p_freight_terms text DEFAULT NULL::text,
    p_customer_carrier_account_id uuid DEFAULT NULL::uuid
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_packing_slip text;
    v_shipment_id uuid;
    v_user_id uuid := auth.uid();
    v_item jsonb;
    v_pre_status jsonb := '{}'::jsonb;
    v_job_ids uuid[];
    v_job_id uuid;
    v_job_number text;
    v_base text;
    v_seq int;
    v_heats jsonb;
    r record;
BEGIN
    IF NOT (p_company_id IN (SELECT get_user_company_ids())) THEN
        RAISE EXCEPTION 'create_shipment_with_line_items: caller does not have access to company %',
            p_company_id
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 1. Resolve the job(s) behind the line items. A packing slip belongs to
    --    exactly one job — reject empty or multi-job inputs.
    SELECT array_agg(DISTINCT jp.job_id)
      INTO v_job_ids
      FROM public.job_parts jp
     WHERE jp.id IN (
        SELECT (item->>'job_part_id')::uuid
          FROM jsonb_array_elements(p_line_items) AS item
     );

    IF v_job_ids IS NULL OR array_length(v_job_ids, 1) IS NULL THEN
        RAISE EXCEPTION 'create_shipment_with_line_items: no job parts resolved from line items';
    END IF;
    IF array_length(v_job_ids, 1) > 1 THEN
        RAISE EXCEPTION 'create_shipment_with_line_items: a packing slip must belong to a single job (got % jobs)',
            array_length(v_job_ids, 1);
    END IF;
    v_job_id := v_job_ids[1];

    -- 2. Lock the job so the per-job packing-slip sequence is collision-free
    --    under concurrent callers. Released at COMMIT/ROLLBACK.
    PERFORM pg_advisory_xact_lock(hashtext('job:' || v_job_id::text));

    -- 3. Snapshot pre-cascade fulfillment_status for the audit row.
    SELECT COALESCE(jsonb_object_agg(j.id::text, j.fulfillment_status), '{}'::jsonb)
      INTO v_pre_status
      FROM public.jobs j
     WHERE j.id = v_job_id;

    -- 4. Mint the job-derived packing-slip number: PS-{jobBase}-{n}, n from 1.
    --    jobBase strips the alpha prefix off job_number (J-0141 -> 0141).
    SELECT j.job_number INTO v_job_number FROM public.jobs j WHERE j.id = v_job_id;
    v_base := regexp_replace(v_job_number, '^[A-Za-z]+-?', '');
    SELECT count(*) + 1 INTO v_seq FROM public.shipments WHERE job_id = v_job_id;
    v_packing_slip := 'PS-' || v_base || '-' || v_seq::text;

    -- 4b. Freeze the job's heat numbers (20260904063844). The distinct
    --     (heat, material) pairs on the depletion rows tagged to this job, as
    --     they stand right now -- a ledger correction later must not rewrite a
    --     slip a customer already holds. One job per part since #812, so this
    --     is per shipped part for every job made from a quote; a legacy
    --     multi-part job prints the same set once. [] when nothing was recorded.
    SELECT COALESCE(
             jsonb_agg(jsonb_build_object('heat_number', d.heat_number, 'material_name', d.material_name)
                       ORDER BY d.material_name, d.heat_number),
             '[]'::jsonb)
      INTO v_heats
      FROM (
        SELECT DISTINCT t.heat_number, t.item_name AS material_name
          FROM public.inventory_transactions t
         WHERE t.job_id = v_job_id
           AND t.type = 'depletion'
           AND t.heat_number IS NOT NULL
      ) d;

    -- 5. Insert shipment + line items. Triggers cascade fulfillment_status, and
    --    snapshot_shipment_party freezes the redacted freight block.
    INSERT INTO public.shipments (
        company_id, customer_id, shipping_address_id, one_time_address,
        packing_slip_number, ship_date, job_id, carrier, shipping_method,
        freight_terms, customer_carrier_account_id,
        heat_numbers_snapshot,
        created_by
    ) VALUES (
        p_company_id, p_customer_id, p_shipping_address_id, p_one_time_address,
        v_packing_slip, COALESCE(p_ship_date, current_date), v_job_id, p_carrier, p_shipping_method,
        p_freight_terms, p_customer_carrier_account_id,
        v_heats,
        v_user_id
    ) RETURNING id INTO v_shipment_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_line_items) LOOP
        INSERT INTO public.shipment_line_items (shipment_id, job_part_id, quantity)
        VALUES (
            v_shipment_id,
            (v_item->>'job_part_id')::uuid,
            (v_item->>'quantity')::numeric
        );
    END LOOP;

    -- 6. Audit the job iff it crossed forward into fully_shipped.
    FOR r IN
        SELECT j.id AS job_id, j.fulfillment_status AS new_status,
               v_pre_status->>(j.id::text) AS old_status
          FROM public.jobs j
         WHERE j.id::text IN (SELECT jsonb_object_keys(v_pre_status))
    LOOP
        IF r.new_status = 'fully_shipped'
           AND r.old_status IS DISTINCT FROM 'fully_shipped' THEN
            INSERT INTO public.job_fulfillment_audit (
                job_id, company_id, from_status, to_status,
                triggering_shipment_id, triggering_user_id
            ) VALUES (
                r.job_id, p_company_id, r.old_status, r.new_status,
                v_shipment_id, v_user_id
            );
        END IF;
    END LOOP;

    RETURN v_shipment_id;
END $function$;

-- CREATE OR REPLACE kept the ACL -- which, since 20260801030048 dropped and
-- recreated this function after the default-privilege revoke, is PUBLIC's
-- built-in default and nothing else: reachable by authenticated AND anon, both
-- as members of PUBLIC. Name the roles, as for the two functions above. Only
-- a signed-in user ever creates a shipment.
REVOKE EXECUTE ON FUNCTION public.create_shipment_with_line_items(uuid, uuid, uuid, jsonb, date, text, text, jsonb, text, text, uuid)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_shipment_with_line_items(uuid, uuid, uuid, jsonb, date, text, text, jsonb, text, text, uuid)
    TO authenticated, service_role;


-- ============================================================================
-- 6. Guards -- turn a silent miss into a failed migration
-- ============================================================================
-- (a) Overload hygiene: `DROP FUNCTION IF EXISTS` against a signature that does
--     not match the live one SUCCEEDS AND DOES NOTHING, leaving two callable
--     functions for PostgREST to pick between (the trap 20260801030048 names).
-- (b) The browser must still reach both stock RPCs after the drop -- and anon
--     must not.
DO $$
DECLARE
    v_name text;
    v_count integer;
    v_oid oid;
BEGIN
    FOREACH v_name IN ARRAY ARRAY['add_stock_at_location', 'deplete_stock_at_location', 'create_shipment_with_line_items'] LOOP
        SELECT count(*), min(p.oid) INTO v_count, v_oid
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = v_name;
        IF v_count <> 1 THEN
            RAISE EXCEPTION '% has % overloads (expected 1) -- the DROP signature did not match the live function',
                v_name, v_count;
        END IF;
        IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
            RAISE EXCEPTION '% is no longer executable by authenticated -- the browser would get 42501', v_name;
        END IF;
        IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
            RAISE EXCEPTION '% is executable by anon', v_name;
        END IF;
    END LOOP;
END $$;
