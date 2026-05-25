-- 20260515_preferred_vendor_only_procurement_cost.sql
--
-- Restrict procurement-cost resolution for bought parts to the part's
-- preferred vendor sheet only. Previously, compute_part_cost_at_qty,
-- compute_part_cost_explain, and get_procurement_cost all picked the
-- cheapest applicable tier across every vendor (and fell through to
-- vendor_id=NULL "internal estimate" rows). The Procurement panel only
-- displays one vendor's sheet at a time, so the cost source was effectively
-- hidden from the user — a silent cross-vendor fallback.
--
-- New contract for bought parts:
--   - parts.preferred_vendor_id IS NULL → cost is NULL.
--   - Otherwise pick the cheapest non-expired tier where
--     vendor_id = preferred_vendor_id AND min_quantity <= p_qty.
--   - vendor_id=NULL "Internal estimate" rows are reference-only and
--     never drive cost. They remain in the table; the Procurement panel
--     still shows them under their pseudo-sheet.
--
-- Made parts (own routing + BOM rollup) are unchanged: their cost
-- naturally inherits the new contract via the recursive child cost call.
--
-- Behavior change, not a data change. Bought parts without a preferred
-- vendor or without a matching tier under that vendor will resolve to
-- NULL, surfaced in the UI as "—" with the existing leaf-link tooltip.
-- This is intentional: the previous behavior masked broken/incomplete
-- procurement data; the new behavior makes it visible and fixable.

BEGIN;

-- ============================================================
-- compute_part_cost_at_qty
-- ============================================================

CREATE OR REPLACE FUNCTION public.compute_part_cost_at_qty(p_part_id uuid, p_qty numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    v_source text;
    v_preferred_vendor_id uuid;
    v_routing_id uuid;
    v_total numeric := 0;
    v_op RECORD;
    v_op_cost numeric;
    v_bom RECORD;
    v_to_primary_factor numeric;
    v_qty_in_primary_unit numeric;
    v_child_cost numeric;
    v_tier_cost numeric;
BEGIN
    IF p_qty IS NULL OR p_qty <= 0 THEN
        RAISE EXCEPTION 'compute_part_cost_at_qty: p_qty must be > 0 (got %)', p_qty
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT source, preferred_vendor_id
      INTO v_source, v_preferred_vendor_id
      FROM public.parts
     WHERE id = p_part_id;
    IF v_source IS NULL THEN
        RAISE EXCEPTION 'compute_part_cost_at_qty: part % not found', p_part_id;
    END IF;

    -- ---------- Bought parts: resolve to a preferred-vendor tier ----------
    IF v_source = 'bought' THEN
        IF v_preferred_vendor_id IS NULL THEN
            RETURN NULL;
        END IF;
        SELECT t.cost_per_unit
          INTO v_tier_cost
          FROM public.part_procurement_tiers t
         WHERE t.part_id = p_part_id
           AND t.vendor_id = v_preferred_vendor_id
           AND t.min_quantity <= p_qty
           AND (t.expires_at IS NULL OR t.expires_at >= CURRENT_DATE)
         ORDER BY t.cost_per_unit ASC,
                  t.min_quantity DESC
         LIMIT 1;
        RETURN v_tier_cost;  -- NULL propagates if no tier matches under preferred vendor
    END IF;

    -- ---------- Made parts: own routing + BOM rollup ----------
    SELECT id INTO v_routing_id FROM public.routings WHERE part_id = p_part_id;

    IF v_routing_id IS NOT NULL THEN
        FOR v_op IN
            SELECT ro.setup_minutes,
                   ro.cycle_minutes_per_unit,
                   ro.labor_rate_override,
                   ro.external_unit_price,
                   ro.external_setup_cost,
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
                        p_part_id
                        USING ERRCODE = 'check_violation';
                END IF;
                v_op_cost := (COALESCE(v_op.setup_minutes, 0) / p_qty
                              + COALESCE(v_op.cycle_minutes_per_unit, 0))
                             * COALESCE(v_op.labor_rate_override, v_op.wc_labor_rate)
                             / 60.0;
            ELSE
                IF v_op.external_unit_price IS NULL AND v_op.external_setup_cost IS NULL THEN
                    RAISE EXCEPTION
                        'Cannot compute cost for part %: external routing op has no pricing (neither external_unit_price nor external_setup_cost)',
                        p_part_id
                        USING ERRCODE = 'check_violation';
                END IF;
                v_op_cost := COALESCE(v_op.external_unit_price, 0)
                             + COALESCE(v_op.external_setup_cost, 0) / p_qty;
            END IF;
            v_total := v_total + v_op_cost;
        END LOOP;
    END IF;

    FOR v_bom IN
        SELECT b.quantity,
               b.unit,
               b.child_part_id,
               c.primary_unit AS child_primary_unit
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
                    v_bom.unit, v_bom.child_primary_unit, v_bom.child_part_id
                    USING ERRCODE = 'check_violation';
            END IF;
            v_qty_in_primary_unit := v_bom.quantity * v_to_primary_factor;
        ELSE
            v_qty_in_primary_unit := v_bom.quantity;
        END IF;

        v_child_cost := public.compute_part_cost_at_qty(
            v_bom.child_part_id,
            p_qty * v_qty_in_primary_unit
        );

        IF v_child_cost IS NULL THEN
            RETURN NULL;
        END IF;

        v_total := v_total + v_qty_in_primary_unit * v_child_cost;
    END LOOP;

    RETURN v_total;
END;
$function$;

-- ============================================================
-- compute_part_cost_explain
-- ============================================================
--
-- The "missing leaves" set is now defined as: bought leaves where the
-- preferred vendor has no applicable non-expired tier at the cascaded qty
-- (or no preferred vendor is set). Mirrors compute_part_cost_at_qty's new
-- contract so the UI tooltip points at the same problem the cost call hit.

CREATE OR REPLACE FUNCTION public.compute_part_cost_explain(p_part_id uuid, p_qty numeric)
 RETURNS TABLE(unit_cost numeric, missing_leaves jsonb)
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    v_missing jsonb;
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
    missing AS (
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
    )
    SELECT COALESCE(
              jsonb_agg(
                  jsonb_build_object(
                      'part_id', m.part_id,
                      'part_name', m.part_name,
                      'depth', m.depth,
                      'qty_required', m.qty_required
                  )
                  ORDER BY m.depth DESC, m.part_name ASC
              ),
              '[]'::jsonb
           )
      INTO v_missing
      FROM missing m;

    unit_cost := public.compute_part_cost_at_qty(p_part_id, p_qty);
    missing_leaves := v_missing;
    RETURN NEXT;
END;
$function$;

-- ============================================================
-- get_procurement_cost
-- ============================================================
--
-- Standalone helper for UI display + quote engine. Same preferred-vendor
-- restriction as compute_part_cost_at_qty. Returns no row when the part
-- has no preferred vendor or no applicable tier under that vendor — the
-- TS wrapper translates "no row" into `unit_cost: null`.

CREATE OR REPLACE FUNCTION public.get_procurement_cost(p_part_id uuid, p_qty numeric)
 RETURNS TABLE(unit_cost numeric, vendor_id uuid, tier_id uuid, source text)
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    v_preferred_vendor_id uuid;
    v_tier RECORD;
BEGIN
    SELECT preferred_vendor_id INTO v_preferred_vendor_id
      FROM public.parts WHERE id = p_part_id;
    IF v_preferred_vendor_id IS NULL THEN
        RETURN; -- no rows, callers treat as NULL cost
    END IF;

    -- Pick the cheapest non-expired tier under the preferred vendor where
    -- min_quantity <= p_qty. Cross-vendor and NULL-vendor rows are now
    -- reference-only; they never drive cost.
    SELECT t.id, t.cost_per_unit, t.vendor_id
      INTO v_tier
      FROM public.part_procurement_tiers t
     WHERE t.part_id = p_part_id
       AND t.vendor_id = v_preferred_vendor_id
       AND t.min_quantity <= p_qty
       AND (t.expires_at IS NULL OR t.expires_at >= CURRENT_DATE)
     ORDER BY t.cost_per_unit ASC,
              t.min_quantity DESC
     LIMIT 1;

    IF FOUND THEN
        unit_cost := v_tier.cost_per_unit;
        vendor_id := v_tier.vendor_id;
        tier_id := v_tier.id;
        source := 'tier';
        RETURN NEXT;
    END IF;
    -- No row returned when no tier matches under the preferred vendor.
END;
$function$;

-- ============================================================
-- Comment refresh
-- ============================================================

COMMENT ON COLUMN "public"."part_procurement_tiers"."vendor_id"
    IS 'Vendor whose sheet this tier belongs to. Cost resolution restricts to the part''s preferred_vendor_id — sheets under other vendors (and vendor_id=NULL "Internal estimate" rows) are reference-only and never drive cost. To switch which sheet drives cost, change the part''s preferred_vendor_id.';

COMMENT ON FUNCTION public.compute_part_cost_at_qty(uuid, numeric)
    IS 'Live unit-cost resolution at a given quantity. For bought parts: requires parts.preferred_vendor_id to be set and to have a non-expired tier with min_quantity <= p_qty. Returns NULL when those conditions aren''t met (no silent fallback to other vendors). For made parts: walks routing operations + BOM children recursively; child costs cascade through the same preferred-vendor rule. Raises on missing labor rate / external pricing / unit conversion.';

COMMENT ON FUNCTION public.get_procurement_cost(uuid, numeric)
    IS 'Returns the active procurement tier under the part''s preferred vendor at quantity p_qty, or no row if either the preferred vendor is unset or no tier under it covers p_qty. Tiers under other vendors are reference-only.';

COMMIT;
