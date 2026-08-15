-- ═══════════════════════════════════════════════════════════════════════════════
-- apply_location_layout: `Change layout` finally changes the layout
-- ═══════════════════════════════════════════════════════════════════════════════
-- `Change layout` was `subdivide_location` / `create_location_tree` — both INSERT-ONLY — with the
-- client passing the unit's real sibling names so the generated ones would continue *past* them.
-- Reshaping a 5-row cabinet into 3 rows produced eight rows, and the confirm button read
-- `Create 8 places`. The label promised a change; no code path could express one.
--
-- A reshape is four kinds of write at once — create, rename, re-parent, delete — plus moving the
-- stock out of whatever is disappearing. This does all of it in ONE transaction, and both halves of
-- that sentence are load-bearing.
--
-- ## Why it cannot be a sequence of client calls
--
-- 1. **Two of the steps are illegal outside a deferring transaction.** A surviving leaf that gains
--    children is direction (b) of `location_children_hold_no_stock` (20260806160053), refused at
--    statement time by `assert_location_parent_holds_no_stock`. Creating the children first breaks
--    the invariant; moving the stock first has nowhere to move it to. That is verbatim the argument
--    `subdivide_location` was written for, and it applies unchanged here.
--
-- 2. **A name swap has no valid ordering at all.** `inventory_locations_unique_sibling_name`
--    (20260729221603) is a UNIQUE *INDEX* on the EXPRESSION
--    `(company_id, coalesce(parent_id, <sentinel>), lower(btrim(name)))`. Three consequences:
--      * `SET CONSTRAINTS ... DEFERRED` cannot touch it — it is an index, not a constraint;
--      * it cannot be *made* deferrable, because `ALTER TABLE ... ADD CONSTRAINT UNIQUE` does not
--        accept expressions;
--      * Postgres checks a unique index per TUPLE, so `Row 1` ↔ `Row 2` fails even as a single
--        `UPDATE ... FROM (VALUES ...)`.
--    So renaming has to happen in two phases, with the touched names parked out of the way in
--    between. Parking is only safe inside a transaction that can roll back: a browser that renamed
--    `Row 1` to a sentinel and then died would leave a location literally called that on a shop's
--    shelf. See section 4.
--
-- 3. **A partial apply here can already have deleted bins.** `materializeLocationSpec` documents the
--    milder version of this failure (#618): "a failure partway left every node created before it: a
--    partial tree, no rollback, an opaque error." Half a reshape is worse than half a create.
--
-- ## Node shape — deliberately the same one the other two RPCs take
--
--   p_nodes    = [{"ref":"id:<uuid>"|"new:/0","parent_ref":null,"name":"Row 1","kind":null,"sort_order":0}, ...]
--   p_moves    = [{"part_id":"…","from_location_id":"…","to_ref":"…","quantity":5,"unit":"ea","converted_quantity":5}]
--   p_removals = uuid[]
--
-- `p_nodes` is the FINAL subtree, flat, parent BEFORE child; `parent_ref` null means "directly under
-- p_parent_id". A ref beginning `id:` names a location that already exists — that prefix is the only
-- thing that distinguishes "this is Row 3, renamed" from "this is a new location that happens to be
-- called Row 3", which is the whole difference between a rename and a remove-then-create. It is
-- minted by `existingKey` in utils/locationReshape.ts and decoded in exactly two places: there, and
-- section 3 below.
--
-- `p_moves` carries `from_location_id` — an id, not a ref — because a move always STARTS at a
-- location that already exists. `to_ref` may name a new node, a surviving one, or the reserved
-- `parent`, which is how a unit that flattens to a single location receives its own stock.
--
-- ## The partition rule
--
-- Every existing descendant of the unit must appear in exactly one of `p_nodes` (as an `id:` ref) or
-- `p_removals`. Asserted rather than trusted, because the failure is silent: a client bug that
-- dropped a node from both lists would leave it hanging under a parent that no longer exists, and
-- nothing would raise.

-- ═══════════════════════════════════════════════════════════════════════════════
-- FIRST: `delete_location` has been broken since 2026-07-31, and this needs it
-- ═══════════════════════════════════════════════════════════════════════════════
-- Found by the smoke test for the RPC below. Deleting a location that has ever been transacted —
-- "a shelf is used, everything is later removed, and the shelf is thrown out", the scenario
-- 20260622034847 exists for and names in its first paragraph — raises:
--
--     ERROR: Only the notes field can be updated on inventory transactions
--     CONTEXT: SQL statement "UPDATE ONLY inventory_transactions SET location_id = NULL ..."
--              PL/pgSQL function delete_location(uuid)
--
-- ## What happened
--
-- `inventory_transactions.location_id` is `ON DELETE SET NULL`, so deleting a location UPDATEs its
-- ledger rows. 20260622034847 made that FK SET NULL and, in the same migration, deliberately
-- REMOVED `location_id` from this guard's column set — its section 4 header says so outright:
-- *"location_id leaves the set (so SET NULL on delete is allowed)"*.
--
-- 20260731235450 then rebuilt the guard to add `photo_path`, read the absence of `location_id` as
-- an oversight rather than a decision, and put it back — *"the other three were mutable by omission
-- from the day the locations work added them."* Two of those three were. This one was load-bearing.
--
-- That is the same trap the `function_execute_leaks()` allowlist has been caught by three times,
-- in a different function: **an allowlist-by-omission rebuilt from a stale copy silently reverts a
-- deliberate removal.** The removal is now spelled out where the next rebuild will read it.
--
-- ## Why it is fixed here rather than filed
--
-- Every removal `apply_location_layout` performs is a bin whose stock has just been moved out —
-- i.e. a location with ledger history, which is exactly the unreachable case. The reshape flow
-- cannot ship over it. It also independently fixes the `Delete` action on the Storage page, which
-- has been raising this at users for two weeks.
--
-- Recreated VERBATIM from 20260731235450, the LATEST definition, with one line removed.
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
       -- Added 2026-07-31. The first is the new evidence column; the other two were mutable by
       -- omission from the day the locations work added them.
       --
       -- ⚠️ `location_id` IS DELIBERATELY ABSENT AND MUST STAY ABSENT. It is `ON DELETE SET NULL`
       -- (20260622034847), so listing it here makes every `delete_location` of a transacted
       -- location fail — the ledger row's durable record of where the movement happened is
       -- `location_name`, which IS immutable, one line below. Do not "close the gap".
       OR OLD.photo_path        IS DISTINCT FROM NEW.photo_path
       OR OLD.location_name     IS DISTINCT FROM NEW.location_name
       OR OLD.transfer_group_id IS DISTINCT FROM NEW.transfer_group_id
    THEN
        RAISE EXCEPTION 'Only the notes field can be updated on inventory transactions';
    END IF;
    RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.restrict_transaction_update_to_notes() IS
  'Ledger immutability: only `notes` may be UPDATEd on inventory_transactions. An allowlist BY OMISSION — anything not named here is mutable — so a rebuild that "restores" a missing column can break a cascade. `location_id` is omitted ON PURPOSE: its FK is ON DELETE SET NULL, and naming it here breaks delete_location for any location that has ever been transacted (regression 20260731235450 → 20260815192344). `location_name` carries the durable snapshot instead.';

CREATE OR REPLACE FUNCTION public.apply_location_layout(
    p_parent_id uuid,
    p_nodes     jsonb,
    p_moves     jsonb  DEFAULT '[]'::jsonb,
    p_removals  uuid[] DEFAULT '{}'::uuid[]
)
RETURNS SETOF public.inventory_locations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
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
            NULL
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
$$;

COMMENT ON FUNCTION public.apply_location_layout(uuid, jsonb, jsonb, uuid[]) IS
  'Reshape a storage unit in one transaction: create, rename, re-parent and delete locations inside it, and move the stock out of whatever is disappearing or being divided up. Replaces subdivide_location, which could only ever append. Two steps are illegal outside a transaction that defers location_children_hold_no_stock, and a name swap is impossible without the parking pass in section 4, because the sibling-name index is an EXPRESSION index and therefore neither deferrable nor convertible to a deferrable constraint. Delegates every stock move to transfer_stock and every deletion to delete_location, so the ledger and the cascade are identical to every other path. Called by applyLocationLayout in utils/inventoryLocationsAccess.ts.';

REVOKE EXECUTE ON FUNCTION public.apply_location_layout(uuid, jsonb, jsonb, uuid[]) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.apply_location_layout(uuid, jsonb, jsonb, uuid[]) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- subdivide_location is gone
-- ─────────────────────────────────────────────────────────────────────────────
-- A reshape is a strict superset of a subdivide: all-creates plus moves. Keeping both would leave
-- two browser-callable SECURITY DEFINER functions permitted to defer the same invariant — double the
-- surface over which "deferring is not skipping" has to hold — and would leave `subdivideLocation()`
-- an unreferenced write path, which is the exact state docs/modules/inventory.md records as the
-- hazard that made a mis-parented cabinet permanent.
--
-- DROP destroys the ACL and the COMMENT with the function. Nothing to re-issue: both go for good.
DROP FUNCTION IF EXISTS public.subdivide_location(uuid, jsonb, jsonb);

-- ─────────────────────────────────────────────────────────────────────────────
-- Allowlist it for the CI execute-grant guard
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THE BROWSER NEEDS IT: this IS the `Change layout` button. Renaming, re-parenting, creating,
-- moving stock and deleting have to land as one transaction, and two of those steps are illegal
-- outside a transaction that defers the container/bin invariant — so it cannot be decomposed into
-- client-side calls. Revoking it would leave the button raising 42501.
--
-- Not an unguarded hole: the body asserts company membership against get_user_company_ids(), calls
-- inv_assert_can_write for the billing gate, refuses the system pile, proves every id in the payload
-- is inside the unit being reshaped, and leaves the deferred constraint to fire at COMMIT.
--
-- ⚠️ Recreated from 20260810142715 — the LATEST migration to declare this function — VERBATIM, with
-- one name added and one removed. The allowlist lives in the body, so rebuilding it from a stale
-- copy silently REVERTS every entry added since. That trap has now been sprung three times in this
-- function's history.
CREATE OR REPLACE FUNCTION public.function_execute_leaks()
RETURNS TABLE(function_name text, role_name text)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT p.proname::text, r.rolname::text
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(rolname)
  WHERE n.nspname = 'public'
    -- SECURITY DEFINER only. An INVOKER function runs as the caller, so RLS and
    -- table grants still contain it and a browser grant is not a hole; scoping
    -- the guard this way keeps the allowlist to the set that actually matters
    -- instead of every helper in the schema.
    AND p.prosecdef
    AND has_function_privilege(r.rolname, p.oid, 'EXECUTE')
    AND p.proname NOT IN (
      -- Named in an RLS policy: the browser cannot query the table without it.
      'company_can_write', 'get_operator_access_id', 'get_user_company_ids',
      'is_company_admin', 'is_system_admin',
      -- Called directly from application code (utils/*Access.ts, app/, hooks/).
      -- NB: enable_location_tracking / disable_location_tracking are deliberately absent.
      -- 20260802015101 dropped both RPCs; re-listing them here would leave the allowlist
      -- naming functions that no longer exist, which is how this list rots.
      'accept_invitation', 'add_stock_at_location', 'adjust_stock_at_location',
      'create_demo_company', 'create_shipment_with_line_items', 'delete_location',
      'deplete_stock_at_location', 'log_note_views', 'log_operator_event',
      'note_viewers', 'reset_demo_company', 'sync_demo_access', 'transfer_stock',
      -- Added 20260801181116: the count sheet's put-away calls it directly
      -- (`bulkPutAway` in utils/inventoryLocationsAccess.ts).
      'bulk_put_away',
      -- Added 20260803043406: the Me tab dismisses its recognition block through it
      -- (`markHelpfulSeen` in utils/operatorAccess.ts).
      'mark_reactions_seen',
      -- Added 20260810142715: the Storage page's create/duplicate path calls it
      -- directly (`materializeLocationSpec` in utils/inventoryLocationsAccess.ts).
      -- Atomicity IS the feature — the loop it replaces could leave a partial
      -- tree behind an opaque error (#618) — so it cannot be decomposed either.
      'create_location_tree',
      -- Added 20260815192344: the Storage page's `Change layout` calls it directly
      -- (`applyLocationLayout` in utils/inventoryLocationsAccess.ts). Create,
      -- rename, re-parent, move stock and delete must be ONE transaction, and two
      -- of those steps are illegal outside one that defers the container/bin
      -- invariant. `subdivide_location` left the list in the same migration: it is
      -- dropped there, and an allowlist naming functions that no longer exist is
      -- how this list rots.
      'apply_location_layout',
      -- Called BY a browser-callable SECURITY INVOKER function, which runs as the
      -- caller — so the caller genuinely needs EXECUTE on this one.
      -- (generate_quote_number / generate_direct_job_number -> next_order_number)
      'next_order_number'
    )
  ORDER BY 1, 2;
$$;

COMMENT ON FUNCTION public.function_execute_leaks() IS
  'Lists SECURITY DEFINER functions in public that a browser role can execute and that are not on the reviewed allowlist. Must always be empty. Exists because the ON FUNCTIONS default privileges auto-granted every new function to anon/authenticated, making the REVOKE ... FROM PUBLIC idiom used across this schema ineffective (issue #640) — and because over-granting is silent, so only a test finds it. To add a function here, say in the PR why the browser needs to call it.';
