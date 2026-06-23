-- Inventory Locations — atomic stock-mutation RPCs (PR1 of 2)
--
-- Every per-location balance change is paired with an inventory_transactions row
-- in ONE transaction. All are SECURITY DEFINER (like create_shipment_with_line_items)
-- so they can write the SELECT-only part_location_stock table; because DEFINER
-- bypasses RLS, the ONLY tenant boundary is the explicit guard inside each function.
--
-- Tenancy guard (load-bearing): we DERIVE the company from the part and verify the
-- caller's membership AND that every location id resolves to that same company. A
-- caller cannot pass a part/location from another company — the FKs check existence,
-- not ownership, and DEFINER skips RLS, so corruption is only prevented by this guard.
--
-- Unit handling mirrors the existing partsAccess functions: the client converts to
-- the part's primary unit and passes p_converted_quantity; the RPC stores the display
-- (quantity, unit) plus converted_quantity, and operates on balances in primary units.

-- ============================================================
-- Helper: assert a location belongs to a company (or raise)
-- ============================================================
CREATE OR REPLACE FUNCTION public.inv_assert_location_in_company(p_location_id uuid, p_company_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF p_location_id IS NULL THEN
        RAISE EXCEPTION 'location_id is required' USING ERRCODE = 'null_value_not_allowed';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.inventory_locations
         WHERE id = p_location_id AND company_id = p_company_id
    ) THEN
        RAISE EXCEPTION 'location % is not in company %', p_location_id, p_company_id
            USING ERRCODE = 'insufficient_privilege';
    END IF;
END;
$function$;

-- ============================================================
-- add_stock_at_location
-- ============================================================
CREATE OR REPLACE FUNCTION public.add_stock_at_location(
    p_part_id uuid, p_location_id uuid,
    p_quantity numeric, p_unit text, p_converted_quantity numeric,
    p_notes text DEFAULT NULL)
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
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;
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
         location_id, notes, created_by)
    VALUES
        (v_company, p_part_id, v_item_name, 'addition', p_quantity, p_unit, p_converted_quantity,
         p_location_id, p_notes, auth.uid());

    SELECT quantity INTO v_rollup FROM public.parts WHERE id = p_part_id;
    RETURN jsonb_build_object('location_balance', v_new_balance, 'part_quantity', v_rollup);
END;
$function$;

-- ============================================================
-- deplete_stock_at_location (graceful clamp under a row lock)
-- ============================================================
CREATE OR REPLACE FUNCTION public.deplete_stock_at_location(
    p_part_id uuid, p_location_id uuid,
    p_quantity numeric, p_unit text, p_converted_quantity numeric,
    p_graceful boolean DEFAULT false,
    p_notes text DEFAULT NULL,
    p_job_id uuid DEFAULT NULL, p_job_operation_id uuid DEFAULT NULL, p_operator_id uuid DEFAULT NULL)
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
$function$;

-- ============================================================
-- adjust_stock_at_location (cycle count -> set balance to target)
-- ============================================================
CREATE OR REPLACE FUNCTION public.adjust_stock_at_location(
    p_part_id uuid, p_location_id uuid,
    p_new_quantity numeric, p_unit text, p_converted_new_quantity numeric,
    p_notes text DEFAULT NULL)
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
         location_id, notes, created_by)
    VALUES
        (v_company, p_part_id, v_item_name, 'adjustment', abs(v_diff), v_primary_unit, abs(v_diff),
         p_location_id, v_notes, auth.uid());

    SELECT quantity INTO v_rollup FROM public.parts WHERE id = p_part_id;
    RETURN jsonb_build_object('location_balance', p_converted_new_quantity, 'part_quantity', v_rollup);
END;
$function$;

-- ============================================================
-- transfer_stock (paired depletion@from + addition@to, one group)
-- ============================================================
CREATE OR REPLACE FUNCTION public.transfer_stock(
    p_part_id uuid, p_from_location_id uuid, p_to_location_id uuid,
    p_quantity numeric, p_unit text, p_converted_quantity numeric,
    p_notes text DEFAULT NULL)
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
         location_id, transfer_group_id, notes, created_by)
    VALUES
        (v_company, p_part_id, v_item_name, 'depletion', p_quantity, p_unit, p_converted_quantity,
         p_from_location_id, v_group, v_from_notes, auth.uid()),
        (v_company, p_part_id, v_item_name, 'addition', p_quantity, p_unit, p_converted_quantity,
         p_to_location_id, v_group, v_to_notes, auth.uid());

    RETURN jsonb_build_object(
        'transfer_group_id', v_group,
        'from_balance', v_from_balance, 'to_balance', v_to_balance);
END;
$function$;

-- ============================================================
-- enable_location_tracking (atomic opt-in + backfill, no double-count)
-- ============================================================
CREATE OR REPLACE FUNCTION public.enable_location_tracking(
    p_part_id uuid, p_initial_location_id uuid DEFAULT NULL)
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
            INSERT INTO public.inventory_locations (company_id, name, kind, is_stockable, is_qr_anchor)
            VALUES (v_company, 'Unassigned', 'system', true, false)
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
$function$;

-- ============================================================
-- disable_location_tracking (collapse balances back; exact order)
-- ============================================================
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
$function$;

-- ============================================================
-- GRANTS — callable via supabase.rpc() by the standard roles
-- ============================================================
GRANT ALL ON FUNCTION public.inv_assert_location_in_company(uuid, uuid) TO anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.add_stock_at_location(uuid, uuid, numeric, text, numeric, text) TO anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.deplete_stock_at_location(uuid, uuid, numeric, text, numeric, boolean, text, uuid, uuid, uuid) TO anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.adjust_stock_at_location(uuid, uuid, numeric, text, numeric, text) TO anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.transfer_stock(uuid, uuid, uuid, numeric, text, numeric, text) TO anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.enable_location_tracking(uuid, uuid) TO anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.disable_location_tracking(uuid) TO anon, authenticated, service_role;
