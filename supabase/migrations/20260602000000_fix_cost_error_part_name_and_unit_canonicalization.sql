-- ---------------------------------------------------------------------------
-- Three follow-up fixes batched into one migration:
--   (1) compute_part_cost_at_qty: surface part_name (not uuid) in RAISE EXCEPTION
--   (2) Canonicalize alias unit values across all six unit-bearing columns
--       (e.g. 'EA' -> 'each', 'in' -> 'inches'). Mapping mirrors
--       api/services/uom_normalizer.py UNIT_ALIASES.
--   (3) Backfill null parts.primary_unit to 'each'
--   (4) Replace the parts_stocked_requires_unit constraint with
--       parts_requires_unit (NOT NULL on primary_unit for every part).
-- ---------------------------------------------------------------------------

-- (1) compute_part_cost_at_qty — error messages use part_name
CREATE OR REPLACE FUNCTION public.compute_part_cost_at_qty(p_part_id uuid, p_qty numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    v_source text;
    v_part_name text;
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

    SELECT source, part_name, preferred_vendor_id
      INTO v_source, v_part_name, v_preferred_vendor_id
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
                        v_part_name
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
                        v_part_name
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
               c.primary_unit AS child_primary_unit,
               c.part_name    AS child_part_name
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

-- ---------------------------------------------------------------------------
-- (2) Canonicalize alias unit values. The CASE mirrors UNIT_ALIASES in
--     api/services/uom_normalizer.py. Values already canonical, or unknown
--     (company_custom_units keys, etc.) pass through unchanged.
--
--     pg_temp.canonicalize_unit is a session-scoped helper — it disappears
--     when the migration completes and doesn't linger in the schema.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION pg_temp.canonicalize_unit(raw text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $$
    SELECT CASE LOWER(TRIM(raw))
        WHEN 'ea'    THEN 'each'
        WHEN 'pcs'   THEN 'pieces'
        WHEN 'pc'    THEN 'pieces'
        WHEN 'dz'    THEN 'dozen'
        WHEN 'lb'    THEN 'pounds'
        WHEN 'lbs'   THEN 'pounds'
        WHEN 'kg'    THEN 'kilograms'
        WHEN 'kgs'   THEN 'kilograms'
        WHEN 'oz'    THEN 'ounces'
        WHEN 'g'     THEN 'grams'
        WHEN 'in'    THEN 'inches'
        WHEN 'ft'    THEN 'feet'
        WHEN 'mm'    THEN 'millimeters'
        WHEN 'cm'    THEN 'centimeters'
        WHEN 'm'     THEN 'meters'
        WHEN 'gal'   THEN 'gallons'
        WHEN 'l'     THEN 'liters'
        WHEN 'qt'    THEN 'quarts'
        WHEN 'ml'    THEN 'milliliters'
        WHEN 'fl oz' THEN 'fluid ounces'
        WHEN 'sq in' THEN 'square inches'
        WHEN 'sq ft' THEN 'square feet'
        WHEN 'sq cm' THEN 'square centimeters'
        WHEN 'sq m'  THEN 'square meters'
        ELSE raw
    END
$$;

UPDATE public.parts
   SET primary_unit = pg_temp.canonicalize_unit(primary_unit)
 WHERE primary_unit IS NOT NULL
   AND primary_unit <> pg_temp.canonicalize_unit(primary_unit);

UPDATE public.parts_bom
   SET unit = pg_temp.canonicalize_unit(unit)
 WHERE unit <> pg_temp.canonicalize_unit(unit);

UPDATE public.parts_unit_conversions
   SET from_unit = pg_temp.canonicalize_unit(from_unit)
 WHERE from_unit <> pg_temp.canonicalize_unit(from_unit);

UPDATE public.job_materials
   SET unit = pg_temp.canonicalize_unit(unit)
 WHERE unit <> pg_temp.canonicalize_unit(unit);

UPDATE public.quote_materials
   SET unit = pg_temp.canonicalize_unit(unit)
 WHERE unit IS NOT NULL
   AND unit <> pg_temp.canonicalize_unit(unit);

UPDATE public.inventory_transactions
   SET unit = pg_temp.canonicalize_unit(unit)
 WHERE unit <> pg_temp.canonicalize_unit(unit);

-- ---------------------------------------------------------------------------
-- (3) Backfill null parts.primary_unit to 'each' so the new NOT-NULL check
--     constraint below can be applied.
-- ---------------------------------------------------------------------------
UPDATE public.parts SET primary_unit = 'each' WHERE primary_unit IS NULL;

-- ---------------------------------------------------------------------------
-- (4) Replace the legacy check (UoM only required when stocked) with one
--     that requires UoM on every part.
-- ---------------------------------------------------------------------------
ALTER TABLE public.parts DROP CONSTRAINT IF EXISTS parts_stocked_requires_unit;
ALTER TABLE public.parts
    ADD CONSTRAINT parts_requires_unit CHECK (primary_unit IS NOT NULL);
