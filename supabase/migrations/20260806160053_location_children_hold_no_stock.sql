-- ═══════════════════════════════════════════════════════════════════════════════
-- A place with sub-locations holds no stock
-- ═══════════════════════════════════════════════════════════════════════════════
-- If Cabinet 1-A is just Side 1 and Side 2, nobody ever means "put it in the
-- cabinet" — they mean a side. Until now every layer allowed it: no picker
-- filtered parents, no RPC checked, and nothing in the schema said otherwise.
--
-- ## This partly reverses 20260623031347
--
-- That migration dropped `is_stockable` on the reasoning that *"every location
-- can hold stock, and every location is printable"*. It was right about LEAVES
-- and right about printing — a parent's QR label is still useful, it navigates.
-- It was wrong about CONTAINERS, and this reverses that half only. Nothing here
-- brings back a per-row flag: containment is already expressed by `parent_id`,
-- and a flag that must agree with it is a second source of truth that can drift.
--
-- ## The invariant
--
--     A location with at least one child holds no part_location_stock rows.
--
-- Two directions, both closed below:
--   (a) you cannot write stock to a location that has children;
--   (b) you cannot give children to a location that holds stock.
--
-- `inventory_locations` has no `deleted_at` — empty locations are hard deleted
-- by `delete_location` — so "has children" is a plain EXISTS with no soft-delete
-- filter to forget.
--
-- ## Why the triggers are DEFERRABLE
--
-- Subdividing a shelf that already holds stock is a legitimate, supported action
-- ("Divide it up…"), and it MUST pass through the illegal intermediate state:
-- create the sub-locations, then move the stock down into them. Postgres has a
-- first-class mechanism for exactly that, so `subdivide_location` below defers
-- the check to COMMIT rather than reaching for a session-GUC escape hatch — a
-- flag any caller could set is not a guard, it is a guard-shaped hole.
--
-- INITIALLY IMMEDIATE means every ordinary path is still checked at statement
-- time. Only a transaction that explicitly defers gets the window.

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. Refuse to install over violating data
-- ─────────────────────────────────────────────────────────────────────────────
-- A constraint trigger never validates rows that already exist, so installing it
-- over bad data would leave a violation permanently invisible behind a guard
-- that claims to prevent it. Audited before writing this: production held 0 such
-- rows of 141, `supabase/seed.sql` stocks only leaves, and the demo template
-- (20260805045639) stocks only leaf refs. So this raises in no known environment
-- — it exists so that if that is ever untrue, the deploy stops instead of
-- silently grandfathering it in.
DO $$
DECLARE
    v_bad bigint;
BEGIN
    SELECT count(*) INTO v_bad
      FROM public.part_location_stock s
     WHERE EXISTS (SELECT 1 FROM public.inventory_locations c
                    WHERE c.parent_id = s.location_id);
    IF v_bad > 0 THEN
        RAISE EXCEPTION
          'refusing to install: % balance row(s) sit at a location that has sub-locations. Move them into a child location first.',
          v_bad;
    END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Direction (a): stock may only land on a leaf
-- ─────────────────────────────────────────────────────────────────────────────
-- INSERT only. `deplete`/`adjust`/`transfer` only ever update or delete rows
-- that already passed this check, and a location acquiring children later is
-- direction (b)'s job.
CREATE OR REPLACE FUNCTION public.assert_stock_location_is_a_leaf()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
    -- LOAD-BEARING, not defensive. See the concurrency note under section 3:
    -- without this lock the invariant is silently breakable by two concurrent
    -- transactions, which is the one failure mode this whole migration exists to
    -- prevent. FOR SHARE (not FOR UPDATE) so two operators receiving into the
    -- same bin still proceed concurrently — only a STRUCTURAL change serialises
    -- against them.
    PERFORM 1 FROM public.inventory_locations
     WHERE id = NEW.location_id
       FOR SHARE;

    IF EXISTS (SELECT 1 FROM public.inventory_locations c
                WHERE c.parent_id = NEW.location_id) THEN
        RAISE EXCEPTION
          'That place has sub-locations, so stock goes in one of those rather than in it.'
          USING ERRCODE = 'check_violation';
    END IF;

    RETURN NULL;  -- AFTER trigger; the return value is ignored.
END;
$$;

COMMENT ON FUNCTION public.assert_stock_location_is_a_leaf() IS
  'Constraint-trigger body for direction (a) of the container/bin invariant: stock may only sit at a location with no children. Takes FOR SHARE on the location row so it serialises against assert_location_parent_holds_no_stock, which takes FOR UPDATE — without that the pair is open to write skew under READ COMMITTED.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Direction (b): a location holding stock may not become a container
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.assert_location_parent_holds_no_stock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_kind text;
    v_name text;
BEGIN
    -- A root has no parent to invalidate. (On UPDATE, only NEW.parent_id matters:
    -- vacating OLD.parent_id can only turn a container back into a leaf, which
    -- relaxes the invariant rather than breaking it.)
    IF NEW.parent_id IS NULL THEN
        RETURN NULL;
    END IF;

    -- The other half of the lock pair. FOR UPDATE conflicts with the FOR SHARE
    -- above, so whichever transaction reaches its lock second blocks until the
    -- first is visible.
    SELECT kind, name INTO v_kind, v_name
      FROM public.inventory_locations
     WHERE id = NEW.parent_id
       FOR UPDATE;

    -- `Unassigned` is the auto-managed put-away pile, not a shelf: it is where
    -- `inv_get_or_create_unassigned` and the parts importer put stock that has
    -- nowhere yet. Giving it children would make it unwritable and strand them.
    IF v_kind = 'system' THEN
        RAISE EXCEPTION
          '% is the put-away pile rather than a place, so it cannot be divided up.', v_name
          USING ERRCODE = 'check_violation';
    END IF;

    IF EXISTS (SELECT 1 FROM public.part_location_stock s
                WHERE s.location_id = NEW.parent_id) THEN
        RAISE EXCEPTION
          '% holds stock, so it cannot have sub-locations until that stock is moved into one of them.',
          v_name
          USING ERRCODE = 'check_violation';
    END IF;

    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.assert_location_parent_holds_no_stock() IS
  'Constraint-trigger body for direction (b) of the container/bin invariant: a location holding stock may not gain children, and the system Unassigned pile may never gain children at all. Takes FOR UPDATE on the parent row to serialise against assert_stock_location_is_a_leaf.';

-- Trigger functions are invoked by the trigger machinery, not by callers, so
-- they need no EXECUTE grant — permission is checked when the trigger is
-- created. Revoking anyway, per the repo's standing idiom: correct under either
-- default-privilege state and free.
REVOKE EXECUTE ON FUNCTION public.assert_stock_location_is_a_leaf()        FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.assert_location_parent_holds_no_stock()  FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The constraint triggers
-- ─────────────────────────────────────────────────────────────────────────────
-- ## Concurrency: why the row locks above are not optional
--
-- Both directions test cross-row state with a plain EXISTS, and PostgREST runs
-- at READ COMMITTED. Without the locks:
--
--   T1 (subdivide) inserts children under Cabinet 1-A, uncommitted. T2 (an
--   operator receiving a part) inserts stock at Cabinet 1-A; its EXISTS cannot
--   see T1's uncommitted children, so it passes. T1's deferred check fires at
--   its own commit, cannot see T2's uncommitted stock row, so it passes. Both
--   commit. A parent now holds stock and NOTHING RAISED.
--
-- That is textbook write skew. Deferral does not help — a deferred trigger takes
-- a FRESH snapshot at commit time, which still excludes a transaction that has
-- not committed. Postgres only detects write skew at SERIALIZABLE, and nothing
-- here runs at SERIALIZABLE.
--
-- The implicit foreign-key locks do not save you either: inserting stock takes
-- FOR KEY SHARE on the location row, and inserting a child takes FOR KEY SHARE
-- on its parent row. FOR KEY SHARE does not conflict with itself, so the two
-- directions never serialise on their own. FOR SHARE and FOR UPDATE do conflict,
-- which is the whole point of the pairing.
--
-- ## One name, two tables
--
-- Deliberate: `SET CONSTRAINTS public.location_children_hold_no_stock DEFERRED`
-- then defers BOTH, so `subdivide_location` cannot defer one direction and leave
-- the other armed. Constraint triggers must be AFTER ... FOR EACH ROW.
CREATE CONSTRAINT TRIGGER location_children_hold_no_stock
    AFTER INSERT ON public.part_location_stock
    DEFERRABLE INITIALLY IMMEDIATE
    FOR EACH ROW EXECUTE FUNCTION public.assert_stock_location_is_a_leaf();

CREATE CONSTRAINT TRIGGER location_children_hold_no_stock
    AFTER INSERT OR UPDATE OF parent_id ON public.inventory_locations
    DEFERRABLE INITIALLY IMMEDIATE
    FOR EACH ROW EXECUTE FUNCTION public.assert_location_parent_holds_no_stock();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. subdivide_location: create the sub-locations AND redistribute, atomically
-- ─────────────────────────────────────────────────────────────────────────────
-- The one caller allowed through the illegal intermediate state, and the only
-- reason the triggers are deferrable.
--
-- It also retires a wart `materializeLocationSpec` documents about itself: that
-- path is sequential and NOT transactional, so a failure halfway leaves the
-- nodes created before it (#618). Subdividing through this RPC is one statement
-- and either happens or does not.
--
-- ## Node shape
--
--   p_nodes = [{"ref":"k1","parent_ref":null,"name":"Side 1","kind":null,"sort_order":0}, ...]
--
-- Flat, with refs resolved in-function through one jsonb map — the same
-- `_ref`/`parent_ref` idiom the demo-template loader uses, and it maps straight
-- onto `LocationSpecNode.key` so the client can reuse the builder's own keys.
-- `parent_ref` null means "directly under p_parent_id". Nodes must arrive
-- parent-before-child; an unresolvable ref raises rather than silently rooting
-- the node somewhere wrong.
--
--   p_moves = [{"part_id":"…","to_ref":"k1","quantity":5,"unit":"ea","converted_quantity":5}]
--
-- Each move delegates to the existing `transfer_stock`, so the ledger rows, the
-- `transfer_group_id` pairing and the unit handling stay identical to every
-- other movement in the app rather than being re-implemented here.
--
-- If the moves do not empty the parent, the deferred check fires at COMMIT and
-- the whole thing rolls back — an incomplete distribution cannot half-apply.
CREATE OR REPLACE FUNCTION public.subdivide_location(
    p_parent_id uuid,
    p_nodes     jsonb,
    p_moves     jsonb DEFAULT '[]'::jsonb
)
RETURNS SETOF public.inventory_locations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_company   uuid;
    v_map       jsonb := '{}'::jsonb;   -- ref -> new location id
    v_created   uuid[] := '{}';
    v_node      jsonb;
    v_move      jsonb;
    v_ref       text;
    v_parent    uuid;
    v_new_id    uuid;
    v_to        uuid;
BEGIN
    IF jsonb_typeof(p_nodes) <> 'array' OR jsonb_array_length(p_nodes) = 0 THEN
        RAISE EXCEPTION 'Nothing to create.' USING ERRCODE = 'check_violation';
    END IF;

    SELECT company_id INTO v_company
      FROM public.inventory_locations WHERE id = p_parent_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'location % not found', p_parent_id USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM public.inv_assert_can_write(v_company);

    -- Take the structural lock UP FRONT rather than leaving it to the deferred
    -- trigger. Blocking a racing stock write here costs one wait; discovering it
    -- at COMMIT means doing every insert and every transfer and then throwing
    -- the lot away.
    PERFORM 1 FROM public.inventory_locations WHERE id = p_parent_id FOR UPDATE;

    SET CONSTRAINTS public.location_children_hold_no_stock DEFERRED;

    -- Children first, so the moves below have somewhere to land.
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

        INSERT INTO public.inventory_locations (company_id, parent_id, name, kind, sort_order)
        VALUES (
            v_company,
            v_parent,
            v_node ->> 'name',
            v_node ->> 'kind',
            COALESCE((v_node ->> 'sort_order')::integer, 0)
        )
        RETURNING id INTO v_new_id;

        v_map     := v_map || jsonb_build_object(v_ref, v_new_id::text);
        v_created := v_created || v_new_id;
    END LOOP;

    -- Then the stock, out of the parent and into the leaves the caller chose.
    FOR v_move IN SELECT * FROM jsonb_array_elements(p_moves) LOOP
        IF NOT (v_map ? (v_move ->> 'to_ref')) THEN
            RAISE EXCEPTION 'Move targets unknown ref %.', v_move ->> 'to_ref'
                USING ERRCODE = 'check_violation';
        END IF;
        v_to := (v_map ->> (v_move ->> 'to_ref'))::uuid;

        PERFORM public.transfer_stock(
            (v_move ->> 'part_id')::uuid,
            p_parent_id,
            v_to,
            (v_move ->> 'quantity')::numeric,
            v_move ->> 'unit',
            (v_move ->> 'converted_quantity')::numeric,
            v_move ->> 'notes',
            NULLIF(v_move ->> 'operator_id', '')::uuid,
            NULL
        );
    END LOOP;

    RETURN QUERY
        SELECT * FROM public.inventory_locations
         WHERE id = ANY(v_created)
         ORDER BY sort_order, name;
END;
$$;

COMMENT ON FUNCTION public.subdivide_location(uuid, jsonb, jsonb) IS
  'Creates a sub-location subtree under a place and moves that place''s stock down into the new leaves, in one transaction. The only caller permitted through the container/bin invariant''s illegal intermediate state, which is why location_children_hold_no_stock is DEFERRABLE. Delegates each move to transfer_stock so the ledger is identical to any other movement. Called by subdivideLocation in utils/inventoryLocationsAccess.ts.';

REVOKE EXECUTE ON FUNCTION public.subdivide_location(uuid, jsonb, jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.subdivide_location(uuid, jsonb, jsonb) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Allowlist the new RPC for the CI execute-grant guard
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THE BROWSER NEEDS IT: `subdivide_location` is the "Divide it up…" button on
-- the Storage page. It belongs in the "called directly from application code"
-- group beside `bulk_put_away` and `transfer_stock`, and for the same reason —
-- creating the sub-locations and moving the stock down must be ONE transaction,
-- so it cannot be decomposed into client-side calls. Revoking it would leave
-- that button raising 42501.
--
-- It is not an unguarded hole: the body asserts company membership, calls
-- `inv_assert_can_write` for the billing gate, and its own deferred constraint
-- check still fires at COMMIT — deferring is not skipping.
--
-- ⚠️ Recreated from 20260803043406 — the LATEST migration to declare this function
-- — VERBATIM, with one name added. Not from 20260801181116, and not from the
-- original: the allowlist lives in the body, so rebuilding it from a stale copy
-- silently REVERTS every entry added since. The first draft of this migration did
-- exactly that, copying 20260801181116 and dropping `mark_reactions_seen` while
-- resurrecting `enable_location_tracking`/`disable_location_tracking`, two RPCs
-- 20260802015101 had already deleted. `function_execute_leaks()` caught it, which
-- is the third time in this file's history the same trap has been sprung.
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
      -- Added 20260806160053: the Storage page's "Divide it up…" calls it
      -- directly (`subdivideLocation` in utils/inventoryLocationsAccess.ts).
      -- Creating the sub-locations and moving the stock down must be one
      -- transaction, so it cannot be decomposed into client-side calls.
      'subdivide_location',
      -- Called BY a browser-callable SECURITY INVOKER function, which runs as the
      -- caller — so the caller genuinely needs EXECUTE on this one.
      -- (generate_quote_number / generate_direct_job_number -> next_order_number)
      'next_order_number'
    )
  ORDER BY 1, 2;
$$;

COMMENT ON FUNCTION public.function_execute_leaks() IS
  'Lists SECURITY DEFINER functions in public that a browser role can execute and that are not on the reviewed allowlist. Must always be empty. Exists because the ON FUNCTIONS default privileges auto-granted every new function to anon/authenticated, making the REVOKE ... FROM PUBLIC idiom used across this schema ineffective (issue #640) — and because over-granting is silent, so only a test finds it. To add a function here, say in the PR why the browser needs to call it.';
