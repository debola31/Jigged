-- ============================================================================
-- A reshape has to say which heat it is moving
-- ============================================================================
-- 20260906121901 keyed balances by (part, location, lot) and made `transfer_stock`
-- REFUSE a lot-less move of a tracked part -- there is no such thing as "move 12 of
-- this bar" when the shelf holds 8 of one heat and 4 of another. `apply_location_layout`
-- delegates every redistribution to `transfer_stock` and passed no lot, so reshaping any
-- unit holding traced material raised. Not a silent corruption; a hard block on an
-- existing feature, and one nothing caught because the reshape tests use untracked parts.
--
-- The move payload gains an optional `lot_id`. Absent or empty means "no lot", which is
-- every part in every shop that does not record heats -- so an existing caller that sends
-- the old payload keeps working exactly as it did.
--
-- CREATE OR REPLACE on an identical signature, so the ACL and the COMMENT survive. The
-- body below is the LIVE definition read back with `pg_get_functiondef` and one call site
-- changed -- not a copy of 20260815192344, which is how an allowlist or a body silently
-- reverts to an older state (this repo has done it four times; see CLAUDE.md).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.apply_location_layout(p_parent_id uuid, p_nodes jsonb, p_moves jsonb DEFAULT '[]'::jsonb, p_removals uuid[] DEFAULT '{}'::uuid[])
 RETURNS SETOF inventory_locations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    -- A lock bound, not a payload bound — the same reasoning as create_location_tree's NODE_MAX and
    -- bulk_put_away's PUT_AWAY_MAX. Every row touched holds a lock for the whole transaction.
    NODE_MAX  constant integer := 1000;
    -- The parked name. Carries the row's own id so two parked rows can never collide with each
    -- other, and no row is ever left wearing it: either the transaction commits with final names
    -- (section 6) or it rolls back entirely.
    PARK      constant text    := '~reshaping~';

    v_company  uuid;
    v_kind     text;
    v_sub      uuid[];                 -- every existing descendant, the unit included
    v_keep     uuid[] := '{}';         -- ids named by an `id:` ref in p_nodes
    v_park     uuid[] := '{}';         -- renamed | re-parented | removed
    -- id -> the name the location had when this transaction started. Section 8 needs it: by the
    -- time a removal is refused, its row is wearing a parked name, so the row itself can no longer
    -- say which shelf the person should go and empty.
    v_names    jsonb  := '{}'::jsonb;
    v_map      jsonb  := '{}'::jsonb;  -- ref -> location id, existing AND new
    v_node     jsonb;
    v_move     jsonb;
    v_ref      text;
    v_parent   uuid;
    v_id       uuid;
    v_new_id   uuid;
    v_to       uuid;
    v_name     text;
    v_dup      text;
    v_orphan   uuid;
BEGIN
    -- ─────────────────────────────────────────────────────────────────────────
    -- 1. The subject, and who is allowed to touch it
    -- ─────────────────────────────────────────────────────────────────────────
    SELECT company_id, kind INTO v_company, v_kind
      FROM public.inventory_locations WHERE id = p_parent_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'location % not found', p_parent_id USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- REQUIRED, and not inherited: `delete_location` checks membership only and has no billing
    -- gate — it escapes definer_writers_missing_write_gate() because that guard's regex matches
    -- only `insert into|update`, and it does neither. Every other write below is ours.
    PERFORM public.inv_assert_can_write(v_company);

    IF v_kind = 'system' THEN
        RAISE EXCEPTION
          'That is where parts with no recorded location go rather than furniture, so it has no layout to change.'
          USING ERRCODE = 'check_violation';
    END IF;

    IF jsonb_typeof(p_nodes) <> 'array' THEN
        RAISE EXCEPTION 'Nothing to change.' USING ERRCODE = 'check_violation';
    END IF;
    IF jsonb_array_length(p_nodes) + COALESCE(cardinality(p_removals), 0) = 0 THEN
        RAISE EXCEPTION 'Nothing to change.' USING ERRCODE = 'check_violation';
    END IF;
    IF jsonb_array_length(p_nodes) + COALESCE(cardinality(p_removals), 0) > NODE_MAX THEN
        RAISE EXCEPTION
          'Too many locations at once (maximum %). Reshape it in smaller sections.', NODE_MAX
          USING ERRCODE = 'check_violation';
    END IF;

    -- ─────────────────────────────────────────────────────────────────────────
    -- 2. Lock the WHOLE subtree, up front
    -- ─────────────────────────────────────────────────────────────────────────
    -- `subdivide_location` locks one parent row, because one parent row is all it changes. A
    -- reshape re-parents, renames and deletes anywhere inside the unit, so every descendant is
    -- locked.
    --
    -- FOR UPDATE is the half of the lock pair that conflicts with FOR SHARE in
    -- `assert_stock_location_is_a_leaf`. Without that pairing the pair is open to write skew under
    -- READ COMMITTED — an operator adding stock to a bin this transaction is about to delete would
    -- see no children, we would see no stock, and both would commit. See the long note in
    -- 20260806160053 §3; deferring does not help, because a deferred trigger takes a fresh snapshot
    -- at commit that still excludes an uncommitted transaction.
    --
    -- ORDER BY id so two reshapes of overlapping subtrees queue instead of deadlocking.
    WITH RECURSIVE d AS (
        SELECT id FROM public.inventory_locations WHERE id = p_parent_id
        UNION ALL
        SELECT l.id FROM public.inventory_locations l JOIN d ON l.parent_id = d.id
    )
    SELECT array_agg(id) INTO v_sub FROM d;

    PERFORM 1 FROM public.inventory_locations
      WHERE id = ANY(v_sub)
      ORDER BY id
      FOR UPDATE;

    -- ─────────────────────────────────────────────────────────────────────────
    -- 3. Validate the payload against reality, before touching anything
    -- ─────────────────────────────────────────────────────────────────────────
    -- Every ref appears once. A repeated ref is the only way to express a cycle through this
    -- payload, and it would also make the resolution map silently lose one of the two.
    SELECT n.node ->> 'ref' INTO v_ref
      FROM jsonb_array_elements(p_nodes) AS n(node)
     GROUP BY n.node ->> 'ref' HAVING count(*) > 1
     LIMIT 1;
    IF v_ref IS NOT NULL THEN
        RAISE EXCEPTION 'Node % appears twice.', v_ref USING ERRCODE = 'check_violation';
    END IF;

    -- Existing refs must name a location inside THIS unit. Without it a caller could rename or
    -- re-parent any location in any company they belong to by grafting its id into the payload.
    SELECT array_agg(substring(n.node ->> 'ref' from 4)::uuid) INTO v_keep
      FROM jsonb_array_elements(p_nodes) AS n(node)
     WHERE n.node ->> 'ref' LIKE 'id:%';
    v_keep := COALESCE(v_keep, '{}');

    SELECT k INTO v_orphan FROM unnest(v_keep) k
     WHERE NOT (k = ANY(v_sub)) OR k = p_parent_id
     LIMIT 1;
    IF v_orphan IS NOT NULL THEN
        RAISE EXCEPTION 'Location % is not inside this unit.', v_orphan
          USING ERRCODE = 'check_violation';
    END IF;

    SELECT k INTO v_orphan FROM unnest(COALESCE(p_removals, '{}')) k
     WHERE NOT (k = ANY(v_sub)) OR k = p_parent_id
     LIMIT 1;
    IF v_orphan IS NOT NULL THEN
        RAISE EXCEPTION 'Location % is not inside this unit.', v_orphan
          USING ERRCODE = 'check_violation';
    END IF;

    -- THE PARTITION. Every existing descendant in exactly one list, and never in both.
    SELECT k INTO v_orphan FROM unnest(v_keep) k
     WHERE k = ANY(COALESCE(p_removals, '{}')) LIMIT 1;
    IF v_orphan IS NOT NULL THEN
        RAISE EXCEPTION 'Location % is both kept and removed.', v_orphan
          USING ERRCODE = 'check_violation';
    END IF;

    SELECT s INTO v_orphan FROM unnest(v_sub) s
     WHERE s <> p_parent_id
       AND NOT (s = ANY(v_keep))
       AND NOT (s = ANY(COALESCE(p_removals, '{}')))
     LIMIT 1;
    IF v_orphan IS NOT NULL THEN
        RAISE EXCEPTION 'Location % is neither kept nor removed; the layout is incomplete.', v_orphan
          USING ERRCODE = 'check_violation';
    END IF;

    -- Duplicate sibling names, folded exactly the way the expression index folds them, so a
    -- collision arrives as a sentence rather than a raw 23505 after half the work is done. The
    -- client checks this live as you type; this is the backstop, not the message anyone should see.
    SELECT min(n.node ->> 'name') INTO v_dup
      FROM jsonb_array_elements(p_nodes) AS n(node)
     GROUP BY COALESCE(n.node ->> 'parent_ref', '<root>'), lower(btrim(n.node ->> 'name'))
    HAVING count(*) > 1
     LIMIT 1;
    IF v_dup IS NOT NULL THEN
        RAISE EXCEPTION 'Two locations in the same place are both called "%".', v_dup
          USING ERRCODE = 'unique_violation';
    END IF;

    -- From here on the illegal intermediate state is permitted. Deferring is not skipping: both
    -- directions still fire at COMMIT, and a distribution that does not empty what it was supposed
    -- to empty rolls the whole thing back.
    SET CONSTRAINTS public.location_children_hold_no_stock DEFERRED;

    -- ─────────────────────────────────────────────────────────────────────────
    -- 4. Park ONLY the names somebody else is about to take
    -- ─────────────────────────────────────────────────────────────────────────
    -- ## Why this set, and not "everything that changes"
    --
    -- The first version parked every renamed, re-parented or removed row. It was correct and it
    -- leaked: `transfer_stock` reads the SOURCE location's name to write its ledger note, and
    -- `snapshot_transaction_location_name` snapshots the path — so moving stock out of a bin that
    -- had been parked wrote `Transfer from ~reshaping~<uuid>` into the ledger PERMANENTLY, where
    -- `location_name` is immutable by design. Parking is reversible inside the transaction; the
    -- history it poisons on the way past is not. Caught by looking at the operator's activity feed
    -- after a real reshape, which no test asserted on.
    --
    -- Parking exists for exactly one reason: a row is sitting on a name that a DIFFERENT row wants
    -- in the final state. That is the whole set. A rename with nobody waiting for the old name, and
    -- a removal whose name nobody reclaims — the ordinary cases — never park at all, so the ledger
    -- records the shelf the operator actually took the stock from.
    --
    -- A final node whose parent is NEW cannot contest anything: its parent does not exist yet, so
    -- no current row can share its (parent, name). Hence the `parent_id` resolution below yields
    -- NULL for those and the join drops them.
    --
    -- ## Residual, stated plainly
    --
    -- If a reshape genuinely REUSES a removed location's name for a different location, that
    -- removal still parks and its ledger note still carries the sentinel. There is no ordering that
    -- avoids it — the stock cannot leave before its destination exists, and the destination cannot
    -- take the name while the old row holds it. It is also the case where the old name has
    -- genuinely stopped meaning that shelf.
    WITH final AS (
        SELECT n.node ->> 'ref' AS ref,
               CASE WHEN n.node ->> 'parent_ref' IS NULL THEN p_parent_id
                    WHEN n.node ->> 'parent_ref' LIKE 'id:%'
                         THEN substring(n.node ->> 'parent_ref' from 4)::uuid
                    ELSE NULL
               END AS parent_id,
               lower(btrim(n.node ->> 'name')) AS folded
          FROM jsonb_array_elements(p_nodes) AS n(node)
    )
    SELECT array_agg(DISTINCT l.id) INTO v_park
      FROM public.inventory_locations l
      JOIN final f
        ON f.parent_id = l.parent_id
       AND f.folded = lower(btrim(l.name))
       -- somebody ELSE wants it. A row keeping its own name matches itself and must not park.
       AND f.ref IS DISTINCT FROM 'id:' || l.id::text
     WHERE l.id = ANY(v_sub)
       AND l.id <> p_parent_id;
    v_park := COALESCE(v_park, '{}');

    -- Snapshot the names first — see the declaration.
    SELECT COALESCE(jsonb_object_agg(id::text, name), '{}'::jsonb) INTO v_names
      FROM public.inventory_locations WHERE id = ANY(v_sub);

    IF cardinality(v_park) > 0 THEN
        UPDATE public.inventory_locations
           SET name = PARK || id::text, updated_at = now()
         WHERE id = ANY(v_park);
    END IF;

    -- ─────────────────────────────────────────────────────────────────────────
    -- 5. Re-parent what survives, insert what is new
    -- ─────────────────────────────────────────────────────────────────────────
    -- One pass, parent before child, so `v_map` always holds a ref by the time a child names it.
    -- New rows go in with their FINAL names — every name they could collide with is parked.
    FOR v_node IN SELECT * FROM jsonb_array_elements(p_nodes) LOOP
        v_ref := v_node ->> 'ref';
        IF v_ref IS NULL OR v_ref = '' THEN
            RAISE EXCEPTION 'Every node needs a ref.' USING ERRCODE = 'check_violation';
        END IF;

        IF v_node ->> 'parent_ref' IS NULL THEN
            v_parent := p_parent_id;
        ELSIF v_map ? (v_node ->> 'parent_ref') THEN
            v_parent := (v_map ->> (v_node ->> 'parent_ref'))::uuid;
        ELSE
            RAISE EXCEPTION 'Unknown parent_ref %; nodes must be ordered parent before child.',
                v_node ->> 'parent_ref' USING ERRCODE = 'check_violation';
        END IF;

        IF v_ref LIKE 'id:%' THEN
            v_id := substring(v_ref from 4)::uuid;
            -- Fires direction (b), now deferred: this is the leaf-gains-children case.
            UPDATE public.inventory_locations
               SET parent_id = v_parent, updated_at = now()
             WHERE id = v_id AND parent_id IS DISTINCT FROM v_parent;
            v_map := v_map || jsonb_build_object(v_ref, v_id::text);
        ELSE
            INSERT INTO public.inventory_locations (company_id, parent_id, name, kind, sort_order)
            VALUES (
                v_company,
                v_parent,
                v_node ->> 'name',
                v_node ->> 'kind',
                COALESCE((v_node ->> 'sort_order')::integer, 0)
            )
            RETURNING id INTO v_new_id;
            v_map := v_map || jsonb_build_object(v_ref, v_new_id::text);
        END IF;
    END LOOP;

    -- ─────────────────────────────────────────────────────────────────────────
    -- 6. Unpark: final names and positions
    -- ─────────────────────────────────────────────────────────────────────────
    -- AFTER the re-parents, because sibling uniqueness is scoped by parent — a name that is free
    -- under the new parent may still be taken under the old one.
    --
    -- `kind` is deliberately NOT written. A reshape has no opinion about it, and the client keeps an
    -- existing location's kind for the same reason: rewriting the column on every row of a cabinet
    -- as a side effect of renaming them is a write nobody asked for.
    FOR v_node IN SELECT * FROM jsonb_array_elements(p_nodes) WHERE value ->> 'ref' LIKE 'id:%' LOOP
        UPDATE public.inventory_locations
           SET name       = v_node ->> 'name',
               sort_order = COALESCE((v_node ->> 'sort_order')::integer, 0),
               updated_at = now()
         WHERE id = substring(v_node ->> 'ref' from 4)::uuid;
    END LOOP;

    -- ─────────────────────────────────────────────────────────────────────────
    -- 7. The stock
    -- ─────────────────────────────────────────────────────────────────────────
    -- Delegated to `transfer_stock`, exactly as `subdivide_location` does, so the ledger rows, the
    -- transfer_group_id pairing and the unit handling are identical to every other movement in the
    -- app rather than being re-implemented here. It also deletes an emptied source row rather than
    -- parking a zero (20260802144310), which is what lets a leaf that gains children pass direction
    -- (b)'s EXISTS check at COMMIT.
    FOR v_move IN SELECT * FROM jsonb_array_elements(p_moves) LOOP
        v_id := (v_move ->> 'from_location_id')::uuid;
        IF v_id IS NULL OR NOT (v_id = ANY(v_sub)) THEN
            RAISE EXCEPTION 'A move starts outside this unit.' USING ERRCODE = 'check_violation';
        END IF;

        IF (v_move ->> 'to_ref') = 'parent' THEN
            -- The unit flattened to a single location and is receiving its own stock back.
            v_to := p_parent_id;
        ELSIF v_map ? (v_move ->> 'to_ref') THEN
            v_to := (v_map ->> (v_move ->> 'to_ref'))::uuid;
        ELSE
            RAISE EXCEPTION 'Move targets unknown ref %.', v_move ->> 'to_ref'
              USING ERRCODE = 'check_violation';
        END IF;

        PERFORM public.transfer_stock(
            (v_move ->> 'part_id')::uuid,
            v_id,
            v_to,
            (v_move ->> 'quantity')::numeric,
            v_move ->> 'unit',
            (v_move ->> 'converted_quantity')::numeric,
            v_move ->> 'notes',
            NULLIF(v_move ->> 'operator_id', '')::uuid,
            NULL,
            -- WHICH heat is moving. `transfer_stock` refuses a lot-less move of a tracked part,
            -- so without this a reshape of any unit holding traced material fails outright. NULL
            -- for every untracked part, which is the ordinary case and unchanged.
            NULLIF(v_move ->> 'lot_id', '')::uuid
        );
    END LOOP;

    -- ─────────────────────────────────────────────────────────────────────────
    -- 8. The removals
    -- ─────────────────────────────────────────────────────────────────────────
    -- Checked by name FIRST. `delete_location` raises 'location subtree still holds stock', which is
    -- true and useless standing in front of a 180-bin cabinet — and by the time it fires the name is
    -- parked, so even the raw message could not name the place. Deleting per SUBTREE ROOT (a removed
    -- node whose parent is not itself removed) rather than per node, because delete_location already
    -- walks a subtree bottom-up and is the one tested implementation of that.
    FOR v_id IN
        SELECT l.id
          FROM public.inventory_locations l
         WHERE l.id = ANY(COALESCE(p_removals, '{}'))
           AND (l.parent_id IS NULL OR NOT (l.parent_id = ANY(COALESCE(p_removals, '{}'))))
    LOOP
        SELECT string_agg(DISTINCT COALESCE(v_names ->> d.id::text, d.id::text), ', ')
          INTO v_name
          FROM (
            WITH RECURSIVE r AS (
                SELECT id FROM public.inventory_locations WHERE id = v_id
                UNION ALL
                SELECT l.id FROM public.inventory_locations l JOIN r ON l.parent_id = r.id
            )
            SELECT id FROM r
          ) d
          JOIN public.part_location_stock s ON s.location_id = d.id
         WHERE s.quantity > 0;

        IF v_name IS NOT NULL THEN
            RAISE EXCEPTION
              'Something is still stored in %, so it cannot be removed. Say where its stock goes first.',
              v_name
              USING ERRCODE = 'foreign_key_violation';
        END IF;

        PERFORM public.delete_location(v_id);
    END LOOP;

    -- What the unit looks like now. Name ordering is the CLIENT's job
    -- (`compareLocationNames`): Postgres collation puts Bin 10 before Bin 2.
    RETURN QUERY
        WITH RECURSIVE d AS (
            SELECT id FROM public.inventory_locations WHERE id = p_parent_id
            UNION ALL
            SELECT l.id FROM public.inventory_locations l JOIN d ON l.parent_id = d.id
        )
        SELECT loc.* FROM public.inventory_locations loc
          JOIN d ON d.id = loc.id
         ORDER BY loc.sort_order, loc.name;
END;
$function$;


-- ============================================================================
-- Guard
-- ============================================================================
DO $guard$
BEGIN
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'apply_location_layout') <> 1 THEN
        RAISE EXCEPTION 'apply_location_layout must have exactly one overload';
    END IF;

    -- The whole point of the change: the body must reach transfer_stock's lot parameter.
    IF (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'apply_location_layout') NOT LIKE '%lot_id%' THEN
        RAISE EXCEPTION 'apply_location_layout no longer passes a lot to transfer_stock';
    END IF;

    IF NOT has_function_privilege('authenticated',
        'public.apply_location_layout(uuid, jsonb, jsonb, uuid[])', 'EXECUTE') THEN
        RAISE EXCEPTION 'authenticated lost EXECUTE on apply_location_layout';
    END IF;
END $guard$;
