-- Recompute job_part.fulfillment_status when its order quantity is edited.
--
-- Until now job_parts.quantity was immutable after job creation, so the only
-- thing that moved fulfillment_status was shipment activity (the
-- recompute_job_part_fulfillment_from_line / _from_void trigger family on
-- shipment_line_items + shipments). The new "edit order quantity" feature
-- mutates job_parts.quantity directly, and NONE of those triggers fire on a
-- job_parts UPDATE — so a part that was fully_shipped at qty 10 would wrongly
-- stay fully_shipped after an edit to qty 15.
--
-- This adds the missing edge: an AFTER UPDATE OF quantity trigger that reuses
-- the existing compute_job_part_fulfillment_status() single source of truth
-- (no duplicated TS/SQL logic) and writes the result back. The inner write
-- touches only fulfillment_status, so it fires the existing
-- trigger_sync_job_fulfillment_from_parts_upd rollup to jobs and does NOT
-- re-enter this trigger (quantity is unchanged). pg_trigger_depth() guards
-- against deeper re-entrancy, matching the sibling functions.

CREATE OR REPLACE FUNCTION public.recompute_job_part_fulfillment_from_qty()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_new text;
BEGIN
    IF pg_trigger_depth() > 2 THEN RETURN NULL; END IF;
    -- AFTER trigger: compute_* re-reads job_parts.quantity, which already
    -- holds the new value at this point, so it resolves against NEW.quantity.
    v_new := public.compute_job_part_fulfillment_status(NEW.id);
    IF v_new IS DISTINCT FROM NEW.fulfillment_status THEN
        UPDATE public.job_parts
           SET fulfillment_status = v_new,
               updated_at = now()
         WHERE id = NEW.id;
    END IF;
    RETURN NULL;
END $function$;

DROP TRIGGER IF EXISTS "trigger_recompute_jp_fulfillment_on_qty" ON "public"."job_parts";
CREATE TRIGGER trigger_recompute_jp_fulfillment_on_qty
  AFTER UPDATE OF quantity ON public.job_parts
  FOR EACH ROW
  WHEN (old.quantity IS DISTINCT FROM new.quantity)
  EXECUTE FUNCTION recompute_job_part_fulfillment_from_qty();

COMMENT ON FUNCTION public.recompute_job_part_fulfillment_from_qty() IS
  'Recomputes job_parts.fulfillment_status after an order-quantity edit, via compute_job_part_fulfillment_status. Added with the editable-order-quantity feature (job_parts.quantity was previously immutable).';
