-- Delete the zero-quantity part_location_stock residue, and stop everything creating it.
--
-- Closes #657.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- WHY
-- ═══════════════════════════════════════════════════════════════════════════════
-- `transfer_stock` decremented, `bulk_put_away` set 0, and `auto_track_stocked_part` seeded an
-- Unassigned row at 0 for every stocked part — so every bin a part had ever passed through kept a
-- row forever. Four read paths filtered around it with `quantity > 0`, one of which said so in its
-- own comment: "this filters around bad data at rest rather than fixing it."
--
-- CLAUDE.md's "No silent runtime fallbacks for data-at-rest issues" indicts exactly that. Four
-- filters over one unfixed invariant is the accumulation it warns about, and the filters were not
-- merely untidy: a zero row is a live absolute write target on a shelf the part has left.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- NO "KEEP THE LAST ROW" RULE — AND WHY THAT IS SAFE
-- ═══════════════════════════════════════════════════════════════════════════════
-- The obvious guarded form ("delete zero rows except a part's last one") was considered and
-- rejected. It is both unnecessary and actively dangerous.
--
-- Unnecessary: nothing requires a part to have a balance row. 20260802015837 asserted only the
-- ROLLUP (`quantity IS DISTINCT FROM COALESCE(SUM(balances), 0)`), which a row-less part satisfies
-- trivially — and 30 parts have had no rows all along. The opening count does not depend on one
-- either: `loadCountCandidates` and `loadPartEverywhereCandidates` synthesise the target from
-- `resolveFallbackPlace(locations)` — the company's `kind = 'system'` bucket, read from the
-- LOCATIONS list — whenever a part holds stock nowhere. No balance row is involved.
--
-- Dangerous: sparing rows is what leaves `a row exists` and `the part is here` out of step, which
-- is the confusion this migration exists to end. Deleting every zero row makes the read paths'
-- premise actually true, so their filters can go rather than being reworded.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- THE BUG THE NAIVE VERSION WOULD HAVE ARMED
-- ═══════════════════════════════════════════════════════════════════════════════
-- Reproduced before writing this. `trg_auto_track_stocked_part` is `AFTER INSERT OR UPDATE OF
-- is_stocked`, and `updatePart` includes `is_stocked` in every save — so the trigger body re-runs
-- when someone merely renames a part. Its `ON CONFLICT (part_id, location_id) DO NOTHING` was
-- being satisfied by the part's own leftover zero row at Unassigned, and nothing else.
--
-- Delete that row without fixing the trigger and the next rename INSERTs `NEW.quantity` at
-- Unassigned on top of the stock already sitting on a real shelf. Measured: a no-op
-- `UPDATE parts SET is_stocked = is_stocked` took BUY-BEARING-608ZZ from 580 to 1160. Silent, and
-- not recoverable from the ledger, because no transaction row is written.
--
-- Hence the ordering below: every producer is fixed BEFORE the delete, never after.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- AND THEN MADE STRUCTURAL
-- ═══════════════════════════════════════════════════════════════════════════════
-- `CHECK (quantity > 0)` replaces `CHECK (quantity >= 0)`. Six functions write this table and
-- `anon`/`authenticated` hold direct DML on it, so a convention would have lasted until the next
-- person wrote `SET quantity = 0`. The constraint turns every missed producer into a loud error
-- instead of silent residue, which is the trade CLAUDE.md asks for.

-- No explicit LOCK TABLE, deliberately: the Supabase CLI runs a migration statement by statement
-- rather than in one transaction, so `LOCK TABLE` raises 25P01 outright — and for the same reason
-- a `ON COMMIT DROP` temp table would vanish the moment its own CREATE committed. The delete and
-- its assertion are therefore one `DO` block, which is a single statement and so atomic on its own.
--
-- Nothing is racing it by then anyway. Every producer is replaced above, in the same run, before a
-- single row is deleted — so no code path can mint a zero row in the window, and the ALTER at the
-- end validates the whole table and fails the deploy loudly if anything somehow did.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Fix every producer. Dumped with pg_get_functiondef() and patched mechanically;
--    each edit was asserted to match exactly once before being applied.
-- ─────────────────────────────────────────────────────────────────────────────
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

    -- Counting a shelf empty removes its row. Without this branch the count sheet's "I looked and
    -- there is nothing here" would INSERT a fresh zero row at a bin the part has never held —
    -- manufacturing the very residue this migration deletes.
    IF p_converted_new_quantity = 0 THEN
        DELETE FROM public.part_location_stock
         WHERE part_id = p_part_id AND location_id = p_location_id;
    ELSE
        INSERT INTO public.part_location_stock (company_id, part_id, location_id, quantity)
        VALUES (v_company, p_part_id, p_location_id, p_converted_new_quantity)
        ON CONFLICT (part_id, location_id) DO UPDATE SET quantity = EXCLUDED.quantity;
    END IF;

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

    -- Two guards, and BOTH are load-bearing. The trigger is `AFTER INSERT OR UPDATE OF
    -- is_stocked`, and `updatePart` sends `is_stocked` on every save — so this body re-runs on
    -- an ordinary rename.
    --
    -- `NOT EXISTS` over ALL of the part's balances, not `ON CONFLICT DO NOTHING`: the conflict
    -- clause only defends the same (part_id, location_id) pair, so it was doing nothing except
    -- colliding with the part's own leftover zero row at Unassigned. Delete that row — as the
    -- prune below does — and a rename would re-insert NEW.quantity on top of the stock already
    -- sitting on a real shelf. Reproduced: a no-op `UPDATE parts SET is_stocked = is_stocked`
    -- took a part from 580 to 1160, silently.
    --
    -- `NEW.quantity <> 0` is what stops this being a residue factory. Seeding an Unassigned row
    -- at 0 for every stocked part is where most of the residue came from, and under the CHECK
    -- below it would now raise outright.
    INSERT INTO public.part_location_stock (company_id, part_id, location_id, quantity)
    SELECT NEW.company_id, NEW.id, v_loc, NEW.quantity
     WHERE NEW.quantity <> 0
       AND NOT EXISTS (SELECT 1 FROM public.part_location_stock s WHERE s.part_id = NEW.id);

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

    -- Parts with no row here or archived simply don't match and are reported as `skipped`. The
    -- `quantity > 0` predicate is now redundant with the table's CHECK and kept only because it
    -- costs nothing and states the intent at the point of use.
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
        -- Delete, not zero. A row means "the part is here"; the whole balance has just left.
        DELETE FROM public.part_location_stock
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

    -- Emptying a bin removes its row rather than parking a zero there. `v_new = 0` is reachable
    -- both by depleting the exact balance and by the graceful over-removal path above.
    IF v_new = 0 THEN
        DELETE FROM public.part_location_stock
         WHERE part_id = p_part_id AND location_id = p_location_id;
    ELSE
        INSERT INTO public.part_location_stock (company_id, part_id, location_id, quantity)
        VALUES (v_company, p_part_id, p_location_id, v_new)
        ON CONFLICT (part_id, location_id) DO UPDATE SET quantity = EXCLUDED.quantity;
    END IF;

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

    -- Computed, not read back: `DELETE ... RETURNING` yields the OLD row, so moving a bin's
    -- entire balance would have reported the PRE-transfer figure as `from_balance` — the UI would
    -- say the shelf still held everything it had just sent away.
    v_from_balance := v_src - p_converted_quantity;
    IF v_from_balance = 0 THEN
        DELETE FROM public.part_location_stock
         WHERE part_id = p_part_id AND location_id = p_from_location_id;
    ELSE
        UPDATE public.part_location_stock
           SET quantity = v_from_balance
         WHERE part_id = p_part_id AND location_id = p_from_location_id;
    END IF;

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
-- 2. Delete the residue, and assert it took nothing real.
-- ─────────────────────────────────────────────────────────────────────────────
-- Delete and assert in ONE statement, so a failed assertion rolls the delete back with it.
DO $$
DECLARE
    v_pruned uuid[];
    v_bad    bigint;
BEGIN
    -- The affected parts are captured rather than re-derived, so the check below blames only rows
    -- this statement touched. An unscoped whole-table rollup scan (what 20260802015837 did) would
    -- abort the deploy on pre-existing drift in some unrelated company it never went near.
    WITH d AS (
        DELETE FROM public.part_location_stock WHERE quantity = 0 RETURNING part_id
    )
    SELECT COALESCE(array_agg(DISTINCT part_id), '{}') INTO v_pruned FROM d;

    RAISE NOTICE 'pruned zero balances for % part(s)', cardinality(v_pruned);

    -- Deleting a zero row must be quantity-neutral. If a part's rollup moved, the DELETE took
    -- something real and the whole migration must abort with the data untouched.
    SELECT count(*) INTO v_bad
      FROM public.parts p
     WHERE p.id = ANY(v_pruned)
       AND p.quantity IS DISTINCT FROM
           COALESCE((SELECT SUM(s.quantity) FROM public.part_location_stock s
                      WHERE s.part_id = p.id), 0);
    IF v_bad > 0 THEN
        RAISE EXCEPTION
          'refusing to prune: % part(s) changed quantity. Deleting a zero row must be quantity-neutral.',
          v_bad;
    END IF;

    -- The invariant that REPLACES "every part has a balance row". A part holding stock nowhere is
    -- now reached through `resolveFallbackPlace`, which needs the company's system bucket to
    -- exist — so that, and not the row, is what must be guaranteed.
    SELECT count(*) INTO v_bad
      FROM public.companies c
     WHERE EXISTS (SELECT 1 FROM public.parts p
                    WHERE p.company_id = c.id AND p.is_stocked AND p.deleted_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM public.inventory_locations l
                        WHERE l.company_id = c.id AND l.kind = 'system');
    IF v_bad > 0 THEN
        RAISE EXCEPTION
          '% company(ies) have stocked parts but no system bucket to count them at.', v_bad;
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Make it structural. The ALTER validates the whole table, so anything the
--    producer fixes missed fails the deploy rather than reaching production.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.part_location_stock
  DROP CONSTRAINT part_location_stock_quantity_non_negative,
  ADD  CONSTRAINT part_location_stock_quantity_positive CHECK (quantity > 0);

COMMENT ON CONSTRAINT part_location_stock_quantity_positive ON public.part_location_stock IS
  'A row means the part IS here. Emptying a bin deletes its row rather than parking a zero — see 20260802144310 (#657). Was >= 0 until then, which let every RPC leave residue behind.';
