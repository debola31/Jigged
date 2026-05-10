-- ============================================================================
-- Pivot parts classification: source enum + is_stocked rename
-- ============================================================================
--
-- Context. Iteration 1 (PR #246) shipped two booleans on parts:
-- (is_manufacturable, is_stockable). Usability review showed the (false,false)
-- "orphan" quadrant is a phantom state that confuses the form (no chip applies)
-- and the dropdown ("Manufactured" vs "Inventory" obscures the made-vs-bought
-- distinction). The fix is to replace `is_manufacturable boolean` with a
-- `source text` enum ('made' | 'bought') and rename `is_stockable` →
-- `is_stocked` to match shop-floor language ("Is this stocked?").
--
-- Backfill rule:
--   source = CASE
--       WHEN is_manufacturable THEN 'made'
--       WHEN is_stockable      THEN 'bought'
--       ELSE 'made'  -- the (false, false) orphan default
--   END
--
-- The orphan default is 'made' (NOT 'bought') because Contour's analysis showed
-- their 689 (false, false) rows are unshipped customer parts (quoted but not
-- yet built), not procurement items. Defaulting these to 'bought' would have
-- silently re-classified them as drop-ship/service items and surfaced
-- "Service" chips on the parts list, which is wrong. Rolling them into 'made'
-- (combined with !is_stocked) classifies them as "Custom Made" — a faithful
-- description of an unshipped customer part.
--
-- After this migration, every part lives in exactly one of four valid quadrants:
--   (source=made,   !is_stocked)  → Custom Made
--   (source=made,    is_stocked)  → Sub-assembly
--   (source=bought,  is_stocked)  → Raw Material
--   (source=bought, !is_stocked)  → Service / Drop-ship
--
-- This migration also:
--   - Renames the parts_stockable_requires_unit constraint to ..._stocked_...
--   - Replaces the partial indexes that filtered by the old columns
--   - Rewrites recalculate_part_cost to read source = 'made' instead of
--     is_manufacturable. (NOTE: recalculate_part_cost still reads
--     child.cost_per_unit directly for BOM children — chunk 13 will rewrite
--     that to call get_procurement_cost. Don't pre-do that work here.)
--   - Rewrites seed_demo_data to read 'source' / 'is_stocked' from the
--     template_data jsonb keys
--   - Rewrites demo_data_templates.template_data parts entries to use the
--     new keys (source, is_stocked) instead of (is_manufacturable, is_stockable)
--
-- Forward-only. Single BEGIN/COMMIT.

BEGIN;

-- ============================================================================
-- Phase 1: Add `source` column with backfill, drop `is_manufacturable`
-- ============================================================================

ALTER TABLE public.parts
    ADD COLUMN source text NOT NULL DEFAULT 'made'
    CHECK (source IN ('made', 'bought'));

-- Backfill: orphan (false, false) defaults to 'made' (see header comment).
UPDATE public.parts
   SET source = CASE
       WHEN is_manufacturable THEN 'made'
       WHEN is_stockable      THEN 'bought'
       ELSE 'made'
   END;

ALTER TABLE public.parts DROP COLUMN is_manufacturable;

COMMENT ON COLUMN public.parts.source
    IS 'How this part is sourced. ''made'' = produced in-shop (will have a routing); ''bought'' = procured from a vendor. Combined with is_stocked, classifies the part into one of four quadrants (Custom Made / Sub-assembly / Raw Material / Service+Drop-ship). Replaces the prior is_manufacturable boolean — see the 20260504 migration header for the (false,false)→''made'' orphan-default rationale.';


-- ============================================================================
-- Phase 2: Rename is_stockable → is_stocked
-- ============================================================================
--
-- "Is this stocked?" matches shop-floor language better than "Is this
-- stockable?" (the latter sounds like a capability, not a state). Form
-- labels follow.

ALTER TABLE public.parts RENAME COLUMN is_stockable TO is_stocked;

ALTER TABLE public.parts
    RENAME CONSTRAINT parts_stockable_requires_unit
        TO parts_stocked_requires_unit;

COMMENT ON COLUMN public.parts.is_stocked
    IS 'True if quantities of this part are tracked in inventory (renamed from is_stockable in the 20260504 migration to match shop-floor language). Used for the "Stocked" saved view, the inventory panel on the part detail page, and the reorder alerts query.';

COMMENT ON COLUMN public.parts.primary_unit
    IS 'Canonical unit of the on-hand quantity and the cost_per_unit. Required when is_stocked=true (parts_stocked_requires_unit CHECK); may be NULL for made-only parts.';

COMMENT ON COLUMN public.parts.cost_per_unit
    IS 'Per-primary_unit cost. For bought items (source=''bought''), the procurement cost. For made items (source=''made''), snapshot from the most recent recalculate_part_cost call.';


-- ============================================================================
-- Phase 3: Replace partial indexes
-- ============================================================================
--
-- The old indexes filtered on the dropped/renamed columns. Recreate them
-- against the new column names so the parts list page's view filters
-- ("Made", "Stocked") still hit an index.

DROP INDEX IF EXISTS public.idx_parts_company_manufacturable;
DROP INDEX IF EXISTS public.idx_parts_company_stockable;

CREATE INDEX IF NOT EXISTS idx_parts_company_made
    ON public.parts (company_id) WHERE source = 'made';

CREATE INDEX IF NOT EXISTS idx_parts_company_stocked
    ON public.parts (company_id) WHERE is_stocked;


-- ============================================================================
-- Phase 4: Rewrite recalculate_part_cost to read `source = 'made'`
-- ============================================================================
--
-- Functionally identical to the prior version except:
--   - reads parts.source instead of parts.is_manufacturable
--   - the gating condition becomes `source <> 'made'` (i.e. a bought part
--     returns its current cost_per_unit unchanged)
--
-- IMPORTANT: this function still reads child.cost_per_unit directly for BOM
-- children. Chunk 13 will rewrite that branch to call get_procurement_cost
-- once the procurement_tiers table exists. Do NOT pre-do that work here —
-- this migration is only the source-enum rename.

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
    -- NOTE: chunk 13 will replace `child.cost_per_unit` with a call to
    -- get_procurement_cost(child_id, 1) to enable tier-aware costing.
    -- Leave the direct read in place for now.
    FOR v_bom IN
        SELECT b.quantity, b.unit, b.child_part_id,
               c.primary_unit AS child_primary_unit,
               c.cost_per_unit AS child_cost_per_unit
        FROM parts_bom b
        JOIN parts c ON c.id = b.child_part_id
        WHERE b.parent_part_id = p_part_id
    LOOP
        IF v_bom.child_cost_per_unit IS NULL THEN
            -- Per the no-silent-fallbacks principle: a BOM child without a
            -- cost can't contribute to the parent's cost rollup. Raise rather
            -- than treating as $0 (which would let users quote without ever
            -- noticing the missing child cost). The UI should walk the BOM
            -- bottom-up and refuse to recalc the parent until all leaves are
            -- priced.
            RAISE EXCEPTION 'Cannot recalculate cost for part %: BOM child % has no cost_per_unit (recalc the child first)', p_part_id, v_bom.child_part_id
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

        v_total_cost := v_total_cost + v_qty_in_primary_unit * v_bom.child_cost_per_unit;
    END LOOP;

    UPDATE parts
    SET cost_per_unit = v_total_cost,
        cost_recalculated_at = now()
    WHERE id = p_part_id;

    RETURN v_total_cost;
END;
$function$;

COMMENT ON FUNCTION public.recalculate_part_cost(uuid)
    IS 'Recompute and snapshot the unit cost of a made part (source=''made'') by walking its routing operations + BOM children. Bought parts (source=''bought'') return parts.cost_per_unit unchanged. Raises on missing labor rate, missing external pricing, missing child cost, or missing unit conversion — never silently substitutes $0. Updates parts.cost_per_unit and parts.cost_recalculated_at on success.';


-- ============================================================================
-- Phase 5: Replace demo_data_templates.template_data parts entries
-- ============================================================================
--
-- The 20260504_rebuild_demo_seed migration shipped a rich template with
-- (is_manufacturable, is_stockable) keys per part. Rewrite the parts array
-- to use the new (source, is_stocked) keys. Coverage targets unchanged:
--   - 2 raw stockables    (source=bought, is_stocked=true)  → Raw Material
--   - 2 sub-assemblies    (source=made,   is_stocked=true)  → Sub-assembly
--   - 3 finished mfg parts(source=made,   is_stocked=false) → Custom Made
--   - 1 reference/scratch (source=made,   is_stocked=false) → Custom Made
--     (the prior "unclassified" example is reclassified to Custom Made; the
--     orphan quadrant no longer exists in the new model)
--
-- Everything else in template_data (vendors, work_centers, parts_bom,
-- routings, customers, quotes, jobs) stays exactly as 20260504_rebuild_demo_seed
-- shipped it. Only the parts array changes.

UPDATE public.demo_data_templates
   SET template_data = jsonb_set(
        template_data,
        '{parts}',
        jsonb_build_array(
            -- Raw stockables (vendor-supplied bar stock + plate)
            jsonb_build_object(
                '_ref', 'part_raw_bar',
                'part_name', '1018-BAR-1IN',
                'description', '1018 cold-rolled steel bar, 1in dia',
                'source', 'bought',
                'is_stocked', true,
                'primary_unit', 'in',
                'quantity', 240,
                'cost_per_unit', 0.85,
                'reorder_point', 60,
                'preferred_vendor_ref', 'vendor_steel_supply'
            ),
            jsonb_build_object(
                '_ref', 'part_raw_plate',
                'part_name', '6061-PLATE-0.25',
                'description', '6061-T6 aluminum plate, 0.25in thick',
                'source', 'bought',
                'is_stocked', true,
                'primary_unit', 'sqin',
                'quantity', 1800,
                'cost_per_unit', 0.12,
                'reorder_point', 600,
                'preferred_vendor_ref', 'vendor_steel_supply'
            ),
            -- Sub-assemblies (made AND stocked — children for the finished
            -- parts below)
            jsonb_build_object(
                '_ref', 'part_sub_blank',
                'part_name', 'SUB-BLANK-001',
                'description', 'Turned blank, used in WIDGET-100',
                'source', 'made',
                'is_stocked', true,
                'primary_unit', 'each',
                'quantity', 18,
                'cost_per_unit', 6.50
            ),
            jsonb_build_object(
                '_ref', 'part_sub_bracket',
                'part_name', 'SUB-BRACKET-002',
                'description', 'Milled bracket sub-assy, used in BRACKET-300',
                'source', 'made',
                'is_stocked', true,
                'primary_unit', 'each',
                'quantity', 24,
                'cost_per_unit', 11.20
            ),
            -- Finished made parts (the ones that get quoted/jobbed)
            jsonb_build_object(
                '_ref', 'part_widget',
                'part_name', 'WIDGET-100',
                'description', 'Finished widget assembly',
                'source', 'made',
                'is_stocked', false
            ),
            jsonb_build_object(
                '_ref', 'part_bracket',
                'part_name', 'BRACKET-300',
                'description', 'Mounting bracket, anodized',
                'source', 'made',
                'is_stocked', false
            ),
            jsonb_build_object(
                '_ref', 'part_pin',
                'part_name', 'PIN-200',
                'description', 'Hardened pin with EDM keyway',
                'source', 'made',
                'is_stocked', false
            ),
            -- Reference/scratch part. Was "unclassified" in the prior
            -- template; under the new model this is just another Custom Made
            -- row (source=made, !is_stocked). The orphan quadrant no longer
            -- exists.
            jsonb_build_object(
                '_ref', 'part_misc',
                'part_name', 'MISC-NOTE-001',
                'description', 'Reference / scratch part, not stocked',
                'source', 'made',
                'is_stocked', false
            )
        ),
        true  -- create the key if missing (it always exists, defense in depth)
   )
 WHERE is_active = true;


-- ============================================================================
-- Phase 6: Rewrite seed_demo_data() to read the new template keys
-- ============================================================================
--
-- The function is otherwise identical to the version 20260504_rebuild_demo_seed
-- shipped — only the parts insert reads `source` / `is_stocked` from the
-- template_data jsonb instead of the old `is_manufacturable` / `is_stockable`
-- keys, and the INSERT column list switches accordingly.

CREATE OR REPLACE FUNCTION public.seed_demo_data(
    p_company_id uuid,
    p_user_id uuid,
    p_template_name text DEFAULT 'default'
)
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
    v_new_id uuid;
    v_routing_id uuid;
    v_quote_id uuid;
    v_job_id uuid;
    v_job_part_id uuid;
    v_part_id uuid;
BEGIN
    SELECT template_data INTO v_template
    FROM demo_data_templates
    WHERE name = p_template_name AND is_active = true
    LIMIT 1;

    IF v_template IS NULL THEN
        RAISE EXCEPTION 'No active demo template found with name: %', p_template_name;
    END IF;

    -- ── Vendors ───────────────────────────────────────────────────────────
    IF v_template->'vendors' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'vendors') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO vendors (id, company_id, name,
                                 contact_name, contact_email, contact_phone,
                                 address_line1, address_line2, city, state, postal_code, country,
                                 notes, legacy_id)
            VALUES (v_new_id, p_company_id, v_item->>'name',
                    v_item->>'contact_name', v_item->>'contact_email', v_item->>'contact_phone',
                    v_item->>'address_line1', v_item->>'address_line2',
                    v_item->>'city', v_item->>'state', v_item->>'postal_code',
                    COALESCE(v_item->>'country', 'USA'),
                    v_item->>'notes', v_item->>'legacy_id');
        END LOOP;
    END IF;

    -- ── Work centers ──────────────────────────────────────────────────────
    -- Resolves vendor_ref via the ref-map for external work_centers.
    -- The CHECK constraints on work_centers enforce internal/external ↔ vendor.
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

    -- ── Parts ─────────────────────────────────────────────────────────────
    -- Inserted before parts_bom so child refs resolve. preferred_vendor_ref
    -- resolves through the ref-map. Reads `source` / `is_stocked` from
    -- template_data (renamed from `is_manufacturable` / `is_stockable` in
    -- this migration).
    IF v_template->'parts' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'parts') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO parts (id, company_id, part_name, description,
                               source, is_stocked,
                               primary_unit, quantity, cost_per_unit,
                               reorder_point, preferred_vendor_id, legacy_id)
            VALUES (v_new_id, p_company_id,
                    v_item->>'part_name', v_item->>'description',
                    COALESCE(v_item->>'source', 'made'),
                    COALESCE((v_item->>'is_stocked')::boolean, false),
                    v_item->>'primary_unit',
                    COALESCE((v_item->>'quantity')::numeric, 0),
                    NULLIF(v_item->>'cost_per_unit', '')::numeric,
                    NULLIF(v_item->>'reorder_point', '')::numeric,
                    CASE WHEN v_item->>'preferred_vendor_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'preferred_vendor_ref'))::uuid
                         ELSE NULL END,
                    v_item->>'legacy_id');
        END LOOP;
    END IF;

    -- ── parts_bom edges ───────────────────────────────────────────────────
    -- Both parent and child must already be in the ref-map (parts loop above).
    -- The enforce_no_bom_cycles trigger guards against accidental cycles in
    -- the template data — if the template defines one, this insert raises.
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

    -- ── Routings + nested routing_operations ──────────────────────────────
    -- Each routing is keyed by its part_ref (1:1 with the part). Operations
    -- pull work_center_id from the ref-map.
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
                        external_unit_price, external_setup_cost,
                        instructions
                    ) VALUES (
                        v_routing_id,
                        (v_ref_map->>(v_inner->>'work_center_ref'))::uuid,
                        COALESCE((v_inner->>'sequence')::integer, 10),
                        NULLIF(v_inner->>'setup_minutes', '')::numeric,
                        NULLIF(v_inner->>'cycle_minutes_per_unit', '')::numeric,
                        NULLIF(v_inner->>'labor_rate_override', '')::numeric,
                        NULLIF(v_inner->>'external_unit_price', '')::numeric,
                        NULLIF(v_inner->>'external_setup_cost', '')::numeric,
                        v_inner->>'instructions'
                    );
                END LOOP;
            END IF;
        END LOOP;
    END IF;

    -- ── Customers ─────────────────────────────────────────────────────────
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

    -- ── Quotes + nested line_items ────────────────────────────────────────
    -- quote_number is auto-generated by the set_quote_number trigger when
    -- left null, so we don't pass it in.
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

    -- ── Jobs + job_parts ──────────────────────────────────────────────────
    -- For each job_part with a routing_ref, materialize ops + materials via
    -- create_job_part_operations_from_routing — exactly the path Convert-to-
    -- Job uses in the UI, so the demo job mirrors a realistic snapshot.
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

                    -- Materialize ops + materials from the routing, exactly
                    -- as Convert-to-Job does in the UI.
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

COMMENT ON FUNCTION public.seed_demo_data(uuid, uuid, text)
    IS 'Seeds a company from the active demo_data_templates row. Walks vendors → work_centers → parts → parts_bom → routings/routing_operations → customers → quotes/line_items → jobs/job_parts (materializing ops + materials via create_job_part_operations_from_routing). Uses a jsonb ref-map to resolve _ref → uuid across the template. Reads parts.source / parts.is_stocked from the template_data jsonb (renamed from is_manufacturable / is_stockable in the 20260504 source-enum-and-stocked-rename migration).';

COMMIT;
