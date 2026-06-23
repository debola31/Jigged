-- Drop the per-location display flags is_stockable + is_qr_anchor.
--
-- Product decision: every location can hold stock, and every location is
-- printable — so these two flags were bogus. The app stopped reading them in
-- the #419 changes (PartLocationInventory filter, the Print-QR anchor guard, the
-- builder QR-depth selector + LocationSpecNode fields all removed); they have
-- since been vestigial NOT-NULL columns. No RPC / trigger / RLS policy reads
-- them — the ONLY remaining reference is enable_location_tracking's INSERT of
-- the system "Unassigned" location, updated below.

-- Re-create enable_location_tracking without the two columns in its INSERT
-- (the column defaults previously supplied true/false). Body is otherwise
-- identical to migration 20260622023407.
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
$function$;

-- Now the columns are unreferenced everywhere — drop them.
ALTER TABLE public.inventory_locations
    DROP COLUMN IF EXISTS is_stockable,
    DROP COLUMN IF EXISTS is_qr_anchor;
