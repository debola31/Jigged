-- Migration: Single-call bulk apply of a markup rate to many parts.
--
-- Why: the client-side bulkApplyMarkupRate previously looped replaceTiersForPart
-- per part, with ~10 round-trips per part (existing-tier SELECT, DELETE diff,
-- N×(compute_part_cost_at_qty RPC + INSERT), parts FK UPDATE, return-tier SELECT).
-- At 8000 parts that crossed 10+ minutes even with client-side concurrency.
-- One RPC collapses it to a single round-trip plus server-local work.
--
-- Semantics mirror replaceTiersForPart + applyRateToPart:
--   * Replaces each part's tiers with the rate's breakpoints, sequence 10/20/...
--   * unit_price = base_cost * (1 + markup_percent/100), where base_cost is
--     compute_part_cost_at_qty(part_id, breakpoint_qty)
--   * When compute_part_cost_at_qty RAISES (missing op rate, missing external
--     pricing, missing unit conversion) or returns NULL (bought leaf with no
--     procurement tier), unit_price is stored NULL. Matches the try/catch in
--     utils/partPricingTiersAccess.ts so the UI surfaces the gap instead of
--     persisting a wrong price.
--   * Sets parts.markup_rate_id to the applied rate (live-link semantics).
--   * Per-part errors collected; batch never aborts on a single failure.
--
-- Default SECURITY INVOKER so RLS applies — caller can only touch parts/tiers
-- in companies they have access to, matching every other write path.
--
-- Return shape: jsonb { updated: int, price_uncomputed: int,
--                       failed: [{ part_id: uuid, error: text }] }

BEGIN;

-- statement_timeout: bumped from the default authenticated-role limit (8s on
-- Supabase) because each part runs compute_part_cost_at_qty per breakpoint, and
-- the client still chunks at a few hundred parts per call. 2 minutes gives a
-- chunk plenty of headroom while still bounding a runaway call. Function-level
-- SET only applies while inside this function — it doesn't leak to the session.
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
    v_unit_price       numeric;
    v_has_null_price   boolean;
    v_updated          integer := 0;
    v_price_uncomputed integer := 0;
    v_failed           jsonb := '[]'::jsonb;
BEGIN
    -- Lookup rate. RLS on markup_rates restricts to the caller's companies, so
    -- a mismatched p_company_id will simply not find the row.
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

                -- Cost compute can RAISE (missing rate / external pricing /
                -- unit conversion) or return NULL (bought leaf with no
                -- procurement tier). Either way: store NULL unit_price, flag
                -- the part, keep going. The outer SQL block's commit is what
                -- locks tier rows in, so a nested EXCEPTION here doesn't lose
                -- the DELETE we already issued.
                BEGIN
                    v_base_cost := public.compute_part_cost_at_qty(v_part_id, v_qty);
                    IF v_base_cost IS NULL THEN
                        v_unit_price := NULL;
                        v_has_null_price := true;
                    ELSE
                        v_unit_price := v_base_cost * (1 + v_markup / 100);
                    END IF;
                EXCEPTION WHEN OTHERS THEN
                    v_unit_price := NULL;
                    v_has_null_price := true;
                END;

                INSERT INTO public.part_pricing_tiers
                    (part_id, company_id, sequence, quantity, markup_percent, unit_price)
                VALUES
                    (v_part_id, p_company_id, v_sequence, v_qty, v_markup, v_unit_price);
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

COMMENT ON FUNCTION public.bulk_apply_markup_rate(uuid, uuid[], uuid) IS
'Apply a markup rate to many parts in one round-trip. Replaces each part''s '
'pricing tiers with the rate''s breakpoints and sets parts.markup_rate_id. '
'Per-part errors are collected, never abort the batch. Returns jsonb with '
'{updated, price_uncomputed, failed[]}.';

COMMIT;
