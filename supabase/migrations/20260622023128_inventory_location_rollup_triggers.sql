-- Inventory Locations — rollup + invariant-guard triggers (PR1 of 2)
--
-- Establishes the data-at-rest invariant for location-tracked parts:
--     parts.quantity == COALESCE(SUM(part_location_stock.quantity), 0)
--
-- Two triggers cooperate:
--   1. recompute_part_quantity_from_locations (AFTER on part_location_stock):
--      whenever a balance row changes, recompute the owning part's rollup from
--      the authoritative SUM — never from NEW-OLD deltas, so concurrent writers
--      cannot drift. Only acts on location-tracked parts.
--   2. enforce_tracked_part_quantity (BEFORE UPDATE on parts): rejects any direct
--      quantity write on a tracked part that does not equal the current SUM. The
--      rollup's own write (= exactly that SUM) passes; an arbitrary client write
--      (e.g. a raw PostgREST PATCH that RLS would otherwise allow) fails. This is
--      what makes the invariant real rather than enforced only in the access layer.

-- ---- 1. Rollup: balance change -> recompute parts.quantity ----------------
CREATE OR REPLACE FUNCTION public.recompute_part_quantity_from_locations()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_part_id uuid := COALESCE(NEW.part_id, OLD.part_id);
    v_tracked boolean;
BEGIN
    SELECT is_location_tracked INTO v_tracked FROM public.parts WHERE id = v_part_id;

    IF COALESCE(v_tracked, false) THEN
        UPDATE public.parts
           SET quantity = COALESCE(
                   (SELECT SUM(quantity) FROM public.part_location_stock WHERE part_id = v_part_id),
                   0),
               updated_at = now()
         WHERE id = v_part_id;
    END IF;

    RETURN NULL; -- AFTER trigger: return value is ignored
END;
$function$;

DROP TRIGGER IF EXISTS "trg_recompute_part_quantity" ON "public"."part_location_stock";
CREATE TRIGGER "trg_recompute_part_quantity"
    AFTER INSERT OR UPDATE OR DELETE ON "public"."part_location_stock"
    FOR EACH ROW EXECUTE FUNCTION public.recompute_part_quantity_from_locations();

-- ---- 2. Guard: reject direct parts.quantity writes on tracked parts --------
CREATE OR REPLACE FUNCTION public.enforce_tracked_part_quantity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_expected numeric;
BEGIN
    IF NEW.is_location_tracked AND NEW.quantity IS DISTINCT FROM OLD.quantity THEN
        v_expected := COALESCE(
            (SELECT SUM(quantity) FROM public.part_location_stock WHERE part_id = NEW.id),
            0);

        IF NEW.quantity IS DISTINCT FROM v_expected THEN
            RAISE EXCEPTION 'parts.quantity for location-tracked part % is maintained from part_location_stock; direct quantity writes are not allowed (attempted %, expected %)',
                NEW.id, NEW.quantity, v_expected
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS "trg_enforce_tracked_part_quantity" ON "public"."parts";
CREATE TRIGGER "trg_enforce_tracked_part_quantity"
    BEFORE UPDATE ON "public"."parts"
    FOR EACH ROW EXECUTE FUNCTION public.enforce_tracked_part_quantity();
