-- Simplify the bought-part procurement model to a SINGLE part-level cost tier
-- set + a vendor label.
--
-- Why: part_procurement_tiers was keyed by (part_id, vendor_id, min_quantity),
-- but only the preferred vendor's sheet ever drove cost — every cost /
-- priceability function filtered `vendor_id = parts.preferred_vendor_id`, and
-- the UI already made the vendor picker double as the preferred-vendor setter.
-- Non-preferred and vendor_id=NULL rows were reference-only. We carried
-- multi-vendor STRUCTURE with none of the payoff (no RFQ / PO / approved-vendor
-- list / comparison). Real multi-vendor sourcing is deferred to a purchasing
-- module (tracked in issue #571). Here we collapse to part-level tiers:
-- vendor becomes a pure "who we PO from" label (parts.preferred_vendor_id stays,
-- still drives the Vendors-page supplier role) and cost reads the part's own
-- tier sheet regardless of vendor.

-- ---------------------------------------------------------------------------
-- 1. Collapse each part's rows to a single vendor's set BEFORE dropping the
--    column, so (part_id, min_quantity) is unique afterward. Priority per part:
--      (a) the preferred vendor's rows (incl. the NULL-preferred ↔ NULL-vendor
--          "Internal estimate" match), else
--      (b) a real vendor's rows (deterministic: lowest vendor_id), else
--      (c) the NULL-vendor rows.
--    The surviving set is exactly what already fed cost, so no costable part
--    changes value. (Destructive only on reference-only rows.)
-- ---------------------------------------------------------------------------
WITH survivor AS (
    SELECT DISTINCT ON (t.part_id)
           t.part_id,
           t.vendor_id AS keep_vendor_id
      FROM public.part_procurement_tiers t
      JOIN public.parts p ON p.id = t.part_id
     ORDER BY t.part_id,
              (t.vendor_id IS NOT DISTINCT FROM p.preferred_vendor_id) DESC,
              (t.vendor_id IS NOT NULL) DESC,
              t.vendor_id ASC NULLS LAST
)
DELETE FROM public.part_procurement_tiers d
 USING survivor s
 WHERE d.part_id = s.part_id
   AND d.vendor_id IS DISTINCT FROM s.keep_vendor_id;

-- ---------------------------------------------------------------------------
-- 2. Drop vendor_id. This auto-removes the column-owned objects: the
--    (part_id, vendor_id, min_quantity) unique constraint, the partial
--    idx_procurement_tiers_vendor index, and the vendor FK. Then re-establish
--    uniqueness at the part level.
-- ---------------------------------------------------------------------------
ALTER TABLE public.part_procurement_tiers DROP COLUMN vendor_id;

CREATE UNIQUE INDEX part_procurement_tiers_part_id_min_quantity_key
    ON public.part_procurement_tiers (part_id, min_quantity);

COMMENT ON TABLE public.part_procurement_tiers IS
    'Part-level bought-part cost tier sheet: (part_id, min_quantity) → cost_per_unit. One set per part, independent of vendor. Cost resolution (compute_part_cost_at_qty / get_procurement_cost) reads these directly; parts.preferred_vendor_id is a supplier label, not a cost filter. Multi-vendor cost sheets / RFQ / POs are deferred to a future purchasing module.';

-- ---------------------------------------------------------------------------
-- 3. Re-issue the four functions that filtered procurement rows by the
--    preferred vendor. Only the vendor predicate changes — batch-pin,
--    whole-unit ceiling, sub-min floor, NULL-markup guard, and the priceability
--    verdict are carried forward verbatim.
-- ---------------------------------------------------------------------------

-- 3a. compute_part_cost_at_qty — bought branch reads the part's own tiers (no
--     preferred-vendor guard, no vendor predicate); still floors to the
--     lowest-min tier below every break.
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

        -- A made child with a costing batch qty is valued at that FIXED batch
        -- (its own production economics), decoupled from how many this order
        -- draws. Otherwise value it at what we actually consume (cascade).
        v_pinned := (v_bom.child_source = 'made'
                     AND v_bom.child_costing_batch_quantity IS NOT NULL);
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
            -- LEGACY PATH — textually identical to the pre-feature expression so
            -- every existing BOM line returns a byte-identical cost.
            v_total := v_total + v_qty_in_primary_unit * v_child_cost;
        ELSE
            -- Ceiling and/or pinning: per parent unit = consumed units × unit
            -- cost, spread across the p_qty parent units.
            v_total := v_total + (v_consumed * v_child_cost) / p_qty;
        END IF;
    END LOOP;

    RETURN v_total;
END;
$function$;

-- 3b. compute_part_cost_explain — a bought leaf is "missing" only if it has NO
--     non-expired procurement tier at all (part-level; vendor no longer gates
--     it). Signature unchanged (5 columns) so CREATE OR REPLACE is valid and
--     preserves owner/grants. Everything else — the recursive tree (batch-pin +
--     ceiling), markups/op_rates CTEs, and the verdict — is carried forward
--     verbatim from 20260713235939, minus the preferred_vendor_id column that
--     the leaves CTE no longer needs.
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
                   -- Pinned made child: value its subtree at the batch qty.
                   WHEN c.source = 'made' AND c.costing_batch_quantity IS NOT NULL THEN
                       c.costing_batch_quantity
                   -- Whole-unit line: ceiling the cascaded consumption.
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
                   -- Legacy fractional cascade (unchanged from prior version).
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
    -- tier makes the leaf priceable at any qty — and tiers are now part-level,
    -- so the vendor predicate is gone.
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

-- 3c. get_procurement_cost — part-level tier lookup. vendor_id in the result is
--     now the part's preferred-vendor LABEL (for display), not a tier column.
--     Signature unchanged so CREATE OR REPLACE preserves owner/grants.
CREATE OR REPLACE FUNCTION public.get_procurement_cost(p_part_id uuid, p_qty numeric)
RETURNS TABLE(unit_cost numeric, vendor_id uuid, tier_id uuid, source text)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    v_preferred_vendor_id uuid;
    v_tier RECORD;
BEGIN
    SELECT preferred_vendor_id INTO v_preferred_vendor_id
      FROM public.parts WHERE id = p_part_id;

    -- Cheapest non-expired tier on the part's own sheet where min_quantity <=
    -- p_qty. Vendor no longer gates cost; the returned vendor_id is the part's
    -- preferred-vendor label.
    SELECT t.id, t.cost_per_unit
      INTO v_tier
      FROM public.part_procurement_tiers t
     WHERE t.part_id = p_part_id
       AND t.min_quantity <= p_qty
       AND (t.expires_at IS NULL OR t.expires_at >= CURRENT_DATE)
     ORDER BY t.cost_per_unit ASC,
              t.min_quantity DESC
     LIMIT 1;

    IF FOUND THEN
        unit_cost := v_tier.cost_per_unit;
        vendor_id := v_preferred_vendor_id;
        tier_id   := v_tier.id;
        source    := 'tier';
        RETURN NEXT;
    END IF;
    -- No row when no tier covers p_qty.
END;
$$;

COMMENT ON FUNCTION public.get_procurement_cost(uuid, numeric) IS
    'Returns the active part-level procurement tier at quantity p_qty (cheapest non-expired tier with min_quantity <= p_qty), or no row if none covers it. vendor_id in the result is the part''s preferred-vendor label (display only) — cost is part-level and vendor-independent.';

-- 3d. get_priceable_part_ids — a bought part is priceable iff it has a
--     non-null-markup pricing tier AND any non-expired procurement tier (no
--     preferred-vendor requirement). Rebased on the latest definition
--     (20260713011616, post markup-rates removal + post external_setup_cost
--     drop) so the only change vs. that version is the removed vendor predicate:
--     the NULL-markup guard and the external_unit_price-only op check are kept.
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
    -- Base case: bought parts with a non-null-markup pricing tier AND any
    -- non-expired procurement tier on their own (part-level) sheet.
    SELECT COALESCE(array_agg(DISTINCT p.id), ARRAY[]::uuid[])
    INTO v_priceable
    FROM public.parts p
    WHERE p.company_id = p_company_id
      AND p.source = 'bought'
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

-- 3e. seed_demo_data — the only OTHER writer of part_procurement_tiers.vendor_id
--     (it always inserted a literal NULL vendor for bought parts). Re-issued
--     verbatim from 20260623022617 with that single insert dropping vendor_id,
--     so `reset_demo_company` (utils/demoAccess.ts → this fn) keeps working
--     after the column is gone. No other line changes.
CREATE OR REPLACE FUNCTION public.seed_demo_data(p_company_id uuid, p_user_id uuid, p_template_name text DEFAULT 'default'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_template jsonb;
    v_ref_map jsonb := '{}'::jsonb;
    v_item jsonb;
    v_inner jsonb;
    v_contact jsonb;
    v_new_id uuid;
    v_routing_id uuid;
    v_quote_id uuid;
    v_job_id uuid;
    v_job_part_id uuid;
    v_part_id uuid;
    v_part_source text;
    v_part_cost numeric;
BEGIN
    SELECT template_data INTO v_template
    FROM demo_data_templates
    WHERE name = p_template_name AND is_active = true
    LIMIT 1;

    IF v_template IS NULL THEN
        RAISE EXCEPTION 'No active demo template found with name: %', p_template_name;
    END IF;

    IF v_template->'vendors' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'vendors') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO vendors (id, company_id, name,
                                 address_line1, address_line2, city, state, postal_code, country,
                                 legacy_id)
            VALUES (v_new_id, p_company_id, v_item->>'name',
                    v_item->>'address_line1', v_item->>'address_line2',
                    v_item->>'city', v_item->>'state', v_item->>'postal_code',
                    COALESCE(v_item->>'country', 'USA'),
                    v_item->>'legacy_id');

            IF v_item->'contacts' IS NOT NULL THEN
                FOR v_contact IN SELECT * FROM jsonb_array_elements(v_item->'contacts') LOOP
                    INSERT INTO vendor_contacts (vendor_id, name, role, role_label,
                                                 email, phone, is_primary)
                    VALUES (v_new_id,
                            v_contact->>'name',
                            COALESCE(v_contact->>'role', 'sales'),
                            v_contact->>'role_label',
                            v_contact->>'email',
                            v_contact->>'phone',
                            COALESCE((v_contact->>'is_primary')::boolean, false));
                END LOOP;
            END IF;
        END LOOP;
    END IF;

    IF v_template->'work_centers' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'work_centers') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO work_centers (id, company_id, name, kind, vendor_id,
                                      labor_rate, description)
            VALUES (v_new_id, p_company_id,
                    v_item->>'name',
                    COALESCE(v_item->>'kind', 'internal'),
                    CASE WHEN v_item->>'vendor_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'vendor_ref'))::uuid
                         ELSE NULL END,
                    NULLIF(v_item->>'labor_rate', '')::numeric,
                    v_item->>'description');
        END LOOP;
    END IF;

    -- Parts: cost_per_unit dropped from parts. For bought parts with a
    -- template-supplied cost, emit a part-level procurement tier.
    IF v_template->'parts' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'parts') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            v_part_source := COALESCE(v_item->>'source', 'made');
            v_part_cost := NULLIF(v_item->>'cost_per_unit', '')::numeric;

            INSERT INTO parts (id, company_id, part_name, description,
                               source, is_stocked,
                               primary_unit, quantity,
                               reorder_point, preferred_vendor_id, legacy_id)
            VALUES (v_new_id, p_company_id,
                    v_item->>'part_name', v_item->>'description',
                    v_part_source,
                    COALESCE((v_item->>'is_stocked')::boolean, false),
                    v_item->>'primary_unit',
                    COALESCE((v_item->>'quantity')::numeric, 0),
                    NULLIF(v_item->>'reorder_point', '')::numeric,
                    CASE WHEN v_item->>'preferred_vendor_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'preferred_vendor_ref'))::uuid
                         ELSE NULL END,
                    v_item->>'legacy_id');

            IF v_part_source = 'bought' AND v_part_cost IS NOT NULL AND v_part_cost > 0 THEN
                INSERT INTO part_procurement_tiers
                    (part_id, min_quantity, cost_per_unit)
                VALUES (v_new_id, 1, v_part_cost);
            END IF;
        END LOOP;
    END IF;

    IF v_template->'parts_bom' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'parts_bom') LOOP
            INSERT INTO parts_bom (parent_part_id, child_part_id, quantity, unit, sequence, notes)
            VALUES ((v_ref_map->>(v_item->>'parent_ref'))::uuid,
                    (v_ref_map->>(v_item->>'child_ref'))::uuid,
                    (v_item->>'quantity')::numeric,
                    v_item->>'unit',
                    COALESCE((v_item->>'sequence')::integer, 0),
                    v_item->>'notes');
        END LOOP;
    END IF;

    IF v_template->'routings' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'routings') LOOP
            v_routing_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_routing_id::text));
            INSERT INTO routings (id, company_id, part_id, name, description, created_by)
            VALUES (v_routing_id, p_company_id,
                    (v_ref_map->>(v_item->>'part_ref'))::uuid,
                    v_item->>'name', v_item->>'description', p_user_id);

            IF v_item->'operations' IS NOT NULL THEN
                FOR v_inner IN SELECT * FROM jsonb_array_elements(v_item->'operations') LOOP
                    INSERT INTO routing_operations (
                        routing_id, work_center_id, sequence,
                        setup_minutes, cycle_minutes_per_unit,
                        labor_rate_override,
                        external_unit_price,
                        instructions
                    ) VALUES (
                        v_routing_id,
                        (v_ref_map->>(v_inner->>'work_center_ref'))::uuid,
                        COALESCE((v_inner->>'sequence')::integer, 10),
                        NULLIF(v_inner->>'setup_minutes', '')::numeric,
                        NULLIF(v_inner->>'cycle_minutes_per_unit', '')::numeric,
                        NULLIF(v_inner->>'labor_rate_override', '')::numeric,
                        NULLIF(v_inner->>'external_unit_price', '')::numeric,
                        v_inner->>'instructions'
                    );
                END LOOP;
            END IF;
        END LOOP;
    END IF;

    IF v_template->'customers' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'customers') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO customers (id, company_id, name,
                                   contact_name, contact_email, contact_phone,
                                   address_line1, address_line2, city, state, postal_code, country,
                                   website)
            VALUES (v_new_id, p_company_id,
                    v_item->>'name',
                    v_item->>'contact_name', v_item->>'contact_email', v_item->>'contact_phone',
                    v_item->>'address_line1', v_item->>'address_line2',
                    v_item->>'city', v_item->>'state', v_item->>'postal_code',
                    COALESCE(v_item->>'country', 'USA'),
                    v_item->>'website');
        END LOOP;
    END IF;

    IF v_template->'quotes' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'quotes') LOOP
            v_quote_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_quote_id::text));
            INSERT INTO quotes (id, company_id, customer_id, status,
                                lead_time_days, expiration_date, created_by)
            VALUES (v_quote_id, p_company_id,
                    CASE WHEN v_item->>'customer_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'customer_ref'))::uuid
                         ELSE NULL END,
                    COALESCE(v_item->>'status', 'active'),
                    NULLIF(v_item->>'lead_time_days', '')::integer,
                    NULLIF(v_item->>'expiration_date', '')::date,
                    p_user_id);

            IF v_item->'line_items' IS NOT NULL THEN
                FOR v_inner IN SELECT * FROM jsonb_array_elements(v_item->'line_items') LOOP
                    INSERT INTO quote_line_items (
                        quote_id, company_id, part_id,
                        sequence, quantity, unit_price, total_price
                    ) VALUES (
                        v_quote_id, p_company_id,
                        (v_ref_map->>(v_inner->>'part_ref'))::uuid,
                        COALESCE((v_inner->>'sequence')::integer, 10),
                        (v_inner->>'quantity')::integer,
                        (v_inner->>'unit_price')::numeric,
                        NULLIF(v_inner->>'total_price', '')::numeric
                    );
                END LOOP;
            END IF;
        END LOOP;
    END IF;

    IF v_template->'jobs' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'jobs') LOOP
            v_job_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_job_id::text));

            INSERT INTO jobs (id, company_id, customer_id, quote_id,
                              job_number, status, created_by)
            VALUES (v_job_id, p_company_id,
                    CASE WHEN v_item->>'customer_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'customer_ref'))::uuid
                         ELSE NULL END,
                    CASE WHEN v_item->>'quote_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'quote_ref'))::uuid
                         ELSE NULL END,
                    COALESCE(v_item->>'job_number',
                             'J-DEMO-' || substr(v_job_id::text, 1, 8)),
                    COALESCE(v_item->>'status', 'not_started'),
                    p_user_id);

            IF v_item->'parts' IS NOT NULL THEN
                FOR v_inner IN SELECT * FROM jsonb_array_elements(v_item->'parts') LOOP
                    v_part_id := (v_ref_map->>(v_inner->>'part_ref'))::uuid;
                    v_job_part_id := gen_random_uuid();

                    INSERT INTO job_parts (id, job_id, company_id, part_id,
                                           sequence, quantity, status)
                    VALUES (v_job_part_id, v_job_id, p_company_id, v_part_id,
                            COALESCE((v_inner->>'sequence')::integer, 10),
                            COALESCE((v_inner->>'quantity')::integer, 1),
                            COALESCE(v_inner->>'status', 'not_started'));

                    IF v_inner->>'routing_ref' IS NOT NULL THEN
                        PERFORM create_job_part_operations_from_routing(
                            v_job_part_id,
                            (v_ref_map->>(v_inner->>'routing_ref'))::uuid
                        );
                    END IF;
                END LOOP;
            END IF;
        END LOOP;
    END IF;
END;
$function$;
