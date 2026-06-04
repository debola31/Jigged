-- Replace get_priceable_part_ids with a set-based structural check.
--
-- The original (migration 20260604033802) called compute_part_cost_at_qty
-- once per tier per part, which walked routing + BOM recursively and hit
-- the Supabase authenticated statement_timeout (8s) on real-world shops.
--
-- This version answers the same question structurally without ever calling
-- compute_part_cost_at_qty: a part is "priceable" iff
--   * it has at least one part_pricing_tier row, AND either
--   * it is bought with a non-expired procurement tier on its preferred
--     vendor, OR
--   * it is made with every routing op fully priced (internal: labor rate;
--     external: external_unit_price or external_setup_cost) AND every BOM
--     child is itself priceable (transitive closure via fixed-point loop).
--
-- This is a slightly looser signal than the quote form's hasUsableTier:
-- it skips the procurement_tier.min_quantity ≤ pricing_tier.quantity match
-- and the unit-conversion existence check. Acceptable for a navigational
-- "what to fix" indicator on the parts list — quote form remains the
-- authoritative check at quote time.
--
-- Per-iteration cost is a single set-based SELECT. Iteration count is
-- bounded by max BOM depth (typically 2-5). Runs in tens of milliseconds.
CREATE OR REPLACE FUNCTION public.get_priceable_part_ids(p_company_id uuid)
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_priceable uuid[];
    v_new uuid[];
BEGIN
    -- Base case: bought parts that have at least one pricing tier AND a
    -- non-expired procurement tier on their preferred vendor.
    SELECT COALESCE(array_agg(DISTINCT p.id), ARRAY[]::uuid[])
    INTO v_priceable
    FROM public.parts p
    WHERE p.company_id = p_company_id
      AND p.source = 'bought'
      AND p.preferred_vendor_id IS NOT NULL
      AND EXISTS (
          SELECT 1
          FROM public.part_pricing_tiers t
          WHERE t.part_id = p.id
      )
      AND EXISTS (
          SELECT 1
          FROM public.part_procurement_tiers pt
          WHERE pt.part_id = p.id
            AND pt.vendor_id = p.preferred_vendor_id
            AND (pt.expires_at IS NULL OR pt.expires_at >= CURRENT_DATE)
      );

    -- Fixed-point: add made parts whose routing is complete and whose BOM
    -- children (if any) are all already in v_priceable. Loop terminates
    -- when no new parts are added — bounded by BOM depth.
    LOOP
        SELECT COALESCE(array_agg(p.id), ARRAY[]::uuid[])
        INTO v_new
        FROM public.parts p
        WHERE p.company_id = p_company_id
          AND p.source = 'made'
          AND NOT (p.id = ANY(v_priceable))
          AND EXISTS (
              SELECT 1
              FROM public.part_pricing_tiers t
              WHERE t.part_id = p.id
          )
          -- Every routing op (if any) must have full pricing. NOT EXISTS
          -- with an unpriced op is the negative form of "all priced".
          AND NOT EXISTS (
              SELECT 1
              FROM public.routings r
              JOIN public.routing_operations ro ON ro.routing_id = r.id
              JOIN public.work_centers wc ON wc.id = ro.work_center_id
              WHERE r.part_id = p.id
                AND (
                    (wc.kind = 'internal'
                        AND ro.labor_rate_override IS NULL
                        AND wc.labor_rate IS NULL)
                    OR
                    (wc.kind <> 'internal'
                        AND ro.external_unit_price IS NULL
                        AND ro.external_setup_cost IS NULL)
                )
          )
          -- Every BOM child must already be priceable. A made part with no
          -- BOM children passes this check trivially (NOT EXISTS over empty).
          AND NOT EXISTS (
              SELECT 1
              FROM public.parts_bom b
              WHERE b.parent_part_id = p.id
                AND NOT (b.child_part_id = ANY(v_priceable))
          );

        EXIT WHEN cardinality(v_new) = 0;
        v_priceable := v_priceable || v_new;
    END LOOP;

    RETURN v_priceable;
END;
$$;

COMMENT ON FUNCTION public.get_priceable_part_ids(uuid) IS
    'Returns the set of part ids in a company that have at least one pricing tier and a structurally complete cost chain (bought: procurement on preferred vendor; made: all routing ops priced and all BOM children priceable). Set-based, fast — slightly looser than QuoteForm.hasUsableTier (skips procurement min_qty match and unit-conversion check). Drives the Parts list "Pricing" column.';

GRANT EXECUTE ON FUNCTION public.get_priceable_part_ids(uuid) TO authenticated;
