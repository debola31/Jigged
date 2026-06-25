-- Location-track every stocked part by default, for companies that use
-- inventory locations (the `inventory_locations` feature flag). Removes the
-- per-part "Enable location tracking" opt-in: a stocked part just lands at the
-- system "Unassigned" location and is moved from there. The "Unassigned" bucket
-- is the implicit "not bin-tracked" state — a part left entirely there behaves
-- exactly like a global-quantity item.
--
-- Flag-OFF companies are untouched: their parts stay is_location_tracked=false
-- and keep the global Add/Remove/Adjust path on parts.quantity (the
-- enforce_tracked_part_quantity guard would otherwise block their direct writes).
--
-- Pattern mirrors enable_location_tracking (migration 20260622023407 / 20260623031347):
-- advisory-lock find-or-create "Unassigned" -> flip the flag (quantity unchanged
-- so the guard skips) -> seed the Unassigned balance = parts.quantity (the rollup
-- trigger then keeps parts.quantity = SUM(balances) = the same value).

-- ---------------------------------------------------------------------------
-- Helper: find-or-create a company's system "Unassigned" location.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.inv_get_or_create_unassigned(p_company_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_loc uuid;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('inv_unassigned:' || p_company_id::text));
    SELECT id INTO v_loc
      FROM public.inventory_locations
     WHERE company_id = p_company_id AND name = 'Unassigned';
    IF v_loc IS NULL THEN
        INSERT INTO public.inventory_locations (company_id, name, kind)
        VALUES (p_company_id, 'Unassigned', 'system')
        RETURNING id INTO v_loc;
    END IF;
    RETURN v_loc;
END;
$function$;

REVOKE ALL ON FUNCTION public.inv_get_or_create_unassigned(uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Auto-track trigger: a newly-inserted (or newly-stocked) part at a flag-on
-- company is location-tracked at "Unassigned" with its whole quantity. Fires
-- ONLY on INSERT or an is_stocked change, so explicit is_location_tracked flips
-- (this RPC, enable_location_tracking) never re-enter it and the self-UPDATE of
-- is_location_tracked below doesn't recurse.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auto_track_stocked_part()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_loc  uuid;
    v_flag boolean;
BEGIN
    -- Cheap exits first (no DB read): only stocked, not-yet-tracked parts.
    IF NEW.is_stocked IS NOT TRUE OR NEW.is_location_tracked IS TRUE THEN
        RETURN NULL;
    END IF;
    -- Only companies that use inventory locations.
    SELECT (settings->'features'->>'inventory_locations')::boolean INTO v_flag
      FROM public.companies WHERE id = NEW.company_id;
    IF COALESCE(v_flag, false) IS NOT TRUE THEN
        RETURN NULL;
    END IF;

    v_loc := public.inv_get_or_create_unassigned(NEW.company_id);

    UPDATE public.parts SET is_location_tracked = true WHERE id = NEW.id;

    INSERT INTO public.part_location_stock (company_id, part_id, location_id, quantity)
    VALUES (NEW.company_id, NEW.id, v_loc, NEW.quantity)
    ON CONFLICT (part_id, location_id) DO NOTHING;

    RETURN NULL; -- AFTER trigger
END;
$function$;

DROP TRIGGER IF EXISTS trg_auto_track_stocked_part ON public.parts;
CREATE TRIGGER trg_auto_track_stocked_part
    AFTER INSERT OR UPDATE OF is_stocked ON public.parts
    FOR EACH ROW EXECUTE FUNCTION public.auto_track_stocked_part();

-- ---------------------------------------------------------------------------
-- Bulk backfill: track every stocked, untracked part in a company. Service-role
-- only (admin flag-toggle) + the migration body below. The is_location_tracked
-- flip does NOT fire the trigger above (it's keyed on is_stocked), so the CTE
-- seeds the balances itself with no double-counting.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enable_location_tracking_for_company(p_company_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_loc   uuid;
    v_count integer;
BEGIN
    v_loc := public.inv_get_or_create_unassigned(p_company_id);

    -- Flip stocked+untracked parts to tracked (quantity unchanged -> guard skips)
    -- and seed each one's whole quantity at "Unassigned" in the same statement,
    -- scoped to ONLY the parts just flipped (so already-tracked parts are untouched).
    WITH flipped AS (
        UPDATE public.parts
           SET is_location_tracked = true, updated_at = now()
         WHERE company_id = p_company_id AND is_stocked AND NOT is_location_tracked
        RETURNING id, company_id, quantity
    )
    INSERT INTO public.part_location_stock (company_id, part_id, location_id, quantity)
    SELECT company_id, id, v_loc, quantity FROM flipped
    ON CONFLICT (part_id, location_id) DO NOTHING;
    GET DIAGNOSTICS v_count = ROW_COUNT;

    RETURN jsonb_build_object('location_id', v_loc, 'parts_tracked', v_count);
END;
$function$;

REVOKE ALL ON FUNCTION public.enable_location_tracking_for_company(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enable_location_tracking_for_company(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Backfill every company that already has the inventory_locations flag on.
-- ---------------------------------------------------------------------------
DO $backfill$
DECLARE
    c record;
BEGIN
    FOR c IN
        SELECT id FROM public.companies
         WHERE (settings->'features'->>'inventory_locations')::boolean IS TRUE
    LOOP
        PERFORM public.enable_location_tracking_for_company(c.id);
    END LOOP;
END
$backfill$;
