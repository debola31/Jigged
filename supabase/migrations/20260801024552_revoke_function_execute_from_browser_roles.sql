-- Make `REVOKE EXECUTE ... FROM PUBLIC` mean what eight migrations already think
-- it means. Issue #640.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- THE BUG
-- ═══════════════════════════════════════════════════════════════════════════════
-- Two independent things grant EXECUTE on a newly created function:
--
--   1. Postgres' own built-in default — every function is executable by PUBLIC.
--   2. THIS schema's default privileges, which still say
--        ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--          GRANT ALL ON FUNCTIONS TO anon;
--          ... TO authenticated;
--      so every new function ALSO lands with an EXPLICIT grant to both browser
--      roles.
--
-- `REVOKE EXECUTE ... FROM PUBLIC` removes (1) and leaves (2) completely intact.
-- It is the ACL equivalent of striking somebody off the all-staff mailing list
-- while they still hold a personal invitation.
--
-- Eight migrations use exactly that idiom and state in their comments that the
-- function is service-role-only. None of them is. The clearest example is
-- viewer_excluded_from_metrics, whose own comment reads "Not granted to
-- authenticated: ... Granting it would hand the browser a per-member probe."
-- It was granted to authenticated the whole time.
--
-- 20260716025048 fixed precisely this for TABLES (it is why `notes` still carried
-- a browser TRUNCATE until 20260801012019). It never touched FUNCTIONS.
--
-- NOTHING LEAKS TODAY — every affected function was checked, and each is either
-- SECURITY INVOKER (so RLS still contains it), already deliberately granted to
-- authenticated, or returns nothing an anonymous caller could use. This migration
-- is about the NEXT function: SECURITY DEFINER is precisely where the sensitive
-- logic lives, because that is why those functions bypass RLS, and the grant is
-- then the only thing between the browser and the data.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. STOP THE BLEEDING: the default itself
-- ═══════════════════════════════════════════════════════════════════════════════
-- ALTER DEFAULT PRIVILEGES IS NOT RETROACTIVE (20260716025048 says the same about
-- its own change). So this line changes NOTHING about the 130 functions that
-- already exist — it only stops the next one being auto-granted. That is what
-- makes it the safe half of this migration, and it is also what makes section 2
-- necessary rather than redundant.
--
-- After this, a new function in public is reachable only by PUBLIC's built-in
-- default, so the familiar `REVOKE ... FROM PUBLIC` finally does close it — and a
-- function that genuinely needs the browser must say so with an explicit GRANT.
-- Same discipline #406 introduced for tables.
--
-- The ACLs, measured, are the clearest way to see what changes:
--
--   before   {=X/postgres, postgres=X, anon=X, authenticated=X, service_role=X}
--   after    {=X/postgres, postgres=X,                          service_role=X}
--
-- Only the leading `=X` (PUBLIC) is left, and that is the entry the standard
-- idiom removes. NOTE that `has_function_privilege('authenticated', ...)` still
-- returns true on a fresh function afterwards — authenticated is a MEMBER of
-- PUBLIC — so the guard in section 3 will flag any new SECURITY DEFINER function
-- until its author either revokes from PUBLIC or allowlists it deliberately.
-- That is the intended outcome, not noise: both are a decision someone has to
-- make on purpose and defend in review.
--
-- FOR ROLE postgres only, matching 20260716025048's scope. Objects created by
-- supabase_admin (the platform's own migrations, not ours) carry a separate
-- default that we neither own nor should fight; ours all run as postgres.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. CLOSE THE EXISTING ONES THAT NEVER NEEDED BROWSER ACCESS
-- ═══════════════════════════════════════════════════════════════════════════════
-- 36 SECURITY DEFINER functions in public are currently browser-executable. Each
-- was classified by EVIDENCE, not by taste — is it named in an RLS policy, called
-- from application code, or called by a browser-callable SECURITY INVOKER
-- function? 21 had at least one such reason and are deliberately left alone. The
-- 15 below had none.
--
-- TWO ASSUMPTIONS UNDERPIN THIS, AND BOTH WERE TESTED RATHER THAN ASSUMED
-- (see api/tests/integration/test_function_execute_grants.py):
--
--   A. A TRIGGER function needs no EXECUTE from the writing role. Permission is
--      checked when the trigger is CREATED, not each time it fires. Verified by
--      revoking notes_validate_subject and then INSERTing a note as
--      `authenticated` — the insert succeeded.
--   B. A function called only from SECURITY DEFINER parents needs no EXECUTE from
--      the browser, because the parent body runs as the function owner. Verified
--      by revoking viewer_excluded_from_metrics and then calling log_note_views
--      as `authenticated` — it still ran and still moved the counter.
--
-- REVOKE names the roles explicitly rather than relying on FROM PUBLIC. That is
-- the entire point of this migration; do not "tidy" these back to FROM PUBLIC.

-- ── 2a. Trigger functions (9) — invoked by the trigger machinery, never called ──
REVOKE EXECUTE ON FUNCTION public.auto_track_stocked_part()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_tracked_part_quantity()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.note_views_bump_counts()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notes_validate_subject()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recompute_part_quantity_from_locations()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.snapshot_document_party()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.snapshot_shipment_party()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.snapshot_transaction_location_name()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.user_company_access_fill_email()
  FROM PUBLIC, anon, authenticated;

-- ── 2b. Event-trigger function ────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable()
  FROM PUBLIC, anon, authenticated;

-- ── 2c. Internal helpers, reachable only through SECURITY DEFINER parents ─────
-- inv_* are called by add/adjust/deplete/transfer_stock and enable_location_tracking;
-- seed_demo_data by create_demo_company and reset_demo_company; and
-- viewer_excluded_from_metrics only from inside log_note_views. Every one of those
-- parents is SECURITY DEFINER and stays granted, so the call chains are unaffected.
REVOKE EXECUTE ON FUNCTION public.inv_assert_location_in_company(p_location_id uuid, p_company_id uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.inv_get_or_create_unassigned(p_company_id uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.inv_location_path_label(p_location_id uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.seed_demo_data(p_company_id uuid, p_user_id uuid, p_template_name text)
  FROM PUBLIC, anon, authenticated;

-- THE ONE THIS ISSUE WAS FOUND THROUGH. Its comment has claimed since
-- 20260728040701 that it is not granted to authenticated, because a per-member
-- "is this account excluded from metrics" probe is exactly the shape of thing the
-- note_views design refuses. The claim is finally true.
REVOKE EXECUTE ON FUNCTION public.viewer_excluded_from_metrics(p_access_id uuid)
  FROM PUBLIC, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. THE DURABLE HALF
-- ═══════════════════════════════════════════════════════════════════════════════
-- Sections 1 and 2 fix today. This is what stops it coming back, and it is the
-- part that actually matters: over-granting is SILENT. It produces no error, no
-- broken page, no symptom of any kind — you find it only by looking, and nobody
-- looks. part_playbook_notes sat anon-executable for three days after a
-- DROP FUNCTION destroyed its ACL and would have sat there indefinitely.
--
-- Same idiom as tenant_tables_missing_write_gate() and no_client_access_grant_leaks():
-- rows mean something is wrong, and a CI test asserts there are none. The
-- allowlist is the reviewable record of a deliberate decision — adding a function
-- to it should require saying why in the PR.

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
