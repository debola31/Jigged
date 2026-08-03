-- Close the billing write-gate on every location-stock RPC. Issue #645.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- THE HOLE
-- ═══════════════════════════════════════════════════════════════════════════════
-- Entitlement is enforced at the DB layer by restrictive `billing_gate_*` RLS
-- policies calling company_can_write(). That works for tables the browser writes
-- directly. It does nothing for these five, and for two compounding reasons:
--
--   1. All five are SECURITY DEFINER, so they run as the function owner. No table
--      in this schema sets FORCE ROW LEVEL SECURITY, and an owner bypasses RLS —
--      so the restrictive policies on `inventory_transactions` never fire inside
--      them.
--   2. `part_location_stock` is not gated at all. It sits on the exempt list in
--      tenant_tables_missing_write_gate() under the rationale
--        "service-role-only / SELECT-only (writes never come from the browser)"
--      which is false. Writes come from the browser constantly; they simply
--      arrive through a definer RPC rather than a direct INSERT.
--
-- The result is entitlement that depends on a FEATURE FLAG, which is the worst
-- shape this bug could take — it looks enforced right up until the newest feature
-- is switched on:
--
--   inventory_locations OFF  →  aggregate path inserts as `authenticated`
--                               (utils/partsAccess.ts) → gate bites → blocked
--   inventory_locations ON   →  every RPC below → no gate → writes freely
--
-- NOTHING IS LEAKING TODAY: the flag is default-off for every tenant. This closes
-- it before the first paid rollout, not after.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- WHY CI WAS GREEN
-- ═══════════════════════════════════════════════════════════════════════════════
-- test_no_tenant_table_left_ungated asserts each company_id table is gated OR
-- exempt. `part_location_stock` was exempt, so it passed. A policy-existence check
-- cannot see a definer function walking past a policy on a table that IS gated.
-- api/tests/integration/test_billing_enforcement.py gains a test for that class.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- WHY THE CHECK IS EXPLICIT IN EVERY FUNCTION
-- ═══════════════════════════════════════════════════════════════════════════════
-- It would be shorter to bury this inside inv_assert_location_in_company(), which
-- all five already call. That is exactly how the current miss happened: a
-- protection nobody can see at the call site is a protection the next audit walks
-- past. Each function now says, in its own body, that it checked.
--
-- The bodies below are otherwise UNCHANGED — they were dumped from the migrated
-- database with pg_get_functiondef() and patched by inserting one PERFORM after
-- the existing membership check, so no line of working logic was retyped. The
-- signatures are byte-identical, which is what makes CREATE OR REPLACE replace
-- rather than overload (the 42725 trap 20260731235450 documents).

-- ─────────────────────────────────────────────────────────────────────────────
-- The assertion itself
-- ─────────────────────────────────────────────────────────────────────────────
-- Raises rather than returning a boolean: a write path must not be able to
-- ignore the answer by forgetting to check it. SECURITY DEFINER because
-- company_can_write reads `company_billing`, which the browser cannot.
--
-- The message is the one the UI already knows how to explain — same wording the
-- RLS denial produces, so a lapsed shop gets one story regardless of which path
-- it hit.
CREATE OR REPLACE FUNCTION public.inv_assert_can_write(p_company_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF NOT public.company_can_write(p_company_id) THEN
        RAISE EXCEPTION 'company % has no active subscription', p_company_id
            USING ERRCODE = 'insufficient_privilege';
    END IF;
END;
$function$;

COMMENT ON FUNCTION public.inv_assert_can_write(uuid) IS
  'Raises insufficient_privilege when a company may not write (billing lapsed). Called by every SECURITY DEFINER stock RPC, which bypass the billing_gate_* RLS policies by construction. Issue #645.';

-- Not browser-callable: it is an internal guard, and 20260801024552 made the
-- ON FUNCTIONS default stop auto-granting, so this needs no REVOKE — but say it
-- explicitly rather than relying on a default nobody can see.
REVOKE EXECUTE ON FUNCTION public.inv_assert_can_write(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.inv_assert_can_write(uuid) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- The five write paths, unchanged except for the PERFORM
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.add_stock_at_location(p_part_id uuid, p_location_id uuid, p_quantity numeric, p_unit text, p_converted_quantity numeric, p_notes text DEFAULT NULL::text, p_operator_id uuid DEFAULT NULL::uuid, p_photo_path text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company uuid; v_item_name text; v_tracked boolean;
    v_new_balance numeric; v_rollup numeric;
BEGIN
    IF p_quantity <= 0 OR p_converted_quantity <= 0 THEN
        RAISE EXCEPTION 'Quantity must be positive' USING ERRCODE = 'check_violation';
    END IF;

    SELECT company_id, part_name, is_location_tracked
      INTO v_company, v_item_name, v_tracked
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
    IF NOT v_tracked THEN
        RAISE EXCEPTION 'part % is not location-tracked; enable tracking first', p_part_id USING ERRCODE = 'check_violation';
    END IF;
    PERFORM public.inv_assert_location_in_company(p_location_id, v_company);

    INSERT INTO public.part_location_stock AS pls (company_id, part_id, location_id, quantity)
    VALUES (v_company, p_part_id, p_location_id, p_converted_quantity)
    ON CONFLICT (part_id, location_id)
        DO UPDATE SET quantity = pls.quantity + EXCLUDED.quantity
    RETURNING pls.quantity INTO v_new_balance;

    INSERT INTO public.inventory_transactions
        (company_id, part_id, item_name, type, quantity, unit, converted_quantity,
         location_id, notes, operator_id, photo_path, created_by)
    VALUES
        (v_company, p_part_id, v_item_name, 'addition', p_quantity, p_unit, p_converted_quantity,
         p_location_id, p_notes, p_operator_id, p_photo_path, auth.uid());

    SELECT quantity INTO v_rollup FROM public.parts WHERE id = p_part_id;
    RETURN jsonb_build_object('location_balance', v_new_balance, 'part_quantity', v_rollup);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.adjust_stock_at_location(p_part_id uuid, p_location_id uuid, p_new_quantity numeric, p_unit text, p_converted_new_quantity numeric, p_notes text DEFAULT NULL::text, p_operator_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company uuid; v_item_name text; v_primary_unit text; v_tracked boolean;
    v_current numeric; v_diff numeric; v_rollup numeric; v_notes text;
BEGIN
    IF p_converted_new_quantity < 0 THEN
        RAISE EXCEPTION 'Quantity cannot be negative' USING ERRCODE = 'check_violation';
    END IF;

    SELECT company_id, part_name, primary_unit, is_location_tracked
      INTO v_company, v_item_name, v_primary_unit, v_tracked
      FROM public.parts WHERE id = p_part_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'part % not found', p_part_id USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Entitlement. Membership says WHO you are; this says whether the shop may still write.
    PERFORM public.inv_assert_can_write(v_company);
    IF NOT v_tracked THEN
        RAISE EXCEPTION 'part % is not location-tracked; enable tracking first', p_part_id USING ERRCODE = 'check_violation';
    END IF;
    PERFORM public.inv_assert_location_in_company(p_location_id, v_company);

    SELECT quantity INTO v_current
      FROM public.part_location_stock
     WHERE part_id = p_part_id AND location_id = p_location_id
       FOR UPDATE;
    v_current := COALESCE(v_current, 0);
    v_diff := p_converted_new_quantity - v_current;

    INSERT INTO public.part_location_stock (company_id, part_id, location_id, quantity)
    VALUES (v_company, p_part_id, p_location_id, p_converted_new_quantity)
    ON CONFLICT (part_id, location_id) DO UPDATE SET quantity = EXCLUDED.quantity;

    v_notes := COALESCE(
        p_notes,
        format('Adjusted from %s to %s %s', v_current, p_converted_new_quantity, v_primary_unit));

    INSERT INTO public.inventory_transactions
        (company_id, part_id, item_name, type, quantity, unit, converted_quantity,
         location_id, notes, operator_id, created_by)
    VALUES
        (v_company, p_part_id, v_item_name, 'adjustment', abs(v_diff), v_primary_unit, abs(v_diff),
         p_location_id, v_notes, p_operator_id, auth.uid());

    SELECT quantity INTO v_rollup FROM public.parts WHERE id = p_part_id;
    RETURN jsonb_build_object('location_balance', p_converted_new_quantity, 'part_quantity', v_rollup);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.bulk_put_away(p_from_location_id uuid, p_to_location_id uuid, p_part_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    PUT_AWAY_MAX constant int := 1000;
    v_company uuid;
    v_requested int;
    v_group uuid;
    v_from_name text;
    v_to_name text;
    v_moved int := 0;
    r record;
BEGIN
    IF p_from_location_id IS NULL OR p_to_location_id IS NULL THEN
        RAISE EXCEPTION 'Both a source and a destination location are required'
            USING ERRCODE = 'null_value_not_allowed';
    END IF;
    IF p_from_location_id = p_to_location_id THEN
        RAISE EXCEPTION 'Source and destination locations must differ'
            USING ERRCODE = 'check_violation';
    END IF;

    v_requested := COALESCE(array_length(p_part_ids, 1), 0);
    IF v_requested = 0 THEN
        RAISE EXCEPTION 'Pick at least one part to put away' USING ERRCODE = 'check_violation';
    END IF;
    IF v_requested > PUT_AWAY_MAX THEN
        RAISE EXCEPTION 'Too many parts at once (% of a maximum %). Narrow your search and put them away in smaller batches.',
            v_requested, PUT_AWAY_MAX USING ERRCODE = 'check_violation';
    END IF;

    -- Company comes from the SOURCE location, then both endpoints are asserted against it — so a
    -- caller can't pair one company's shelf with another's.
    SELECT company_id INTO v_company
      FROM public.inventory_locations WHERE id = p_from_location_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'location % not found', p_from_location_id USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Entitlement. Membership says WHO you are; this says whether the shop may still write.
    PERFORM public.inv_assert_can_write(v_company);
    PERFORM public.inv_assert_location_in_company(p_from_location_id, v_company);
    PERFORM public.inv_assert_location_in_company(p_to_location_id, v_company);

    -- ONE group id for the whole batch, so the ledger records it as a single traceable event
    -- rather than N unrelated transfers.
    v_group := gen_random_uuid();
    SELECT name INTO v_from_name FROM public.inventory_locations WHERE id = p_from_location_id;
    SELECT name INTO v_to_name   FROM public.inventory_locations WHERE id = p_to_location_id;

    -- Parts with no row here, a zero balance, tracking off, or archived simply don't match and are
    -- reported as `skipped`. A zero balance is the common case, not an error: the auto-track trigger
    -- seeds an Unassigned row for every stocked part whether or not it holds anything.
    --
    -- `ORDER BY part_id` gives every concurrent caller the same lock order, so two overlapping
    -- put-aways queue instead of deadlocking.
    FOR r IN
        SELECT pls.part_id, pls.quantity, p.part_name, p.primary_unit
          FROM public.part_location_stock pls
          JOIN public.parts p ON p.id = pls.part_id
         WHERE pls.location_id = p_from_location_id
           AND pls.company_id = v_company
           AND pls.part_id = ANY(p_part_ids)
           AND pls.quantity > 0
           AND p.is_location_tracked
           AND p.deleted_at IS NULL
         ORDER BY pls.part_id
           FOR UPDATE OF pls
    LOOP
        -- `inventory_transactions.unit` is NOT NULL, and the balance is already stored in the part's
        -- primary unit — so `r.primary_unit` is written straight through with no conversion. No null
        -- check is needed: `parts_requires_unit` is an unconditional `CHECK (primary_unit IS NOT
        -- NULL)`, so a part without one cannot exist to reach this loop.
        UPDATE public.part_location_stock
           SET quantity = 0
         WHERE part_id = r.part_id AND location_id = p_from_location_id;

        INSERT INTO public.part_location_stock AS pls (company_id, part_id, location_id, quantity)
        VALUES (v_company, r.part_id, p_to_location_id, r.quantity)
        ON CONFLICT (part_id, location_id)
            DO UPDATE SET quantity = pls.quantity + EXCLUDED.quantity;

        INSERT INTO public.inventory_transactions
            (company_id, part_id, item_name, type, quantity, unit, converted_quantity,
             location_id, transfer_group_id, notes, created_by)
        VALUES
            (v_company, r.part_id, r.part_name, 'depletion', r.quantity, r.primary_unit, r.quantity,
             p_from_location_id, v_group, format('Put away to %s', v_to_name), auth.uid()),
            (v_company, r.part_id, r.part_name, 'addition', r.quantity, r.primary_unit, r.quantity,
             p_to_location_id, v_group, format('Put away from %s', v_from_name), auth.uid());

        v_moved := v_moved + 1;
    END LOOP;

    RETURN jsonb_build_object(
        'moved', v_moved,
        'skipped', v_requested - v_moved,
        'transfer_group_id', v_group);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.deplete_stock_at_location(p_part_id uuid, p_location_id uuid, p_quantity numeric, p_unit text, p_converted_quantity numeric, p_graceful boolean DEFAULT false, p_notes text DEFAULT NULL::text, p_job_id uuid DEFAULT NULL::uuid, p_job_operation_id uuid DEFAULT NULL::uuid, p_operator_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company uuid; v_item_name text; v_primary_unit text; v_tracked boolean;
    v_current numeric; v_new numeric; v_rollup numeric;
    v_discrepancy boolean := false; v_shortfall numeric := 0;
    v_notes text; v_disc_note text;
BEGIN
    IF p_quantity <= 0 OR p_converted_quantity <= 0 THEN
        RAISE EXCEPTION 'Quantity must be positive' USING ERRCODE = 'check_violation';
    END IF;

    SELECT company_id, part_name, primary_unit, is_location_tracked
      INTO v_company, v_item_name, v_primary_unit, v_tracked
      FROM public.parts WHERE id = p_part_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'part % not found', p_part_id USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Entitlement. Membership says WHO you are; this says whether the shop may still write.
    PERFORM public.inv_assert_can_write(v_company);
    IF NOT v_tracked THEN
        RAISE EXCEPTION 'part % is not location-tracked; enable tracking first', p_part_id USING ERRCODE = 'check_violation';
    END IF;
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

    INSERT INTO public.part_location_stock (company_id, part_id, location_id, quantity)
    VALUES (v_company, p_part_id, p_location_id, v_new)
    ON CONFLICT (part_id, location_id) DO UPDATE SET quantity = EXCLUDED.quantity;

    INSERT INTO public.inventory_transactions
        (company_id, part_id, item_name, type, quantity, unit, converted_quantity,
         location_id, job_id, job_operation_id, operator_id, notes, has_discrepancy, created_by)
    VALUES
        (v_company, p_part_id, v_item_name, 'depletion', p_quantity, p_unit, p_converted_quantity,
         p_location_id, p_job_id, p_job_operation_id, p_operator_id, v_notes, v_discrepancy, auth.uid());

    SELECT quantity INTO v_rollup FROM public.parts WHERE id = p_part_id;
    RETURN jsonb_build_object(
        'location_balance', v_new, 'part_quantity', v_rollup,
        'has_discrepancy', v_discrepancy, 'shortfall', v_shortfall);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.transfer_stock(p_part_id uuid, p_from_location_id uuid, p_to_location_id uuid, p_quantity numeric, p_unit text, p_converted_quantity numeric, p_notes text DEFAULT NULL::text, p_operator_id uuid DEFAULT NULL::uuid, p_photo_path text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company uuid; v_item_name text; v_tracked boolean;
    v_src numeric; v_from_balance numeric; v_to_balance numeric;
    v_group uuid; v_from_name text; v_to_name text;
    v_from_notes text; v_to_notes text; v_base text;
BEGIN
    IF p_quantity <= 0 OR p_converted_quantity <= 0 THEN
        RAISE EXCEPTION 'Quantity must be positive' USING ERRCODE = 'check_violation';
    END IF;
    IF p_from_location_id = p_to_location_id THEN
        RAISE EXCEPTION 'Source and destination locations must differ' USING ERRCODE = 'check_violation';
    END IF;

    SELECT company_id, part_name, is_location_tracked
      INTO v_company, v_item_name, v_tracked
      FROM public.parts WHERE id = p_part_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'part % not found', p_part_id USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Entitlement. Membership says WHO you are; this says whether the shop may still write.
    PERFORM public.inv_assert_can_write(v_company);
    IF NOT v_tracked THEN
        RAISE EXCEPTION 'part % is not location-tracked; enable tracking first', p_part_id USING ERRCODE = 'check_violation';
    END IF;
    PERFORM public.inv_assert_location_in_company(p_from_location_id, v_company);
    PERFORM public.inv_assert_location_in_company(p_to_location_id, v_company);

    -- Lock + verify source has enough (hard fail — you can't move stock you lack).
    SELECT quantity INTO v_src
      FROM public.part_location_stock
     WHERE part_id = p_part_id AND location_id = p_from_location_id
       FOR UPDATE;
    IF v_src IS NULL OR v_src < p_converted_quantity THEN
        RAISE EXCEPTION 'Insufficient stock at source location (have %, need %)',
            COALESCE(v_src, 0), p_converted_quantity USING ERRCODE = 'check_violation';
    END IF;

    UPDATE public.part_location_stock
       SET quantity = v_src - p_converted_quantity
     WHERE part_id = p_part_id AND location_id = p_from_location_id
    RETURNING quantity INTO v_from_balance;

    INSERT INTO public.part_location_stock AS pls (company_id, part_id, location_id, quantity)
    VALUES (v_company, p_part_id, p_to_location_id, p_converted_quantity)
    ON CONFLICT (part_id, location_id)
        DO UPDATE SET quantity = pls.quantity + EXCLUDED.quantity
    RETURNING pls.quantity INTO v_to_balance;

    v_group := gen_random_uuid();
    SELECT name INTO v_from_name FROM public.inventory_locations WHERE id = p_from_location_id;
    SELECT name INTO v_to_name   FROM public.inventory_locations WHERE id = p_to_location_id;
    v_base := COALESCE(NULLIF(p_notes, ''), '');

    v_from_notes := btrim(v_base || ' ' || format('[Transfer to %s]', v_to_name));
    v_to_notes   := btrim(v_base || ' ' || format('[Transfer from %s]', v_from_name));

    INSERT INTO public.inventory_transactions
        (company_id, part_id, item_name, type, quantity, unit, converted_quantity,
         location_id, transfer_group_id, notes, operator_id, photo_path, created_by)
    VALUES
        (v_company, p_part_id, v_item_name, 'depletion', p_quantity, p_unit, p_converted_quantity,
         p_from_location_id, v_group, v_from_notes, p_operator_id, p_photo_path, auth.uid()),
        (v_company, p_part_id, v_item_name, 'addition', p_quantity, p_unit, p_converted_quantity,
         p_to_location_id, v_group, v_to_notes, p_operator_id, p_photo_path, auth.uid());

    RETURN jsonb_build_object(
        'transfer_group_id', v_group,
        'from_balance', v_from_balance, 'to_balance', v_to_balance);
END;
$function$
;

-- ─────────────────────────────────────────────────────────────────────────────
-- The two tracking RPCs, found by the sweep below
-- ─────────────────────────────────────────────────────────────────────────────
-- Both are browser-callable (they are on 20260801024552's reviewed allowlist) and
-- both write `part_location_stock`. They are dead UI-wise today — superseded by
-- the auto-track trigger, zero callers — but a gate that depends on nobody calling
-- a public function is not a gate.
CREATE OR REPLACE FUNCTION public.disable_location_tracking(p_part_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company uuid; v_tracked boolean; v_total numeric;
BEGIN
    SELECT company_id, is_location_tracked
      INTO v_company, v_tracked
      FROM public.parts WHERE id = p_part_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'part % not found', p_part_id USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM public.inv_assert_can_write(v_company);

    IF NOT v_tracked THEN
        RETURN jsonb_build_object('part_quantity',
            (SELECT quantity FROM public.parts WHERE id = p_part_id), 'tracked', false, 'noop', true);
    END IF;

    v_total := COALESCE(
        (SELECT SUM(quantity) FROM public.part_location_stock WHERE part_id = p_part_id), 0);

    -- Flip the flag FIRST (so the subsequent DELETE's rollup is a no-op) and set
    -- the collapsed total in the same statement (allowed: tracked is now false).
    UPDATE public.parts
       SET is_location_tracked = false, quantity = v_total, updated_at = now()
     WHERE id = p_part_id;

    DELETE FROM public.part_location_stock WHERE part_id = p_part_id;

    RETURN jsonb_build_object('part_quantity', v_total, 'tracked', false);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.enable_location_tracking(p_part_id uuid, p_initial_location_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company uuid; v_qty numeric; v_tracked boolean; v_loc uuid; v_rollup numeric;
BEGIN
    SELECT company_id, quantity, is_location_tracked
      INTO v_company, v_qty, v_tracked
      FROM public.parts WHERE id = p_part_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'part % not found', p_part_id USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM public.inv_assert_can_write(v_company);

    -- Idempotent: already tracked -> no-op.
    IF v_tracked THEN
        SELECT quantity INTO v_rollup FROM public.parts WHERE id = p_part_id;
        RETURN jsonb_build_object('part_quantity', v_rollup, 'tracked', true, 'noop', true);
    END IF;

    -- Resolve the backfill location: caller-chosen, else find-or-create "Unassigned".
    IF p_initial_location_id IS NOT NULL THEN
        PERFORM public.inv_assert_location_in_company(p_initial_location_id, v_company);
        v_loc := p_initial_location_id;
    ELSE
        PERFORM pg_advisory_xact_lock(hashtext('inv_unassigned:' || v_company::text));
        SELECT id INTO v_loc
          FROM public.inventory_locations
         WHERE company_id = v_company AND name = 'Unassigned';
        IF v_loc IS NULL THEN
            INSERT INTO public.inventory_locations (company_id, name, kind)
            VALUES (v_company, 'Unassigned', 'system')
            RETURNING id INTO v_loc;
        END IF;
    END IF;

    -- Flip the flag FIRST (quantity unchanged -> guard skipped), THEN seed the
    -- backfill balance equal to the pre-existing quantity so the rollup overwrites
    -- parts.quantity with the same SUM. Never let a standalone value coexist.
    UPDATE public.parts SET is_location_tracked = true, updated_at = now() WHERE id = p_part_id;

    INSERT INTO public.part_location_stock AS pls (company_id, part_id, location_id, quantity)
    VALUES (v_company, p_part_id, v_loc, v_qty)
    ON CONFLICT (part_id, location_id)
        DO UPDATE SET quantity = pls.quantity + EXCLUDED.quantity;

    SELECT quantity INTO v_rollup FROM public.parts WHERE id = p_part_id;
    RETURN jsonb_build_object('location_id', v_loc, 'part_quantity', v_rollup, 'tracked', true);
END;
$function$
;
-- ═══════════════════════════════════════════════════════════════════════════════
-- STOP THIS CLASS RECURRING
-- ═══════════════════════════════════════════════════════════════════════════════
-- The reason #645 survived review is that the existing guard,
-- tenant_tables_missing_write_gate(), checks whether a POLICY EXISTS. A SECURITY
-- DEFINER function walking past a policy that does exist is invisible to it.
--
-- This is the companion check: definer functions that write a gated table and
-- never consult the gate. It found the two above, which the issue had missed.
--
-- The exemptions are by CATEGORY, and each has to be argued rather than listed:
--
--   triggers          — fire inside another statement that was itself gated;
--                       gating again would reject a write already allowed
--   internal helpers  — unreachable from the browser (no EXECUTE grant) and only
--                       called from a path that has already asserted
--   demo bootstrap    — company_can_write() returns true for is_demo by design,
--                       so the check would be a no-op with extra steps
--
-- NOT exempt and deliberately still listed as a known gap:
--   create_shipment_with_line_items — browser-callable, writes gated tables, no
--   gate. Same bug, different module, and whether a lapsed shop may still SHIP an
--   order it has already made is a policy question for billing rather than
--   inventory. Tracked separately; this function is named in the exempt list only
--   so the check goes green on a known, filed gap instead of being ignored.
CREATE OR REPLACE FUNCTION public.definer_writers_missing_write_gate()
RETURNS TABLE(function_name text)
LANGUAGE sql
STABLE
AS $$
  WITH gated AS (
    SELECT DISTINCT tablename FROM pg_policies
    WHERE schemaname = 'public' AND policyname = 'billing_gate_insert'
  )
  SELECT p.proname::text
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prokind = 'f'
    AND p.prosecdef
    AND EXISTS (
      SELECT 1 FROM gated g
      WHERE pg_get_functiondef(p.oid) ~* ('(insert into|update)\s+(public\.)?' || g.tablename)
    )
    AND pg_get_functiondef(p.oid) NOT LIKE '%company_can_write%'
    AND pg_get_functiondef(p.oid) NOT LIKE '%inv_assert_can_write%'
    AND p.proname NOT IN (
      -- triggers: the statement that fired them was gated
      'auto_track_stocked_part', 'note_views_bump_counts',
      -- internal helpers: no browser EXECUTE, always called post-assertion
      'inv_get_or_create_unassigned', 'recompute_part_quantity_from_locations',
      'enable_location_tracking_for_company',
      -- demo bootstrap: company_can_write() is true for is_demo by design
      'seed_demo_data',
      -- known gap, filed separately: browser-callable, genuinely ungated
      'create_shipment_with_line_items'
    )
  ORDER BY 1;
$$;

COMMENT ON FUNCTION public.definer_writers_missing_write_gate() IS
  'Lists SECURITY DEFINER functions that write a billing-gated table without consulting company_can_write. A CI test asserts this is empty. Exists because SECURITY DEFINER bypasses RLS, so the policy-existence check in tenant_tables_missing_write_gate() cannot see this class — which is how issue #645 shipped.';

GRANT EXECUTE ON FUNCTION public.definer_writers_missing_write_gate() TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Make the exempt list honest
-- ─────────────────────────────────────────────────────────────────────────────
-- With the RPCs gated, `part_location_stock` no longer needs an exemption. The
-- restrictive policies are belt-and-braces — the definer RPCs bypass them by
-- construction and the browser has no direct write grant — but they mean a future
-- direct write cannot quietly become the unguarded path, and they let the table
-- come off the list. A false rationale left in that list is how the next person
-- repeats this.
SELECT public.apply_billing_write_gate('public.part_location_stock');

-- Rebased on the definition in 20260728040701 (NOT the original in 20260726033616),
-- which is the current one: it added the `note_views` / `operator_events` entries
-- and dropped SECURITY DEFINER. Recreating from the older text would have silently
-- reverted both. Only the `part_location_stock` entry is removed here.
--
-- Those two stay exempt and are NOT the same bug: they are definer-only writers for
-- *logging*, and gating them would block a lapsed shop from reading notes — reads
-- stay open by design. `part_location_stock` was different because the thing being
-- written is the tenant's data.
CREATE OR REPLACE FUNCTION public.tenant_tables_missing_write_gate()
RETURNS TABLE(table_name text)
LANGUAGE sql
STABLE
AS $$
  SELECT c.relname::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a
    ON a.attrelid = c.oid AND a.attname = 'company_id' AND NOT a.attisdropped
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname NOT IN (
      -- identity / bootstrap (gating would block signup / team / preferences)
      'companies', 'user_company_access', 'user_preferences', 'system_admins',
      'invitations', 'demo_data_templates', 'waitlist', 'saved_insights', 'feedback',
      'company_billing',
      -- service-role-only / SELECT-only (writes never come from the browser).
      -- `part_location_stock` was removed from this list in 20260801150944: its
      -- writes DO come from the browser, through SECURITY DEFINER RPCs, and the
      -- exemption was what hid issue #645.
      'auth_audit_log', 'job_fulfillment_audit',
      'company_order_counters', 'quickbooks_connections', 'quickbooks_customer_map',
      'quickbooks_invoice_links', 'quickbooks_invoice_line_items',
      -- SECURITY DEFINER-only writers; see 20260728040701
      'note_views', 'operator_events'
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_policies p
      WHERE p.schemaname = 'public'
        AND p.tablename = c.relname
        AND p.policyname = 'billing_gate_insert'
    )
  ORDER BY 1;
$$;

COMMENT ON FUNCTION public.tenant_tables_missing_write_gate() IS
  'Lists public tables with a company_id column that are neither billing-gated nor exempt. A CI test asserts this returns no rows, so a new tenant table left un-gated fails the build instead of silently bypassing billing.';

GRANT EXECUTE ON FUNCTION public.tenant_tables_missing_write_gate() TO service_role;
