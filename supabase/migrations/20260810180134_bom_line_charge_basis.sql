-- Per-BOM-line charge basis: a child contributes its COST (default) or its
-- MARKED-UP PRICE to the parent's rollup. Issue #727.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- WHY
-- ═══════════════════════════════════════════════════════════════════════════════
-- Every part already carries cost tiers and pricing tiers. What was missing is one
-- rollup rule: a child in a parent's BOM always contributed its COST, so the
-- child's declared markup evaporated. The only way to express "markup on material,
-- straight cost on machining" was padding the child's cost with hidden margin —
-- which falsifies the cost field and corrupts the ground-truth data the product
-- exists to accumulate.
--
-- Now each BOM line declares what the child contributes. Cost fields stay true
-- cost; markup lives where it is declared. Economically this is transfer pricing:
-- "we sell the material to the job at our material price."
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- THE RULE
-- ═══════════════════════════════════════════════════════════════════════════════
--   true_cost(P,n)   = ops(P,n) + Σ qᵢ × true_cost(Cᵢ, valqtyᵢ)     ← ignores bases
--   charge_base(P,n) = ops(P,n) + Σ qᵢ × ( basisᵢ = 'cost'
--                                            ? charge_base(Cᵢ, valqtyᵢ)
--                                            : price(Cᵢ, valqtyᵢ) )
--
--   price(C,q):  own pricing tier            → source 'tier'
--                else company default (BOUGHT children only)
--                                             → source 'company_default'
--                else NULL                    → un-priceable, surfaced as a gap
--
-- A line's basis governs how that child is charged into its parent AT EVERY LEVEL:
-- a 'cost' line contributes the child's CHARGE BASE (not its true cost), so a
-- material markup declared deep in a tree survives the hop upward instead of
-- evaporating one level higher. The two modes are therefore one function body with
-- one flag, not two engines — see part_rollup_at_qty.
--
-- NO-OP GUARANTEE. Every line defaults to 'cost' and every company's default
-- markup starts NULL, so charge_base ≡ true_cost and compute_part_cost_at_qty
-- returns exactly what it returned before this migration. No BOM changes value; no
-- price moves. Asserted directly by the integration tests.
--
-- BOUGHT-ONLY DEFAULT. The company default applies to bought children only. Every
-- incumbent (Fulcrum, ProShop, JobBOSS²) scopes material markup to out-of-pocket
-- purchased cost, never in-house labor; the default already propagates upward from
-- bought leaves via the nesting rule, so applying it again at a made mid-level part
-- would double-mark the embedded material AND mark up labor nobody declared.
-- Marking up in-house work is deliberate transfer pricing and needs an explicit
-- tier on that part.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. SCHEMA
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1a. The per-line declaration. Default 'cost' = today's behavior for every row.
ALTER TABLE public.parts_bom
  ADD COLUMN charge_basis text NOT NULL DEFAULT 'cost'
    CHECK (charge_basis IN ('cost', 'price'));

COMMENT ON COLUMN public.parts_bom.charge_basis IS
  'What this child contributes to the parent''s rollup: ''cost'' (default) = the child''s charge base, i.e. our cost of it; ''price'' = the child''s marked-up price (its own pricing tier, else the company default material markup for bought children). Per-line by design — a shop may charge material at price on customer jobs and at cost on internal stock-making work orders.';

-- 1b. The shop-wide default material markup.
--
-- A REAL COLUMN, not a companies.settings jsonb entry in lib/companyDefaults.ts
-- KNOWN_DEFAULTS, for three reasons — any one of them disqualifying:
--   1. The engine that reads it is THIS FILE. A jsonb path would mean the
--      clamp/fallback semantics live in the TS registry and get re-implemented in
--      SQL with nothing enforcing agreement — a second copy of a money rule.
--   2. That registry's coerceInt() rounds to a whole number. part_pricing_tiers
--      .markup_percent is numeric(10,6), widened from numeric(5,2) precisely
--      because 0.01% quantization visibly moved the price.
--   3. The registry is dense — every descriptor has a non-null fallback and
--      readCompanyDefault returns `number`. "Unset" cannot be expressed, and
--      unset-means-no-default is the entire no-op guarantee above.
-- NULL = unset = a price-basis child must carry its own pricing tier.
ALTER TABLE public.companies
  ADD COLUMN default_material_markup_percent numeric(10,6)
    CHECK (default_material_markup_percent IS NULL
           OR default_material_markup_percent >= 0);

COMMENT ON COLUMN public.companies.default_material_markup_percent IS
  'Shop-wide default markup % applied to a BOUGHT material charged at price on a BOM line that has no pricing tier of its own. NULL = unset: such a line is un-priceable and surfaces as a gap (no silent fallback to cost). Never applies to made parts — see the migration header.';

-- 1c. Quote snapshot fidelity.
--
-- charge_basis + true cost alone cannot explain a price-basis line: which rung
-- fired is unrecoverable, and so is the percentage (for a made child the charged
-- and true rates have DIFFERENT bases, so charged/true - 1 ≠ markup). Both are
-- captured so a committed quote keeps saying "shop default 25%" after the setting
-- becomes 30% — the read-time-shared-default failure that got the markup_rates
-- module deleted in July 2026 is exactly what these two columns prevent.
ALTER TABLE public.quote_materials
  ADD COLUMN charge_basis text NOT NULL DEFAULT 'cost'
    CHECK (charge_basis IN ('cost', 'price')),
  ADD COLUMN true_cost_per_unit numeric,
  ADD COLUMN true_line_cost numeric,
  ADD COLUMN charge_rate_source text
    CHECK (charge_rate_source IS NULL
           OR charge_rate_source IN ('tier', 'company_default')),
  ADD COLUMN charge_markup_percent numeric(10,6);

-- Data at rest, not a read-time fallback: every existing row is a 'cost' row, so
-- its charged numbers ARE its true numbers.
UPDATE public.quote_materials
   SET true_cost_per_unit = cost_per_unit,
       true_line_cost     = line_cost;

COMMENT ON COLUMN public.quote_materials.cost_per_unit IS
  'The rate that actually went INTO the rollup for this material — the child''s cost on a ''cost'' line, its marked-up price on a ''price'' line. Read it together with charge_basis. True cost is true_cost_per_unit.';
COMMENT ON COLUMN public.quote_materials.line_cost IS
  'Per-parent-unit contribution at the charged rate. Σ line_cost reconciles against quote_line_items.base_cost_per_unit.';
COMMENT ON COLUMN public.quote_materials.charge_basis IS
  'The BOM line''s charge basis at quote time: ''cost'' or ''price''.';
COMMENT ON COLUMN public.quote_materials.true_cost_per_unit IS
  'The child''s TRUE cost per unit, ignoring every charge basis in the tree. The denominator for effective margin.';
COMMENT ON COLUMN public.quote_materials.true_line_cost IS
  'Per-parent-unit contribution at the TRUE cost rate.';
COMMENT ON COLUMN public.quote_materials.charge_rate_source IS
  'Which rung produced the charged rate on a ''price'' line: ''tier'' (the material''s own pricing tier) or ''company_default'' (the shop-wide material markup). NULL on ''cost'' lines — nothing was resolved.';
COMMENT ON COLUMN public.quote_materials.charge_markup_percent IS
  'The markup % actually applied on a ''price'' line, frozen. Not derivable from charged-vs-true, and must not move when the company default later changes.';

ALTER TABLE public.quote_line_items
  ADD COLUMN true_cost_per_unit numeric;

UPDATE public.quote_line_items
   SET true_cost_per_unit = base_cost_per_unit;

COMMENT ON COLUMN public.quote_line_items.base_cost_per_unit IS
  'The CHARGE BASE the price was built on, at the matched tier''s quantity. The row''s own invariant is unit_price = base_cost_per_unit × (1 + markup_percent/100).';
COMMENT ON COLUMN public.quote_line_items.true_cost_per_unit IS
  'True rolled-up cost per unit at the same quantity, ignoring every BOM charge basis. Effective margin = (unit_price - true_cost_per_unit) / unit_price. Equals base_cost_per_unit whenever no material is charged at price.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. ENGINE — one body, two modes
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- part_rollup_at_qty holds what used to be compute_part_cost_at_qty's body,
-- verbatim, plus ONE branch in the BOM loop. The flag propagates through the
-- recursion, so `false` reproduces the old function exactly and `true` honors
-- every declaration in the tree.
--
-- compute_part_cost_at_qty is CREATE OR REPLACE'd in place rather than dropped and
-- recreated with a defaulted third argument: a 2-arg call would then be ambiguous
-- against the 3-arg overload, and DROP FUNCTION destroys both the ACL and the
-- COMMENT. Replacing in place keeps its existing grants untouched.
--
-- part_rollup_at_qty and compute_part_price_explain_at_qty are mutually recursive.
-- plpgsql resolves called functions at execution time, so creation order is free.

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
    v_consumed numeric;
    v_child_val_qty numeric;
    v_pinned boolean;
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

        -- THE ONE NEW BRANCH. Tier resolution for the price rung uses the SAME
        -- valuation quantity the cost path already uses — any divergence produces
        -- unexplainable quotes, and for bought material the two are identical
        -- anyway (valqty IS the consumed qty).
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

COMMENT ON FUNCTION public.part_rollup_at_qty(uuid, numeric, boolean) IS
  'THE cost/charge rollup for a part at a quantity — one body, two modes. p_apply_charge_basis=false ignores every parts_bom.charge_basis and returns TRUE COST (identical to the pre-#727 compute_part_cost_at_qty). true honors each line: a ''cost'' line contributes the child''s charge base, a ''price'' line the child''s marked-up price. Callers use the two named wrappers; this exists so there is only one implementation of the math.';

-- ── The price rung ────────────────────────────────────────────────────────────
-- Returns the rate AND which rung produced it. The UI and the quote snapshot both
-- need the source, and deriving it at the call site would be a second copy of the
-- rule on a money path.
CREATE OR REPLACE FUNCTION public.compute_part_price_explain_at_qty(
    p_part_id uuid,
    p_qty numeric
)
RETURNS TABLE(
    unit_price     numeric,
    rate_source    text,
    markup_percent numeric
)
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    v_markup    numeric;
    v_basis_qty numeric;
    v_source    text;
    v_base      numeric;
    v_default   numeric;
BEGIN
    -- Rung 1 — the child's OWN pricing tier. Explicit beats default. Mirrors
    -- resolveMarkupAtQty: largest quantity <= qty, floored to the lowest break
    -- when below the ladder.
    SELECT pt.markup_percent, pt.quantity
      INTO v_markup, v_basis_qty
      FROM public.part_pricing_tiers pt
     WHERE pt.part_id = p_part_id
       AND pt.markup_percent IS NOT NULL
       AND pt.quantity <= p_qty
     ORDER BY pt.quantity DESC
     LIMIT 1;

    IF v_markup IS NULL THEN
        SELECT pt.markup_percent, pt.quantity
          INTO v_markup, v_basis_qty
          FROM public.part_pricing_tiers pt
         WHERE pt.part_id = p_part_id
           AND pt.markup_percent IS NOT NULL
         ORDER BY pt.quantity ASC
         LIMIT 1;
    END IF;

    IF v_markup IS NOT NULL THEN
        -- The tier's listed price holds for its whole band, so the base is
        -- evaluated at the TIER's quantity — the number this part's own Pricing
        -- card shows for that break (founder rule, 2026-08-07).
        v_source := 'tier';
    ELSE
        -- Rung 2 — the shop-wide default, BOUGHT children only.
        SELECT c.default_material_markup_percent
          INTO v_default
          FROM public.parts p
          JOIN public.companies c ON c.id = p.company_id
         WHERE p.id = p_part_id
           AND p.source = 'bought';

        -- Rung 3 — nothing. A gap to surface, never a silent fall back to cost.
        IF v_default IS NULL THEN
            RETURN;
        END IF;

        v_markup    := v_default;
        v_source    := 'company_default';
        -- No tier means no band to hold, so the base is evaluated at the
        -- quantity actually being valued.
        v_basis_qty := p_qty;
    END IF;

    v_base := public.part_rollup_at_qty(p_part_id, v_basis_qty, true);

    unit_price     := CASE WHEN v_base IS NULL THEN NULL
                           ELSE round(v_base * (1 + v_markup / 100.0), 2) END;
    rate_source    := v_source;
    markup_percent := v_markup;
    RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.compute_part_price_explain_at_qty(uuid, numeric) IS
  'The price a part is charged at when a BOM line charges it at price, plus WHICH rung produced it: ''tier'' (its own pricing tier, base evaluated at the tier''s own quantity per the tier-band rule) or ''company_default'' (companies.default_material_markup_percent, bought parts only, base evaluated at p_qty). Returns NO ROW when neither applies — the caller must treat that as un-priceable, never as cost.';

CREATE OR REPLACE FUNCTION public.compute_part_price_at_qty(p_part_id uuid, p_qty numeric)
 RETURNS numeric
 LANGUAGE sql
 STABLE
AS $function$
    SELECT unit_price FROM public.compute_part_price_explain_at_qty(p_part_id, p_qty);
$function$;

COMMENT ON FUNCTION public.compute_part_price_at_qty(uuid, numeric) IS
  'Rate-only wrapper over compute_part_price_explain_at_qty, so there is one implementation of the three-rung rule. NULL when no rung applies.';

-- ── The two named modes ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.compute_part_cost_at_qty(p_part_id uuid, p_qty numeric)
 RETURNS numeric
 LANGUAGE sql
 STABLE
AS $function$
    SELECT public.part_rollup_at_qty(p_part_id, p_qty, false);
$function$;

COMMENT ON FUNCTION public.compute_part_cost_at_qty(uuid, numeric) IS
  'TRUE unit cost at a quantity — what the part costs us. Ignores every parts_bom.charge_basis, so it is unchanged by #727 and is the honest denominator for effective margin. Bought: procurement tier at that qty, floored to the lowest tier below the minimum. Made: routing ops + BOM children (a made child at its costing lot size, a bought child at the consumed qty). Raises on missing labor rate / external pricing / unit conversion. The number a PRICE is built on is compute_part_charge_base_at_qty.';

CREATE OR REPLACE FUNCTION public.compute_part_charge_base_at_qty(p_part_id uuid, p_qty numeric)
 RETURNS numeric
 LANGUAGE sql
 STABLE
AS $function$
    SELECT public.part_rollup_at_qty(p_part_id, p_qty, true);
$function$;

COMMENT ON FUNCTION public.compute_part_charge_base_at_qty(uuid, numeric) IS
  'The base a PRICE is built on: the rollup honoring every parts_bom.charge_basis in the tree. Equals compute_part_cost_at_qty whenever no line charges at price. This is what markup is applied to, and what quote_line_items.base_cost_per_unit snapshots.';

-- Browser roles need these: the pricing card, the BOM panel and the quote form all
-- call them directly. All four are SECURITY INVOKER, so RLS still contains them —
-- the companies read inside the price rung resolves through user_company_access.
GRANT EXECUTE ON FUNCTION public.part_rollup_at_qty(uuid, numeric, boolean)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.compute_part_price_explain_at_qty(uuid, numeric)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.compute_part_price_at_qty(uuid, numeric)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.compute_part_charge_base_at_qty(uuid, numeric)
  TO anon, authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. PRICEABILITY — both halves of the agreement move together
-- ═══════════════════════════════════════════════════════════════════════════════
-- 20260715180446 established that only the ROOT needs a markup, reasoning that "a
-- material's markup is never used when it's consumed inside another part". A
-- price-basis line makes that false for that edge — and the company default makes
-- it false again in the other direction, because a bought child covered by the
-- default needs no tier of its own.
--
-- The list RPC and the detail explain must agree in every combination, so both
-- learn the same rule:
--
--   a price-basis child is satisfied  ⇔  it has a non-null-markup pricing tier
--                                        OR (it is bought AND the company default
--                                            is set)
--
-- is_priceable stays STRUCTURAL (the three gap arrays), deliberately. Adding "and
-- the charge base resolves" would flip parts whose cost RAISES for reasons the
-- arrays don't model — a missing unit conversion — while get_priceable_part_ids,
-- which evaluates no costs, kept saying ready. That is the exact disagreement the
-- agreement test exists to prevent.

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
    v_default_markup   numeric;
BEGIN
    -- The shop-wide default, read once from the root part's company. A BOM tree
    -- lives inside one company (RLS scopes every read to the caller's companies).
    SELECT c.default_material_markup_percent
      INTO v_default_markup
      FROM public.parts p
      JOIN public.companies c ON c.id = p.company_id
     WHERE p.id = p_part_id;

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
    -- Markup is needed by the ROOT (the part being quoted) and by any child
    -- CHARGED AT PRICE — its markup is what the parent pays. A bought child
    -- covered by the shop-wide default needs no tier of its own.
    markups AS (
        SELECT tr.part_id, tr.part_name, tr.source, MIN(tr.depth) AS depth
          FROM tree tr
         WHERE (
                   tr.depth = 0
                   OR (
                       tr.charged_at_price
                       AND NOT (tr.source = 'bought' AND v_default_markup IS NOT NULL)
                   )
               )
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

COMMENT ON FUNCTION public.compute_part_cost_explain(uuid, numeric) IS
  'TRUE unit cost (charge bases ignored) plus the three structural gap arrays: bought leaves with no procurement tier, parts that need a markup and lack one, and routing ops with no rate. A part needs a markup when it is the ROOT being quoted or when a BOM line charges it AT PRICE — unless it is a bought part covered by companies.default_material_markup_percent. is_priceable is the AND of the three arrays being empty, and matches get_priceable_part_ids exactly.';

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
    v_default_markup numeric;
BEGIN
    -- Read the shop-wide default once, not per fixed-point iteration.
    SELECT c.default_material_markup_percent
      INTO v_default_markup
      FROM public.companies c
     WHERE c.id = p_company_id;

    -- COSTABLE — a part whose cost resolves. Markup is NOT required here unless a
    -- BOM line charges the child at price (below). Base case: bought parts with a
    -- non-expired procurement tier.
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
          -- Every BOM child must already be costable — AND, when the line charges
          -- it at price, must have a markup to charge: its own tier, or the
          -- shop-wide default if it is a bought part.
          AND NOT EXISTS (
              SELECT 1
              FROM public.parts_bom b
              JOIN public.parts cp ON cp.id = b.child_part_id
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
                        AND NOT (cp.source = 'bought' AND v_default_markup IS NOT NULL)
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

COMMENT ON FUNCTION public.get_priceable_part_ids(uuid) IS
    'Returns the part ids in a company that are ready to quote: cost resolves (bought: procurement tier; made: all ops priced and all BOM children costable) AND the part itself has a non-null-markup pricing tier. A material''s own markup is required only when a BOM line charges it AT PRICE — and even then not if it is a bought part covered by companies.default_material_markup_percent. Matches compute_part_cost_explain.is_priceable.';
