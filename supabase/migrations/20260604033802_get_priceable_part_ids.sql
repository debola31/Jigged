-- get_priceable_part_ids(company_id)
--
-- Returns the set of parts in a company that the quote form would consider
-- "priceable" — same semantic as QuoteForm's `hasUsableTier`: at least one
-- part_pricing_tiers row whose live cost (via compute_part_cost_at_qty)
-- yields a non-null result.
--
-- Wrapped in BEGIN/EXCEPTION WHEN OTHERS to mirror bulk_apply_markup_rate:
-- compute_part_cost_at_qty can both return NULL (e.g. missing procurement
-- tier on a bought part / unpriced BOM child) and RAISE (e.g. missing labor
-- rate, missing external pricing, missing unit conversion). Both outcomes
-- mean "not priceable on this tier" — try the next tier and short-circuit
-- to "priceable" the moment any tier returns non-null.
--
-- O(parts × tiers × bom_depth). Acceptable at shop scale; the upgrade path
-- if it ever hurts is a trigger-maintained parts.is_priceable boolean.
CREATE OR REPLACE FUNCTION public.get_priceable_part_ids(p_company_id uuid)
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_result uuid[] := ARRAY[]::uuid[];
    v_part record;
    v_tier record;
    v_cost numeric;
    v_priceable boolean;
BEGIN
    FOR v_part IN
        SELECT id FROM public.parts WHERE company_id = p_company_id
    LOOP
        v_priceable := false;
        FOR v_tier IN
            SELECT quantity
            FROM public.part_pricing_tiers
            WHERE part_id = v_part.id
              AND quantity > 0
        LOOP
            BEGIN
                v_cost := public.compute_part_cost_at_qty(v_part.id, v_tier.quantity);
                IF v_cost IS NOT NULL THEN
                    v_priceable := true;
                    EXIT;
                END IF;
            EXCEPTION WHEN OTHERS THEN
                -- treat raises (missing labor rate / external pricing /
                -- unit conversion) as "not priceable on this tier" — same
                -- as bulk_apply_markup_rate's price_uncomputed accounting.
                NULL;
            END;
        END LOOP;
        IF v_priceable THEN
            v_result := array_append(v_result, v_part.id);
        END IF;
    END LOOP;
    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.get_priceable_part_ids(uuid) IS
    'Returns the set of part ids in a company that have at least one pricing tier yielding a non-null cost via compute_part_cost_at_qty. Same semantic as QuoteForm.hasUsableTier — drives the Parts list "Pricing" column.';

-- Surface to authenticated callers only. RLS on parts/part_pricing_tiers
-- already scopes the underlying SELECTs to the caller's company access.
GRANT EXECUTE ON FUNCTION public.get_priceable_part_ids(uuid) TO authenticated;
