-- ============================================================================
-- Procurement tier sheets for bought parts (Phase 1)
-- ============================================================================
--
-- Context. Iteration 2 usability review showed that bought parts often have
-- vendor-supplied tiered pricing ("buy 100 lbs at $0.85/lb, buy 1000 lbs at
-- $0.75/lb"). The single `parts.cost_per_unit` column can't represent that
-- shape. This migration adds an optional `part_procurement_tiers` table that
-- holds the tier sheets, and a `get_procurement_cost(part_id, qty)` SQL
-- function that resolves the right cost for a given quantity.
--
-- Phase 1 scope (this migration + chunk 13 UI):
--   - Data model + tier-sheet UI on bought-part detail pages.
--   - recalculate_part_cost is patched to call get_procurement_cost(child, 1)
--     for BOM rollups so that bought children with tiers contribute the
--     smallest-tier cost rather than the snapshot-only cost_per_unit.
--   - parts.cost_per_unit stays as the single/default cost for bought parts
--     (used as the fallback when no tier matches and as the snapshot for
--     made parts).
--
-- Phase 2 (deferred): tier-aware quote-time recomputation that walks the
-- BOM with the aggregate quote quantity. Tracked in the iteration-2 plan's
-- "Risks and known follow-ups" section.
--
-- Note on `sequence`: there is intentionally no `sequence` column on the
-- tier table. Tier ordering derives from `min_quantity` ascending — that
-- IS the order, and a separate sequence column would just be a second
-- source of truth that can drift. The unique constraint on
-- (part_id, vendor_id, min_quantity) ensures no two tiers from the same
-- vendor sit at the same break.
--
-- Forward-only. Single BEGIN/COMMIT.

BEGIN;

-- ============================================================================
-- Phase 1: part_procurement_tiers table
-- ============================================================================

CREATE TABLE public.part_procurement_tiers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    part_id uuid NOT NULL REFERENCES public.parts(id) ON DELETE CASCADE,
    vendor_id uuid REFERENCES public.vendors(id) ON DELETE RESTRICT,
    -- Nullable vendor_id = "internal estimate, no specific vendor yet"
    -- (useful when sketching cost before sourcing).
    min_quantity numeric NOT NULL CHECK (min_quantity > 0),
    cost_per_unit numeric NOT NULL CHECK (cost_per_unit > 0),
    quoted_at date,
    expires_at date,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    -- Tier ordering is derived from min_quantity ascending. We do NOT carry
    -- a separate `sequence` column — that would be a second source of truth
    -- that can drift from the min_quantity ordering. The unique constraint
    -- below ensures no two tiers from the same vendor sit at the same break.
    UNIQUE (part_id, vendor_id, min_quantity)
);

CREATE INDEX idx_procurement_tiers_part
    ON public.part_procurement_tiers (part_id);

CREATE INDEX idx_procurement_tiers_vendor
    ON public.part_procurement_tiers (vendor_id) WHERE vendor_id IS NOT NULL;

CREATE INDEX idx_procurement_tiers_expiring
    ON public.part_procurement_tiers (part_id, expires_at) WHERE expires_at IS NOT NULL;

COMMENT ON TABLE public.part_procurement_tiers
    IS 'Vendor-keyed tiered pricing for bought parts. Each row is one (vendor, min_quantity, cost_per_unit) point on a vendor''s tier sheet. vendor_id may be NULL for "internal estimate" rows. Ordering of tiers within a vendor sheet is derived from min_quantity ASC — no separate sequence column. Resolved at read time via get_procurement_cost(part_id, qty), which picks the cheapest non-expired tier where min_quantity <= qty across all vendors.';

COMMENT ON COLUMN public.part_procurement_tiers.vendor_id
    IS 'Vendor offering this tier. NULL = "internal estimate" (sketch before sourcing). When set, ON DELETE RESTRICT prevents removing a vendor that still has live tier sheets — drop the tiers first.';

COMMENT ON COLUMN public.part_procurement_tiers.min_quantity
    IS 'Lower bound (inclusive) of this tier in the part''s primary unit. A row with min_quantity=100 means "this price applies when ordering >= 100 of this part". Combined with the next-larger tier from the same vendor, defines a half-open break range.';

COMMENT ON COLUMN public.part_procurement_tiers.cost_per_unit
    IS 'Per-primary_unit cost at this tier. Always positive (CHECK).';

COMMENT ON COLUMN public.part_procurement_tiers.expires_at
    IS 'Date when this tier expires. Tiers past their expires_at are excluded by get_procurement_cost. NULL = never expires (open-ended quote).';


-- ============================================================================
-- Phase 2: updated_at trigger
-- ============================================================================

CREATE TRIGGER part_procurement_tiers_updated_at
    BEFORE UPDATE ON public.part_procurement_tiers
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();


-- ============================================================================
-- Phase 3: RLS policies — mirror parts_bom (scope through parts.company_id)
-- ============================================================================
--
-- part_procurement_tiers has no company_id of its own (the part_id FK
-- carries the tenancy). RLS pivots through `parts` exactly the way parts_bom
-- does, so the same get_user_company_ids() helper enforces multi-tenant
-- isolation here.

ALTER TABLE public.part_procurement_tiers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view part_procurement_tiers"
    ON public.part_procurement_tiers
    FOR SELECT
    USING (part_id IN (
        SELECT parts.id
        FROM public.parts
        WHERE parts.company_id IN (SELECT get_user_company_ids() AS get_user_company_ids)
    ));

CREATE POLICY "Users can insert part_procurement_tiers"
    ON public.part_procurement_tiers
    FOR INSERT
    WITH CHECK (part_id IN (
        SELECT parts.id
        FROM public.parts
        WHERE parts.company_id IN (SELECT get_user_company_ids() AS get_user_company_ids)
    ));

CREATE POLICY "Users can update part_procurement_tiers"
    ON public.part_procurement_tiers
    FOR UPDATE
    USING (part_id IN (
        SELECT parts.id
        FROM public.parts
        WHERE parts.company_id IN (SELECT get_user_company_ids() AS get_user_company_ids)
    ));

CREATE POLICY "Users can delete part_procurement_tiers"
    ON public.part_procurement_tiers
    FOR DELETE
    USING (part_id IN (
        SELECT parts.id
        FROM public.parts
        WHERE parts.company_id IN (SELECT get_user_company_ids() AS get_user_company_ids)
    ));

CREATE POLICY "ai_readonly_select"
    ON public.part_procurement_tiers
    FOR SELECT
    TO jigged_ai_readonly
    USING (EXISTS (
        SELECT 1
        FROM public.parts
        WHERE parts.id = part_procurement_tiers.part_id
          AND parts.company_id = (current_setting('jigged.company_id'::text, true))::uuid
    ));


-- ============================================================================
-- Phase 4: get_procurement_cost(part_id, qty) function
-- ============================================================================
--
-- Contract (verbatim — see the COMMENT below; callers MUST NOT add a
-- "is this a bought part" guard before invoking):
--
-- - Bought parts WITH tiers: cheapest non-expired tier where
--   min_quantity <= p_qty across vendors. Returns source='tier'.
-- - Bought parts WITHOUT tiers: parts.cost_per_unit. Returns 'fallback'.
-- - Made parts (sub-assemblies and pure custom): no tiers will match
--   (they wouldn't have any), so returns parts.cost_per_unit which is
--   the snapshot from the most recent recalculate_part_cost call.
--   vendor_id and tier_id are NULL in this case. source='fallback'.
--
-- "Non-expired" = expires_at IS NULL OR expires_at >= CURRENT_DATE.
--
-- "Cheapest" tie-break: ORDER BY cost_per_unit ASC, then min_quantity DESC
-- (prefer the wider/larger break at the same price), then vendor_id NULLS
-- LAST (prefer a real vendor over an internal estimate at the same price).

CREATE OR REPLACE FUNCTION public.get_procurement_cost(p_part_id uuid, p_qty numeric)
 RETURNS TABLE(unit_cost numeric, vendor_id uuid, tier_id uuid, source text)
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    v_tier RECORD;
    v_fallback numeric;
BEGIN
    -- Pick the cheapest non-expired tier across vendors where the requested
    -- quantity meets or exceeds the tier's min_quantity break.
    SELECT t.id, t.cost_per_unit, t.vendor_id
      INTO v_tier
      FROM public.part_procurement_tiers t
     WHERE t.part_id = p_part_id
       AND t.min_quantity <= p_qty
       AND (t.expires_at IS NULL OR t.expires_at >= CURRENT_DATE)
     ORDER BY t.cost_per_unit ASC,
              t.min_quantity DESC,
              -- Prefer a real vendor over an "internal estimate" tie.
              t.vendor_id NULLS LAST
     LIMIT 1;

    IF FOUND THEN
        unit_cost := v_tier.cost_per_unit;
        vendor_id := v_tier.vendor_id;
        tier_id := v_tier.id;
        source := 'tier';
        RETURN NEXT;
        RETURN;
    END IF;

    -- No matching tier — fall back to the part's snapshot cost. This branch
    -- intentionally fires for:
    --   - bought parts with no tier sheet at all
    --   - bought parts whose tier sheets all start above p_qty
    --   - bought parts whose tier sheets are all expired
    --   - made parts (which never have tier sheets; cost_per_unit is the
    --     recalculate_part_cost snapshot)
    SELECT cost_per_unit INTO v_fallback FROM public.parts WHERE id = p_part_id;

    unit_cost := v_fallback;
    vendor_id := NULL;
    tier_id := NULL;
    source := 'fallback';
    RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.get_procurement_cost(uuid, numeric)
    IS 'Resolve the per-unit procurement cost of a part for a target quantity. Contract (works for ANY part, not just bought parts): bought parts with tiers return the cheapest non-expired tier where min_quantity <= p_qty (source=''tier''); bought parts without a matching tier return parts.cost_per_unit (source=''fallback''); made parts (no tier sheets) return parts.cost_per_unit which is the snapshot from the most recent recalculate_part_cost call (source=''fallback''). Callers MUST NOT add a "is this a bought part" guard — the function handles all part kinds correctly. Used by the BOM-rollup branch of recalculate_part_cost (with qty=1 in Phase 1) and by the procurement-pricing UI status line.';


-- ============================================================================
-- Phase 5: Patch recalculate_part_cost to use get_procurement_cost for BOM
-- ============================================================================
--
-- Identical to the chunk-11 version EXCEPT the BOM-rollup loop now reads the
-- child's effective cost via get_procurement_cost(child_id, 1) instead of
-- pulling child.cost_per_unit directly. Per get_procurement_cost's
-- documented contract, this works for any child kind:
--   - bought child with tiers → smallest-tier cost
--   - bought child without tiers → child.cost_per_unit (fallback)
--   - made child → child.cost_per_unit snapshot (fallback)
--
-- No type-of-child guard is needed at the call site. Phase 1 still uses
-- qty=1 — the tier-aware aggregate-quantity rollup is Phase 2.

CREATE OR REPLACE FUNCTION public.recalculate_part_cost(p_part_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_source text;
    v_routing_id uuid;
    v_total_cost numeric := 0;
    v_op record;
    v_op_cost numeric;
    v_bom record;
    v_to_primary_factor numeric;
    v_qty_in_primary_unit numeric;
    v_child_unit_cost numeric;
BEGIN
    SELECT source INTO v_source FROM parts WHERE id = p_part_id;
    IF v_source IS NULL THEN
        RAISE EXCEPTION 'part % not found', p_part_id;
    END IF;
    IF v_source <> 'made' THEN
        -- Bought parts: cost is the procurement cost; no rollup to compute.
        RETURN (SELECT cost_per_unit FROM parts WHERE id = p_part_id);
    END IF;

    SELECT id INTO v_routing_id FROM routings WHERE part_id = p_part_id;

    -- Routing operations (only if a routing exists; some made parts may not
    -- have one yet, e.g. immediately after creation).
    IF v_routing_id IS NOT NULL THEN
        FOR v_op IN
            SELECT ro.setup_minutes,
                   ro.cycle_minutes_per_unit,
                   ro.labor_rate_override,
                   ro.external_unit_price,
                   ro.external_setup_cost,
                   wc.kind AS wc_kind,
                   wc.labor_rate AS wc_labor_rate
            FROM routing_operations ro
            JOIN work_centers wc ON wc.id = ro.work_center_id
            WHERE ro.routing_id = v_routing_id
        LOOP
            IF v_op.wc_kind = 'internal' THEN
                -- Per the no-silent-fallbacks engineering principle: if neither
                -- the per-op override nor the work-center default rate is set,
                -- we cannot price this operation. Raise rather than silently
                -- treating as $0 cost (which would let users quote at zero
                -- labor without ever seeing the missing data).
                IF v_op.labor_rate_override IS NULL AND v_op.wc_labor_rate IS NULL THEN
                    RAISE EXCEPTION 'Cannot recalculate cost for part %: routing op has no labor rate (neither override nor work_center default)', p_part_id
                        USING ERRCODE = 'check_violation';
                END IF;
                v_op_cost := (COALESCE(v_op.setup_minutes, 0) / 1
                               + COALESCE(v_op.cycle_minutes_per_unit, 0))
                             * COALESCE(v_op.labor_rate_override, v_op.wc_labor_rate)
                             / 60.0;
            ELSE
                -- External op: at least one of unit_price or setup_cost should be
                -- set (a free outside op is meaningless). NULL on both means
                -- the user hasn't filled in pricing yet — refuse to compute.
                IF v_op.external_unit_price IS NULL AND v_op.external_setup_cost IS NULL THEN
                    RAISE EXCEPTION 'Cannot recalculate cost for part %: external routing op has no pricing (neither external_unit_price nor external_setup_cost)', p_part_id
                        USING ERRCODE = 'check_violation';
                END IF;
                v_op_cost := COALESCE(v_op.external_unit_price, 0)
                             + COALESCE(v_op.external_setup_cost, 0) / 1;
            END IF;
            v_total_cost := v_total_cost + v_op_cost;
        END LOOP;
    END IF;

    -- BOM children. Convert BOM unit → child.primary_unit if they differ;
    -- error explicitly when no conversion exists (matches the existing
    -- unknown_* validation pattern).
    --
    -- Child unit cost is resolved through get_procurement_cost(child_id, 1)
    -- per the function's documented contract — this works for any child
    -- kind (bought-with-tiers, bought-without-tiers, made-snapshot). No
    -- caller-side guard needed. Phase 1 uses qty=1; Phase 2 will revisit
    -- to enable tier-aware aggregate-quantity rollups at quote time.
    FOR v_bom IN
        SELECT b.quantity, b.unit, b.child_part_id,
               c.primary_unit AS child_primary_unit
        FROM parts_bom b
        JOIN parts c ON c.id = b.child_part_id
        WHERE b.parent_part_id = p_part_id
    LOOP
        SELECT unit_cost
          INTO v_child_unit_cost
          FROM public.get_procurement_cost(v_bom.child_part_id, 1);

        IF v_child_unit_cost IS NULL THEN
            -- Per the no-silent-fallbacks principle: a BOM child without a
            -- cost can't contribute to the parent's cost rollup. Raise rather
            -- than treating as $0 (which would let users quote without ever
            -- noticing the missing child cost). The UI should walk the BOM
            -- bottom-up and refuse to recalc the parent until all leaves are
            -- priced.
            RAISE EXCEPTION 'Cannot recalculate cost for part %: BOM child % has no cost_per_unit (recalc the child first, or add a procurement tier)', p_part_id, v_bom.child_part_id
                USING ERRCODE = 'check_violation';
        END IF;

        IF v_bom.unit IS DISTINCT FROM v_bom.child_primary_unit THEN
            SELECT to_primary_factor INTO v_to_primary_factor
            FROM parts_unit_conversions
            WHERE part_id = v_bom.child_part_id
              AND from_unit = v_bom.unit;

            IF v_to_primary_factor IS NULL THEN
                RAISE EXCEPTION 'No unit conversion from % to % for part %',
                    v_bom.unit, v_bom.child_primary_unit, v_bom.child_part_id
                    USING ERRCODE = 'check_violation';
            END IF;

            v_qty_in_primary_unit := v_bom.quantity * v_to_primary_factor;
        ELSE
            v_qty_in_primary_unit := v_bom.quantity;
        END IF;

        v_total_cost := v_total_cost + v_qty_in_primary_unit * v_child_unit_cost;
    END LOOP;

    UPDATE parts
    SET cost_per_unit = v_total_cost,
        cost_recalculated_at = now()
    WHERE id = p_part_id;

    RETURN v_total_cost;
END;
$function$;

COMMENT ON FUNCTION public.recalculate_part_cost(uuid)
    IS 'Recompute and snapshot the unit cost of a made part (source=''made'') by walking its routing operations + BOM children. Bought parts (source=''bought'') return parts.cost_per_unit unchanged. BOM child unit costs are resolved through get_procurement_cost(child_id, 1) per its documented all-kinds contract — bought children with live tiers contribute the smallest-tier cost, bought children without tiers and made children both contribute their parts.cost_per_unit snapshot. Raises on missing labor rate, missing external pricing, missing child cost, or missing unit conversion — never silently substitutes $0. Updates parts.cost_per_unit and parts.cost_recalculated_at on success.';


COMMIT;
