-- Remove the "markup rates" module. Named, reusable (qty→markup%) templates
-- (`markup_rates`) are gone; each part now owns its markup directly via its
-- `part_pricing_tiers` rows (which already drive every price — no price path
-- ever read `markup_rates`). A new part starts with an unfilled pricing row
-- instead of silently inheriting a company "Default" rate.
--
-- Existing parts keep their tiers untouched (a prior backfill already gave
-- every unconfigured part a real Default-25% tier), so no pricing data is lost
-- — the dropped `parts.markup_rate_id` link was only a cascade pointer.
--
-- Order matters: the seed trigger depends on its function, and the FK column
-- must go before the table it references. Everything else (RLS policies, the
-- updated_at trigger, indexes, unique constraints, grants) is auto-dropped with
-- its owning table/column.

-- 1. Seed trigger depends on seed_default_markup_rates() → drop the trigger first.
DROP TRIGGER IF EXISTS companies_seed_default_markup_rates ON public.companies;
DROP FUNCTION IF EXISTS public.seed_default_markup_rates();

-- 2. Bulk-apply RPC reads markup_rates and writes parts.markup_rate_id → gone.
DROP FUNCTION IF EXISTS public.bulk_apply_markup_rate(uuid, uuid[], uuid);

-- 3. Drop the live-link FK column BEFORE the table (auto-drops the FK
--    constraint parts_markup_rate_id_fkey + index idx_parts_markup_rate_id).
ALTER TABLE public.parts DROP COLUMN IF EXISTS markup_rate_id;

-- 4. Drop the table itself. Cascades to: its RLS policies, the
--    markup_rates_updated_at trigger, idx_markup_rates_company, the
--    markup_rates_one_default_per_company partial unique index, the
--    (company_id, name) unique constraint, and all grants.
DROP TABLE IF EXISTS public.markup_rates;

-- 5. Tighten priceability. Both the parts-list signal (get_priceable_part_ids)
--    and the detail-page explainer (compute_part_cost_explain) previously
--    treated "has any part_pricing_tiers row" as "has a markup". A part now
--    starts with an *unfilled* tier row (markup_percent = NULL), so require a
--    non-null markup — an unfilled row correctly reads "no markup / not
--    priceable" until the user fills it. Bodies copied verbatim from their
--    latest definitions (compute_part_cost_explain: 20260710024144;
--    get_priceable_part_ids: 20260623022617) with only the NULL-markup guard
--    added. Same signatures → CREATE OR REPLACE preserves owner and grants.

CREATE OR REPLACE FUNCTION public.compute_part_cost_explain(p_part_id uuid, p_qty numeric)
RETURNS TABLE(
    unit_cost        numeric,
    missing_leaves   jsonb,
    missing_markups  jsonb,
    missing_op_rates jsonb,
    is_priceable     boolean
)
    LANGUAGE plpgsql
    STABLE
    AS $$
DECLARE
    v_missing_leaves   jsonb;
    v_missing_markups  jsonb;
    v_missing_op_rates jsonb;
    v_unit_cost        numeric;
BEGIN
    WITH RECURSIVE tree(part_id, part_name, source, preferred_vendor_id, cumulative_qty, depth) AS (
        SELECT p.id, p.part_name, p.source, p.preferred_vendor_id, p_qty, 0
          FROM public.parts p
         WHERE p.id = p_part_id

        UNION ALL

        SELECT c.id,
               c.part_name,
               c.source,
               c.preferred_vendor_id,
               t.cumulative_qty *
                   CASE
                       WHEN b.unit IS DISTINCT FROM c.primary_unit THEN
                           b.quantity * COALESCE(
                               (SELECT uc.to_primary_factor
                                  FROM public.parts_unit_conversions uc
                                 WHERE uc.part_id = c.id
                                   AND uc.from_unit = b.unit),
                               1
                           )
                       ELSE b.quantity
                   END,
               t.depth + 1
          FROM tree t
          JOIN public.parts_bom b ON b.parent_part_id = t.part_id
          JOIN public.parts c     ON c.id = b.child_part_id
         WHERE t.source = 'made'
           AND t.depth < 50
    ),
    -- Bought leaves whose procurement-tier lookup returns NULL at the cascaded
    -- qty (unchanged — drives the existing tooltips).
    leaves AS (
        SELECT tr.part_id, tr.part_name, tr.depth, tr.cumulative_qty AS qty_required
          FROM tree tr
         WHERE tr.source = 'bought'
           AND (
               tr.preferred_vendor_id IS NULL
               OR NOT EXISTS (
                   SELECT 1
                     FROM public.part_procurement_tiers t
                    WHERE t.part_id = tr.part_id
                      AND t.vendor_id = tr.preferred_vendor_id
                      AND t.min_quantity <= tr.cumulative_qty
                      AND (t.expires_at IS NULL OR t.expires_at >= CURRENT_DATE)
                   )
           )
    ),
    -- Any part in the tree (root or descendant, made or bought) with no priced
    -- markup — either no pricing tier at all, or only tier rows whose
    -- markup_percent is NULL (an unfilled row). Diamond BOMs can visit a node
    -- more than once — collapse to one row per part.
    markups AS (
        SELECT tr.part_id, tr.part_name, tr.source, MIN(tr.depth) AS depth
          FROM tree tr
         WHERE NOT EXISTS (
                   SELECT 1 FROM public.part_pricing_tiers pt
                    WHERE pt.part_id = tr.part_id
                      AND pt.markup_percent IS NOT NULL
               )
         GROUP BY tr.part_id, tr.part_name, tr.source
    ),
    -- Made nodes in the tree with at least one unpriced routing op. Same
    -- op-pricing predicate get_priceable_part_ids uses (internal: labor rate;
    -- external: external_unit_price).
    op_rates AS (
        SELECT tr.part_id, tr.part_name, MIN(tr.depth) AS depth
          FROM tree tr
          JOIN public.routings r            ON r.part_id = tr.part_id
          JOIN public.routing_operations ro ON ro.routing_id = r.id
          JOIN public.work_centers wc       ON wc.id = ro.work_center_id
         WHERE tr.source = 'made'
           AND (
               (wc.kind = 'internal'
                   AND ro.labor_rate_override IS NULL
                   AND wc.labor_rate IS NULL)
               OR
               (wc.kind <> 'internal'
                   AND ro.external_unit_price IS NULL)
           )
         GROUP BY tr.part_id, tr.part_name
    )
    SELECT
        (SELECT COALESCE(
                    jsonb_agg(
                        jsonb_build_object(
                            'part_id',      l.part_id,
                            'part_name',    l.part_name,
                            'depth',        l.depth,
                            'qty_required', l.qty_required
                        )
                        ORDER BY l.depth DESC, l.part_name ASC
                    ), '[]'::jsonb)
           FROM leaves l),
        (SELECT COALESCE(
                    jsonb_agg(
                        jsonb_build_object(
                            'part_id',   m.part_id,
                            'part_name', m.part_name,
                            'depth',     m.depth,
                            'source',    m.source
                        )
                        ORDER BY m.depth ASC, m.part_name ASC
                    ), '[]'::jsonb)
           FROM markups m),
        (SELECT COALESCE(
                    jsonb_agg(
                        jsonb_build_object(
                            'part_id',   o.part_id,
                            'part_name', o.part_name,
                            'depth',     o.depth
                        )
                        ORDER BY o.depth ASC, o.part_name ASC
                    ), '[]'::jsonb)
           FROM op_rates o)
      INTO v_missing_leaves, v_missing_markups, v_missing_op_rates;

    -- Best-effort cost for display. An unpriced op makes compute_part_cost_at_qty
    -- raise; the gap CTEs (not this value) are authoritative for is_priceable, so
    -- swallow the raise and leave cost NULL rather than aborting the explainer.
    BEGIN
        v_unit_cost := public.compute_part_cost_at_qty(p_part_id, p_qty);
    EXCEPTION WHEN OTHERS THEN
        v_unit_cost := NULL;
    END;

    unit_cost        := v_unit_cost;
    missing_leaves   := v_missing_leaves;
    missing_markups  := v_missing_markups;
    missing_op_rates := v_missing_op_rates;
    is_priceable     := (v_missing_leaves = '[]'::jsonb
                         AND v_missing_markups = '[]'::jsonb
                         AND v_missing_op_rates = '[]'::jsonb);
    RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.compute_part_cost_explain(uuid, numeric) IS
    'Structural pricing status for a part and its BOM tree. Returns unit_cost (best-effort; NULL if a rate/tier is missing), plus three gap arrays — missing_leaves (bought leaves with no procurement tier at the cascaded qty), missing_markups (any tree node with no pricing tier, or only tiers whose markup_percent is NULL), missing_op_rates (made nodes with an unpriced routing op) — and is_priceable (true iff all three are empty). is_priceable matches the canonical rule get_priceable_part_ids enforces for the parts list, so the detail page and list can''t disagree.';

CREATE OR REPLACE FUNCTION public.get_priceable_part_ids(p_company_id uuid)
 RETURNS uuid[]
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_priceable uuid[];
    v_new uuid[];
BEGIN
    -- Base case: bought parts that have at least one pricing tier with a
    -- non-null markup AND a non-expired procurement tier on their preferred vendor.
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
            AND t.markup_percent IS NOT NULL
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
                AND t.markup_percent IS NOT NULL
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
                        AND ro.external_unit_price IS NULL)
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
$function$;
