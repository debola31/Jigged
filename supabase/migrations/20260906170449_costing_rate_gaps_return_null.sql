-- An unpriced routing step is a GAP, not an exception.
--
-- WHY. `part_rollup_at_qty` had two ways of saying "we cannot cost this yet".
-- A bought leaf with no procurement tier returned NULL; a routing operation
-- with no rate raised. Same class of fact -- nobody has typed a number in yet --
-- reported through two mechanisms, and the raising one is the wrong mechanism
-- for a fact a shop owner is supposed to see and fix on the page.
--
-- Two things follow from raising, and both were live:
--
--   1. The message reached the customer verbatim. PartPricing's BOM loop caught
--      the throw and rendered `cost lookup failed (Cannot compute cost for part
--      HAS-LNR323 SPL UF110(.336): outside routing op has no unit price (neither
--      a step override nor a price on the vendor service))`. The same gap on the
--      part's OWN routing already rendered "no price per piece (neither on the
--      step nor on the service)" -- the copy the raising path could not reach.
--
--   2. It filed a Sentry issue on page load (JAVASCRIPT-NEXTJS-32, 2026-09-04).
--      Supabase's Sentry integration captures every failing response, and the
--      `.rpc()` carve-out in lib/sentryEventPolicy.ts reads `getActiveSpan()`,
--      which is already gone by the time `beforeSend` runs -- so the drop missed.
--      That guard is worth fixing on its own, but an expected data gap should
--      never have reached it.
--
-- Nobody wanted the exception. EVERY caller already converts it straight back to
-- NULL: routingCostCalculation, quoteLineItemsAccess (x2), PartBomPanel, the
-- pricing-tier base fetches, compute_part_cost_explain's `EXCEPTION WHEN OTHERS`,
-- snapshot_job_part_true_cost, and the job_parts backfill in 20260811233748 --
-- which iterates per row ONLY because a set-based UPDATE would abort on the
-- first raise. Ten swallows for a signal with no consumer.
--
-- HOW BIG. Production, today: 860 of 974 outside routing steps carry no price on
-- either the step or the service (the split migration, 20260823163931, recorded
-- 861 of 966 at import -- this is the imported state, not drift). 844 parts hold
-- one, and 1058 BOM lines point at such a part, so 1058 part pages could throw on
-- open. At Contour that is 525 pages.
--
-- WHAT MOVES. The two routing-rate gaps return NULL. NULL already propagates:
-- the BOM loop's `IF v_child_cost IS NULL THEN RETURN NULL` has handled the
-- missing-tier case since 20260713235939, and every caller stores NULL as
-- "unknown, excluded from profitability" rather than zero. No number changes:
-- a part that costed before still costs the same, and a part that raised before
-- now returns NULL where its caller was already writing NULL.
--
-- WHAT DELIBERATELY DOES NOT MOVE.
--
--   * The missing-unit-conversion raise STAYS. `compute_part_cost_explain` has
--     no gap array for it (its recursive CTE COALESCEs the factor to 1), so
--     turning it into a bare NULL would produce a part with no cost and no
--     stated reason -- the "silent hole" the soft-delete/backfill rule in
--     CLAUDE.md exists to prevent. 15 BOM lines in production are in this state.
--     Giving it a fourth gap array changes compute_part_cost_explain's signature,
--     which needs a DROP + re-issued COMMENT and grants; that is its own PR.
--
--   * The two PROGRAMMER-ERROR raises stay: `p_qty <= 0` and `part not found`.
--     They are not data gaps, and NULL would hide a bug.
--
--   * snapshot_job_part_true_cost keeps its `EXCEPTION WHEN OTHERS`. A cost
--     snapshot must never block putting a part on a job -- that is the whole
--     point of 20260811233748 -- and after this change the handler only sees
--     conversions and faults. Both it and compute_part_cost_explain now
--     `RAISE WARNING` first, so a genuine fault lands in the Postgres log
--     instead of disappearing.
--
-- Both bodies below were extracted verbatim from 20260906005845 (their newest
-- definition) and patched in place; nothing else in either was retyped.
-- CREATE OR REPLACE throughout, never DROP + CREATE: a drop destroys both the
-- ACL and the COMMENT, and part_rollup_at_qty is granted to anon and
-- authenticated.

CREATE OR REPLACE FUNCTION public.part_rollup_at_qty(
    p_part_id uuid,
    p_qty numeric,
    p_apply_charge_basis boolean
)
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
    v_child_val_qty numeric;
    v_child_cost numeric;
    v_tier_cost numeric;
BEGIN
    IF p_qty IS NULL OR p_qty <= 0 THEN
        RAISE EXCEPTION 'part_rollup_at_qty: p_qty must be > 0 (got %)', p_qty
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT source, part_name
      INTO v_source, v_part_name
      FROM public.parts
     WHERE id = p_part_id;
    IF v_source IS NULL THEN
        RAISE EXCEPTION 'part_rollup_at_qty: part % not found', p_part_id;
    END IF;

    -- ---------- Bought parts: resolve to the part's own tier sheet ----------
    -- A bought part has no BOM, so the charge-basis flag cannot apply here. Its
    -- own markup is added by the CALLER (the price rung), never by itself.
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
        -- buy) so the part is still costable, rather than returning NULL. This
        -- path is hit MORE often now that consumption is exact rather than
        -- ceilinged -- get_procurement_cost is aligned to it below for that
        -- reason.
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
                   ro.vendor_service_id,
                   wc.labor_rate    AS wc_labor_rate,
                   vs.unit_price    AS vs_unit_price
              FROM public.routing_operations ro
              LEFT JOIN public.work_centers    wc ON wc.id = ro.work_center_id
              LEFT JOIN public.vendor_services vs ON vs.id = ro.vendor_service_id
             WHERE ro.routing_id = v_routing_id
        LOOP
            IF v_op.vendor_service_id IS NULL THEN
                -- A station with no rate is a GAP, not a fault: nobody has said
                -- what an hour there costs yet. Same shape as a bought leaf with
                -- no tier, three lines below -- return NULL and let
                -- compute_part_cost_explain name it via missing_op_rates.
                IF v_op.labor_rate_override IS NULL AND v_op.wc_labor_rate IS NULL THEN
                    RETURN NULL;
                END IF;
                v_op_cost := (COALESCE(v_op.setup_minutes, 0) / p_qty
                              + COALESCE(v_op.cycle_minutes_per_unit, 0))
                             * COALESCE(v_op.labor_rate_override, v_op.wc_labor_rate)
                             / 60.0;
            ELSE
                -- INHERITANCE, symmetric with the internal arm above: the step's
                -- own price wins, else the service's. Raising a vendor's price
                -- moves every step that never overrode it, exactly as raising a
                -- station's labor_rate does.
                IF v_op.external_unit_price IS NULL AND v_op.vs_unit_price IS NULL THEN
                    RETURN NULL;
                END IF;
                v_op_cost := COALESCE(v_op.external_unit_price, v_op.vs_unit_price);
            END IF;
            v_total := v_total + v_op_cost;
        END LOOP;
    END IF;

    FOR v_bom IN
        SELECT b.quantity,
               b.unit,
               b.child_part_id,
               b.charge_basis,
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

        -- A MADE child is valued at its standard costing lot size (setup
        -- amortized over the run it's produced in), fixed regardless of how many
        -- this order draws. A BOUGHT child is valued at what we actually consume
        -- across the parent batch (to hit the right procurement tier / floor) --
        -- exactly, with no ceiling.
        IF v_bom.child_source = 'made' THEN
            v_child_val_qty := v_bom.child_costing_batch_quantity;
        ELSE
            v_child_val_qty := p_qty * v_qty_in_primary_unit;
        END IF;

        -- Tier resolution for the price rung uses the SAME valuation quantity the
        -- cost path uses -- any divergence produces unexplainable quotes, and for
        -- bought material the two are identical anyway.
        IF p_apply_charge_basis AND v_bom.charge_basis = 'price' THEN
            SELECT unit_price
              INTO v_child_cost
              FROM public.compute_part_price_explain_at_qty(
                       v_bom.child_part_id, v_child_val_qty);
        ELSE
            v_child_cost := public.part_rollup_at_qty(
                v_bom.child_part_id,
                v_child_val_qty,
                p_apply_charge_basis
            );
        END IF;

        IF v_child_cost IS NULL THEN
            RETURN NULL;
        END IF;

        -- One expression for every line. Previously this was two branches that
        -- the ceiling forced apart; without it they are algebraically identical,
        -- since (p_qty * qty_in_primary * cost) / p_qty = qty_in_primary * cost.
        v_total := v_total + v_qty_in_primary_unit * v_child_cost;
    END LOOP;

    RETURN v_total;
END;
$function$;
-- ── The verdict function stops swallowing in silence ────────────────────────
-- Rebuilt from 20260906005845, its newest definition. The gap arrays are
-- untouched: op_rates already listed exactly the two conditions that now return
-- NULL, so the copy this change routes to was written and tested months ago.
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
                   -- Bought child: the exact cascade, never ceilinged.
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
          LEFT JOIN public.work_centers    wc ON wc.id = ro.work_center_id
          LEFT JOIN public.vendor_services vs ON vs.id = ro.vendor_service_id
         WHERE tr.source = 'made'
           AND (
               -- Nobody said what an hour on this station costs.
               (ro.vendor_service_id IS NULL
                   AND ro.labor_rate_override IS NULL
                   AND wc.labor_rate IS NULL)
               -- Or nobody said how long it takes. A rate with no time multiplies
               -- out to zero, and zero is a PRICE — it reads as "this operation is
               -- free" rather than "we have not costed this yet".
               OR (ro.vendor_service_id IS NULL
                   AND ro.setup_minutes IS NULL
                   AND ro.cycle_minutes_per_unit IS NULL)
               -- An outside process is a price per unit, and its absence is the
               -- same silence. The step may override it; the service supplies it
               -- otherwise. Both missing is the unpriced case.
               OR (ro.vendor_service_id IS NOT NULL
                   AND ro.external_unit_price IS NULL
                   AND vs.unit_price IS NULL)
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

    -- The rollup no longer raises for a missing labour rate or outside price --
    -- both return NULL now, and the gap arrays above name them. What is left in
    -- here is a missing unit conversion (which still raises, deliberately: no
    -- gap array carries it yet) and genuine faults. Those must not vanish, so
    -- the handler logs before it nulls: `RAISE WARNING` reaches the Postgres log
    -- without aborting, which keeps the page rendering its gap list.
    BEGIN
        v_unit_cost := public.compute_part_cost_at_qty(p_part_id, p_qty);
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'compute_part_cost_explain: rollup failed for part % at qty %: % (%)',
            p_part_id, p_qty, SQLERRM, SQLSTATE;
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
-- ── The job-cost snapshot logs before it nulls ──────────────────────────────
-- Rebuilt from 20260811233748, its only definition. The handler stays (a cost
-- snapshot must not block job creation); it just stops being silent. Its two
-- named causes are now one -- the rate gaps arrive as NULL through the normal
-- return path and never enter this block at all.
CREATE OR REPLACE FUNCTION public.snapshot_job_part_true_cost()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- Only on insert, or when the quantity actually moved. An unrelated UPDATE
    -- must not silently re-price history.
    IF TG_OP = 'UPDATE' AND NEW.quantity IS NOT DISTINCT FROM OLD.quantity THEN
        RETURN NEW;
    END IF;

    BEGIN
        NEW.true_cost_per_unit :=
            public.compute_part_cost_at_qty(NEW.part_id, NEW.quantity);
    EXCEPTION WHEN OTHERS THEN
        -- A missing unit conversion still raises out of the rollup, and a fault
        -- would too. Neither may block creating the job, so record that we do
        -- not know rather than inventing a number -- but say so in the log.
        RAISE WARNING 'snapshot_job_part_true_cost: cost failed for part % at qty %: % (%)',
            NEW.part_id, NEW.quantity, SQLERRM, SQLSTATE;
        NEW.true_cost_per_unit := NULL;
    END;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.snapshot_job_part_true_cost() IS
  'BEFORE INSERT OR UPDATE OF quantity on job_parts: freezes true_cost_per_unit from compute_part_cost_at_qty. An incomplete part costs NULL (the rollup returns it for a missing rate or tier) and can still be put on a job; a missing unit conversion or a genuine fault is swallowed to NULL as well, after a RAISE WARNING, because a snapshot must never block the job. NULL means unknown — profitability excludes it, never costs it at zero.';

REVOKE EXECUTE ON FUNCTION public.snapshot_job_part_true_cost() FROM PUBLIC, anon, authenticated;

-- ── The comments the change makes false ─────────────────────────────────────
-- CREATE OR REPLACE preserves a COMMENT, so these must be re-issued by hand.
-- "Raises on missing labor rate / external pricing" was the contract this
-- migration retires; the wrappers are what the TS access layer documents itself
-- against, so leaving the old sentence there is how the next reader re-adds a
-- try/catch nobody needs.
COMMENT ON FUNCTION public.compute_part_cost_at_qty(uuid, numeric) IS
  'TRUE unit cost at a quantity — what the part costs us. Ignores every parts_bom.charge_basis, so it is unchanged by #727 and is the honest denominator for effective margin. Bought: procurement tier at that qty, floored to the lowest tier below the minimum. Made: routing ops + BOM children (a made child at its costing lot size, a bought child at the consumed qty). Returns NULL for any costing gap — a bought leaf with no tier, a routing op with no labour rate, an outside op with no unit price — which compute_part_cost_explain names via missing_leaves / missing_op_rates. Still RAISES on a missing unit conversion (no gap array carries it yet) and on a non-positive qty or unknown part. The number a PRICE is built on is compute_part_charge_base_at_qty.';

COMMENT ON FUNCTION public.part_rollup_at_qty(uuid, numeric, boolean) IS
  'THE cost/charge rollup for a part at a quantity — one body, two modes. p_apply_charge_basis=false ignores every parts_bom.charge_basis and returns TRUE COST (identical to the pre-#727 compute_part_cost_at_qty). true honors each line: a ''cost'' line contributes the child''s charge base, a ''price'' line the child''s marked-up price. Callers use the two named wrappers; this exists so there is only one implementation of the math. A costing GAP (no tier, no labour rate, no outside unit price) returns NULL and propagates; only a missing unit conversion and genuine programmer errors raise.';
