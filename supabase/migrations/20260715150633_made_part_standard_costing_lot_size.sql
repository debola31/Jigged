-- Standard costing lot size for made parts.
--
-- Move from "cascade" valuation (value a made child at whatever qty the parent
-- order happens to draw) to the industry-standard "standard costing lot size":
-- a made part is ALWAYS costed at its own costing_batch_quantity (setup
-- amortized over the run it's produced in), and that fixed cost rolls up into
-- every parent — exactly how Dynamics 365 / JobBOSS / ProShop compute
-- manufactured cost. There is no longer a per-order/cascade mode.
--
-- costing_batch_quantity therefore applies to EVERY made part (not just ones
-- consumed as a fraction). Backfill NULL → 1 and make it NOT NULL DEFAULT 1 so
-- the value is correct at rest (no read-time COALESCE). Bought parts carry the
-- default but ignore it (their cost comes from procurement tiers).
--
-- Behavior change (intended): made sub-parts that previously cascaded now carry
-- full setup at a lot size of 1 until a real batch is set, so multi-level BOM
-- costs move up until lot sizes are configured.

-- ---------------------------------------------------------------------------
-- 1. Data at rest: every part gets a costing lot size (default 1).
-- ---------------------------------------------------------------------------
UPDATE public.parts SET costing_batch_quantity = 1 WHERE costing_batch_quantity IS NULL;
ALTER TABLE public.parts ALTER COLUMN costing_batch_quantity SET DEFAULT 1;
ALTER TABLE public.parts ALTER COLUMN costing_batch_quantity SET NOT NULL;

COMMENT ON COLUMN public.parts.costing_batch_quantity IS
    'Standard costing lot size: the production run this part''s cost is amortized over (setup / batch). A made part is always valued at this quantity when it is consumed as a component in another part''s BOM. Default 1. Bought parts ignore it.';

-- ---------------------------------------------------------------------------
-- 2. compute_part_cost_at_qty — a MADE child is always valued at its costing
--    lot size (no cascade). Bought children still value at the consumed qty
--    (to hit the right procurement tier / floor). Everything else carried
--    forward verbatim from 20260714173443.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compute_part_cost_at_qty(p_part_id uuid, p_qty numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    v_source text;
    v_part_name text;
    v_routing_id uuid;
    v_total numeric := 0;
    v_op RECORD;
    v_op_cost numeric;
    v_bom RECORD;
    v_to_primary_factor numeric;
    v_qty_in_primary_unit numeric;
    v_consumed numeric;
    v_child_val_qty numeric;
    v_pinned boolean;
    v_child_cost numeric;
    v_tier_cost numeric;
BEGIN
    IF p_qty IS NULL OR p_qty <= 0 THEN
        RAISE EXCEPTION 'compute_part_cost_at_qty: p_qty must be > 0 (got %)', p_qty
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT source, part_name
      INTO v_source, v_part_name
      FROM public.parts
     WHERE id = p_part_id;
    IF v_source IS NULL THEN
        RAISE EXCEPTION 'compute_part_cost_at_qty: part % not found', p_part_id;
    END IF;

    -- ---------- Bought parts: resolve to the part's own tier sheet ----------
    IF v_source = 'bought' THEN
        SELECT t.cost_per_unit
          INTO v_tier_cost
          FROM public.part_procurement_tiers t
         WHERE t.part_id = p_part_id
           AND t.min_quantity <= p_qty
           AND (t.expires_at IS NULL OR t.expires_at >= CURRENT_DATE)
         ORDER BY t.cost_per_unit ASC,
                  t.min_quantity DESC
         LIMIT 1;
        -- Below every break: floor to the lowest-min tier (smallest pack you can
        -- buy) so the part is still costable, rather than returning NULL.
        IF v_tier_cost IS NULL THEN
            SELECT t.cost_per_unit
              INTO v_tier_cost
              FROM public.part_procurement_tiers t
             WHERE t.part_id = p_part_id
               AND (t.expires_at IS NULL OR t.expires_at >= CURRENT_DATE)
             ORDER BY t.min_quantity ASC,
                      t.cost_per_unit ASC
             LIMIT 1;
        END IF;
        RETURN v_tier_cost;
    END IF;

    -- ---------- Made parts: own routing + BOM rollup ----------
    SELECT id INTO v_routing_id FROM public.routings WHERE part_id = p_part_id;

    IF v_routing_id IS NOT NULL THEN
        FOR v_op IN
            SELECT ro.setup_minutes,
                   ro.cycle_minutes_per_unit,
                   ro.labor_rate_override,
                   ro.external_unit_price,
                   wc.kind          AS wc_kind,
                   wc.labor_rate    AS wc_labor_rate
              FROM public.routing_operations ro
              JOIN public.work_centers wc ON wc.id = ro.work_center_id
             WHERE ro.routing_id = v_routing_id
        LOOP
            IF v_op.wc_kind = 'internal' THEN
                IF v_op.labor_rate_override IS NULL AND v_op.wc_labor_rate IS NULL THEN
                    RAISE EXCEPTION
                        'Cannot compute cost for part %: internal routing op has no labor rate (neither override nor work_center default)',
                        v_part_name
                        USING ERRCODE = 'check_violation';
                END IF;
                v_op_cost := (COALESCE(v_op.setup_minutes, 0) / p_qty
                              + COALESCE(v_op.cycle_minutes_per_unit, 0))
                             * COALESCE(v_op.labor_rate_override, v_op.wc_labor_rate)
                             / 60.0;
            ELSE
                IF v_op.external_unit_price IS NULL THEN
                    RAISE EXCEPTION
                        'Cannot compute cost for part %: external routing op has no unit price (external_unit_price is required)',
                        v_part_name
                        USING ERRCODE = 'check_violation';
                END IF;
                v_op_cost := COALESCE(v_op.external_unit_price, 0);
            END IF;
            v_total := v_total + v_op_cost;
        END LOOP;
    END IF;

    FOR v_bom IN
        SELECT b.quantity,
               b.unit,
               b.child_part_id,
               b.consume_whole_units,
               c.primary_unit          AS child_primary_unit,
               c.part_name             AS child_part_name,
               c.source                AS child_source,
               c.costing_batch_quantity AS child_costing_batch_quantity
          FROM public.parts_bom b
          JOIN public.parts c ON c.id = b.child_part_id
         WHERE b.parent_part_id = p_part_id
    LOOP
        IF v_bom.unit IS DISTINCT FROM v_bom.child_primary_unit THEN
            SELECT to_primary_factor INTO v_to_primary_factor
              FROM public.parts_unit_conversions
             WHERE part_id = v_bom.child_part_id
               AND from_unit = v_bom.unit;
            IF v_to_primary_factor IS NULL THEN
                RAISE EXCEPTION
                    'No unit conversion from % to % for part %',
                    v_bom.unit, v_bom.child_primary_unit, v_bom.child_part_name
                    USING ERRCODE = 'check_violation';
            END IF;
            v_qty_in_primary_unit := v_bom.quantity * v_to_primary_factor;
        ELSE
            v_qty_in_primary_unit := v_bom.quantity;
        END IF;

        -- Units of the child physically consumed across the parent batch of
        -- p_qty. Whole-unit lines ceiling to discrete stock; fractional lines
        -- are exact.
        IF v_bom.consume_whole_units THEN
            v_consumed := ceil(p_qty * v_qty_in_primary_unit);
        ELSE
            v_consumed := p_qty * v_qty_in_primary_unit;
        END IF;

        -- A MADE child is valued at its standard costing lot size (setup
        -- amortized over the run it's produced in), fixed regardless of how many
        -- this order draws. A BOUGHT child is valued at what we actually consume
        -- (to hit the right procurement tier / floor).
        v_pinned := (v_bom.child_source = 'made');
        IF v_pinned THEN
            v_child_val_qty := v_bom.child_costing_batch_quantity;
        ELSE
            v_child_val_qty := v_consumed;
        END IF;

        v_child_cost := public.compute_part_cost_at_qty(
            v_bom.child_part_id,
            v_child_val_qty
        );

        IF v_child_cost IS NULL THEN
            RETURN NULL;
        END IF;

        IF NOT v_bom.consume_whole_units AND NOT v_pinned THEN
            -- Bought child, fractional consumption — textually identical to the
            -- pre-feature expression so those lines stay byte-for-byte the same.
            v_total := v_total + v_qty_in_primary_unit * v_child_cost;
        ELSE
            -- Made (lot-size valuation) and/or whole-unit ceiling: per parent
            -- unit = consumed units × unit cost, spread across the p_qty units.
            v_total := v_total + (v_consumed * v_child_cost) / p_qty;
        END IF;
    END LOOP;

    RETURN v_total;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. compute_part_cost_explain — mirror: a made child's subtree is required at
--    its costing lot size (no cascade). Bought children keep the cascaded
--    (ceil/fractional) qty for tier coverage. Everything else verbatim.
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
    -- Because the cost function FLOORS to the lowest tier below the minimum, any
    -- tier makes the leaf priceable at any qty — and tiers are part-level.
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
    -- A part with no priced markup — no tier at all, or only unfilled tiers
    -- (markup_percent NULL). Requires a non-null markup.
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
