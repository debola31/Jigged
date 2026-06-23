-- Allow deleting a location whose ENTIRE subtree is empty.
--
-- Previously delete_location refused any location that had children ("delete or
-- move them first"). A shop owner who built a cabinet of empty rows/bins then
-- wants to throw the whole cabinet out should be able to. New behavior: a
-- location is deletable when NO location in its subtree holds qty>0 stock; the
-- empty subtree (and its leftover zero-qty balance rows) is cascade-deleted.
-- Refuse only when some descendant still holds stock. Historical ledger rows
-- keep their location_name snapshot; their location_id is nulled by the FK
-- (ON DELETE SET NULL).

CREATE OR REPLACE FUNCTION public.delete_location(p_location_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company uuid;
    v_guard   integer := 0;
BEGIN
    SELECT company_id INTO v_company FROM public.inventory_locations WHERE id = p_location_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'location % not found', p_location_id USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Refuse only if any location in the subtree still holds stock.
    IF EXISTS (
        WITH RECURSIVE sub AS (
            SELECT id FROM public.inventory_locations WHERE id = p_location_id
            UNION ALL
            SELECT l.id FROM public.inventory_locations l JOIN sub s ON l.parent_id = s.id
        )
        SELECT 1
          FROM public.part_location_stock pls
          JOIN sub ON pls.location_id = sub.id
         WHERE pls.quantity > 0
    ) THEN
        RAISE EXCEPTION 'location subtree still holds stock' USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- Drop leftover zero-qty balance rows across the subtree (clients can't —
    -- part_location_stock is SELECT-only). part_location_stock.location_id is
    -- ON DELETE RESTRICT, so these must go before their locations.
    DELETE FROM public.part_location_stock
     WHERE location_id IN (
        WITH RECURSIVE sub AS (
            SELECT id FROM public.inventory_locations WHERE id = p_location_id
            UNION ALL
            SELECT l.id FROM public.inventory_locations l JOIN sub s ON l.parent_id = s.id
        )
        SELECT id FROM sub
     );

    -- Delete the subtree bottom-up. inventory_locations.parent_id is ON DELETE
    -- RESTRICT, so a parent can't be removed while children exist; repeatedly
    -- delete the current leaves of the subtree until the target is gone.
    LOOP
        v_guard := v_guard + 1;
        IF v_guard > 1000 THEN
            RAISE EXCEPTION 'delete_location: subtree too deep or cyclic for %', p_location_id;
        END IF;

        DELETE FROM public.inventory_locations loc
         WHERE loc.id IN (
            WITH RECURSIVE sub AS (
                SELECT id FROM public.inventory_locations WHERE id = p_location_id
                UNION ALL
                SELECT l.id FROM public.inventory_locations l JOIN sub s ON l.parent_id = s.id
            )
            SELECT s.id
              FROM sub s
             WHERE NOT EXISTS (
                SELECT 1 FROM public.inventory_locations c WHERE c.parent_id = s.id
             )
         );

        EXIT WHEN NOT EXISTS (SELECT 1 FROM public.inventory_locations WHERE id = p_location_id);
    END LOOP;
END;
$function$;

COMMENT ON FUNCTION public.delete_location(uuid) IS 'Delete a location and its empty subtree. Refuses only if some descendant still holds qty>0 stock; cascade-removes empty sub-locations and their zero-qty balance rows bottom-up. Ledger rows keep location_name; location_id is nulled by the FK.';
