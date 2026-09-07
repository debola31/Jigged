-- ============================================================================
-- Recording a heat on a receipt IS the decision to trace that part
-- ============================================================================
-- 20260906121901 built the per-part flag and left nothing able to set it. That
-- is not an oversight to patch with a settings screen -- the founder described
-- the behaviour directly:
--
--   "I wonder if we should have a setting per part that once someone adds a
--    heat number to it, then it becomes a tracked part so we only enforce
--    things as necessary."
--
-- Read it as written and the flag is not a setting at all. It is a CONSEQUENCE.
-- Nobody goes looking for a preference; they write down the number off the mill
-- tag because this is the bar they will have to account for, and the software
-- notices. A shop holds thousands of parts and a handful of bar and plate is
-- what needs tracing, so enforcement that switches itself on for exactly the
-- items someone bothered to record a heat against is enforcement that lands
-- where it was wanted and nowhere else.
--
-- WHY IT LIVES IN THE RPC AND NOT IN THE BROWSER. Two writers would be two
-- answers. A dialog that flipped the flag before calling the RPC would leave a
-- part tracked when the receipt then failed, and would never fire for the CSV
-- importer or a future PO receipt -- both of which already call this function
-- with p_heat_number. Here there is exactly one path from "a heat was recorded"
-- to "this part is traced", and nothing can take a different one.
--
-- WHY IT DELEGATES TO set_part_lot_tracking RATHER THAN SETTING THE COLUMN.
-- Flipping the flag alone would break the invariant the flag exists to state.
-- Stock already on this part's shelves sits in lot-less rows; tracked, those
-- rows can never be removed, because a take of a tracked part must name a lot
-- and they have none. `set_part_lot_tracking` migrates them into a PRE-TRACKING
-- lot in the same statement, which is why it is an RPC and not an UPDATE. The
-- rule being honoured is CLAUDE.md's "no silent runtime fallbacks for
-- data-at-rest issues": the invariant holds at rest the moment the flag turns
-- on, rather than being patched by an "if the lot is missing" branch on every
-- read for the rest of the part's life.
--
-- WHAT IT DELIBERATELY DOES NOT DO:
--   * It never turns tracking OFF. A receipt with no heat against a tracked
--     part is ordinary -- untagged material still arrives -- and it mints a
--     code rather than quietly ending the traceability of everything else.
--     Switching off stays a deliberate act through set_part_lot_tracking.
--   * It does not fire on p_lot_id alone. Passing a lot id means "add to the
--     lot I already picked", which is only reachable for a part that is already
--     tracked; it is not a new assertion about the part.
--   * It does not fire on a blank or whitespace heat. The normalisation the
--     ledger trigger applies is applied to the DECISION too, so "  " cannot
--     start tracing a part that nobody meant to trace.
--
-- The only function body that changes is add_stock_at_location's. DROP would
-- destroy the ACL and the COMMENT, so this is a CREATE OR REPLACE -- the
-- signature is identical.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.add_stock_at_location(
    p_part_id uuid,
    p_location_id uuid,
    p_quantity numeric,
    p_unit text,
    p_converted_quantity numeric,
    p_notes text DEFAULT NULL::text,
    p_operator_id uuid DEFAULT NULL::uuid,
    p_photo_path text DEFAULT NULL::text,
    p_heat_number text DEFAULT NULL::text,
    p_lot_id uuid DEFAULT NULL::uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company uuid; v_item_name text; v_tracked boolean;
    v_lot uuid; v_heat text;
    v_new_balance numeric; v_rollup numeric;
    v_started_tracking boolean := false;
BEGIN
    IF p_quantity <= 0 OR p_converted_quantity <= 0 THEN
        RAISE EXCEPTION 'Quantity must be positive' USING ERRCODE = 'check_violation';
    END IF;

    SELECT company_id, part_name, lot_tracked
      INTO v_company, v_item_name, v_tracked
      FROM public.parts WHERE id = p_part_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'part % not found', p_part_id USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM public.inv_assert_can_write(v_company);
    PERFORM public.inv_assert_location_in_company(p_location_id, v_company);

    -- The first real heat on an untraced part is the decision to trace it.
    -- Normalised the same way the ledger normalises, so "  " decides nothing.
    IF NOT v_tracked AND NULLIF(btrim(COALESCE(p_heat_number, '')), '') IS NOT NULL THEN
        -- BEFORE the insert below, so the stock arriving now lands in its own
        -- real lot and only the PRE-EXISTING lot-less balances are migrated.
        PERFORM public.set_part_lot_tracking(p_part_id, true);
        v_tracked := true;
        v_started_tracking := true;
    END IF;

    -- Mint on the way IN, so a tracked bar that arrives untagged is still storable.
    v_lot := public.resolve_lot(v_company, p_part_id, p_lot_id, p_heat_number, true, v_tracked);
    SELECT heat_number INTO v_heat FROM public.material_lots WHERE id = v_lot;

    INSERT INTO public.part_location_stock AS pls (company_id, part_id, location_id, lot_id, quantity)
    VALUES (v_company, p_part_id, p_location_id, v_lot, p_converted_quantity)
    ON CONFLICT (part_id, location_id, lot_key)
        DO UPDATE SET quantity = pls.quantity + EXCLUDED.quantity
    RETURNING pls.quantity INTO v_new_balance;

    INSERT INTO public.inventory_transactions
        (company_id, part_id, item_name, type, quantity, unit, converted_quantity,
         location_id, notes, operator_id, photo_path, heat_number, lot_id, created_by)
    VALUES
        (v_company, p_part_id, v_item_name, 'addition', p_quantity, p_unit, p_converted_quantity,
         p_location_id, p_notes, p_operator_id, p_photo_path, v_heat, v_lot, auth.uid());

    SELECT quantity INTO v_rollup FROM public.parts WHERE id = p_part_id;
    -- `started_tracking` is returned so the UI can SAY what just happened. A part
    -- that silently begins demanding a heat on every removal is the surprise this
    -- whole design is trying to avoid; the dialog that caused it is the only place
    -- that can explain it at the moment it becomes true.
    RETURN jsonb_build_object('location_balance', v_new_balance, 'part_quantity', v_rollup,
                              'lot_id', v_lot, 'started_tracking', v_started_tracking);
END;
$function$;

COMMENT ON FUNCTION public.add_stock_at_location(uuid, uuid, numeric, text, numeric, text, uuid, text, text, uuid) IS
  'Stock a part into a location. Recording a heat on an untraced part turns tracking ON for it (and migrates its lot-less balances), because writing down a mill heat IS the decision to trace that part -- there is no separate setting. Resolves the lot -- an explicit p_lot_id, else the typed heat, else a minted code when the part is tracked, else none -- so the balance is keyed by (part, location, lot). Returns started_tracking so the caller can say what just happened.';


-- ============================================================================
-- Guards
-- ============================================================================
-- CREATE OR REPLACE keeps the ACL, but "keeps" is the claim being tested: the
-- allowlist in function_execute_leaks() names this function, so a lost grant
-- would not show up there as a leak -- it would show up as a browser that can
-- no longer receive stock, at runtime, in a shop.
DO $$
BEGIN
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'add_stock_at_location') <> 1 THEN
        RAISE EXCEPTION 'add_stock_at_location must have exactly one overload';
    END IF;

    IF NOT has_function_privilege('authenticated',
        'public.add_stock_at_location(uuid, uuid, numeric, text, numeric, text, uuid, text, text, uuid)',
        'EXECUTE') THEN
        RAISE EXCEPTION 'authenticated lost EXECUTE on add_stock_at_location';
    END IF;

    IF has_function_privilege('anon',
        'public.add_stock_at_location(uuid, uuid, numeric, text, numeric, text, uuid, text, text, uuid)',
        'EXECUTE') THEN
        RAISE EXCEPTION 'anon must not execute add_stock_at_location';
    END IF;
END $$;
