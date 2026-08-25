-- Drop the per-person recorded-time reporting path: get_operator_time_detail()
-- and the operator_time_access_log it wrote to.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- WHAT THESE WERE
-- ═══════════════════════════════════════════════════════════════════════════════
-- 20260816203641 shipped time capture with "aggregate by default" enforced in the
-- SCHEMA rather than the UI: there is no admin SELECT policy on
-- job_operation_intervals, because a row-returning policy exposing operator_id
-- would BE a per-person report -- PostgREST hands the caller the grouping for
-- free. Every office reader (get_operation_actuals, get_open_intervals) returns
-- no identity.
--
-- get_operator_time_detail() was the deliberate exception: the one function that
-- resolved recorded time to a NAMED person. It was admin-gated, refused a blank
-- reason, and wrote an operator_time_access_log row BEFORE returning anything, so
-- a failure partway through could not yield an unlogged look. That migration
-- argued it should ship pre-emptively -- "an owner who cannot get this number AT
-- ALL will ask for a permissive view of the underlying table, and that request is
-- much harder to refuse than to pre-empt."
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- WHY THEY GO
-- ═══════════════════════════════════════════════════════════════════════════════
-- The narrow door was built to keep the wide one shut. Removing it does not open
-- the wide one: the absence of an admin SELECT policy is unchanged, and that is
-- what was ever load-bearing. What is left is the stronger claim -- there is no
-- route from the office to a named person's hours at all, logged or otherwise.
--
-- The audit log goes with it because it was write-only. The ONLY writer was the
-- INSERT inside get_operator_time_detail, and nothing ever read the table: no
-- RPC, no policy (it had none), no access layer, no route, no test, no surface.
-- The deterrent was a sentence of dialog copy, not a trail anyone could review.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- WHAT DOES NOT CHANGE, and this is the part to check before editing
-- ═══════════════════════════════════════════════════════════════════════════════
-- job_operation_intervals.operator_id STAYS. It is not a reporting column; it is
-- three structural things at once:
--   * the RLS key for the operator's own rows -- job_op_intervals_select_own and
--     job_op_intervals_update_own both read
--     `operator_id = get_operator_access_id(company_id)`;
--   * the ownership assertion inside close_operation_interval, which is what
--     stops one member rewriting another's recorded hours with RLS bypassed;
--   * the serialization key for the ad-hoc chain -- job_op_intervals_one_open_adhoc,
--     the partial unique index that stands in for work_center_id when an
--     operation has no machine to chain on.
-- Dropping it would silently break the operator's own view, which is the surface
-- the no-gamification rule exists to protect. Removing the OFFICE's read is not
-- the same act as removing the WORKER's.
--
-- start_operation_interval, close_operation_interval, get_operation_actuals and
-- get_open_intervals are untouched.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- DATA AT REST
-- ═══════════════════════════════════════════════════════════════════════════════
-- Production holds ZERO rows in operator_time_access_log (checked before writing
-- this, along with job_operation_intervals, which is also empty -- the feature
-- has never been used in prod). Nothing is destroyed. Stated rather than assumed,
-- because a DROP TABLE is otherwise the one statement here that could lose data.
--
-- No backfill, no UPDATE, no data-dependent DDL: every statement below succeeds
-- independent of row count, and the table has no inbound FK. So the pre-merge
-- gate replaying on an EMPTY database is a faithful proxy here -- unlike a
-- backfill, whose first real run is always production.


-- ---------------------------------------------------------------------------
-- 1. The function, BEFORE the table it writes to.
-- ---------------------------------------------------------------------------
-- The order is deliberate and Postgres will NOT enforce it for us. A plpgsql body
-- is not parsed at CREATE time, so pg_depend records no dependency from this
-- function to operator_time_access_log: DROP TABLE alone would succeed and leave
-- a function that raises `relation "operator_time_access_log" does not exist` on
-- its next call -- a break only a caller can find. Dropping the writer first
-- means the writer never outlives its target.
--
-- Argument types are named: without them Postgres errors on an overload, and
-- naming them means a future overload cannot be dropped by accident.
--
-- The ACL (GRANT EXECUTE ... TO authenticated, service_role) and the COMMENT go
-- with it. The "a DROP FUNCTION destroys both the ACL and the COMMENT" rule
-- requires re-issuing them only when a migration drops AND RECREATES; this one
-- does not recreate, so their destruction is the intended outcome.
DROP FUNCTION IF EXISTS public.get_operator_time_detail(uuid, uuid, text);


-- ---------------------------------------------------------------------------
-- 2. The table. Its index, its RLS flag and its grants go with it.
-- ---------------------------------------------------------------------------
-- Nothing depends on it, checked rather than assumed:
--   * no inbound FK -- its three FKs are all OUTBOUND (companies,
--     user_company_access twice), and DROP TABLE simply removes them;
--   * no policies at all. RLS was enabled with NONE, which is what actually
--     denied every role that was not service_role;
--   * no triggers, and no billing-gate trigger in particular:
--     apply_billing_write_gate() was never called on it, so there is no
--     gate_key_immutable trigger and no billing_gate_* policy to unwind;
--   * idx_operator_time_access_log_company is dropped with the table.
--
-- RESTRICT is the default and is left as the default. CASCADE would silently take
-- anything that grew a dependency since this was written; RESTRICT turns that
-- into an error somebody reads.
DROP TABLE IF EXISTS public.operator_time_access_log;


-- ---------------------------------------------------------------------------
-- 3. The CI EXECUTE allowlist.
-- ---------------------------------------------------------------------------
-- RESTATED FROM THE NEWEST DEFINITION, which is
-- 20260816203641_job_operation_intervals.sql -- NOT 20260801024552, which created
-- it. Eight migrations have amended this list, and CREATE OR REPLACE takes the
-- whole body, so rebasing from the original silently deletes every entry added
-- since. That file's own WARNING records it happening: its first draft dropped
-- bulk_put_away, mark_reactions_seen, create_location_tree and
-- apply_location_layout, and resurrected two names 20260802015101 had removed.
-- The failure is invisible in review and shows up only as a red test.
--
-- This body was extracted programmatically from 20260816203641 rather than
-- retyped, and verified against the LIVE production definition (prod is at
-- 20260824221219, after both amendments) before writing.
--
-- RE-CHECK BEFORE MERGE, not just at authoring time. 20260818142814 documents the
-- same trap firing in the opposite direction: it rebased correctly when written,
-- main then merged #769, and because 20260818142814 had the later timestamp its
-- now-stale body overwrote theirs. Main moves underneath you. Confirm with
--   SELECT pg_get_functiondef('public.function_execute_leaks()'::regprocedure);
-- against a database carrying every prior migration, and diff.
--
-- ONE EDIT: 'get_operator_time_detail' is removed from the group of five. The
-- other four interval functions stay -- they survive and are still
-- browser-callable for the reasons 20260816203641 gives.
--
-- NOTE that the paragraph in 20260816203641 justifying all five entries is now
-- partly stale AS HISTORY, and is deliberately not edited. Migrations are an
-- executable log: that entry records why the function was worth allowlisting,
-- and this file records why it stopped being.
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
      -- Added 20260816203641: operator cycle-time capture. That migration added
      -- FIVE; get_operator_time_detail was the fifth and is dropped in section 1
      -- above, so it leaves this list here for the subdivide_location reason --
      -- an allowlist naming functions that no longer exist is how the list rots.
      'start_operation_interval', 'close_operation_interval',
      'get_operation_actuals', 'get_open_intervals',
      -- Called BY a browser-callable SECURITY INVOKER function, which runs as the
      -- caller — so the caller genuinely needs EXECUTE on this one.
      -- (generate_quote_number / generate_direct_job_number -> next_order_number)
      'next_order_number'
    )
  ORDER BY 1, 2;
$$;
-- CREATE OR REPLACE keeps the pg_proc OID, so the COMMENT and the ACL survive and
-- the DROP-FUNCTION rule does not bite. Re-issued anyway, because the trap it
-- guards is real and specific: if anyone later "tidies" this into DROP + CREATE,
-- the REVOKE evaporates and the leak guard itself becomes browser-callable -- and
-- it would not report itself, being SECURITY INVOKER and therefore outside its
-- own p.prosecdef filter. Two free statements remove the trap.
COMMENT ON FUNCTION public.function_execute_leaks() IS
  'Lists SECURITY DEFINER functions in public that a browser role can execute and that are not on the reviewed allowlist. Must always be empty. Exists because the ON FUNCTIONS default privileges auto-granted every new function to anon/authenticated, making the REVOKE ... FROM PUBLIC idiom used across this schema ineffective (issue #640) — and because over-granting is silent, so only a test finds it. To add a function here, say in the PR why the browser needs to call it.';

REVOKE EXECUTE ON FUNCTION public.function_execute_leaks()
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.function_execute_leaks() TO service_role;


-- ---------------------------------------------------------------------------
-- 4. The billing-gate exempt list.
-- ---------------------------------------------------------------------------
-- RESTATED FROM THE NEWEST DEFINITION, which is
-- 20260818142814_terms_acceptances.sql -- NOT 20260816203641, and NOT
-- 20260726033616, which created it. Six migrations have amended it. Same warning
-- as section 3, same pre-merge re-check, and this body was likewise extracted
-- programmatically and verified against the live production definition.
--
-- ONE EDIT: 'operator_time_access_log' and its justification are removed, because
-- the TABLE is dropped in section 2. 'terms_acceptances' -- the entry
-- 20260818142814 added -- stays.
--
-- A stale name here would be inert rather than wrong: the clause is
-- `relname NOT IN (...)` matched against pg_class, so a name with no table behind
-- it excludes nothing. It is removed for reviewability, not correctness -- an
-- exempt list naming tables that do not exist is a list a reviewer stops reading,
-- and this list is the only thing standing between a new tenant table and a
-- silent billing bypass.
CREATE OR REPLACE FUNCTION public.tenant_tables_missing_write_gate()
RETURNS TABLE(table_name text)
LANGUAGE sql
STABLE
AS $$
  SELECT c.relname::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a
    ON a.attrelid = c.oid AND a.attname = 'company_id' AND NOT a.attisdropped
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname NOT IN (
      -- identity / bootstrap (gating would block signup / team / preferences)
      'companies', 'user_company_access', 'user_preferences', 'system_admins',
      'invitations', 'demo_data_templates', 'waitlist', 'saved_insights', 'feedback',
      'company_billing',
      -- service-role-only / SELECT-only (writes never come from the browser).
      -- `part_location_stock` was removed from this list in 20260801150944: its
      -- writes DO come from the browser, through SECURITY DEFINER RPCs, and the
      -- exemption was what hid issue #645.
      'auth_audit_log', 'job_fulfillment_audit',
      'company_order_counters', 'quickbooks_connections', 'quickbooks_customer_map',
      'quickbooks_invoice_links', 'quickbooks_invoice_line_items',
      'quickbooks_desktop_connections', 'quickbooks_terms_cache',
      -- SECURITY DEFINER-only writers; see 20260728040701
      'note_views', 'operator_events',
      -- `operator_time_access_log` stood HERE, added 20260816203641 and carried
      -- forward by 20260818142814. The table is dropped in section 2 above, so
      -- the entry goes with it. job_operation_intervals is unaffected: it IS
      -- gated (apply_billing_write_gate, 20260816203641), so it is satisfied by
      -- the policy-existence check below and never by this list.
      -- Append-only legal record, service-role write only; see section 6 above
      'terms_acceptances'
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_policies p
      WHERE p.schemaname = 'public'
        AND p.tablename = c.relname
        AND p.policyname = 'billing_gate_insert'
    )
  ORDER BY 1;
$$;
COMMENT ON FUNCTION public.tenant_tables_missing_write_gate() IS
  'Lists public tables with a company_id column that are neither billing-gated nor exempt. A CI test asserts this returns no rows, so a new tenant table left un-gated fails the build instead of silently bypassing billing.';

GRANT EXECUTE ON FUNCTION public.tenant_tables_missing_write_gate() TO service_role;


-- ---------------------------------------------------------------------------
-- 5. definer_writers_missing_write_gate() is DELIBERATELY NOT TOUCHED.
-- ---------------------------------------------------------------------------
-- Recorded because "the third guard was left alone" is indistinguishable from
-- "the third guard was forgotten" six months from now.
--
-- Its newest body is 20260819012414_drop_part_is_stocked.sql. Two checks, both
-- negative:
--
--   1. Its exempt list does not name anything dropped here. The interval entry is
--      'void_intervals_with_completion', an AFTER UPDATE trigger function on
--      job_operation_completions, which SURVIVES.
--   2. get_operator_time_detail was never in its OUTPUT to begin with. That guard
--      matches definer function bodies writing to tables carrying a
--      billing_gate_insert policy. operator_time_access_log had no such policy --
--      section 4 above is precisely the record of it being exempt -- so it never
--      entered the gated set, and this function's only write targeted it.
--      Dropping a definer function can shrink that guard's output or leave it
--      unchanged; it cannot grow it.
--
-- Restating it would re-run the rebase hazard section 3 describes, for no gain.
-- test_no_definer_function_walks_past_the_gate asserts it green, which is how we
-- find out if this reasoning is wrong.


-- ---------------------------------------------------------------------------
-- 6. Comments on SURVIVING objects whose text this migration falsified.
-- ---------------------------------------------------------------------------
-- Four COMMENTs in 20260816203641 describe the dropped objects. Two vanish on
-- their own -- COMMENT ON FUNCTION get_operator_time_detail and COMMENT ON TABLE
-- operator_time_access_log die with the objects they describe.
--
-- These two do NOT. They sit on objects that survive and cite a function that no
-- longer exists. A comment that is merely out of date is worse than none: the
-- second is exactly what a future reader consults while deciding whether
-- operator_id is still load-bearing, and the honest answer changed DIRECTION
-- rather than disappearing -- it is more load-bearing now, not less.
COMMENT ON FUNCTION public.get_open_intervals(uuid) IS
  'Admin-only list of intervals that are still open, oldest first — the forgotten-stop detection channel, and the only route to an interval whose owner has gone home (close_operation_interval refuses a non-owner by design). Carries no operator identity, and as of 20260825170421 NOTHING does: get_operator_time_detail, the one path that resolved an interval to a named person, is dropped. An open interval is a fact about a machine.';

COMMENT ON COLUMN public.job_operation_intervals.operator_id IS
  'Who was on it. An ATTRIBUTE, never the chain key — see the table comment. STRUCTURAL, not reporting: the RLS key for the operator''s own rows (job_op_intervals_select_own / job_op_intervals_update_own), the ownership assertion inside close_operation_interval, and the serialization key for the ad-hoc chain (job_op_intervals_one_open_adhoc, which stands in for work_center_id when an operation has no machine). No path returns it to the office: get_operator_time_detail was dropped in 20260825170421, there is still no admin SELECT policy on this table, and every aggregate reader omits it. Do not add one back without re-reading docs/modules/operator-view.md#surveillance-guardrail-non-negotiable.';


-- ═══════════════════════════════════════════════════════════════════════════════
-- Reversibility (documentation -- the branching pipeline is forward-only)
-- ═══════════════════════════════════════════════════════════════════════════════
-- The DDL is reversible: re-run 20260816203641's CREATE TABLE + index for
-- operator_time_access_log, its grants (REVOKE ALL FROM anon, authenticated;
-- GRANT SELECT, INSERT TO service_role; ENABLE ROW LEVEL SECURITY), section 6e
-- (get_operator_time_detail and its COMMENT), the two EXECUTE lines from its
-- section 7, and re-add both names to the two guards restated above.
--
-- If it is ever recreated, add a REVOKE from jigged_ai_readonly: the baseline's
-- ALTER DEFAULT PRIVILEGES grants SELECT on every new public table, and
-- 20260816203641 never revoked it -- RLS-with-no-policy is what kept the table
-- unreachable. Dropping it now closes that gap along with the table.
--
-- The ROWS would not come back, but there are none: production holds zero.
