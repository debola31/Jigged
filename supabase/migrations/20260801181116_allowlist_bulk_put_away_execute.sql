-- Allowlist `bulk_put_away` for browser EXECUTE.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- WHY THIS IS NEEDED, AND WHY NEITHER SIDE WAS WRONG
-- ═══════════════════════════════════════════════════════════════════════════════
-- Two changes were written in parallel and only collide once merged:
--
--   * this branch added `bulk_put_away` (20260730010705), a SECURITY DEFINER RPC
--     the count sheet calls directly to empty a bin in one atomic move;
--   * main added `function_execute_leaks()` (20260801024552, issue #640), which
--     asserts that every browser-executable SECURITY DEFINER function in `public`
--     is on a reviewed allowlist.
--
-- That allowlist was written when `bulk_put_away` did not exist, so the merged
-- migration set produces a function the guard has never been shown. CI failed
-- exactly as designed:
--
--   AssertionError: SECURITY DEFINER functions reachable by a browser role:
--   [{'function_name': 'bulk_put_away', 'role_name': 'authenticated'}]
--
-- This is the guard working, not a defect in it. The fix is to make the decision
-- the guard is asking for, in the same terms its own comments use.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- THE DECISION: allowlist, do not revoke
-- ═══════════════════════════════════════════════════════════════════════════════
-- `bulk_put_away` belongs in the "called directly from application code" group,
-- beside `add_stock_at_location` and `transfer_stock`. It is invoked from
-- `bulkPutAway` in utils/inventoryLocationsAccess.ts, reached from the place-scoped
-- count sheet's "Put N away". Revoking it would leave that button raising
-- `42501 permission denied` — the whole reason the function exists is that
-- emptying a bin must be one statement rather than N chunked ones.
--
-- It is not an unguarded hole. Inside the body it asserts company membership,
-- asserts both locations belong to that company, and (as of 20260801150944)
-- calls `inv_assert_can_write` for the billing gate. Browser-callable and
-- unguarded are different properties, which is precisely the distinction issue
-- #640 exists to keep visible.
--
-- Recreated from the definition in 20260801024552 VERBATIM, with one name added.
-- Retyping the rest would risk silently reverting an entry, the way rebuilding
-- `tenant_tables_missing_write_gate()` from a stale copy nearly dropped the
-- `note_views` exemptions during #645.

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
      'accept_invitation', 'add_stock_at_location', 'adjust_stock_at_location',
      'create_demo_company', 'create_shipment_with_line_items', 'delete_location',
      'deplete_stock_at_location', 'disable_location_tracking',
      'enable_location_tracking', 'log_note_views', 'log_operator_event',
      'note_viewers', 'reset_demo_company', 'sync_demo_access', 'transfer_stock',
      -- Added 20260801181116: the count sheet's put-away calls it directly
      -- (`bulkPutAway` in utils/inventoryLocationsAccess.ts).
      'bulk_put_away',
      -- Called BY a browser-callable SECURITY INVOKER function, which runs as the
      -- caller — so the caller genuinely needs EXECUTE on this one.
      -- (generate_quote_number / generate_direct_job_number -> next_order_number)
      'next_order_number'
    )
  ORDER BY 1, 2;
$$;
COMMENT ON FUNCTION public.function_execute_leaks() IS
  'Lists SECURITY DEFINER functions in public that a browser role can execute and that are not on the reviewed allowlist. Must always be empty. Exists because the ON FUNCTIONS default privileges auto-granted every new function to anon/authenticated, making the REVOKE ... FROM PUBLIC idiom used across this schema ineffective (issue #640) — and because over-granting is silent, so only a test finds it. To add a function here, say in the PR why the browser needs to call it.';

REVOKE EXECUTE ON FUNCTION public.function_execute_leaks()
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.function_execute_leaks() TO service_role;
