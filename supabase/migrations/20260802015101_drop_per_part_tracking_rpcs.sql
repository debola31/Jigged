-- Drop the two per-part location-tracking RPCs.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- WHY
-- ═══════════════════════════════════════════════════════════════════════════════
-- Founder's decision, 2026-08-01: "All parts should have location, we should remove
-- this attribute entirely." These two are the per-part opt-in and opt-out for that
-- attribute, so they go first — before the column they exist to toggle.
--
-- They were already dead. `enableLocationTracking` / `disableLocationTracking` in
-- utils/inventoryLocationsAccess.ts had **zero callers** outside their own tests;
-- tracking has been set by `trg_auto_track_stocked_part` since 20260625140636, and
-- the module doc has listed both as superseded for weeks.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- AND THEY WERE NOT MERELY DEAD
-- ═══════════════════════════════════════════════════════════════════════════════
-- Both are SECURITY DEFINER and both are executable by `anon` AND `authenticated`
-- (verified with has_function_privilege against the migrated stack). They sit on the
-- reviewed allowlist in `function_execute_leaks()` under "Called directly from
-- application code" — which stopped being true when their last caller went, and
-- nothing re-checked it.
--
-- `disable_location_tracking` is the one that matters: it DELETEs every
-- `part_location_stock` row for a part and writes the summed quantity back to
-- `parts.quantity`. A browser role could call it with any part id in a company it
-- belongs to and erase that part's entire per-place history in one request — with no
-- UI anywhere that does so, and therefore nothing to notice it had happened.
--
-- Dropping them removes the reachable surface and the stale allowlist entries
-- together, which is why this is its own migration rather than a line in the big
-- one: it is worth being able to point at on its own.
--
-- `enable_location_tracking_for_company` is deliberately NOT dropped here. It is the
-- flag-flip backfill, still called from api/routes/admin_routes.py, and it is
-- superseded by the universal backfill in the next migration — so it goes with that
-- one, leaving no path un-backfilled at any point in the sequence.

DROP FUNCTION IF EXISTS public.enable_location_tracking(uuid, uuid);
DROP FUNCTION IF EXISTS public.disable_location_tracking(uuid);

-- Both were named in the reviewed allowlist. Leaving them there after the drop would
-- keep two dead exemptions in a list whose entire value is that every entry was
-- argued for. Rebuilt from 20260801181116 VERBATIM, minus the two names — retyping
-- the rest risks silently reverting an entry.
CREATE OR REPLACE FUNCTION public.function_execute_leaks()
RETURNS TABLE(function_name text, role_name text)
LANGUAGE sql
STABLE
AS $$
  SELECT p.proname::text, r.rolname::text
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(rolname)
  WHERE n.nspname = 'public'
    -- SECURITY DEFINER only. An INVOKER function runs as the caller, so RLS and
    -- table grants still contain it and a browser grant is not a hole.
    AND p.prosecdef
    AND has_function_privilege(r.rolname, p.oid, 'EXECUTE')
    AND p.proname NOT IN (
      -- Named in an RLS policy: the browser cannot query the table without it.
      'company_can_write', 'get_operator_access_id', 'get_user_company_ids',
      'is_company_admin', 'is_system_admin',
      -- Called directly from application code (utils/*Access.ts, app/, hooks/).
      -- `enable_location_tracking` / `disable_location_tracking` were removed from
      -- this list in 20260802015101, with the functions themselves.
      'accept_invitation', 'add_stock_at_location', 'adjust_stock_at_location',
      'create_demo_company', 'create_shipment_with_line_items', 'delete_location',
      'deplete_stock_at_location', 'log_note_views', 'log_operator_event',
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
