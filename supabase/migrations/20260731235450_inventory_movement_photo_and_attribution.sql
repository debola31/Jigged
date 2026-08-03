-- Photo evidence on a stock movement, and an attributable author for one.
--
-- ## Why a column and not a table
--
-- One photo per movement, mirroring `inventory_locations.photo_path` (20260730020251), which made
-- the same call for the same reason. A `transaction_media` table would buy many photos per movement
-- at the cost of RLS, grants, a billing write-gate entry and a CI exemption — none of it earned
-- until somebody asks for a second photo.
--
-- ## Why the RPC parameter is not an optional extra
--
-- Every location-stock row is inserted inside a SECURITY DEFINER function, so the client can never
-- INSERT `photo_path` directly. Adding the column alone would leave it **unwritable by
-- construction**: no insert path sets it, and `restrict_transaction_update_to_notes` blocks setting
-- it afterwards. The parameter is what makes the column reachable at all.
--
-- Call-site order is upload-then-RPC. A failed RPC therefore leaves an orphaned object in the
-- bucket, which is the accepted cost: the reverse order (insert, upload, then UPDATE the path)
-- requires the column to stay mutable, and mutable evidence is not evidence.
--
-- ## Why operator_id ships in the same migration
--
-- Bin history has to say WHO put something away, and today it cannot. `operator_id` is written only
-- by `deplete_stock_at_location`; add / adjust / transfer record `created_by`, which is an
-- `auth.users` id the browser cannot read — there is no FK to embed a name through and no policy
-- that would let the client resolve one. A photo captioned with nobody is not evidence either, so
-- the two ship together.
--
-- Every parameter is additive with a DEFAULT and appended after the existing ones, so current
-- callers keep working untouched. The three function bodies below are otherwise **verbatim copies**
-- of 20260622023407 — only the signature and the INSERT column list change.

-- ── 1. The column ────────────────────────────────────────────────────────────

ALTER TABLE public.inventory_transactions
    ADD COLUMN IF NOT EXISTS photo_path text;

COMMENT ON COLUMN public.inventory_transactions.photo_path IS
    'Storage path of a photo taken as evidence of this movement, in the private attachments bucket. '
    'Set at INSERT by the stock RPCs and immutable afterwards (restrict_transaction_update_to_notes). '
    'NULL for every movement recorded without one, which is most of them.';

-- ── 2. Keep the evidence immutable ───────────────────────────────────────────
--
-- `restrict_transaction_update_to_notes` is an allowlist BY OMISSION: it enumerates the columns
-- that must not change, and anything absent is silently mutable. `location_id`, `location_name` and
-- `transfer_group_id` were never added when the locations work introduced them, so all three are
-- editable today through the notes-only UPDATE policy. This adds `photo_path` — evidence that can
-- be swapped after the fact is worthless — and closes those three pre-existing gaps while here.

CREATE OR REPLACE FUNCTION public.restrict_transaction_update_to_notes()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    IF OLD.company_id          IS DISTINCT FROM NEW.company_id
       OR OLD.part_id          IS DISTINCT FROM NEW.part_id
       OR OLD.item_name        IS DISTINCT FROM NEW.item_name
       OR OLD.type             IS DISTINCT FROM NEW.type
       OR OLD.quantity         IS DISTINCT FROM NEW.quantity
       OR OLD.unit             IS DISTINCT FROM NEW.unit
       OR OLD.converted_quantity IS DISTINCT FROM NEW.converted_quantity
       OR OLD.job_id           IS DISTINCT FROM NEW.job_id
       OR OLD.job_operation_id IS DISTINCT FROM NEW.job_operation_id
       OR OLD.operator_id      IS DISTINCT FROM NEW.operator_id
       OR OLD.created_at       IS DISTINCT FROM NEW.created_at
       OR OLD.created_by       IS DISTINCT FROM NEW.created_by
       OR OLD.has_discrepancy  IS DISTINCT FROM NEW.has_discrepancy
       -- Added 2026-07-31. The first is the new evidence column; the other three were mutable by
       -- omission from the day the locations work added them.
       OR OLD.photo_path        IS DISTINCT FROM NEW.photo_path
       OR OLD.location_id       IS DISTINCT FROM NEW.location_id
       OR OLD.location_name     IS DISTINCT FROM NEW.location_name
       OR OLD.transfer_group_id IS DISTINCT FROM NEW.transfer_group_id
    THEN
        RAISE EXCEPTION 'Only the notes field can be updated on inventory transactions';
    END IF;
    RETURN NEW;
END;
$function$;

-- ── 3. Drop the old signatures FIRST ─────────────────────────────────────────
--
-- ⚠️ `CREATE OR REPLACE FUNCTION` replaces a function only when the argument list matches exactly.
-- Adding a parameter creates an **overload** instead, and then a call with the original arity
-- matches both candidates and fails at runtime:
--
--   ERROR: function public.transfer_stock(uuid, uuid, uuid, numeric, unknown, numeric, text)
--          is not unique (SQLSTATE 42725)
--
-- which is precisely what `supabase db reset` produced on the first attempt, from `seed.sql`. The
-- new parameters all have defaults, so every existing call site still resolves once the old
-- signature is gone — but it has to actually be gone.
--
-- Dropping loses grants. That is safe here only because 20260622023407 issued none and these
-- functions rely on the default PUBLIC execute privilege; if that ever changes, re-grant below.

DROP FUNCTION IF EXISTS public.add_stock_at_location(uuid, uuid, numeric, text, numeric, text);
DROP FUNCTION IF EXISTS public.adjust_stock_at_location(uuid, uuid, numeric, text, numeric, text);
DROP FUNCTION IF EXISTS public.transfer_stock(uuid, uuid, uuid, numeric, text, numeric, text);

-- ── 4. add_stock_at_location — a photo and an author ─────────────────────────

CREATE OR REPLACE FUNCTION public.add_stock_at_location(
    p_part_id uuid, p_location_id uuid,
    p_quantity numeric, p_unit text, p_converted_quantity numeric,
    p_notes text DEFAULT NULL,
    p_operator_id uuid DEFAULT NULL,
    p_photo_path text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company uuid; v_item_name text; v_tracked boolean;
    v_new_balance numeric; v_rollup numeric;
BEGIN
    IF p_quantity <= 0 OR p_converted_quantity <= 0 THEN
        RAISE EXCEPTION 'Quantity must be positive' USING ERRCODE = 'check_violation';
    END IF;

    SELECT company_id, part_name, is_location_tracked
      INTO v_company, v_item_name, v_tracked
      FROM public.parts WHERE id = p_part_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'part % not found', p_part_id USING ERRCODE = 'no_data_found';
    END IF;
    -- DEFINER bypasses RLS, so this guard is the ONLY tenant boundary in the function.
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT v_tracked THEN
        RAISE EXCEPTION 'part % is not location-tracked; enable tracking first', p_part_id USING ERRCODE = 'check_violation';
    END IF;
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
$function$;

-- ── 5. adjust_stock_at_location — attribution only ───────────────────────────
--
-- No photo here on purpose: an adjustment is a correction to a number, not a physical movement
-- somebody can photograph. Its evidence is the count that produced it.

CREATE OR REPLACE FUNCTION public.adjust_stock_at_location(
    p_part_id uuid, p_location_id uuid,
    p_new_quantity numeric, p_unit text, p_converted_new_quantity numeric,
    p_notes text DEFAULT NULL,
    p_operator_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company uuid; v_item_name text; v_primary_unit text; v_tracked boolean;
    v_current numeric; v_diff numeric; v_rollup numeric; v_notes text;
BEGIN
    IF p_converted_new_quantity < 0 THEN
        RAISE EXCEPTION 'Quantity cannot be negative' USING ERRCODE = 'check_violation';
    END IF;

    SELECT company_id, part_name, primary_unit, is_location_tracked
      INTO v_company, v_item_name, v_primary_unit, v_tracked
      FROM public.parts WHERE id = p_part_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'part % not found', p_part_id USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT v_tracked THEN
        RAISE EXCEPTION 'part % is not location-tracked; enable tracking first', p_part_id USING ERRCODE = 'check_violation';
    END IF;
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
$function$;

-- ── 6. transfer_stock — one author on both halves ────────────────────────────
--
-- One person moved the material, so the same id stamps the depletion and the addition. The pair
-- already shares a `transfer_group_id`; without a shared author, bin history at the destination
-- could name nobody while the source named somebody.

CREATE OR REPLACE FUNCTION public.transfer_stock(
    p_part_id uuid, p_from_location_id uuid, p_to_location_id uuid,
    p_quantity numeric, p_unit text, p_converted_quantity numeric,
    p_notes text DEFAULT NULL,
    p_operator_id uuid DEFAULT NULL,
    p_photo_path text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company uuid; v_item_name text; v_tracked boolean;
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

    SELECT company_id, part_name, is_location_tracked
      INTO v_company, v_item_name, v_tracked
      FROM public.parts WHERE id = p_part_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'part % not found', p_part_id USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT v_tracked THEN
        RAISE EXCEPTION 'part % is not location-tracked; enable tracking first', p_part_id USING ERRCODE = 'check_violation';
    END IF;
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
$function$;
