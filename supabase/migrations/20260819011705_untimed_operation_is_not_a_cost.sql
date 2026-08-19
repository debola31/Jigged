-- ═══════════════════════════════════════════════════════════════════════════════
-- An operation nobody has timed is not an operation that costs nothing
-- ═══════════════════════════════════════════════════════════════════════════════
-- `part_rollup_at_qty` computes an operation as
--     (COALESCE(setup_minutes, 0) / qty + COALESCE(cycle_minutes_per_unit, 0)) * rate
-- so an operation with a work centre, a labour rate and NO TIMES contributes
-- exactly $0.00 — and nothing flagged it. `missing_op_rates` looked only for a
-- missing RATE. Measured on this schema before the change: a part routed through
-- four stations with no times, plus a markup, computes $0.00 and
-- `get_priceable_part_ids` returns it as ready to quote.
--
-- That is the same failure as the empty made part fixed in
-- 20260816231611_part_cost_basis_predicate.sql, one level down: there, no
-- operations at all; here, operations that say nothing. Both roll a silence up as
-- a number, and a number on a quote is a promise.
--
-- ## Why this matters now
--
-- The drawings import is about to let a shop say WHERE a part goes without saying
-- how long it takes there — stations are recall, times are a consensus, and
-- forcing the second to get the first is how a made-up cycle time ends up on a
-- customer quote. That flow is only safe if "routed, not costed" is a state the
-- database agrees with. This makes it one.
--
-- ## What counts as untimed
--
-- BOTH setup and cycle null. Either one alone is a real answer: a setup-only
-- operation is a fixed charge, and a cycle-only operation is the normal case with
-- no setup. Silence is only silence when nothing was said at all.
--
-- ## Blast radius
--
-- Parts whose operations carry a rate but no times change from priceable to not.
-- They were quoting at an understated cost, so this surfaces existing damage
-- rather than causing it. Counted in production before merge — see the PR.
--
-- Both traversals are rewritten because the predicate lives in both: a per-part
-- recursive walk for the detail page and a company-wide fixed point for the list.
-- The shared `part_has_cost_basis` deliberately still returns true here — the part
-- HAS a basis (it has operations); what it lacks is a complete one, and that is
-- what these two report.

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
    -- COSTABLE — a part whose cost resolves. Markup is NOT required here unless a
    -- BOM line charges the child at price (below). Base case: bought parts with a
    -- non-expired procurement tier.
    SELECT COALESCE(array_agg(DISTINCT p.id), ARRAY[]::uuid[])
    INTO v_costable
    FROM public.parts p
    WHERE p.company_id = p_company_id
      AND p.source = 'bought'
      AND public.part_has_cost_basis(p.id);

    -- Fixed-point: add made parts whose routing is complete and whose BOM
    -- children (if any) are all already costable. Bounded by BOM depth.
    LOOP
        SELECT COALESCE(array_agg(p.id), ARRAY[]::uuid[])
        INTO v_new
        FROM public.parts p
        WHERE p.company_id = p_company_id
          AND p.source = 'made'
          AND NOT (p.id = ANY(v_costable))
          -- A made part with no operations AND no BOM is not "free" — it has no
          -- cost basis. Same predicate the detail view uses.
          AND public.part_has_cost_basis(p.id)
          -- Every routing op (if any) must have full pricing.
          AND NOT EXISTS (
              SELECT 1
              FROM public.routings r
              JOIN public.routing_operations ro ON ro.routing_id = r.id
              JOIN public.work_centers wc ON wc.id = ro.work_center_id
              WHERE r.part_id = p.id
                AND (
                    -- Nobody said what an hour on this station costs.
                    (wc.kind = 'internal'
                        AND ro.labor_rate_override IS NULL
                        AND wc.labor_rate IS NULL)
                    -- Or nobody said how long it takes. A rate with no time multiplies
                    -- out to zero, and zero is a PRICE — it reads as "this operation is
                    -- free" rather than "we have not costed this yet".
                    OR (wc.kind = 'internal'
                        AND ro.setup_minutes IS NULL
                        AND ro.cycle_minutes_per_unit IS NULL)
                    -- An outside process is a price per unit, and its absence is the
                    -- same silence.
                    OR (wc.kind <> 'internal'
                        AND ro.external_unit_price IS NULL)
                )
          )
          -- Every BOM child must already be costable — AND, when the line charges
          -- it at price, must carry its own markup tier. Nothing covers for a
          -- missing one.
          AND NOT EXISTS (
              SELECT 1
              FROM public.parts_bom b
              WHERE b.parent_part_id = p.id
                AND (
                    NOT (b.child_part_id = ANY(v_costable))
                    OR (
                        b.charge_basis = 'price'
                        AND NOT EXISTS (
                            SELECT 1
                            FROM public.part_pricing_tiers t
                            WHERE t.part_id = b.child_part_id
                              AND t.markup_percent IS NOT NULL
                        )
                    )
                )
          );

        EXIT WHEN cardinality(v_new) = 0;
        v_costable := v_costable || v_new;
    END LOOP;

    -- PRICEABLE = costable AND has its own non-null-markup pricing tier. Only the
    -- part being sold needs a markup of its own; its materials need one only when
    -- a line charges them at price.
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

CREATE OR REPLACE FUNCTION public.compute_part_cost_explain(p_part_id uuid, p_qty numeric)
 RETURNS TABLE(unit_cost numeric, missing_leaves jsonb, missing_markups jsonb, missing_op_rates jsonb, is_priceable boolean)
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    v_missing_leaves   jsonb;
    v_missing_markups  jsonb;
    v_missing_op_rates jsonb;
    v_unit_cost        numeric;
BEGIN
    WITH RECURSIVE tree(part_id, part_name, source, cumulative_qty, depth, charged_at_price) AS (
        SELECT p.id, p.part_name, p.source, p_qty, 0, false
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
               t.depth + 1,
               -- Is THIS node charged into its parent at price? Per-edge, so the
               -- same part can be cost-charged in one BOM and price-charged in
               -- another.
               b.charge_basis = 'price'
          FROM tree t
          JOIN public.parts_bom b ON b.parent_part_id = t.part_id
          JOIN public.parts c     ON c.id = b.child_part_id
         WHERE t.source = 'made'
           AND t.depth < 50
    ),
    -- A leaf is "missing" when it has NO COST BASIS AT ALL. Shared with
    -- get_priceable_part_ids via public.part_has_cost_basis so the rule cannot
    -- drift between the detail view and the list view.
    leaves AS (
        SELECT tr.part_id, tr.part_name, tr.depth, tr.cumulative_qty AS qty_required
          FROM tree tr
         WHERE NOT public.part_has_cost_basis(tr.part_id)
    ),
    -- Markup is needed by the ROOT (the part being quoted) and by any child
    -- CHARGED AT PRICE — its markup is what the parent pays, and there is no
    -- shop-wide fallback to cover for a missing tier.
    markups AS (
        SELECT tr.part_id, tr.part_name, tr.source, MIN(tr.depth) AS depth
          FROM tree tr
         WHERE (tr.depth = 0 OR tr.charged_at_price)
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
               -- Nobody said what an hour on this station costs.
               (wc.kind = 'internal'
                   AND ro.labor_rate_override IS NULL
                   AND wc.labor_rate IS NULL)
               -- Or nobody said how long it takes. A rate with no time multiplies
               -- out to zero, and zero is a PRICE — it reads as "this operation is
               -- free" rather than "we have not costed this yet".
               OR (wc.kind = 'internal'
                   AND ro.setup_minutes IS NULL
                   AND ro.cycle_minutes_per_unit IS NULL)
               -- An outside process is a price per unit, and its absence is the
               -- same silence.
               OR (wc.kind <> 'internal'
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
$function$;

COMMENT ON FUNCTION public.get_priceable_part_ids(uuid) IS
  'Every part in this company that can be quoted: a complete cost basis and a markup, evaluated as a fixed point so a BOM parent waits on its children. An operation counts as costed only when it carries both a rate and at least one of setup/cycle time — a rate with no time multiplies out to $0.00, which reads as free rather than unknown.';

COMMENT ON FUNCTION public.compute_part_cost_explain(uuid, numeric) IS
  'Unit cost for a part at a quantity, plus WHY it cannot be priced. `missing_op_rates` covers an operation with no rate AND an operation with no times — both compute to zero and neither is a real cost.';
