-- Remove consume_whole_units entirely.
--
-- WHY. The flag encoded, for a second time, something parts_bom.quantity already
-- says: a fractional quantity means the material gets cut, a whole number means
-- it gets consumed whole. Two encodings of one fact can disagree, and they did.
--
-- MaterialRowEditor re-derived the flag from the BOM line's unit on every save
-- (count unit -> true), with no toggle. Contour's C FLAT .125 STB432 WF10 (MG18)
-- is bar stock stocked as "each", so hand-editing any line that used it silently
-- turned on ceil(). On NPP-490/40752-1ST POS-INS at 0.2 per part, the price is
-- anchored at its only pricing tier (quantity 1), so the material term was
-- ceil(1 x 0.2) x $70 = $70 -- and EVERY quantity in (0, 1] produced the same
-- number. The field was inert across its whole useful range.
--
-- That was one row against ~140 imported rows using the same material, all of
-- which correctly had the flag off. Across all of production exactly one row
-- paired whole-units with a fractional quantity.
--
-- WHAT MOVES. Material cost becomes qty_in_primary * child_unit_cost, always.
-- Once the ceil is gone, (units_consumed * child_cost) / p_qty is identically
-- qty_in_primary * child_cost, so the made and bought arms of the accumulation
-- merge into one line. Made vs bought now differs ONLY in the quantity the
-- child's cost is resolved at (pinned lot size vs actual consumption).
--
-- The shop floor loses its whole-unit fetch rounding too: a material card that
-- read "needs 1 each" now reads "needs 0.6 each". Deliberate -- see the plan.
--
-- NOTE for whoever reads 20260811233748_job_cost_snapshot.sql: its header cites
-- "the consume_whole_units ceiling" as one reason materials are not snapshotted
-- per job line. That reason is gone as of this migration; the other two stand.
--
-- Every definition below was rebuilt from the LIVE PRODUCTION body (verified by
-- md5 against pg_proc.prosrc), not from the migration that first created it.
-- CREATE OR REPLACE throughout, never DROP+CREATE: a drop destroys both the ACL
-- and the COMMENT, and part_rollup_at_qty is granted to anon and authenticated.

-- ── The cost engine ─────────────────────────────────────────────────────────
-- Rebuilt from 20260823163931 (split_vendor_services_from_work_centers), its
-- newest definition. One change: the whole-unit ceiling and the two-branch
-- accumulation it forced are gone. The routing-op loop, the charge-basis
-- handling and the made-vs-bought valuation are byte-identical.
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
                -- INHERITANCE, symmetric with the internal arm above: the step's
                -- own price wins, else the service's. Raising a vendor's price
                -- moves every step that never overrode it, exactly as raising a
                -- station's labor_rate does.
                IF v_op.external_unit_price IS NULL AND v_op.vs_unit_price IS NULL THEN
                    RAISE EXCEPTION
                        'Cannot compute cost for part %: outside routing op has no unit price (neither a step override nor a price on the vendor service)',
                        v_part_name
                        USING ERRCODE = 'check_violation';
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

-- ── The detail-page verdict, which MUST agree with get_priceable_part_ids ────
-- Rebuilt from 20260823163931, its newest definition. One change: the recursive
-- CTE's three-way CASE loses its whole-unit arm and collapses to two. Note this
-- CTE ceilinged a DIFFERENT quantity from the engine above (the cascaded
-- cumulative_qty, not the per-line consumption), so the two had to move together
-- or the list and detail pages would give opposite confident answers again --
-- which is exactly the 2026-08-19 incident that
-- api/tests/integration/test_priceability_agreement.py exists to catch.
--
-- User-visible side effect: leaves.qty_required feeds the "no priced tier covers
-- qty X" gap message, so X is now the exact consumption (0.05) rather than the
-- ceilinged one (1). Cosmetic, but it will look like a regression to anyone who
-- knows the old text.
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

-- ── get_procurement_cost: floor below the lowest break, like the engine ─────
-- Rebuilt from 20260714173443, its newest definition. part_rollup_at_qty has
-- floored to the lowest-min tier since 20260713235939; this function never did,
-- so below every break the engine returned a real cost while this returned no
-- row at all. It feeds a bought part's displayed "Base / unit", so the page
-- could show a blank base for a part the engine costs fine.
--
-- Verified against production before the change, on the part that prompted all
-- of this: at qty 0.1, get_procurement_cost -> NULL, part_rollup_at_qty -> 70.
--
-- Removing the whole-unit ceiling makes bought consumption fractional far more
-- often, so this divergence was about to fire much harder than it used to.
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

    -- Below every break: floor to the lowest-min tier, byte-parallel with the
    -- fallback in part_rollup_at_qty. The two answer the same question and must
    -- not disagree.
    IF NOT FOUND THEN
        SELECT t.id, t.cost_per_unit
          INTO v_tier
          FROM public.part_procurement_tiers t
         WHERE t.part_id = p_part_id
           AND (t.expires_at IS NULL OR t.expires_at >= CURRENT_DATE)
         ORDER BY t.min_quantity ASC,
                  t.cost_per_unit ASC
         LIMIT 1;
    END IF;

    IF FOUND THEN
        unit_cost := v_tier.cost_per_unit;
        vendor_id := v_preferred_vendor_id;
        tier_id   := v_tier.id;
        source    := 'tier';
        RETURN NEXT;
    END IF;
    -- No row only when the part has no live tier at all.
END;
$$;

COMMENT ON FUNCTION public.get_procurement_cost(uuid, numeric) IS
    'Returns the active part-level procurement tier at quantity p_qty (cheapest non-expired tier with min_quantity <= p_qty), flooring to the lowest-min tier when p_qty is below every break — matching part_rollup_at_qty. No row only when the part has no live tier at all. vendor_id in the result is the part''s preferred-vendor label (display only) — cost is part-level and vendor-independent.';

-- ── Demo seeding ────────────────────────────────────────────────────────────
-- Rebuilt from 20260824022226 (vendor_addresses), its newest definition, with
-- consume_whole_units removed from the parts_bom INSERT. Nothing else changes.
--
-- THIS IS THE ONE THAT BITES. A stale plpgsql body referencing a dropped column
-- applies clean, passes every static guard and every CI check, and fails only
-- when someone actually creates a demo company. Found by querying pg_proc.prosrc
-- in production; nothing in the repo would have surfaced it. Template JSON rows
-- may still carry a "consume_whole_units" key -- now simply ignored, and
-- harmless, since templates ship as migrations.
CREATE OR REPLACE FUNCTION public.seed_demo_data(p_company_id uuid, p_user_id uuid, p_template_name text DEFAULT 'default'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_template   jsonb;
    v_ref_map    jsonb := '{}'::jsonb;
    v_service_refs  jsonb := '[]'::jsonb;
    v_item       jsonb;
    v_inner      jsonb;
    v_leaf       jsonb;
    v_new_id     uuid;
    v_routing_id uuid;
    v_quote_id   uuid;
    v_job_id     uuid;
    v_job_part_id uuid;
    v_ship_id    uuid;
    v_note_id    uuid;
    v_op_id      uuid;
    v_part_id    uuid;
    v_cust_id    uuid;
    v_loc_id     uuid;
    v_source     text;
    v_qty        numeric;
    v_unit_price numeric;
    v_job_number text;
    v_base       text;
    v_seq        integer;
    v_members    uuid[];   -- user_company_access.id
    v_users      uuid[];   -- auth.users.id
    v_author     uuid;
    v_n_authors  integer;
BEGIN
    SELECT template_data INTO v_template
    FROM demo_data_templates
    WHERE name = p_template_name AND is_active = true
    LIMIT 1;

    IF v_template IS NULL THEN
        RAISE EXCEPTION 'No active demo template found with name: %', p_template_name;
    END IF;

    -- Two author pools, because the schema names actors two different ways and
    -- getting them backwards is a FK error at best and the wrong name on screen
    -- at worst:
    --   notes.author_id / note_reactions.reactor_id -> user_company_access.id
    --       (the MEMBERSHIP row — a note belongs to someone's membership of this
    --        company, so removing them from the company detaches it)
    --   job_operation_completions.completed_by, inventory_transactions.created_by,
    --   jobs/quotes/shipments.created_by                    -> auth.users.id
    -- Both are built in one pass ordered by user_id, so `author_index: 2` is the
    -- same person in a note and in a completion, and stays that person across
    -- resets. create_demo_company mirrors user_company_access BEFORE seeding, so
    -- the demo already has the real company's team — which is what makes the
    -- activity feed read like a shop rather than one person talking to themselves.
    SELECT COALESCE(array_agg(id      ORDER BY user_id), ARRAY[]::uuid[]),
           COALESCE(array_agg(user_id ORDER BY user_id), ARRAY[]::uuid[])
      INTO v_members, v_users
      FROM user_company_access WHERE company_id = p_company_id;
    IF array_length(v_users, 1) IS NULL THEN
        v_members := ARRAY[]::uuid[];      -- no membership row to point a note at
        v_users   := ARRAY[p_user_id];
    END IF;
    v_n_authors := array_length(v_users, 1);

    -- ---- custom units -------------------------------------------------
    IF v_template->'custom_units' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'custom_units') LOOP
            INSERT INTO company_custom_units (company_id, unit_name)
            VALUES (p_company_id, v_item#>>'{}')
            ON CONFLICT (company_id, unit_name) DO NOTHING;
        END LOOP;
    END IF;

    -- ---- storage locations --------------------------------------------
    -- Parents must be listed before their children; `parent_ref` resolves
    -- through the same map as everything else.
    IF v_template->'locations' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'locations') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO inventory_locations (id, company_id, parent_id, name, kind, sort_order)
            VALUES (v_new_id, p_company_id,
                    CASE WHEN v_item->>'parent_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'parent_ref'))::uuid END,
                    v_item->>'name',
                    v_item->>'kind',
                    COALESCE((v_item->>'sort_order')::integer, 0));
        END LOOP;
    END IF;

    -- ---- vendors + contacts -------------------------------------------
    IF v_template->'vendors' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'vendors') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO vendors (id, company_id, name)
            VALUES (v_new_id, p_company_id, v_item->>'name');

            -- The address is its own row now. The TEMPLATE keeps its flat
            -- address_* keys — they still describe one address, which is all a
            -- demo vendor needs — so only the destination changed. A template
            -- entry with no street and no city produces no row at all, rather
            -- than a blank address the UI would render as "an address exists".
            IF COALESCE(v_item->>'address_line1', '') <> ''
               OR COALESCE(v_item->>'city', '') <> '' THEN
                INSERT INTO vendor_addresses (vendor_id, address_line1, address_line2,
                                              city, state, postal_code, country, is_default)
                VALUES (v_new_id, v_item->>'address_line1', v_item->>'address_line2',
                        v_item->>'city', v_item->>'state', v_item->>'postal_code',
                        COALESCE(v_item->>'country', 'USA'), true);
            END IF;

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'contacts', '[]'::jsonb)) LOOP
                INSERT INTO vendor_contacts (vendor_id, name, role, role_label, email, phone, is_primary)
                VALUES (v_new_id, v_inner->>'name',
                        COALESCE(v_inner->>'role', 'sales'), v_inner->>'role_label',
                        v_inner->>'email', v_inner->>'phone',
                        COALESCE((v_inner->>'is_primary')::boolean, false));
            END LOOP;
        END LOOP;
    END IF;

    -- ---- work centers and vendor services ------------------------------
    -- One template array still feeds both, because the template's own shape is
    -- fine: an entry with kind='external' and a vendor_ref has always described
    -- a vendor's service rather than a station. Only the destination changed,
    -- so no template row needs rewriting.
    --
    -- v_service_refs records which _refs became services, so the routing loop
    -- below knows which of the two target columns to fill. The _ref -> uuid map
    -- stays shared, so a template's work_center_ref keeps resolving either way.
    IF v_template->'work_centers' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'work_centers') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));

            IF COALESCE(v_item->>'kind', 'internal') = 'external' THEN
                v_service_refs := v_service_refs || jsonb_build_array(v_item->>'_ref');
                INSERT INTO vendor_services (id, company_id, vendor_id, name, description, unit_price)
                VALUES (v_new_id, p_company_id,
                        (v_ref_map->>(v_item->>'vendor_ref'))::uuid,
                        v_item->>'name',
                        v_item->>'description',
                        NULLIF(v_item->>'unit_price', '')::numeric);
            ELSE
                INSERT INTO work_centers (id, company_id, name, labor_rate, description,
                                          make, model, serial_number, year_built, purchased_on)
                VALUES (v_new_id, p_company_id, v_item->>'name',
                        NULLIF(v_item->>'labor_rate', '')::numeric,
                        v_item->>'description',
                        v_item->>'make', v_item->>'model', v_item->>'serial_number',
                        NULLIF(v_item->>'year_built', '')::integer,
                        CASE WHEN v_item->>'purchased_years_ago' IS NOT NULL
                             THEN (CURRENT_DATE - make_interval(years =>
                                      (v_item->>'purchased_years_ago')::integer))::date END);
            END IF;
        END LOOP;
    END IF;

    -- ---- parts, with their tiers, conversions and shelf balances -------
    IF v_template->'parts' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'parts') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            v_source := COALESCE(v_item->>'source', 'made');

            -- quantity is DERIVED from part_location_stock by trigger. When the
            -- template places stock on named shelves we insert the part at 0 and
            -- let `recompute_part_quantity_from_locations` do the arithmetic;
            -- with no `stock` array we pass the quantity through and
            -- `seed_new_part_balance` parks it at Unassigned. Never write both
            -- — that is how a part ends up counted twice.
            INSERT INTO parts (id, company_id, part_name, description, source,
                               primary_unit, quantity, reorder_point,
                               costing_batch_quantity, preferred_vendor_id)
            VALUES (v_new_id, p_company_id, v_item->>'part_name', v_item->>'description',
                    v_source,
                    COALESCE(v_item->>'primary_unit', 'each'),
                    CASE WHEN v_item->'stock' IS NOT NULL THEN 0
                         ELSE COALESCE((v_item->>'quantity')::numeric, 0) END,
                    NULLIF(v_item->>'reorder_point', '')::numeric,
                    COALESCE((v_item->>'costing_batch_quantity')::numeric, 1),
                    CASE WHEN v_item->>'preferred_vendor_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'preferred_vendor_ref'))::uuid END);

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'stock', '[]'::jsonb)) LOOP
                v_qty := (v_inner->>'quantity')::numeric;
                CONTINUE WHEN v_qty IS NULL OR v_qty <= 0;  -- CHECK: quantity > 0
                INSERT INTO part_location_stock (company_id, part_id, location_id, quantity)
                VALUES (p_company_id, v_new_id,
                        (v_ref_map->>(v_inner->>'location_ref'))::uuid, v_qty);
            END LOOP;

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'procurement_tiers', '[]'::jsonb)) LOOP
                INSERT INTO part_procurement_tiers (part_id, min_quantity, cost_per_unit,
                                                    quoted_at, expires_at, notes)
                VALUES (v_new_id,
                        (v_inner->>'min_quantity')::numeric,
                        (v_inner->>'cost_per_unit')::numeric,
                        CASE WHEN v_inner->>'quoted_days_ago' IS NOT NULL
                             THEN (CURRENT_DATE - (v_inner->>'quoted_days_ago')::integer) END,
                        CASE WHEN v_inner->>'expires_in_days' IS NOT NULL
                             THEN (CURRENT_DATE + (v_inner->>'expires_in_days')::integer) END,
                        v_inner->>'notes');
            END LOOP;

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'pricing_tiers', '[]'::jsonb)) LOOP
                INSERT INTO part_pricing_tiers (part_id, company_id, sequence, quantity, markup_percent)
                VALUES (v_new_id, p_company_id,
                        (v_inner->>'sequence')::integer,
                        (v_inner->>'quantity')::numeric,
                        NULLIF(v_inner->>'markup_percent', '')::numeric);
            END LOOP;

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'unit_conversions', '[]'::jsonb)) LOOP
                INSERT INTO parts_unit_conversions (part_id, from_unit, to_primary_factor)
                VALUES (v_new_id, v_inner->>'from_unit', (v_inner->>'to_primary_factor')::numeric);
            END LOOP;
        END LOOP;
    END IF;

    -- ---- BOM ------------------------------------------------------------
    IF v_template->'parts_bom' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'parts_bom') LOOP
            INSERT INTO parts_bom (parent_part_id, child_part_id, quantity, unit, sequence,
                                   notes)
            VALUES ((v_ref_map->>(v_item->>'parent_ref'))::uuid,
                    (v_ref_map->>(v_item->>'child_ref'))::uuid,
                    (v_item->>'quantity')::numeric,
                    v_item->>'unit',
                    COALESCE((v_item->>'sequence')::integer, 0),
                    v_item->>'notes');
        END LOOP;
    END IF;

    -- ---- routings --------------------------------------------------------
    IF v_template->'routings' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'routings') LOOP
            v_routing_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_routing_id::text));
            INSERT INTO routings (id, company_id, part_id, name, description, created_by)
            VALUES (v_routing_id, p_company_id,
                    (v_ref_map->>(v_item->>'part_ref'))::uuid,
                    v_item->>'name', v_item->>'description', p_user_id);

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'operations', '[]'::jsonb)) LOOP
                -- Exactly one target, per routing_operations_exactly_one_target.
                INSERT INTO routing_operations (routing_id, work_center_id, vendor_service_id, sequence,
                                                setup_minutes, cycle_minutes_per_unit,
                                                labor_rate_override, external_unit_price, instructions)
                VALUES (v_routing_id,
                        CASE WHEN NOT (v_service_refs ? (v_inner->>'work_center_ref'))
                             THEN (v_ref_map->>(v_inner->>'work_center_ref'))::uuid END,
                        CASE WHEN v_service_refs ? (v_inner->>'work_center_ref')
                             THEN (v_ref_map->>(v_inner->>'work_center_ref'))::uuid END,
                        COALESCE((v_inner->>'sequence')::integer, 10),
                        NULLIF(v_inner->>'setup_minutes', '')::numeric,
                        NULLIF(v_inner->>'cycle_minutes_per_unit', '')::numeric,
                        NULLIF(v_inner->>'labor_rate_override', '')::numeric,
                        NULLIF(v_inner->>'external_unit_price', '')::numeric,
                        v_inner->>'instructions');
            END LOOP;
        END LOOP;
    END IF;

    -- ---- customers, contacts, addresses ---------------------------------
    -- The embedded contact_*/address_* columns were dropped from `customers`;
    -- both are now child tables, and `jobs`/`quotes` reference them by id.
    IF v_template->'customers' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'customers') LOOP
            v_cust_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_cust_id::text));
            INSERT INTO customers (id, company_id, name, default_payment_terms,
                                   credit_status, credit_hold_note)
            VALUES (v_cust_id, p_company_id, v_item->>'name',
                    v_item->>'default_payment_terms',
                    COALESCE(v_item->>'credit_status', 'open'),
                    v_item->>'credit_hold_note');

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'contacts', '[]'::jsonb)) LOOP
                v_new_id := gen_random_uuid();
                IF v_inner->>'_ref' IS NOT NULL THEN
                    v_ref_map := jsonb_set(v_ref_map, ARRAY[v_inner->>'_ref'], to_jsonb(v_new_id::text));
                END IF;
                INSERT INTO customer_contacts (id, customer_id, name, role, role_label,
                                               email, phone, is_primary, is_billing_default)
                VALUES (v_new_id, v_cust_id, v_inner->>'name',
                        COALESCE(v_inner->>'role', 'buyer'), v_inner->>'role_label',
                        v_inner->>'email', v_inner->>'phone',
                        COALESCE((v_inner->>'is_primary')::boolean, false),
                        COALESCE((v_inner->>'is_billing_default')::boolean, false));
            END LOOP;

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'addresses', '[]'::jsonb)) LOOP
                v_new_id := gen_random_uuid();
                IF v_inner->>'_ref' IS NOT NULL THEN
                    v_ref_map := jsonb_set(v_ref_map, ARRAY[v_inner->>'_ref'], to_jsonb(v_new_id::text));
                END IF;
                INSERT INTO customer_addresses (id, customer_id, address_line1, address_line2,
                                                city, state, postal_code, country, attention_to,
                                                default_billing, default_shipping)
                VALUES (v_new_id, v_cust_id, v_inner->>'address_line1', v_inner->>'address_line2',
                        v_inner->>'city', v_inner->>'state', v_inner->>'postal_code',
                        COALESCE(v_inner->>'country', 'USA'), v_inner->>'attention_to',
                        COALESCE((v_inner->>'default_billing')::boolean, false),
                        COALESCE((v_inner->>'default_shipping')::boolean, false));
            END LOOP;
        END LOOP;
    END IF;

    -- ---- quotes ----------------------------------------------------------
    -- quote_number is minted by the set_quote_number trigger off the shared
    -- per-company counter, exactly as the app gets it. Reset clears that counter
    -- so a re-seeded demo starts at Q-0001 again instead of drifting upward.
    IF v_template->'quotes' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'quotes') LOOP
            v_quote_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_quote_id::text));
            INSERT INTO quotes (id, company_id, customer_id, status, expiration_date,
                                lead_time_text, payment_terms,
                                billing_address_id, shipping_address_id, contact_id,
                                created_by, created_at)
            VALUES (v_quote_id, p_company_id,
                    CASE WHEN v_item->>'customer_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'customer_ref'))::uuid END,
                    COALESCE(v_item->>'status', 'active'),
                    CASE WHEN v_item->>'expires_in_days' IS NOT NULL
                         THEN (CURRENT_DATE + (v_item->>'expires_in_days')::integer) END,
                    v_item->>'lead_time_text',
                    v_item->>'payment_terms',
                    CASE WHEN v_item->>'billing_address_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'billing_address_ref'))::uuid END,
                    CASE WHEN v_item->>'shipping_address_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'shipping_address_ref'))::uuid END,
                    CASE WHEN v_item->>'contact_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'contact_ref'))::uuid END,
                    p_user_id,
                    now() - make_interval(days => COALESCE((v_item->>'created_days_ago')::integer, 0)));

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'line_items', '[]'::jsonb)) LOOP
                v_qty := (v_inner->>'quantity')::numeric;
                v_unit_price := (v_inner->>'unit_price')::numeric;
                INSERT INTO quote_line_items (quote_id, company_id, part_id, sequence, quantity,
                                              unit_price, total_price, markup_percent,
                                              base_cost_per_unit, lead_time_text)
                VALUES (v_quote_id, p_company_id,
                        (v_ref_map->>(v_inner->>'part_ref'))::uuid,
                        COALESCE((v_inner->>'sequence')::integer, 10),
                        v_qty, v_unit_price,
                        COALESCE(NULLIF(v_inner->>'total_price', '')::numeric,
                                 round(v_qty * v_unit_price, 4)),
                        NULLIF(v_inner->>'markup_percent', '')::numeric,
                        NULLIF(v_inner->>'base_cost_per_unit', '')::numeric,
                        v_inner->>'lead_time_text');
            END LOOP;
        END LOOP;
    END IF;

    -- ---- jobs -------------------------------------------------------------
    IF v_template->'jobs' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'jobs') LOOP
            v_job_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_job_id::text));
            v_job_number := COALESCE(v_item->>'job_number', generate_direct_job_number(p_company_id));

            INSERT INTO jobs (id, company_id, customer_id, quote_id, job_number,
                              production_status, fulfillment_status, invoicing_status,
                              due_date, customer_po_number, is_hot,
                              payment_terms, freight_terms, ship_via, shipping_instructions,
                              billing_address_id, shipping_address_id, contact_id,
                              created_by, created_at)
            VALUES (v_job_id, p_company_id,
                    CASE WHEN v_item->>'customer_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'customer_ref'))::uuid END,
                    CASE WHEN v_item->>'quote_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'quote_ref'))::uuid END,
                    v_job_number,
                    'not_started', 'unshipped', 'uninvoiced',
                    CASE WHEN v_item->>'due_in_days' IS NOT NULL
                         THEN (CURRENT_DATE + (v_item->>'due_in_days')::integer) END,
                    v_item->>'customer_po_number',
                    COALESCE((v_item->>'is_hot')::boolean, false),
                    v_item->>'payment_terms', v_item->>'freight_terms',
                    v_item->>'ship_via', v_item->>'shipping_instructions',
                    CASE WHEN v_item->>'billing_address_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'billing_address_ref'))::uuid END,
                    CASE WHEN v_item->>'shipping_address_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'shipping_address_ref'))::uuid END,
                    CASE WHEN v_item->>'contact_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'contact_ref'))::uuid END,
                    p_user_id,
                    now() - make_interval(days => COALESCE((v_item->>'created_days_ago')::integer, 0)));

            -- A quote that produced a job is converted, by definition.
            IF v_item->>'quote_ref' IS NOT NULL THEN
                UPDATE quotes SET converted_at = COALESCE(converted_at, now())
                 WHERE id = (v_ref_map->>(v_item->>'quote_ref'))::uuid;
            END IF;

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'parts', '[]'::jsonb)) LOOP
                v_job_part_id := gen_random_uuid();
                IF v_inner->>'_ref' IS NOT NULL THEN
                    v_ref_map := jsonb_set(v_ref_map, ARRAY[v_inner->>'_ref'], to_jsonb(v_job_part_id::text));
                END IF;
                v_part_id := (v_ref_map->>(v_inner->>'part_ref'))::uuid;
                v_qty := COALESCE((v_inner->>'quantity')::numeric, 1);
                v_unit_price := NULLIF(v_inner->>'unit_price', '')::numeric;

                -- A bought part has no operations to run, so createJobFromPO
                -- lands it 'completed' on creation. Mirror that, and let made
                -- parts be driven entirely by their completions below.
                v_source := COALESCE(v_inner->>'source', 'made');
                INSERT INTO job_parts (id, job_id, company_id, part_id, sequence, quantity,
                                       unit_price, total_price,
                                       production_status, fulfillment_status, invoicing_status,
                                       started_at, completed_at)
                VALUES (v_job_part_id, v_job_id, p_company_id, v_part_id,
                        COALESCE((v_inner->>'sequence')::integer, 10), v_qty,
                        v_unit_price,
                        CASE WHEN v_unit_price IS NOT NULL THEN round(v_qty * v_unit_price, 4) END,
                        CASE WHEN v_source = 'bought' THEN 'completed' ELSE 'not_started' END,
                        'unshipped', 'uninvoiced',
                        CASE WHEN v_source = 'bought' THEN now() END,
                        CASE WHEN v_source = 'bought' THEN now() END);

                IF v_inner->>'routing_ref' IS NOT NULL THEN
                    PERFORM create_job_part_operations_from_routing(
                        v_job_part_id, (v_ref_map->>(v_inner->>'routing_ref'))::uuid);
                END IF;

                -- Progress is expressed the way the shop floor expresses it: a
                -- completion event per operation. The triggers then derive the
                -- operation status, the job_part's, and the job's — so the demo
                -- can never hold a status combination the app cannot produce.
                FOR v_leaf IN SELECT * FROM jsonb_array_elements(COALESCE(v_inner->'operations', '[]'::jsonb)) LOOP
                    SELECT id INTO v_op_id FROM job_operations
                     WHERE job_part_id = v_job_part_id
                       AND sequence = (v_leaf->>'sequence')::integer;
                    CONTINUE WHEN v_op_id IS NULL;

                    -- Outside ops are driven by the send/receive lifecycle, not
                    -- by quantity events (compute_job_operation_status returns
                    -- their stored status untouched), so they are set directly.
                    IF v_leaf->>'status' IS NOT NULL THEN
                        UPDATE job_operations
                           SET status = v_leaf->>'status',
                               sent_at = CASE WHEN v_leaf->>'status' IN ('sent', 'completed')
                                              THEN now() - make_interval(days =>
                                                   COALESCE((v_leaf->>'days_ago')::integer, 1)) END,
                               sent_by = CASE WHEN v_leaf->>'status' IN ('sent', 'completed')
                                              THEN p_user_id END,
                               completed_at = CASE WHEN v_leaf->>'status' = 'completed'
                                              THEN now() - make_interval(days =>
                                                   COALESCE((v_leaf->>'days_ago')::integer, 0)) END
                         WHERE id = v_op_id;
                    END IF;

                    IF v_leaf->>'completed_quantity' IS NOT NULL THEN
                        v_author := v_users[1 + (COALESCE((v_leaf->>'author_index')::integer, 0)
                                                 % v_n_authors)];
                        INSERT INTO job_operation_completions
                            (company_id, job_operation_id, job_part_id, quantity_good,
                             completed_by, completed_at, note)
                        VALUES (p_company_id, v_op_id, v_job_part_id,
                                (v_leaf->>'completed_quantity')::numeric,
                                v_author,
                                now() - make_interval(days =>
                                        COALESCE((v_leaf->>'days_ago')::integer, 0)),
                                v_leaf->>'note');
                    END IF;
                END LOOP;

                -- External ops set above bypass the completion trigger, so roll
                -- the job_part up explicitly; that UPDATE fires the part->job
                -- sync in turn.
                UPDATE job_parts jp
                   SET production_status = compute_job_part_production_status(jp.id),
                       current_operation_sequence = COALESCE(
                           (SELECT min(o.sequence) FROM job_operations o
                             WHERE o.job_part_id = jp.id AND o.status <> 'completed'),
                           (SELECT max(o.sequence) FROM job_operations o
                             WHERE o.job_part_id = jp.id))
                 WHERE jp.id = v_job_part_id
                   AND jp.production_status IS DISTINCT FROM compute_job_part_production_status(jp.id);
            END LOOP;
        END LOOP;
    END IF;

    -- ---- shipments --------------------------------------------------------
    -- Inserted directly rather than through create_shipment_with_line_items:
    -- that RPC gates on auth.uid()'s company access, which is not a dependency a
    -- seeder should carry. The packing-slip formula is the RPC's, verbatim
    -- (PS-{job_number minus alpha prefix}-{nth shipment on that job}).
    IF v_template->'shipments' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'shipments') LOOP
            v_ship_id := gen_random_uuid();
            v_job_id  := (v_ref_map->>(v_item->>'job_ref'))::uuid;
            SELECT job_number INTO v_job_number FROM jobs WHERE id = v_job_id;
            v_base := regexp_replace(v_job_number, '^[A-Za-z]+-?', '');
            SELECT count(*) + 1 INTO v_seq FROM shipments WHERE job_id = v_job_id;

            INSERT INTO shipments (id, company_id, customer_id, job_id, shipping_address_id,
                                   packing_slip_number, ship_date, carrier, shipping_method,
                                   freight_terms, created_by, created_at)
            VALUES (v_ship_id, p_company_id,
                    (v_ref_map->>(v_item->>'customer_ref'))::uuid, v_job_id,
                    CASE WHEN v_item->>'shipping_address_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'shipping_address_ref'))::uuid END,
                    'PS-' || v_base || '-' || v_seq::text,
                    CURRENT_DATE - COALESCE((v_item->>'ship_days_ago')::integer, 0),
                    v_item->>'carrier',
                    COALESCE(v_item->>'shipping_method', 'shipment'),
                    v_item->>'freight_terms', p_user_id,
                    now() - make_interval(days => COALESCE((v_item->>'ship_days_ago')::integer, 0)));

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'line_items', '[]'::jsonb)) LOOP
                v_qty := (v_inner->>'quantity')::numeric;
                CONTINUE WHEN v_qty IS NULL OR v_qty <= 0;
                INSERT INTO shipment_line_items (shipment_id, job_part_id, quantity)
                VALUES (v_ship_id, (v_ref_map->>(v_inner->>'job_part_ref'))::uuid, v_qty);
            END LOOP;
        END LOOP;
    END IF;

    -- ---- notes / activity feed -------------------------------------------
    IF v_template->'notes' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'notes') LOOP
            v_note_id := gen_random_uuid();
            IF v_item->>'_ref' IS NOT NULL THEN
                v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_note_id::text));
            END IF;
            -- NULL author when the company somehow has no membership rows: an
            -- unattributed note is a real state the UI renders, a dangling FK is not.
            v_author := CASE WHEN array_length(v_members, 1) IS NULL THEN NULL
                        ELSE v_members[1 + (COALESCE((v_item->>'author_index')::integer, 0)
                                            % array_length(v_members, 1))] END;

            INSERT INTO notes (id, company_id, subject_kind, note_type, body, author_id,
                               job_id, job_part_id, job_operation_id,
                               part_id, work_center_id, maintenance_kind, resolves_note_id,
                               created_at)
            VALUES (v_note_id, p_company_id,
                    v_item->>'subject_kind',
                    COALESCE(v_item->>'note_type', 'user'),
                    v_item->>'body', v_author,
                    CASE WHEN v_item->>'job_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'job_ref'))::uuid END,
                    CASE WHEN v_item->>'job_part_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'job_part_ref'))::uuid END,
                    CASE WHEN v_item->>'job_part_ref' IS NOT NULL
                          AND v_item->>'operation_sequence' IS NOT NULL
                         THEN (SELECT id FROM job_operations
                                WHERE job_part_id = (v_ref_map->>(v_item->>'job_part_ref'))::uuid
                                  AND sequence = (v_item->>'operation_sequence')::integer) END,
                    CASE WHEN v_item->>'part_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'part_ref'))::uuid END,
                    CASE WHEN v_item->>'work_center_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'work_center_ref'))::uuid END,
                    v_item->>'maintenance_kind',
                    CASE WHEN v_item->>'resolves_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'resolves_ref'))::uuid END,
                    now() - make_interval(days => COALESCE((v_item->>'days_ago')::integer, 0)));

            CONTINUE WHEN array_length(v_members, 1) IS NULL;  -- reactor_id is NOT NULL
            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'reactions', '[]'::jsonb)) LOOP
                v_author := v_members[1 + (COALESCE((v_inner->>'reactor_index')::integer, 0)
                                           % array_length(v_members, 1))];
                INSERT INTO note_reactions (company_id, note_id, reactor_id, kind)
                VALUES (p_company_id, v_note_id, v_author, COALESCE(v_inner->>'kind', 'helpful'))
                ON CONFLICT DO NOTHING;
            END LOOP;
        END LOOP;
    END IF;

    -- ---- inventory movement history --------------------------------------
    -- The ledger only; balances already come from part_location_stock above.
    -- Writing both is deliberate: the transaction rows are what the Storage
    -- history reads, and they are a log, not a source of truth for quantity.
    IF v_template->'inventory_transactions' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'inventory_transactions') LOOP
            v_part_id := (v_ref_map->>(v_item->>'part_ref'))::uuid;
            v_loc_id  := CASE WHEN v_item->>'location_ref' IS NOT NULL
                              THEN (v_ref_map->>(v_item->>'location_ref'))::uuid END;
            v_qty     := (v_item->>'quantity')::numeric;
            v_author  := v_users[1 + (COALESCE((v_item->>'author_index')::integer, 0) % v_n_authors)];

            INSERT INTO inventory_transactions (company_id, part_id, item_name, type, quantity,
                                                unit, converted_quantity, location_id,
                                                job_id, notes, created_by, created_at)
            SELECT p_company_id, v_part_id, p.part_name, v_item->>'type', v_qty,
                   COALESCE(v_item->>'unit', p.primary_unit),
                   COALESCE(NULLIF(v_item->>'converted_quantity', '')::numeric, v_qty),
                   v_loc_id,
                   CASE WHEN v_item->>'job_ref' IS NOT NULL
                        THEN (v_ref_map->>(v_item->>'job_ref'))::uuid END,
                   v_item->>'notes', v_author,
                   now() - make_interval(days => COALESCE((v_item->>'days_ago')::integer, 0))
              FROM parts p WHERE p.id = v_part_id;
        END LOOP;
    END IF;
END;
$function$;

-- ── Finally, the column itself ──────────────────────────────────────────────
-- Ordered last on purpose: every function that referenced it has been replaced
-- above, in this same transaction. Nothing else depends on it -- verified
-- against pg_depend (no views), pg_policy (no RLS predicate) and pg_constraint
-- (no CHECK). parts_bom_quantity_positive is "> 0" only; nothing in the schema
-- ever assumed integer consumption.
ALTER TABLE public.parts_bom DROP COLUMN consume_whole_units;
