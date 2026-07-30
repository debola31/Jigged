-- Put many parts away in one place, atomically.
--
-- `trg_auto_track_stocked_part` parks every stocked part at the auto-created 'Unassigned' bucket,
-- so a real shop's first sight of the storage board is one tile holding everything (9,428 parts for
-- the shop we're building against) and four holding nothing. That board is truthful but useless,
-- and `docs/modules/inventory.md` §5.5 decision 8 names it as the thing that gates showing the
-- feature to them at all. Emptying it needs a batch move; nobody empties thousands of parts through
-- a per-part modal.
--
-- **It moves each part's FULL current balance, so it takes no quantity and no unit.** That is the
-- design, not a shortcut:
--
--   * Put-away means "this lives here now", not "split 40 across two bins". Partial moves already
--     have a path — per-part Move via `transfer_stock`.
--   * No quantity argument means no unit conversion, so the caller needs no per-part conversion
--     read. One request for N parts instead of 2N.
--   * The balance is read INSIDE this transaction, so `transfer_stock`'s 'Insufficient stock at
--     source location' failure is unreachable here by construction.
--
-- **Atomicity is the whole point.** A half-moved pile is worse than no move: you can't tell what
-- you already did. One function call is one transaction, so any failure rolls the batch back. That
-- guarantee is why the TS wrapper must NOT chunk the array — see `bulkPutAway`.

-- How many parts one call may move.
--
-- Not a payload limit (an RPC POSTs a JSON body; 10k uuids would parse fine) but a LOCK limit:
-- every part takes a `FOR UPDATE` row lock held for the whole transaction, and a five-figure batch
-- would hold `part_location_stock` against every other writer in the company. Enforced here rather
-- than in the UI so no caller — present or future — can break the atomicity guarantee by looping.
--
-- Selecting thousands to send to one place is pathological anyway: it just recreates 'Unassigned'
-- under a different name.
CREATE OR REPLACE FUNCTION public.bulk_put_away(
    p_from_location_id uuid,
    p_to_location_id uuid,
    p_part_ids uuid[])
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
           AND p.is_location_tracked
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
$function$;

COMMENT ON FUNCTION public.bulk_put_away(uuid, uuid, uuid[]) IS
  'Move the FULL balance of many parts from one location to another in a single transaction. '
  'Takes no quantity or unit (it moves everything, in the part''s primary unit), so callers need no '
  'conversion read. Atomic by design — the TS wrapper must never chunk the array. Caps at 1000 '
  'parts per call to bound how long part_location_stock row locks are held.';

REVOKE ALL ON FUNCTION public.bulk_put_away(uuid, uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bulk_put_away(uuid, uuid, uuid[]) TO authenticated, service_role;
