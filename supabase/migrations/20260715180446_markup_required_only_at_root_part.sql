-- Markup is required only on the part being quoted — not on its materials.
--
-- A material's markup is never used when it's consumed inside another part: the
-- parent applies its own markup to the rolled-up cost. So a child material
-- without a markup should NOT block quoting the parent (it only needs to be
-- COSTABLE). This re-resolves the old #12 agreement (which chose to require a
-- markup on every tree node) in the correct direction for the standard-costing
-- model: a part is quotable iff its cost resolves AND *it* has a markup.
--
--   * compute_part_cost_explain: missing_markups now flags only the root part
--     (depth 0), so is_priceable = cost resolves + root has a markup.
--   * get_priceable_part_ids: a COSTABLE fixed-point (no markup), then
--     priceable = costable ∩ has-own-markup.
-- The two stay in lock-step (agreement test).

-- ---------------------------------------------------------------------------
-- 1. compute_part_cost_explain — markups CTE restricted to the root (depth 0).
--    Everything else verbatim from 20260715150633.
-- ---------------------------------------------------------------------------
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
    WITH RECURSIVE tree(part_id, part_name, source, cumulative_qty, depth) AS (
        SELECT p.id, p.part_name, p.source, p_qty, 0
          FROM public.parts p
         WHERE p.id = p_part_id

        UNION ALL

        SELECT c.id,
               c.part_name,
               c.source,
               CASE
                   -- Made child: value its subtree at its standard costing lot
                   -- size (fixed, not the cascaded consumed qty).
                   WHEN c.source = 'made' THEN
                       c.costing_batch_quantity
                   -- Bought whole-unit line: ceiling the cascaded consumption.
                   WHEN b.consume_whole_units THEN
                       ceil(
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
                           END
                       )
                   -- Bought fractional cascade.
                   ELSE
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
                       END
               END,
               t.depth + 1
          FROM tree t
          JOIN public.parts_bom b ON b.parent_part_id = t.part_id
          JOIN public.parts c     ON c.id = b.child_part_id
         WHERE t.source = 'made'
           AND t.depth < 50
    ),
    -- A bought leaf is "missing" only if it has NO non-expired procurement tier.
    leaves AS (
        SELECT tr.part_id, tr.part_name, tr.depth, tr.cumulative_qty AS qty_required
          FROM tree tr
         WHERE tr.source = 'bought'
           AND NOT EXISTS (
                   SELECT 1
                     FROM public.part_procurement_tiers t
                    WHERE t.part_id = tr.part_id
                      AND (t.expires_at IS NULL OR t.expires_at >= CURRENT_DATE)
               )
    ),
    -- Only the ROOT part (depth 0 = the part being quoted) needs a markup. A
    -- material's markup is never used inside a parent, so descendants are not
    -- flagged.
    markups AS (
        SELECT tr.part_id, tr.part_name, tr.source, MIN(tr.depth) AS depth
          FROM tree tr
         WHERE tr.depth = 0
           AND NOT EXISTS (
                   SELECT 1 FROM public.part_pricing_tiers pt
                    WHERE pt.part_id = tr.part_id
                      AND pt.markup_percent IS NOT NULL
               )
         GROUP BY tr.part_id, tr.part_name, tr.source
    ),
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

-- ---------------------------------------------------------------------------
-- 2. get_priceable_part_ids — split costable (no markup) from priceable
--    (costable + own markup), so a child material's missing markup doesn't
--    block the parent.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_priceable_part_ids(p_company_id uuid)
 RETURNS uuid[]
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_costable uuid[];
    v_priceable uuid[];
    v_new uuid[];
BEGIN
    -- COSTABLE — a part whose cost resolves. Markup is NOT required here: a
    -- material's markup is never used when consumed in a parent. Base case:
    -- bought parts with a non-expired procurement tier.
    SELECT COALESCE(array_agg(DISTINCT p.id), ARRAY[]::uuid[])
    INTO v_costable
    FROM public.parts p
    WHERE p.company_id = p_company_id
      AND p.source = 'bought'
      AND EXISTS (
          SELECT 1
          FROM public.part_procurement_tiers pt
          WHERE pt.part_id = p.id
            AND (pt.expires_at IS NULL OR pt.expires_at >= CURRENT_DATE)
      );

    -- Fixed-point: add made parts whose routing is complete and whose BOM
    -- children (if any) are all already costable. Bounded by BOM depth.
    LOOP
        SELECT COALESCE(array_agg(p.id), ARRAY[]::uuid[])
        INTO v_new
        FROM public.parts p
        WHERE p.company_id = p_company_id
          AND p.source = 'made'
          AND NOT (p.id = ANY(v_costable))
          -- Every routing op (if any) must have full pricing.
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
          -- Every BOM child must already be costable.
          AND NOT EXISTS (
              SELECT 1
              FROM public.parts_bom b
              WHERE b.parent_part_id = p.id
                AND NOT (b.child_part_id = ANY(v_costable))
          );

        EXIT WHEN cardinality(v_new) = 0;
        v_costable := v_costable || v_new;
    END LOOP;

    -- PRICEABLE = costable AND has its own non-null-markup pricing tier. Only the
    -- part being sold needs a markup; its materials just need to be costable.
    SELECT COALESCE(array_agg(p.id), ARRAY[]::uuid[])
    INTO v_priceable
    FROM public.parts p
    WHERE p.id = ANY(v_costable)
      AND EXISTS (
          SELECT 1
          FROM public.part_pricing_tiers t
          WHERE t.part_id = p.id
            AND t.markup_percent IS NOT NULL
      );

    RETURN v_priceable;
END;
$function$;

COMMENT ON FUNCTION public.get_priceable_part_ids(uuid) IS
    'Returns the part ids in a company that are ready to quote: cost resolves (bought: procurement tier; made: all ops priced and all BOM children costable) AND the part itself has a non-null-markup pricing tier. A material''s own markup is NOT required — the parent marks up the rolled-up cost. Matches compute_part_cost_explain.is_priceable.';
