-- Every part has a place. Remove `parts.is_location_tracked`.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- WHAT AND WHY
-- ═══════════════════════════════════════════════════════════════════════════════
-- Founder, 2026-08-01: "All parts should have location, we should remove this
-- attribute entirely."
--
-- The column split the product in two. A part with it TRUE wrote stock through the
-- `*_at_location` RPCs, atomically, with a per-place ledger. A part with it FALSE
-- wrote `parts.quantity` directly from the browser, and the location RPCs actively
-- refused it. Which path a part took was decided by a trigger gated on a company
-- feature flag — so the same product behaved structurally differently for two shops,
-- and every read had to branch.
--
-- After this there is one write path for everyone. The flag keeps gating whether a
-- shop MANAGES places (the Storage nav, the locations route, the operator tab); it
-- no longer decides whether stock HAS one. **Every part has a place; not every shop
-- manages places.**
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- WHY THE BACKFILL IS UNCONDITIONAL
-- ═══════════════════════════════════════════════════════════════════════════════
-- The obvious shortcut is "only backfill flag-on companies, the rest have no
-- locations anyway". That is wrong twice over.
--
-- First, flag-ON does not mean backfilled. The documented way to enable the pilot is
-- raw SQL against `companies.settings` (lib/featureFlags.ts) which never calls
-- `enable_location_tracking_for_company` at all; the one path that does — the admin
-- route — runs it in a SEPARATE transaction from the flag write, catches every
-- exception, and still returns success. A flag-on company can therefore be fully or
-- partly un-backfilled, and no one can tell from the outside.
--
-- Second, the trigger only fires `AFTER INSERT OR UPDATE OF is_stocked`, so parts
-- touched since a flip are seeded and older ones are not.
--
-- So this backfills EVERY company and then ASSERTS. Provenance stops mattering,
-- which is the only way to make this safe without knowing how each flag got set.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- THE FAILURE THIS PREVENTS
-- ═══════════════════════════════════════════════════════════════════════════════
-- A part left with `quantity = 40` and zero balance rows is not merely inconsistent.
-- Once `recompute_part_quantity_from_locations` is unconditional, the first ordinary
-- put-away destroys the difference:
--
--   1. someone adds 5 to a shelf
--   2. the recompute trigger fires: quantity := SUM(balances) = 5
--   3. 35 units are gone, silently, and the ledger row says stock went UP
--
-- `inventory_transactions` carries no running balance, so `parts.quantity` cannot be
-- replayed — the loss is unrecoverable. Hence: seed first, assert, and only then
-- make the trigger unconditional and drop the column.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- NOT `ON CONFLICT DO NOTHING`
-- ═══════════════════════════════════════════════════════════════════════════════
-- The existing company backfill seeds with `ON CONFLICT (part_id, location_id) DO
-- NOTHING` while flipping the flag in the same CTE. If an Unassigned row already
-- exists, the flag flips, the quantity is NOT seeded, no row changes, the recompute
-- never fires — instant permanent divergence. That idiom is exactly how a shop
-- arrives in the broken state this migration exists to repair.
--
-- Here the seed is guarded by `NOT EXISTS` over ALL of a part's balances, so a
-- conflict would be a bug and is allowed to raise.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Every company needs an Unassigned bucket to seed into.
-- ─────────────────────────────────────────────────────────────────────────────
-- Flag-off companies have never had one: `inv_get_or_create_unassigned` is only
-- reached from paths the flag gates.
DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT id FROM public.companies LOOP
        PERFORM public.inv_get_or_create_unassigned(c.id);
    END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Seed a balance for every part that has no place at all.
-- ─────────────────────────────────────────────────────────────────────────────
-- `is_stocked OR quantity <> 0` rather than `is_stocked` alone: the importer can
-- produce `is_stocked = false AND quantity <> 0` rows (an explicit is_stocked column
-- beats quantity-inference, while the quantity write is gated only on tracking), and
-- neither the trigger nor the old backfill reaches them. They are precisely the rows
-- that would be silently zeroed later.
--
-- At this point the recompute trigger is still the OLD, tracked-only one, so seeding
-- an untracked part does not touch `parts.quantity` — the balance is written to
-- match it, not the other way round.
INSERT INTO public.part_location_stock (company_id, part_id, location_id, quantity)
SELECT p.company_id, p.id, u.id, p.quantity
  FROM public.parts p
  JOIN public.inventory_locations u
    ON u.company_id = p.company_id AND u.kind = 'system' AND u.name = 'Unassigned'
 WHERE (p.is_stocked OR p.quantity <> 0)
   AND NOT EXISTS (
         SELECT 1 FROM public.part_location_stock s WHERE s.part_id = p.id
       );

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Assert BEFORE changing any behaviour.
-- ─────────────────────────────────────────────────────────────────────────────
-- If this raises, the migration aborts with the data untouched — which is the whole
-- point of asserting here rather than after the drop.
DO $$
DECLARE v_bad bigint;
BEGIN
    SELECT count(*) INTO v_bad
      FROM public.parts p
     WHERE p.quantity IS DISTINCT FROM
           COALESCE((SELECT SUM(s.quantity) FROM public.part_location_stock s
                      WHERE s.part_id = p.id), 0);
    IF v_bad > 0 THEN
        RAISE EXCEPTION
          'refusing to drop is_location_tracked: % part(s) have quantity <> SUM(balances). Backfill did not converge.',
          v_bad;
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Recreate every function without the column.
-- ─────────────────────────────────────────────────────────────────────────────
-- Dumped from the migrated database with pg_get_functiondef() and patched
-- mechanically, so no working logic was retyped. What changed, and nothing else:
--   * the four stock RPCs lose `v_tracked` and their "part % is not location-tracked"
--     raises — a refusal that is now unreachable
--   * `bulk_put_away` loses `AND p.is_location_tracked` from its WHERE
--   * `auto_track_stocked_part` loses BOTH the flag check and the tracked check, and
--     no longer writes the column; it just seeds Unassigned
--   * `enforce_tracked_part_quantity` becomes unconditional
--   * `recompute_part_quantity_from_locations` becomes unconditional

CREATE OR REPLACE FUNCTION public.add_stock_at_location(p_part_id uuid, p_location_id uuid, p_quantity numeric, p_unit text, p_converted_quantity numeric, p_notes text DEFAULT NULL::text, p_operator_id uuid DEFAULT NULL::uuid, p_photo_path text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company uuid; v_item_name text;
    v_new_balance numeric; v_rollup numeric;
BEGIN
    IF p_quantity <= 0 OR p_converted_quantity <= 0 THEN
        RAISE EXCEPTION 'Quantity must be positive' USING ERRCODE = 'check_violation';
    END IF;

    SELECT company_id, part_name
      INTO v_company, v_item_name
      FROM public.parts WHERE id = p_part_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'part % not found', p_part_id USING ERRCODE = 'no_data_found';
    END IF;
    -- DEFINER bypasses RLS, so this guard is the ONLY tenant boundary in the function.
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Entitlement. Membership says WHO you are; this says whether the shop may still write.
    PERFORM public.inv_assert_can_write(v_company);
    PERFORM public.inv_assert_location_in_company(p_location_id, v_company);

    INSERT INTO public.part_location_stock AS pls (company_id, part_id, location_id, quantity)
    VALUES (v_company, p_part_id, p_location_id, p_converted_quantity)
    ON CONFLICT (part_id, location_id)
        DO UPDATE SET quantity = pls.quantity + EXCLUDED.quantity
    RETURNING pls.quantity INTO v_new_balance;

    INSERT INTO public.inventory_transactions
        (company_id, part_id, item_name, type, quantity, unit, converted_quantity,
         location_id, notes, operator_id, photo_path, created_by)
    VALUES
        (v_company, p_part_id, v_item_name, 'addition', p_quantity, p_unit, p_converted_quantity,
         p_location_id, p_notes, p_operator_id, p_photo_path, auth.uid());

    SELECT quantity INTO v_rollup FROM public.parts WHERE id = p_part_id;
    RETURN jsonb_build_object('location_balance', v_new_balance, 'part_quantity', v_rollup);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.adjust_stock_at_location(p_part_id uuid, p_location_id uuid, p_new_quantity numeric, p_unit text, p_converted_new_quantity numeric, p_notes text DEFAULT NULL::text, p_operator_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company uuid; v_item_name text; v_primary_unit text;
    v_current numeric; v_diff numeric; v_rollup numeric; v_notes text;
BEGIN
    IF p_converted_new_quantity < 0 THEN
        RAISE EXCEPTION 'Quantity cannot be negative' USING ERRCODE = 'check_violation';
    END IF;

    SELECT company_id, part_name, primary_unit
      INTO v_company, v_item_name, v_primary_unit
      FROM public.parts WHERE id = p_part_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'part % not found', p_part_id USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Entitlement. Membership says WHO you are; this says whether the shop may still write.
    PERFORM public.inv_assert_can_write(v_company);
    PERFORM public.inv_assert_location_in_company(p_location_id, v_company);

    SELECT quantity INTO v_current
      FROM public.part_location_stock
     WHERE part_id = p_part_id AND location_id = p_location_id
       FOR UPDATE;
    v_current := COALESCE(v_current, 0);
    v_diff := p_converted_new_quantity - v_current;

    INSERT INTO public.part_location_stock (company_id, part_id, location_id, quantity)
    VALUES (v_company, p_part_id, p_location_id, p_converted_new_quantity)
    ON CONFLICT (part_id, location_id) DO UPDATE SET quantity = EXCLUDED.quantity;

    v_notes := COALESCE(
        p_notes,
        format('Adjusted from %s to %s %s', v_current, p_converted_new_quantity, v_primary_unit));

    INSERT INTO public.inventory_transactions
        (company_id, part_id, item_name, type, quantity, unit, converted_quantity,
         location_id, notes, operator_id, created_by)
    VALUES
        (v_company, p_part_id, v_item_name, 'adjustment', abs(v_diff), v_primary_unit, abs(v_diff),
         p_location_id, v_notes, p_operator_id, auth.uid());

    SELECT quantity INTO v_rollup FROM public.parts WHERE id = p_part_id;
    RETURN jsonb_build_object('location_balance', p_converted_new_quantity, 'part_quantity', v_rollup);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.auto_track_stocked_part()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_loc uuid;
BEGIN
    -- Stocked parts only. Nothing else has a quantity to place.
    IF NEW.is_stocked IS NOT TRUE THEN
        RETURN NULL;
    END IF;

    -- The feature-flag check is GONE, and that is the point of this change. It used to mean a
    -- flag-off company's stocked parts had no place at all and wrote stock through a second,
    -- structurally different path. Every part has a place now; the flag governs only whether a
    -- shop MANAGES places, not whether its stock has one.
    v_loc := public.inv_get_or_create_unassigned(NEW.company_id);

    INSERT INTO public.part_location_stock (company_id, part_id, location_id, quantity)
    VALUES (NEW.company_id, NEW.id, v_loc, NEW.quantity)
    ON CONFLICT (part_id, location_id) DO NOTHING;

    RETURN NULL; -- AFTER trigger
END;
$function$
;

CREATE OR REPLACE FUNCTION public.bulk_put_away(p_from_location_id uuid, p_to_location_id uuid, p_part_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    PUT_AWAY_MAX constant int := 1000;
    v_company uuid;
    v_requested int;
    v_group uuid;
    v_from_name text;
    v_to_name text;
    v_moved int := 0;
    r record;
BEGIN
    IF p_from_location_id IS NULL OR p_to_location_id IS NULL THEN
        RAISE EXCEPTION 'Both a source and a destination location are required'
            USING ERRCODE = 'null_value_not_allowed';
    END IF;
    IF p_from_location_id = p_to_location_id THEN
        RAISE EXCEPTION 'Source and destination locations must differ'
            USING ERRCODE = 'check_violation';
    END IF;

    v_requested := COALESCE(array_length(p_part_ids, 1), 0);
    IF v_requested = 0 THEN
        RAISE EXCEPTION 'Pick at least one part to put away' USING ERRCODE = 'check_violation';
    END IF;
    IF v_requested > PUT_AWAY_MAX THEN
        RAISE EXCEPTION 'Too many parts at once (% of a maximum %). Narrow your search and put them away in smaller batches.',
            v_requested, PUT_AWAY_MAX USING ERRCODE = 'check_violation';
    END IF;

    -- Company comes from the SOURCE location, then both endpoints are asserted against it — so a
    -- caller can't pair one company's shelf with another's.
    SELECT company_id INTO v_company
      FROM public.inventory_locations WHERE id = p_from_location_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'location % not found', p_from_location_id USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Entitlement. Membership says WHO you are; this says whether the shop may still write.
    PERFORM public.inv_assert_can_write(v_company);
    PERFORM public.inv_assert_location_in_company(p_from_location_id, v_company);
    PERFORM public.inv_assert_location_in_company(p_to_location_id, v_company);

    -- ONE group id for the whole batch, so the ledger records it as a single traceable event
    -- rather than N unrelated transfers.
    v_group := gen_random_uuid();
    SELECT name INTO v_from_name FROM public.inventory_locations WHERE id = p_from_location_id;
    SELECT name INTO v_to_name   FROM public.inventory_locations WHERE id = p_to_location_id;

    -- Parts with no row here, a zero balance, tracking off, or archived simply don't match and are
    -- reported as `skipped`. A zero balance is the common case, not an error: the auto-track trigger
    -- seeds an Unassigned row for every stocked part whether or not it holds anything.
    --
    -- `ORDER BY part_id` gives every concurrent caller the same lock order, so two overlapping
    -- put-aways queue instead of deadlocking.
    FOR r IN
        SELECT pls.part_id, pls.quantity, p.part_name, p.primary_unit
          FROM public.part_location_stock pls
          JOIN public.parts p ON p.id = pls.part_id
         WHERE pls.location_id = p_from_location_id
           AND pls.company_id = v_company
           AND pls.part_id = ANY(p_part_ids)
           AND pls.quantity > 0
           AND p.deleted_at IS NULL
         ORDER BY pls.part_id
           FOR UPDATE OF pls
    LOOP
        -- `inventory_transactions.unit` is NOT NULL, and the balance is already stored in the part's
        -- primary unit — so `r.primary_unit` is written straight through with no conversion. No null
        -- check is needed: `parts_requires_unit` is an unconditional `CHECK (primary_unit IS NOT
        -- NULL)`, so a part without one cannot exist to reach this loop.
        UPDATE public.part_location_stock
           SET quantity = 0
         WHERE part_id = r.part_id AND location_id = p_from_location_id;

        INSERT INTO public.part_location_stock AS pls (company_id, part_id, location_id, quantity)
        VALUES (v_company, r.part_id, p_to_location_id, r.quantity)
        ON CONFLICT (part_id, location_id)
            DO UPDATE SET quantity = pls.quantity + EXCLUDED.quantity;

        INSERT INTO public.inventory_transactions
            (company_id, part_id, item_name, type, quantity, unit, converted_quantity,
             location_id, transfer_group_id, notes, created_by)
        VALUES
            (v_company, r.part_id, r.part_name, 'depletion', r.quantity, r.primary_unit, r.quantity,
             p_from_location_id, v_group, format('Put away to %s', v_to_name), auth.uid()),
            (v_company, r.part_id, r.part_name, 'addition', r.quantity, r.primary_unit, r.quantity,
             p_to_location_id, v_group, format('Put away from %s', v_from_name), auth.uid());

        v_moved := v_moved + 1;
    END LOOP;

    RETURN jsonb_build_object(
        'moved', v_moved,
        'skipped', v_requested - v_moved,
        'transfer_group_id', v_group);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.deplete_stock_at_location(p_part_id uuid, p_location_id uuid, p_quantity numeric, p_unit text, p_converted_quantity numeric, p_graceful boolean DEFAULT false, p_notes text DEFAULT NULL::text, p_job_id uuid DEFAULT NULL::uuid, p_job_operation_id uuid DEFAULT NULL::uuid, p_operator_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company uuid; v_item_name text; v_primary_unit text;
    v_current numeric; v_new numeric; v_rollup numeric;
    v_discrepancy boolean := false; v_shortfall numeric := 0;
    v_notes text; v_disc_note text;
BEGIN
    IF p_quantity <= 0 OR p_converted_quantity <= 0 THEN
        RAISE EXCEPTION 'Quantity must be positive' USING ERRCODE = 'check_violation';
    END IF;

    SELECT company_id, part_name, primary_unit
      INTO v_company, v_item_name, v_primary_unit
      FROM public.parts WHERE id = p_part_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'part % not found', p_part_id USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Entitlement. Membership says WHO you are; this says whether the shop may still write.
    PERFORM public.inv_assert_can_write(v_company);
    PERFORM public.inv_assert_location_in_company(p_location_id, v_company);

    -- Lock the balance row (treat a missing row as 0 on hand).
    SELECT quantity INTO v_current
      FROM public.part_location_stock
     WHERE part_id = p_part_id AND location_id = p_location_id
       FOR UPDATE;
    v_current := COALESCE(v_current, 0);

    v_new := v_current - p_converted_quantity;
    v_notes := p_notes;

    IF v_new < 0 THEN
        IF p_graceful THEN
            v_shortfall := p_converted_quantity - v_current;
            v_new := 0;
            v_discrepancy := true;
            v_disc_note := format(
                '[DISCREPANCY: Confirmed %s %s, but only %s %s was available. Shortfall: %s %s]',
                p_converted_quantity, v_primary_unit, v_current, v_primary_unit, v_shortfall, v_primary_unit);
            v_notes := CASE WHEN v_notes IS NULL OR v_notes = '' THEN v_disc_note
                            ELSE v_notes || ' ' || v_disc_note END;
        ELSE
            RAISE EXCEPTION 'Insufficient stock at location (have %, need %)', v_current, p_converted_quantity
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    INSERT INTO public.part_location_stock (company_id, part_id, location_id, quantity)
    VALUES (v_company, p_part_id, p_location_id, v_new)
    ON CONFLICT (part_id, location_id) DO UPDATE SET quantity = EXCLUDED.quantity;

    INSERT INTO public.inventory_transactions
        (company_id, part_id, item_name, type, quantity, unit, converted_quantity,
         location_id, job_id, job_operation_id, operator_id, notes, has_discrepancy, created_by)
    VALUES
        (v_company, p_part_id, v_item_name, 'depletion', p_quantity, p_unit, p_converted_quantity,
         p_location_id, p_job_id, p_job_operation_id, p_operator_id, v_notes, v_discrepancy, auth.uid());

    SELECT quantity INTO v_rollup FROM public.parts WHERE id = p_part_id;
    RETURN jsonb_build_object(
        'location_balance', v_new, 'part_quantity', v_rollup,
        'has_discrepancy', v_discrepancy, 'shortfall', v_shortfall);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.enforce_tracked_part_quantity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_expected numeric;
BEGIN
    IF NEW.quantity IS DISTINCT FROM OLD.quantity THEN
        v_expected := COALESCE(
            (SELECT SUM(quantity) FROM public.part_location_stock WHERE part_id = NEW.id),
            0);

        IF NEW.quantity IS DISTINCT FROM v_expected THEN
            RAISE EXCEPTION 'parts.quantity is maintained from part_location_stock; direct quantity writes are not allowed (attempted %, expected %)',
                NEW.quantity, v_expected
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.recompute_part_quantity_from_locations()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_part_id uuid := COALESCE(NEW.part_id, OLD.part_id);
BEGIN
    -- Unconditional. It used to skip untracked parts, which is what let a flag-off company's
    -- `parts.quantity` and its balances drift apart by design.
    UPDATE public.parts
       SET quantity = COALESCE(
               (SELECT SUM(quantity) FROM public.part_location_stock WHERE part_id = v_part_id),
               0),
           updated_at = now()
     WHERE id = v_part_id;

    RETURN NULL; -- AFTER trigger: return value is ignored
END;
$function$
;

CREATE OR REPLACE FUNCTION public.transfer_stock(p_part_id uuid, p_from_location_id uuid, p_to_location_id uuid, p_quantity numeric, p_unit text, p_converted_quantity numeric, p_notes text DEFAULT NULL::text, p_operator_id uuid DEFAULT NULL::uuid, p_photo_path text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company uuid; v_item_name text;
    v_src numeric; v_from_balance numeric; v_to_balance numeric;
    v_group uuid; v_from_name text; v_to_name text;
    v_from_notes text; v_to_notes text; v_base text;
BEGIN
    IF p_quantity <= 0 OR p_converted_quantity <= 0 THEN
        RAISE EXCEPTION 'Quantity must be positive' USING ERRCODE = 'check_violation';
    END IF;
    IF p_from_location_id = p_to_location_id THEN
        RAISE EXCEPTION 'Source and destination locations must differ' USING ERRCODE = 'check_violation';
    END IF;

    SELECT company_id, part_name
      INTO v_company, v_item_name
      FROM public.parts WHERE id = p_part_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'part % not found', p_part_id USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Entitlement. Membership says WHO you are; this says whether the shop may still write.
    PERFORM public.inv_assert_can_write(v_company);
    PERFORM public.inv_assert_location_in_company(p_from_location_id, v_company);
    PERFORM public.inv_assert_location_in_company(p_to_location_id, v_company);

    -- Lock + verify source has enough (hard fail — you can't move stock you lack).
    SELECT quantity INTO v_src
      FROM public.part_location_stock
     WHERE part_id = p_part_id AND location_id = p_from_location_id
       FOR UPDATE;
    IF v_src IS NULL OR v_src < p_converted_quantity THEN
        RAISE EXCEPTION 'Insufficient stock at source location (have %, need %)',
            COALESCE(v_src, 0), p_converted_quantity USING ERRCODE = 'check_violation';
    END IF;

    UPDATE public.part_location_stock
       SET quantity = v_src - p_converted_quantity
     WHERE part_id = p_part_id AND location_id = p_from_location_id
    RETURNING quantity INTO v_from_balance;

    INSERT INTO public.part_location_stock AS pls (company_id, part_id, location_id, quantity)
    VALUES (v_company, p_part_id, p_to_location_id, p_converted_quantity)
    ON CONFLICT (part_id, location_id)
        DO UPDATE SET quantity = pls.quantity + EXCLUDED.quantity
    RETURNING pls.quantity INTO v_to_balance;

    v_group := gen_random_uuid();
    SELECT name INTO v_from_name FROM public.inventory_locations WHERE id = p_from_location_id;
    SELECT name INTO v_to_name   FROM public.inventory_locations WHERE id = p_to_location_id;
    v_base := COALESCE(NULLIF(p_notes, ''), '');

    v_from_notes := btrim(v_base || ' ' || format('[Transfer to %s]', v_to_name));
    v_to_notes   := btrim(v_base || ' ' || format('[Transfer from %s]', v_from_name));

    INSERT INTO public.inventory_transactions
        (company_id, part_id, item_name, type, quantity, unit, converted_quantity,
         location_id, transfer_group_id, notes, operator_id, photo_path, created_by)
    VALUES
        (v_company, p_part_id, v_item_name, 'depletion', p_quantity, p_unit, p_converted_quantity,
         p_from_location_id, v_group, v_from_notes, p_operator_id, p_photo_path, auth.uid()),
        (v_company, p_part_id, v_item_name, 'addition', p_quantity, p_unit, p_converted_quantity,
         p_to_location_id, v_group, v_to_notes, p_operator_id, p_photo_path, auth.uid());

    RETURN jsonb_build_object(
        'transfer_group_id', v_group,
        'from_balance', v_from_balance, 'to_balance', v_to_balance);
END;
$function$
;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. The company backfill RPC is superseded.
-- ─────────────────────────────────────────────────────────────────────────────
-- It existed to catch up existing parts when the flag flipped. Nothing to catch up
-- now — every part is seeded at creation regardless of the flag. Its call site in
-- api/routes/admin_routes.py goes with it in the same PR.
DROP FUNCTION IF EXISTS public.enable_location_tracking_for_company(uuid);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Drop the column.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.parts DROP COLUMN is_location_tracked;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Assert again, now that the triggers are unconditional.
-- ─────────────────────────────────────────────────────────────────────────────
-- Step 3 proved the data converged; this proves nothing in step 4 or 6 disturbed it.
DO $$
DECLARE v_bad bigint;
BEGIN
    SELECT count(*) INTO v_bad
      FROM public.parts p
     WHERE p.quantity IS DISTINCT FROM
           COALESCE((SELECT SUM(s.quantity) FROM public.part_location_stock s
                      WHERE s.part_id = p.id), 0);
    IF v_bad > 0 THEN
        RAISE EXCEPTION 'post-drop invariant violated for % part(s)', v_bad;
    END IF;
END $$;

COMMENT ON COLUMN public.parts.quantity IS
  'On-hand total. Maintained ONLY by recompute_part_quantity_from_locations from part_location_stock — direct writes raise. Every part has at least one balance row (Unassigned by default); see migration 20260802015837.';
