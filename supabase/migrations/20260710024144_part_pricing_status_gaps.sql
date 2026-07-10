-- Make the part-detail cost explainer agree with the parts-list priceability
-- signal (get_priceable_part_ids), and surface *why* a part isn't ready.
--
-- Before: the detail page derived isPriceable from compute_part_cost_explain's
-- unit_cost (non-null == ready). That only checks the cost *resolves* — it never
-- required a markup at any level. So a part whose made sub-part had no markup of
-- its own still showed "ready" on the detail page while the parts list correctly
-- flagged it "Incomplete" (get_priceable_part_ids requires every part in the BOM
-- tree to have a pricing tier). Two disagreeing sources of truth.
--
-- After: compute_part_cost_explain returns the full structural gap set for the
-- part and its BOM tree — missing_leaves (bought leaves with no procurement tier,
-- unchanged), missing_markups (any tree node with no pricing tier), and
-- missing_op_rates (made nodes with an unpriced routing op) — plus is_priceable,
-- which is true iff all three are empty. That verdict now matches the canonical
-- rule get_priceable_part_ids already enforces for the list, and the UI can name
-- the offending sub-part instead of silently showing "ready".
--
-- Adding OUT columns changes the return type, so the function must be dropped and
-- recreated (CREATE OR REPLACE can't change OUT params); grants are re-applied.

DROP FUNCTION IF EXISTS public.compute_part_cost_explain(uuid, numeric);

CREATE FUNCTION public.compute_part_cost_explain(p_part_id uuid, p_qty numeric)
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
    -- qty (unchanged from the previous version — drives the existing tooltips).
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
    -- Any part in the tree (root or descendant, made or bought) with no pricing
    -- tier. Mirrors get_priceable_part_ids's EXISTS(part_pricing_tiers) gate.
    -- Diamond BOMs can visit a node more than once — collapse to one row per part.
    markups AS (
        SELECT tr.part_id, tr.part_name, tr.source, MIN(tr.depth) AS depth
          FROM tree tr
         WHERE NOT EXISTS (
                   SELECT 1 FROM public.part_pricing_tiers pt
                    WHERE pt.part_id = tr.part_id
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

ALTER FUNCTION public.compute_part_cost_explain(uuid, numeric) OWNER TO postgres;

COMMENT ON FUNCTION public.compute_part_cost_explain(uuid, numeric) IS
    'Structural pricing status for a part and its BOM tree. Returns unit_cost (best-effort; NULL if a rate/tier is missing), plus three gap arrays — missing_leaves (bought leaves with no procurement tier at the cascaded qty), missing_markups (any tree node with no pricing tier), missing_op_rates (made nodes with an unpriced routing op) — and is_priceable (true iff all three are empty). is_priceable matches the canonical rule get_priceable_part_ids enforces for the parts list, so the detail page and list can''t disagree.';

GRANT ALL ON FUNCTION public.compute_part_cost_explain(uuid, numeric) TO anon;
GRANT ALL ON FUNCTION public.compute_part_cost_explain(uuid, numeric) TO authenticated;
GRANT ALL ON FUNCTION public.compute_part_cost_explain(uuid, numeric) TO service_role;
