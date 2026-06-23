-- Allow fractional order quantities end-to-end for parts measured in non-count
-- units (length / weight / volume / area / time) — e.g. selling 0.32 inches of
-- material. The whole-number assumption only holds for count units; the app now
-- accepts up to 4 decimal places uniformly (the UI is the precision authority).
--
-- Every column below holds a quantity that flows along the pricing -> quote ->
-- job -> shipment chain. Widening to unbounded `numeric` mirrors the existing
-- part_procurement_tiers.min_quantity column and is lossless: every current
-- integer / numeric(12,2) value fits unchanged, so no backfill is required. The
-- existing `quantity > 0` CHECK constraints survive ALTER COLUMN ... TYPE and
-- need no drop/recreate.

ALTER TABLE public.part_pricing_tiers
  ALTER COLUMN quantity TYPE numeric USING quantity::numeric;

ALTER TABLE public.quote_line_items
  ALTER COLUMN quantity TYPE numeric USING quantity::numeric;

ALTER TABLE public.job_parts
  ALTER COLUMN quantity TYPE numeric USING quantity::numeric;

-- Shipment qty was numeric(12,2). Widen so a 4-dp job_part quantity (e.g. a
-- fractional-inch order like 0.1875") can be shipped exactly — otherwise the
-- fulfillment status could never reach 'fully_shipped' for sub-cent fractions.
--
-- trigger_recompute_jp_fulfillment_on_line_upd fires AFTER UPDATE OF "quantity"
-- on this table, so Postgres refuses to alter the column type while it exists
-- (SQLSTATE 0A000). Drop it, alter, then recreate it verbatim from the baseline.
DROP TRIGGER IF EXISTS "trigger_recompute_jp_fulfillment_on_line_upd"
  ON public.shipment_line_items;

ALTER TABLE public.shipment_line_items
  ALTER COLUMN quantity TYPE numeric USING quantity::numeric;

CREATE TRIGGER "trigger_recompute_jp_fulfillment_on_line_upd"
  AFTER UPDATE OF "quantity", "job_part_id", "shipment_id" ON "public"."shipment_line_items"
  FOR EACH ROW EXECUTE FUNCTION "public"."recompute_job_part_fulfillment_from_line"();

-- get_ready_operations_for_station returns part_quantity as the job_part order
-- quantity (jp.quantity). Its RETURNS TABLE column was typed `integer`, which
-- would truncate a fractional quantity in the shop-floor station view. Re-type
-- it to `numeric`. Changing an OUT/TABLE column type is not allowed via
-- CREATE OR REPLACE, so drop and recreate (no SQL object depends on it — the
-- only callers are app-side RPCs). Body is unchanged from the baseline.
DROP FUNCTION IF EXISTS "public"."get_ready_operations_for_station"("uuid", "uuid");

CREATE OR REPLACE FUNCTION "public"."get_ready_operations_for_station"("p_company_id" "uuid", "p_work_center_id" "uuid") RETURNS TABLE("job_id" "uuid", "job_part_id" "uuid", "job_operation_id" "uuid", "operation_name" "text", "op_status" "text", "job_number" "text", "part_id" "uuid", "part_name" "text", "part_description" "text", "part_quantity" numeric)
    LANGUAGE "plpgsql" STABLE
    AS $$
BEGIN
    RETURN QUERY
    WITH eligible_jobs AS (
        SELECT j.id, j.job_number FROM jobs j
        WHERE j.company_id = p_company_id
          AND j.status IN ('not_started', 'in_progress')
    ),
    station_ops AS (
        SELECT jo.id, jo.job_id, jo.job_part_id, jo.operation_name, jo.status, jo.sequence, ej.job_number
        FROM job_operations jo
        JOIN eligible_jobs ej ON ej.id = jo.job_id
        WHERE jo.work_center_id = p_work_center_id
          AND jo.status IN ('pending', 'in_progress')
    ),
    ready_or_active AS (
        SELECT so.id, so.job_id, so.job_part_id, so.operation_name, so.status, so.job_number
        FROM station_ops so
        WHERE so.status = 'in_progress'
           OR NOT EXISTS (
               SELECT 1 FROM job_operations prev
               WHERE prev.job_part_id = so.job_part_id
                 AND prev.sequence < so.sequence
                 AND prev.status <> 'completed'
           )
    )
    SELECT
        ra.job_id,
        ra.job_part_id,
        ra.id AS job_operation_id,
        ra.operation_name,
        ra.status AS op_status,
        ra.job_number,
        jp.part_id,
        p.part_name,
        p.description AS part_description,
        jp.quantity AS part_quantity
    FROM ready_or_active ra
    JOIN job_parts jp ON jp.id = ra.job_part_id
    JOIN parts p ON p.id = jp.part_id;
END;
$$;

ALTER FUNCTION "public"."get_ready_operations_for_station"("p_company_id" "uuid", "p_work_center_id" "uuid") OWNER TO "postgres";
