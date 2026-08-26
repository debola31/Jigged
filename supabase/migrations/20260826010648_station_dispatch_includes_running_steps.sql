-- ═══════════════════════════════════════════════════════════════════════════════
-- A STEP WITH A TIMER RUNNING BELONGS ON ITS STATION'S DISPATCH LIST
-- ═══════════════════════════════════════════════════════════════════════════════
-- Observed in production 2026-08-25. J-0118 / OP 30 EDM had an interval open since
-- 3:01 PM. It showed on the office Still-running card and NOWHERE ELSE: not under
-- "My Station" at EDM, not under "Completed", not in "All Stations". The one step
-- on the floor that was actually running was the one step the floor could not see.
--
-- TWO CORRECT RULES COMPOSING INTO A WRONG ANSWER, which is why neither is at
-- fault on its own:
--
--   1. `job_operations.status` is DERIVED FROM RECORDED QUANTITY by
--      compute_job_operation_status -- `pending` until the first completion row.
--      So a step that has been started but has produced nothing yet is `pending`,
--      correctly: nothing has been produced.
--
--   2. get_ready_operations_for_station admits a `pending` step only when it is
--      SEQUENCE-READY (every lower-sequence step on its job_part completed).
--      Also correct: that is the dispatch list, and it lists what is next.
--
-- Starting, however, does NOT require sequence-readiness -- the traveler lets an
-- operator start any step, deliberately, because shops work out of order (see
-- job_operations.predecessors_incomplete, which warns and does not block). So the
-- start path admits a case the read path then hides. On J-0118 OP 10 PROGRAM and
-- OP 20 Harig Hogger were both still pending, so EDM was not sequence-ready, and
-- being `pending` it was not "in progress" either. It fell through both branches.
--
-- THE FIX IS TO ADD THE THIRD WAY A STEP CAN BE UNDER WAY. `status = 'in_progress'`
-- means "quantity has been recorded against it". An open interval means "somebody
-- is on it right now". Both are work in progress; only the first was represented.
--
-- WHY THIS MATTERS BEYOND ONE STALE ROW: the station list is the only surface that
-- can CLEAR one of these. close_operation_interval refuses a non-owner by design
-- (an unchecked id would let any member rewrite anyone's hours), so an interval
-- whose owner has gone home cannot be closed by the office at all. What CAN reach
-- it is start_operation_interval, which closes whatever holds the work centre's
-- chain slot as 'switched' -- the shift handoff, B starting on the machine A forgot
-- to close. That recovery path runs through the station list, and until now the
-- station list was the one place the forgotten interval did not appear.


-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. WHICH OPERATIONS AT A STATION HAVE A TIMER RUNNING
-- ═══════════════════════════════════════════════════════════════════════════════
-- SECURITY DEFINER, AND IT HAS TO BE. `job_operation_intervals` has exactly one
-- SELECT policy -- job_op_intervals_select_own, `operator_id = get_operator_
-- access_id(company_id)`. get_ready_operations_for_station is SECURITY INVOKER, so
-- an EXISTS written inline there would see the CALLER'S OWN intervals and no one
-- else's, which inverts the feature: the forgotten interval that needs finding is
-- by definition somebody else's. Reading past that policy is the point, so it is
-- done in one function, narrowly, rather than by loosening the policy.
--
-- IT RETURNS OPERATION IDS AND NOTHING ELSE. No operator_id, no started_at, no
-- duration, no count. "OP 30 at EDM is running" is a fact about a MACHINE; who is
-- on it and for how long is a different question that this function cannot answer
-- and that no function answers any more (get_operator_time_detail was dropped in
-- 20260825170421). That is what keeps this the same class of disclosure as the
-- office Still-running card and clear of
-- docs/modules/operator-view.md#surveillance-guardrail-non-negotiable.
--
-- Membership is RE-DERIVED from the JWT rather than trusted from p_company_id --
-- the house pattern for every SECURITY DEFINER reader here, and the only thing
-- standing between a caller and another company's rows once RLS is bypassed.
CREATE OR REPLACE FUNCTION public.get_running_operation_ids_for_station(
    p_company_id uuid,
    p_work_center_id uuid
)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT DISTINCT i.job_operation_id
    FROM public.job_operation_intervals i
   WHERE i.company_id = p_company_id
     AND i.work_center_id = p_work_center_id
     AND i.ended_at IS NULL
     AND i.voided_at IS NULL
     AND p_company_id IN (SELECT public.get_user_company_ids());
$$;

COMMENT ON FUNCTION public.get_running_operation_ids_for_station(uuid, uuid) IS
  'The job_operations at one work centre that have an interval still open — ids only, deliberately: no operator identity, no start time, no duration, no count. SECURITY DEFINER because job_op_intervals_select_own restricts SELECT to the caller''s own rows and the interval worth finding is somebody else''s. Called only from get_ready_operations_for_station, which is SECURITY INVOKER and therefore needs the browser to hold EXECUTE.';

-- The browser holds EXECUTE because its only caller runs as the caller -- the
-- next_order_number case, and section 4 records it on the leak allowlist.
-- `anon` is excluded: every operator route bounces to /login without a session
-- (app/operator/[companyId]/layout.tsx), so anon cannot reach the caller either.
REVOKE EXECUTE ON FUNCTION public.get_running_operation_ids_for_station(uuid, uuid)
  FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_running_operation_ids_for_station(uuid, uuid)
  TO authenticated, service_role;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. THE DISPATCH RPC LEARNS THE THIRD BRANCH
-- ═══════════════════════════════════════════════════════════════════════════════
-- DROP + CREATE rather than CREATE OR REPLACE: the RETURNS TABLE gains
-- has_open_interval, and Postgres refuses to replace a function whose return type
-- changed. That destroys the ACL and any COMMENT, so section 3 re-issues the
-- grants explicitly (CLAUDE.md's DROP FUNCTION rule) and this one adds the COMMENT
-- the function never had.
DROP FUNCTION IF EXISTS public.get_ready_operations_for_station(uuid, uuid);

CREATE FUNCTION public.get_ready_operations_for_station(
    p_company_id uuid,
    p_work_center_id uuid
)
RETURNS TABLE(
    job_id uuid,
    job_part_id uuid,
    job_operation_id uuid,
    operation_name text,
    op_status text,
    job_number text,
    part_id uuid,
    part_name text,
    part_description text,
    part_quantity numeric,
    is_hot boolean,
    -- NEW. True when a timer is open on this step at this station. The card reads
    -- it to mark the row, and WITHOUT the mark the row is worse than absent: an
    -- out-of-sequence step appearing under EDM with no explanation reads as the
    -- dispatch list being wrong.
    has_open_interval boolean
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    WITH running_ops AS (
        -- Evaluated once. The set is tiny (open intervals at ONE work centre --
        -- normally zero or one, since the chain allows one per machine) and this
        -- keeps the SECURITY DEFINER hop out of the per-row path.
        SELECT public.get_running_operation_ids_for_station(
                   p_company_id, p_work_center_id) AS job_operation_id
    ),
    eligible_jobs AS (
        SELECT j.id, j.job_number, j.is_hot FROM jobs j
        WHERE j.company_id = p_company_id
          AND j.production_status IN ('not_started', 'in_progress')
    ),
    station_ops AS (
        SELECT jo.id, jo.job_id, jo.job_part_id, jo.operation_name, jo.status, jo.sequence,
               ej.job_number, ej.is_hot
        FROM job_operations jo
        JOIN eligible_jobs ej ON ej.id = jo.job_id
        WHERE jo.work_center_id = p_work_center_id
          AND jo.status IN ('pending', 'in_progress')
    ),
    ready_or_active AS (
        SELECT so.id, so.job_id, so.job_part_id, so.operation_name, so.status,
               so.job_number, so.is_hot,
               (so.id IN (SELECT r.job_operation_id FROM running_ops r)) AS has_open_interval
        FROM station_ops so
        WHERE so.status = 'in_progress'
           -- THE NEW BRANCH. Sequence-readiness is not consulted: a step somebody
           -- is standing at is under way whatever the steps before it say, and
           -- hiding it is what stranded J-0118.
           OR so.id IN (SELECT r.job_operation_id FROM running_ops r)
           OR NOT EXISTS (
               SELECT 1 FROM job_operations prev
               WHERE prev.job_part_id = so.job_part_id
                 AND prev.sequence < so.sequence
                 AND prev.status <> 'completed'
           )
    )
    SELECT
        ra.job_id,
        ra.job_part_id,
        ra.id AS job_operation_id,
        ra.operation_name,
        ra.status AS op_status,
        ra.job_number,
        jp.part_id,
        p.part_name,
        p.description AS part_description,
        jp.quantity AS part_quantity,
        ra.is_hot,
        ra.has_open_interval
    FROM ready_or_active ra
    JOIN job_parts jp ON jp.id = ra.job_part_id
    JOIN parts p ON p.id = jp.part_id
    -- Hot jobs to the top, unchanged -- the rush marker outranks everything and
    -- that contract is not being renegotiated here. Running next: of the work that
    -- is merely ready, the step a machine is already turning is the one an operator
    -- walking up to this station has to deal with first, and on a busy station it
    -- would otherwise sort by job number into the middle of the pile. job_number
    -- still breaks the remaining ties, so the order stays deterministic.
    ORDER BY ra.is_hot DESC, ra.has_open_interval DESC, ra.job_number;
END;
$$;

COMMENT ON FUNCTION public.get_ready_operations_for_station(uuid, uuid) IS
  'The dispatch list for one station: steps that are sequence-ready, have quantity recorded against them, or have a timer still open. The third branch was added 20260826010648 — op status derives from recorded quantity, so a started-but-nothing-produced step reads `pending`, and if it is also out of sequence it fell through every branch and appeared on no operator surface at all. SECURITY INVOKER: company isolation is RLS on jobs/job_operations, not the p_company_id argument.';


-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. RE-ISSUE THE GRANTS THE DROP DESTROYED
-- ═══════════════════════════════════════════════════════════════════════════════
-- The dropped function's ACL was `anon=X | authenticated=X | service_role=X` plus
-- PUBLIC, all of it inherited from the ALTER DEFAULT PRIVILEGES that 20260801024552
-- revoked for future functions. Re-granting is not optional -- without these lines
-- the browser keeps EXECUTE only via PUBLIC's built-in default, which is exactly
-- the implicit reachability this schema has been moving away from.
--
-- `anon` IS DELIBERATELY NOT RE-GRANTED, and that is a real (if inert) narrowing
-- rather than an oversight. The function is SECURITY INVOKER, so an anon caller
-- reads jobs/job_operations under anon's RLS and gets zero rows; and no anon caller
-- exists, because the operator layout redirects to /login without a session. If a
-- public read-only station board is ever built, grant it back here on purpose.
REVOKE EXECUTE ON FUNCTION public.get_ready_operations_for_station(uuid, uuid)
  FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_ready_operations_for_station(uuid, uuid)
  TO authenticated, service_role;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. THE LEAK ALLOWLIST
-- ═══════════════════════════════════════════════════════════════════════════════
-- REBUILT FROM 20260825170421, THE NEWEST DEFINITION, NOT FROM THE MIGRATION THAT
-- CREATED THIS FUNCTION. Restating an older body silently reverts every entry added
-- between the two -- this list has been reverted that way before, and re-adding
-- get_operator_time_detail (dropped yesterday) would be the exact repeat.
--
-- ONE EDIT: 'get_running_operation_ids_for_station' joins the next_order_number
-- group. Same shape, same reason -- a browser-callable SECURITY INVOKER function
-- (get_ready_operations_for_station) calls it, and a SECURITY INVOKER function runs
-- as its caller, so the browser genuinely needs EXECUTE on the callee. The browser
-- can also call it directly, which is why what it returns was kept to bare ids.
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
      -- (get_ready_operations_for_station -> get_running_operation_ids_for_station,
      --  added 20260826010648)
      'next_order_number', 'get_running_operation_ids_for_station'
    )
  ORDER BY 1, 2;
$$;
-- CREATE OR REPLACE keeps the pg_proc OID, so the COMMENT and the ACL survive and
-- the DROP-FUNCTION rule does not bite. Re-issued anyway, for the reason
-- 20260825170421 gives: if anyone later "tidies" this into DROP + CREATE, the
-- REVOKE evaporates and the leak guard itself becomes browser-callable -- and it
-- would not report itself, being SECURITY INVOKER and outside its own prosecdef
-- filter. Two free statements remove the trap.
COMMENT ON FUNCTION public.function_execute_leaks() IS
  'Lists SECURITY DEFINER functions in public that a browser role can execute and that are not on the reviewed allowlist. Must always be empty. Exists because the ON FUNCTIONS default privileges auto-granted every new function to anon/authenticated, making the REVOKE ... FROM PUBLIC idiom used across this schema ineffective (issue #640) — and because over-granting is silent, so only a test finds it. To add a function here, say in the PR why the browser needs to call it.';

REVOKE EXECUTE ON FUNCTION public.function_execute_leaks()
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.function_execute_leaks() TO service_role;


-- ═══════════════════════════════════════════════════════════════════════════════
-- What this migration deliberately does NOT widen
-- ═══════════════════════════════════════════════════════════════════════════════
-- Two filters upstream of the new branch are left alone, and both can still strand
-- an interval. Naming them is the point -- each is a real hole, and each would cost
-- more than it fixes if closed here:
--
--   * `eligible_jobs` still requires jobs.production_status IN ('not_started',
--     'in_progress'). An interval left open on a job somebody then CANCELLED stays
--     invisible to the station list. Admitting cancelled jobs would put dead work
--     on the dispatch list for every operator, every day, to reach a case that
--     needs an office decision anyway.
--
--   * `station_ops` still requires job_operations.status IN ('pending',
--     'in_progress'). An office-side completion sets a step to `completed` WITHOUT
--     closing any interval on it, so that combination strands one too. It belongs
--     on the "Completed" list, not the active one, and wiring it there is a
--     different change with a different UI.
--
-- Both remain visible on the office Still-running card, which is the surface that
-- exists to notice them. Neither has been observed in production.
