-- Drop the dead `part_pricing_tiers.unit_price` column.
--
-- The TS read path computes tier prices live from the part's routing + BOM via
-- `getTiersWithComputedPrices` (utils/partPricingTiersAccess.ts); the stored
-- column was a denormalized cache that no code path reads any more. Two
-- writers still touched it defensively:
--   * `replaceTiersForPart` wrote `unit_price: null` on UPDATE (now removed
--     in the TS change shipping with this migration).
--   * `bulk_apply_markup_rate` (this function) INSERTed it. We replace the
--     function below to drop that write, then drop the column.
--
-- Function-replace runs first so there's never a window where the live
-- function references a column that no longer exists.

BEGIN;

CREATE OR REPLACE FUNCTION public.bulk_apply_markup_rate(
    p_company_id uuid,
    p_part_ids   uuid[],
    p_rate_id    uuid
) RETURNS jsonb
LANGUAGE plpgsql
SET statement_timeout = '120s'
AS $$
DECLARE
    v_rate_breakpoints jsonb;
    v_part_id          uuid;
    v_qty              integer;
    v_markup           numeric;
    v_sequence         integer;
    v_base_cost        numeric;
    v_has_null_price   boolean;
    v_updated          integer := 0;
    v_price_uncomputed integer := 0;
    v_failed           jsonb := '[]'::jsonb;
BEGIN
    SELECT breakpoints INTO v_rate_breakpoints
    FROM public.markup_rates
    WHERE id = p_rate_id AND company_id = p_company_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Markup rate % not found in company %', p_rate_id, p_company_id;
    END IF;

    FOREACH v_part_id IN ARRAY p_part_ids LOOP
        BEGIN
            v_has_null_price := false;
            v_sequence := 0;

            DELETE FROM public.part_pricing_tiers WHERE part_id = v_part_id;

            FOR v_qty, v_markup IN
                SELECT FLOOR((bp->>'qty')::numeric)::integer,
                       (bp->>'markup_percent')::numeric
                FROM jsonb_array_elements(v_rate_breakpoints) bp
                WHERE (bp->>'qty')::numeric > 0
                ORDER BY (bp->>'qty')::numeric ASC
            LOOP
                v_sequence := v_sequence + 10;

                -- Still call compute_part_cost_at_qty so the per-part
                -- "price uncomputed" flag returned to the UI stays accurate.
                -- We just no longer persist the resulting unit price.
                BEGIN
                    v_base_cost := public.compute_part_cost_at_qty(v_part_id, v_qty);
                    IF v_base_cost IS NULL THEN
                        v_has_null_price := true;
                    END IF;
                EXCEPTION WHEN OTHERS THEN
                    v_has_null_price := true;
                END;

                INSERT INTO public.part_pricing_tiers
                    (part_id, company_id, sequence, quantity, markup_percent)
                VALUES
                    (v_part_id, p_company_id, v_sequence, v_qty, v_markup);
            END LOOP;

            UPDATE public.parts
                SET markup_rate_id = p_rate_id
              WHERE id = v_part_id;

            v_updated := v_updated + 1;
            IF v_has_null_price THEN
                v_price_uncomputed := v_price_uncomputed + 1;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            v_failed := v_failed || jsonb_build_object(
                'part_id', v_part_id,
                'error',   SQLERRM
            );
        END;
    END LOOP;

    RETURN jsonb_build_object(
        'updated',          v_updated,
        'price_uncomputed', v_price_uncomputed,
        'failed',           v_failed
    );
END;
$$;

ALTER TABLE public.part_pricing_tiers DROP COLUMN unit_price;

COMMIT;
