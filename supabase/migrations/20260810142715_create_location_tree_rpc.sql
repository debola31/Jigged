-- ═══════════════════════════════════════════════════════════════════════════════
-- create_location_tree: build a whole storage unit in ONE transaction (#618)
-- ═══════════════════════════════════════════════════════════════════════════════
-- `materializeLocationSpec` inserts each node with its own INSERT, awaited in a loop. A shop owner
-- generating a 12 × 15 cabinet paid 240 sequential round trips on an old office computer and
-- concluded the app had frozen — the reason this is being fixed at all. Worse than slow: a failure
-- halfway leaves every node created before it, a partial tree with no rollback and an opaque error.
--
-- ## Why a new function rather than widening subdivide_location
--
-- `subdivide_location` already does almost this, and its insert loop already handles a NULL parent
-- correctly (parent_id is nullable, and `v_parent := p_parent_id` roots the node). What it cannot
-- do is a ROOT-level create, because it derives company_id solely from the parent row:
--
--     SELECT company_id INTO v_company FROM inventory_locations WHERE id = p_parent_id;
--     IF v_company IS NULL THEN RAISE 'location % not found' ...
--
-- Giving it a p_company_id changes its arity to (uuid, uuid, jsonb, jsonb). CREATE OR REPLACE would
-- then create an OVERLOAD rather than replace it, leaving the 3-arg version live with its grants —
-- so it would need an explicit DROP FUNCTION, which destroys both the ACL and the COMMENT and
-- requires re-issuing both.
--
-- **This module has already been bitten by exactly that, live.** 20260731235450 added p_photo_path
-- to the three stock RPCs and records the result: the added parameter created an overload, a call
-- at the original arity became ambiguous — "is not unique (SQLSTATE 42725) … which is precisely
-- what `supabase db reset` produced on the first attempt, from seed.sql" — and the fix was DROP
-- FUNCTION IF EXISTS on all three before recreating them. There is no reason to reopen that.
--
-- A separate function is also simply SMALLER, because it needs none of what makes
-- `subdivide_location` hard:
--
--   * no p_moves and no transfer_stock delegation — a fresh subtree has no stock to redistribute;
--   * **no constraint deferral**. A subtree under a NULL or empty parent never passes through the
--     illegal intermediate state that `location_children_hold_no_stock` exists to allow, so the
--     trigger stays INITIALLY IMMEDIATE and correctly refuses if the parent holds stock. Deferring
--     is a privilege `subdivide_location` needs and this does not, and a function that defers a
--     check it never has to break is a guard-shaped hole waiting for a future caller.
--
-- ## Node shape — deliberately identical to subdivide_location's
--
--   p_nodes = [{"ref":"k1","parent_ref":null,"name":"Row 1","kind":null,"sort_order":0}, ...]
--
-- Flat, refs resolved in-function through one jsonb map, parent BEFORE child. `parent_ref` null
-- means "directly under p_parent_id" (or a root, when that is null). An unresolvable ref raises
-- rather than silently rooting the node somewhere wrong. The client already emits exactly this via
-- `flattenSpec`, so both RPCs read the same payload and neither needs its own serializer.

-- Signature note: `p_parent_id` is last and DEFAULTs to NULL, because the ROOT create — a whole new
-- storage unit — is the case that could not be expressed before, and it should not have to pass an
-- explicit null. Postgres requires every parameter after a defaulted one to be defaulted too, hence
-- the ordering. It also keeps the generated TS type optional (`p_parent_id?: string`), so the
-- client can pass `parentId ?? undefined` the way it does for every other optional RPC argument.
CREATE OR REPLACE FUNCTION public.create_location_tree(
    p_company_id uuid,
    p_nodes      jsonb,
    p_parent_id  uuid DEFAULT NULL
)
RETURNS SETOF public.inventory_locations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    -- A lock bound, not a payload bound — same reasoning as bulk_put_away's PUT_AWAY_MAX. Every
    -- inserted row holds a lock for the whole transaction, and the cap lives HERE rather than in
    -- the UI so no caller, present or future, can break the atomicity guarantee by looping. A
    -- 15 × 15 cabinet is 240 nodes, so this is roughly 4x the largest thing anyone has built.
    NODE_MAX  constant integer := 1000;
    v_map     jsonb := '{}'::jsonb;   -- ref -> new location id
    v_created uuid[] := '{}';
    v_node    jsonb;
    v_ref     text;
    v_parent  uuid;
    v_new_id  uuid;
    v_count   integer;
BEGIN
    IF jsonb_typeof(p_nodes) <> 'array' OR jsonb_array_length(p_nodes) = 0 THEN
        RAISE EXCEPTION 'Nothing to create.' USING ERRCODE = 'check_violation';
    END IF;

    v_count := jsonb_array_length(p_nodes);
    IF v_count > NODE_MAX THEN
        RAISE EXCEPTION
          'Too many places at once (% of a maximum %). Build it in smaller sections.',
          v_count, NODE_MAX USING ERRCODE = 'check_violation';
    END IF;

    IF p_company_id IS NULL THEN
        RAISE EXCEPTION 'company is required' USING ERRCODE = 'null_value_not_allowed';
    END IF;
    IF NOT (p_company_id IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', p_company_id
          USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- The company is the caller's OWN claim here rather than something derived from a parent row,
    -- so a parent must be proven to belong to it — otherwise a caller could pass their own company
    -- with someone else's parent id and graft a subtree into another shop's cabinet.
    IF p_parent_id IS NOT NULL THEN
        PERFORM public.inv_assert_location_in_company(p_parent_id, p_company_id);
    END IF;

    PERFORM public.inv_assert_can_write(p_company_id);

    FOR v_node IN SELECT * FROM jsonb_array_elements(p_nodes) LOOP
        v_ref := v_node ->> 'ref';
        IF v_ref IS NULL OR v_ref = '' THEN
            RAISE EXCEPTION 'Every node needs a ref.' USING ERRCODE = 'check_violation';
        END IF;

        IF v_node ->> 'parent_ref' IS NULL THEN
            v_parent := p_parent_id;   -- NULL here is a root, which is the whole point
        ELSIF v_map ? (v_node ->> 'parent_ref') THEN
            v_parent := (v_map ->> (v_node ->> 'parent_ref'))::uuid;
        ELSE
            RAISE EXCEPTION 'Unknown parent_ref %; nodes must be ordered parent before child.',
                v_node ->> 'parent_ref' USING ERRCODE = 'check_violation';
        END IF;

        INSERT INTO public.inventory_locations (company_id, parent_id, name, kind, sort_order)
        VALUES (
            p_company_id,
            v_parent,
            v_node ->> 'name',
            v_node ->> 'kind',
            COALESCE((v_node ->> 'sort_order')::integer, 0)
        )
        RETURNING id INTO v_new_id;

        v_map     := v_map || jsonb_build_object(v_ref, v_new_id::text);
        v_created := v_created || v_new_id;
    END LOOP;

    -- Name ordering is the CLIENT's job (`compareLocationNames`): Postgres collation puts Bin 10
    -- before Bin 2, and this returns rows the caller then renders.
    RETURN QUERY
        SELECT * FROM public.inventory_locations
         WHERE id = ANY(v_created)
         ORDER BY sort_order, name;
END;
$$;

COMMENT ON FUNCTION public.create_location_tree(uuid, jsonb, uuid) IS
  'Create a subtree of storage locations — optionally at the root — in one transaction. Takes the same flat {ref, parent_ref} node list as subdivide_location, so the client serializes once for both. Unlike subdivide_location it moves no stock and defers no constraint: a fresh subtree never passes through the container/bin invariant''s illegal intermediate state, so the trigger stays immediate and refuses a parent that holds stock. Caps at 1000 nodes to bound lock duration. Called by materializeLocationSpec in utils/inventoryLocationsAccess.ts.';

REVOKE EXECUTE ON FUNCTION public.create_location_tree(uuid, jsonb, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.create_location_tree(uuid, jsonb, uuid) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Allowlist it for the CI execute-grant guard
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THE BROWSER NEEDS IT: this IS the "Add storage" / "Subdivide" create path. The whole point is
-- that the subtree lands atomically, so it cannot be decomposed into client-side inserts — that is
-- the bug (#618) being fixed. Revoking it would leave the create button raising 42501.
--
-- Not an unguarded hole: the body asserts company membership against get_user_company_ids(),
-- proves any parent belongs to that company, calls inv_assert_can_write for the billing gate, and
-- leaves the container/bin constraint trigger armed.
--
-- ⚠️ Recreated from 20260806160053 — the LATEST migration to declare this function — VERBATIM, with
-- one name added. The allowlist lives in the body, so rebuilding it from a stale copy silently
-- REVERTS every entry added since. That trap has now been sprung three times in this function's
-- history; the note in 20260806160053 documents the most recent.
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
      -- Added 20260810142715: the Storage page's create/duplicate path calls it
      -- directly (`materializeLocationSpec` in utils/inventoryLocationsAccess.ts).
      -- Atomicity IS the feature — the loop it replaces could leave a partial
      -- tree behind an opaque error (#618) — so it cannot be decomposed either.
      'create_location_tree',
      -- Called BY a browser-callable SECURITY INVOKER function, which runs as the
      -- caller — so the caller genuinely needs EXECUTE on this one.
      -- (generate_quote_number / generate_direct_job_number -> next_order_number)
      'next_order_number'
    )
  ORDER BY 1, 2;
$$;

COMMENT ON FUNCTION public.function_execute_leaks() IS
  'Lists SECURITY DEFINER functions in public that a browser role can execute and that are not on the reviewed allowlist. Must always be empty. Exists because the ON FUNCTIONS default privileges auto-granted every new function to anon/authenticated, making the REVOKE ... FROM PUBLIC idiom used across this schema ineffective (issue #640) — and because over-granting is silent, so only a test finds it. To add a function here, say in the PR why the browser needs to call it.';
