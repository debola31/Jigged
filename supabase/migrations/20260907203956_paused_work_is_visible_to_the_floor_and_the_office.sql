-- ═══════════════════════════════════════════════════════════════════════════════
-- PAUSED WORK IS VISIBLE — TO THE FLOOR AND TO THE OFFICE
-- ═══════════════════════════════════════════════════════════════════════════════
-- 20260907203755 gave the operator a Pause. On its own that ships a hole this repo
-- has already fallen into once, so this migration is not optional polish -- it is
-- the other half.
--
-- THE HOLE, WHICH IS 20260826010648 EXACTLY. That migration was written after
-- J-0118 / OP 30 EDM sat with an interval open since 3:01 PM, showed on the office
-- card, and appeared on NO operator surface at all. The cause: op status derives
-- from recorded QUANTITY, so a started-but-nothing-produced step reads `pending`,
-- and the dispatch list admitted a `pending` step only when it was sequence-ready.
-- Two correct rules composed into a wrong answer.
--
-- A PAUSED STEP COMPOSES THE SAME WRONG ANSWER. It has produced nothing, so it is
-- `pending`. Its interval is CLOSED, so the has_open_interval branch does not catch
-- it. If it is also out of sequence it satisfies none of the three branches and
-- vanishes -- and unlike the J-0118 case it would vanish having been made invisible
-- by a control we just shipped. So: a fourth branch.
--
-- WHAT THE MARK MAY CARRY, which is the same rule 20260826010648 set and it has not
-- moved. get_ready_operations_for_station is SECURITY INVOKER and
-- job_op_intervals_select_own scopes the interval table to the caller's OWN rows,
-- so the fact has to come through a SECURITY DEFINER helper. That helper returns
-- OPERATION IDS AND NOTHING ELSE -- no operator_id, no timestamp, no elapsed
-- figure. "OP 30 at EDM is paused" is a fact about a machine, the same class of
-- disclosure as "OP 30 at EDM is running", and the only form that stays clear of
-- docs/modules/operator-view.md#surveillance-guardrail-non-negotiable.
--
-- THE ESTIMATE SPLIT, and it is deliberate rather than an oversight to tidy up
-- later. get_paused_operations and get_open_intervals (office, admin-gated) return
-- `expected_minutes`; get_my_paused_operations (the operator's own) does NOT, and
-- must not. The guardrail calls hiding the estimate from a running step "the
-- load-bearing half ... the half that must not move": beside a live counter an
-- estimate is a target, and a badge DERIVED from it is that comparison wearing a
-- hat. The office needs the relative signal to spot an overrun; the operator needs
-- an absolute one to spot a forgotten timer. Enforcing it in the RETURNS TABLE
-- means a future component cannot reach the number by accident.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ── 1. THE STATION HELPER — IDS AND NOTHING ELSE ─────────────────────────────
-- Sibling of get_running_operation_ids_for_station (20260826010648), same shape
-- for the same reason.
--
-- "Paused" is defined as NO OPEN INTERVAL and a latest closed span of 'paused',
-- rather than "any paused span exists". A step paused at 10:00 and resumed at 10:20
-- has a paused span forever, and marking it paused while it is running would be a
-- lie the operator can see. The no-open-interval half is belt-and-braces on a
-- work-centre chain (one open per machine makes it redundant) but NOT on an ad-hoc
-- operation, where the chain keys per operator and two people can hold open spans
-- on the same step.
CREATE OR REPLACE FUNCTION public.get_paused_operation_ids_for_station(
    p_company_id uuid,
    p_work_center_id uuid
)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT i.job_operation_id
    FROM public.job_operation_intervals i
   WHERE i.company_id = p_company_id
     AND i.work_center_id = p_work_center_id
     AND i.voided_at IS NULL
     AND p_company_id IN (SELECT public.get_user_company_ids())
     AND NOT EXISTS (
           SELECT 1 FROM public.job_operation_intervals o
            WHERE o.job_operation_id = i.job_operation_id
              AND o.ended_at IS NULL
              AND o.voided_at IS NULL
         )
   GROUP BY i.job_operation_id
  HAVING (array_agg(i.close_reason ORDER BY i.ended_at DESC))[1] = 'paused';
$$;

COMMENT ON FUNCTION public.get_paused_operation_ids_for_station(uuid, uuid) IS
  'Operation ids at one work centre whose latest recorded span was paused and that have no span running now. IDS AND NOTHING ELSE, exactly like get_running_operation_ids_for_station: no operator_id, no timestamp, no elapsed figure. It exists because get_ready_operations_for_station is SECURITY INVOKER and job_op_intervals_select_own scopes the table to own rows, so the dispatch list cannot see a colleague''s pause without a definer hop. Added 20260907203956 so a paused step cannot fall off every operator surface the way J-0118 did — see the migration header.';

REVOKE EXECUTE ON FUNCTION public.get_paused_operation_ids_for_station(uuid, uuid)
  FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_paused_operation_ids_for_station(uuid, uuid)
  TO authenticated, service_role;


-- ── 2. THE FOURTH BRANCH ─────────────────────────────────────────────────────
-- Rebuilt from 20260906151902, the newest definition -- NOT from 20260826010648,
-- whose copy still names jobs.is_hot in the ORDER BY. has_paused_interval joins
-- the RETURNS TABLE, and Postgres refuses to replace a function whose return type
-- changed, so this is DROP + CREATE. That destroys BOTH the ACL and the COMMENT
-- (CLAUDE.md), and §2b re-issues both.
--
-- function_execute_leaks() IS restated in this migration, but not because of THIS
-- function -- it is SECURITY INVOKER and has never been on that list. §4 restates
-- it for the two new DEFINER functions.
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
    has_open_interval boolean,
    -- NEW. True when the latest span on this step was paused and nothing is
    -- running on it now. Same contract as has_open_interval: the card marks the
    -- row, and without the mark an out-of-sequence step appearing under EDM with
    -- no explanation reads as the dispatch list being wrong.
    has_paused_interval boolean
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
    paused_ops AS (
        -- Same treatment, and the set is larger but still bounded by the steps
        -- ever paused at this one station.
        SELECT public.get_paused_operation_ids_for_station(
                   p_company_id, p_work_center_id) AS job_operation_id
    ),
    eligible_jobs AS (
        SELECT j.id, j.job_number FROM jobs j
        WHERE j.company_id = p_company_id
          AND j.production_status IN ('not_started', 'in_progress')
    ),
    station_ops AS (
        SELECT jo.id, jo.job_id, jo.job_part_id, jo.operation_name, jo.status, jo.sequence,
               ej.job_number
        FROM job_operations jo
        JOIN eligible_jobs ej ON ej.id = jo.job_id
        WHERE jo.work_center_id = p_work_center_id
          AND jo.status IN ('pending', 'in_progress')
    ),
    ready_or_active AS (
        SELECT so.id, so.job_id, so.job_part_id, so.operation_name, so.status,
               so.job_number,
               (so.id IN (SELECT r.job_operation_id FROM running_ops r)) AS has_open_interval,
               (so.id IN (SELECT pa.job_operation_id FROM paused_ops pa)) AS has_paused_interval
        FROM station_ops so
        WHERE so.status = 'in_progress'
           -- Sequence-readiness is not consulted: a step somebody is standing at
           -- is under way whatever the steps before it say, and hiding it is what
           -- stranded J-0118.
           OR so.id IN (SELECT r.job_operation_id FROM running_ops r)
           -- THE FOURTH BRANCH (20260907203956). A paused step has produced
           -- nothing, so it reads `pending`, and its interval is CLOSED, so the
           -- branch above misses it. Out of sequence as well and it satisfies
           -- none of the others -- which would make Pause a control that hides
           -- the work it is used on.
           OR so.id IN (SELECT pa.job_operation_id FROM paused_ops pa)
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
        ra.has_open_interval,
        ra.has_paused_interval
    FROM ready_or_active ra
    JOIN job_parts jp ON jp.id = ra.job_part_id
    JOIN parts p ON p.id = jp.part_id
    -- Running first, then paused, then the rest by job number. Paused ranks above
    -- plain ready work because it is work this shop has already started and set
    -- down: picking it up finishes something, where picking up a ready step starts
    -- a second thing. It ranks BELOW running because a turning machine is the one
    -- an operator walking up has to deal with first. job_number breaks the
    -- remaining ties, so the order stays deterministic.
    ORDER BY ra.has_open_interval DESC, ra.has_paused_interval DESC, ra.job_number;
END;
$$;

-- §2b. Re-issue what the DROP destroyed.
--
--      Copied from 20260906151902: `anon` is deliberately not granted (the
--      function is SECURITY INVOKER, an anon caller reads zero rows under anon's
--      RLS, and no anon caller exists because the operator layout redirects to
--      /login without a session).
REVOKE EXECUTE ON FUNCTION public.get_ready_operations_for_station(uuid, uuid)
  FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_ready_operations_for_station(uuid, uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.get_ready_operations_for_station(uuid, uuid) IS
  'The dispatch list for one station: steps that are sequence-ready, have quantity recorded against them, have a timer still open, or were paused and not resumed. The open-interval branch was added 20260826010648 and the paused branch 20260907203956, both for the same reason — op status derives from recorded quantity, so a started-but-nothing-produced step reads `pending`, and if it is also out of sequence it fell through every branch and appeared on no operator surface at all. Rows come back running-first, then paused, then by job number; a rush tier sorted above all until 20260906151902 dropped jobs.is_hot. SECURITY INVOKER: company isolation is RLS on jobs/job_operations, not the p_company_id argument, which is why both interval facts arrive through SECURITY DEFINER helpers that return ids and nothing else.';


-- ── 3. THE OPERATOR'S OWN PAUSED WORK ────────────────────────────────────────
-- SECURITY INVOKER, so job_op_intervals_select_own does the scoping and this needs
-- no function_execute_leaks() entry at all. That is the whole reason it is invoker:
-- a definer version would have to re-implement own-rows filtering by hand, and a
-- bug in that hand-written filter is a per-person time view.
--
-- NO expected_minutes, PERMANENTLY. See the migration header. The operator's own
-- "what am I holding" list is beside live clocks, and an estimate-derived figure
-- there is the adjacent comparison the guardrail exists to prevent. If a future
-- caller needs it, that is the moment to re-read the guardrail, not to add a
-- column.
CREATE OR REPLACE FUNCTION public.get_my_paused_operations(p_company_id uuid)
RETURNS TABLE(
    interval_id uuid,
    job_operation_id uuid,
    job_id uuid,
    job_part_id uuid,
    job_number text,
    part_name text,
    operation_name text,
    work_center_name text,
    paused_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT DISTINCT ON (i.job_operation_id)
         i.id, i.job_operation_id, j.id, jp.id, j.job_number, p.part_name,
         o.operation_name, wc.name, i.ended_at
    FROM public.job_operation_intervals i
    JOIN public.job_operations o ON o.id = i.job_operation_id
    JOIN public.job_parts jp ON jp.id = i.job_part_id
    JOIN public.jobs j ON j.id = jp.job_id
    LEFT JOIN public.parts p ON p.id = jp.part_id
    LEFT JOIN public.work_centers wc ON wc.id = i.work_center_id
   WHERE i.company_id = p_company_id
     AND i.close_reason = 'paused'
     AND i.voided_at IS NULL
     AND j.deleted_at IS NULL
     AND j.production_status IN ('not_started', 'in_progress')
     AND o.status IN ('pending', 'in_progress')
     -- Resumed or finished: not paused any more. Scoped to the OPERATION rather
     -- than to this row, so your own second pause supersedes your first.
     --
     -- THE HORIZON THIS HAS, stated because it is invisible and a reader will
     -- otherwise assume it away: SECURITY INVOKER means this subquery reads the
     -- table as the CALLER, so it only sees the caller's own spans. If a colleague
     -- takes the step over while you are away, your row keeps saying `Paused`
     -- until you touch it. Verified, not theorised — api/tests/integration/
     -- test_pause_operation_interval.py pins it.
     --
     -- LEFT AS IS DELIBERATELY. Closing it means a SECURITY DEFINER version with a
     -- hand-written `operator_id = get_operator_access_id(...)` filter, and a bug
     -- in that one line is a per-person time view — the exact thing this schema
     -- has no path to. The cost is small and self-correcting: tapping the row goes
     -- to the step, whose primary reads RESUME, and resuming takes the machine
     -- through the chain. That is the documented shift handoff, identical to
     -- tapping START on a step somebody else is running. The OFFICE list
     -- (get_paused_operations, DEFINER) has no horizon and shows the truth.
     AND NOT EXISTS (
           SELECT 1 FROM public.job_operation_intervals later
            WHERE later.job_operation_id = i.job_operation_id
              AND later.voided_at IS NULL
              AND (later.ended_at IS NULL OR later.started_at > i.ended_at)
         )
   ORDER BY i.job_operation_id, i.ended_at DESC;
$$;

COMMENT ON FUNCTION public.get_my_paused_operations(uuid) IS
  'The caller''s own paused steps — a span closed as ''paused'' with nothing later on the same operation THAT THE CALLER CAN SEE. SECURITY INVOKER on purpose: job_op_intervals_select_own already scopes the table to own rows, so there is no hand-written owner filter to get wrong and no function_execute_leaks() entry to justify — and the price of that is a horizon, since the not-exists check cannot see a colleague who took the step over, so the row keeps saying paused until the caller touches it. Accepted: tapping it goes to the step, RESUME takes the machine through the chain (the documented shift handoff), and the admin sibling get_paused_operations has no horizon. Returns NO expected_minutes and must not grow one: this list renders beside live clocks, and an estimate-derived figure there is the adjacent comparison docs/modules/operator-view.md#surveillance-guardrail-non-negotiable calls the half that must not move. Added 20260907203956 alongside pause_operation_interval.';

REVOKE EXECUTE ON FUNCTION public.get_my_paused_operations(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_my_paused_operations(uuid) TO authenticated, service_role;


-- ── 4. THE OFFICE'S VIEW OF PAUSED WORK ──────────────────────────────────────
-- The admin sibling of §3, mirroring get_open_intervals exactly: SECURITY DEFINER,
-- is_company_admin checked INSIDE, and NO operator identity in the result. An
-- admin-readable SELECT policy on the table would be a per-person report because
-- PostgREST supplies the grouping for free, which is why there isn't one and why
-- the office reads through functions like this.
--
-- It carries expected_minutes, which §3 refuses. The office is where actual and
-- estimate already sit together (components/jobs/OperationCard.tsx), and the
-- question here — "has this been set down for longer than the work would take?" —
-- cannot be answered without it.
CREATE OR REPLACE FUNCTION public.get_paused_operations(p_company_id uuid)
RETURNS TABLE(
    interval_id uuid,
    job_operation_id uuid,
    job_id uuid,
    job_number text,
    part_name text,
    operation_name text,
    work_center_name text,
    paused_at timestamptz,
    expected_minutes numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT DISTINCT ON (i.job_operation_id)
         i.id, i.job_operation_id, j.id, j.job_number, p.part_name,
         o.operation_name, wc.name, i.ended_at,
         COALESCE(o.estimated_setup_minutes, 0)
           + jp.quantity * COALESCE(o.estimated_run_minutes_per_unit, 0)
    FROM public.job_operation_intervals i
    JOIN public.job_operations o ON o.id = i.job_operation_id
    JOIN public.job_parts jp ON jp.id = i.job_part_id
    JOIN public.jobs j ON j.id = jp.job_id
    LEFT JOIN public.parts p ON p.id = jp.part_id
    LEFT JOIN public.work_centers wc ON wc.id = i.work_center_id
   WHERE i.company_id = p_company_id
     AND i.close_reason = 'paused'
     AND i.voided_at IS NULL
     AND j.deleted_at IS NULL
     AND j.production_status IN ('not_started', 'in_progress')
     AND o.status IN ('pending', 'in_progress')
     AND public.is_company_admin(p_company_id)
     AND NOT EXISTS (
           SELECT 1 FROM public.job_operation_intervals later
            WHERE later.job_operation_id = i.job_operation_id
              AND later.voided_at IS NULL
              AND (later.ended_at IS NULL OR later.started_at > i.ended_at)
         )
   ORDER BY i.job_operation_id, i.ended_at DESC;
$$;

COMMENT ON FUNCTION public.get_paused_operations(uuid) IS
  'Admin-only list of steps the floor paused and did not resume — the other half of the forgotten-work channel that get_open_intervals opened, and the direct answer to the objection the "No pause / resume" non-goal raised ("one more thing to remember to undo"). Carries NO operator identity, like every office read of this table: whose pause it was is not a question this product answers. expected_minutes is the estimate for the whole step (setup + quantity x run), so the caller can flag a step set down for far longer than the work would take; get_my_paused_operations deliberately does not return it. Unlike get_open_intervals this filters jobs.deleted_at and production_status — a paused step on an archived or cancelled job needs no attention, whereas a still-RUNNING clock on one is exactly the row nobody else can reach. Added 20260907203956.';

REVOKE EXECUTE ON FUNCTION public.get_paused_operations(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_paused_operations(uuid) TO authenticated, service_role;


-- ── 5. get_open_intervals LEARNS THE ESTIMATE ────────────────────────────────
-- DROP + CREATE, NOT CREATE OR REPLACE. One added column is still a changed return
-- type -- Postgres answers `cannot change return type of existing function
-- (42P13): Row type defined by OUT parameters is different` -- which is the same
-- wall 20260906151902 hit adding has_open_interval. The DROP destroys the ACL and
-- the COMMENT, so both are re-issued below (CLAUDE.md). Re-issuing the ACL is not
-- ceremony here: the schema still carries ALTER DEFAULT PRIVILEGES granting ALL on
-- functions to anon and authenticated (#640), so a freshly created function is
-- browser-callable until something revokes it, and this one is admin-only.
--
-- function_execute_leaks() allowlists by NAME, so the drop does not disturb it.
--
-- The 6-hour staleness rule the office card has used since 20260816203641 was a
-- flat constant, which means a 20-minute deburr left running over lunch was
-- indistinguishable from a 5-hour EDM burn until the sixth hour. With the estimate
-- here the caller can flag the first one at an hour and still leave the second
-- alone. Rows keep coming back oldest-first and still carry no operator identity.
--
-- expected_minutes is 0, never NULL, when the step carries no estimate — both
-- estimate columns are nullable and a step with neither is common. Zero is not a
-- fabricated duration here; it is the caller's signal to fall back to the flat
-- ceiling, and lib/duration.ts branches on `> 0` for exactly that reason.
DROP FUNCTION IF EXISTS public.get_open_intervals(uuid);

CREATE FUNCTION public.get_open_intervals(p_company_id uuid)
RETURNS TABLE(
    interval_id uuid,
    job_operation_id uuid,
    job_id uuid,
    job_number text,
    part_name text,
    operation_name text,
    work_center_name text,
    started_at timestamptz,
    capture_source text,
    expected_minutes numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT i.id, i.job_operation_id, j.id, j.job_number, p.part_name,
         o.operation_name, wc.name, i.started_at, i.capture_source,
         COALESCE(o.estimated_setup_minutes, 0)
           + jp.quantity * COALESCE(o.estimated_run_minutes_per_unit, 0)
    FROM public.job_operation_intervals i
    JOIN public.job_operations o ON o.id = i.job_operation_id
    JOIN public.job_parts jp ON jp.id = i.job_part_id
    JOIN public.jobs j ON j.id = jp.job_id
    LEFT JOIN public.parts p ON p.id = jp.part_id
    LEFT JOIN public.work_centers wc ON wc.id = i.work_center_id
   WHERE i.company_id = p_company_id
     AND i.ended_at IS NULL
     AND i.voided_at IS NULL
     AND public.is_company_admin(p_company_id)
   ORDER BY i.started_at ASC;
$$;

REVOKE EXECUTE ON FUNCTION public.get_open_intervals(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_open_intervals(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_open_intervals(uuid) IS
  'Admin-only list of intervals that are still open, oldest first — the forgotten-stop detection channel, and the only route to an interval whose owner has gone home (close_operation_interval and cancel_operation_interval both refuse a non-owner by design; void_open_intervals_for_operation, 20260828124806, is the correction half). Carries no operator identity: an open interval is a fact about a machine, and no path in this product resolves recorded time to a named person since 20260825170421. expected_minutes (setup + quantity x run, 0 when the step carries no estimate) was added 20260907203956 so the caller can flag a short step running long without waiting for the flat six-hour ceiling. Deliberately does NOT filter jobs.deleted_at: a clock still running on an archived job is precisely the row nobody else can reach.';


-- ── 6. THE CI ALLOWLIST ──────────────────────────────────────────────────────
-- Two new entries, both SECURITY DEFINER and both browser-reachable:
--
--   get_paused_operations              -- the office card's second list. Admin
--                                         gated inside; returns no operator id.
--   get_paused_operation_ids_for_station -- called BY the SECURITY INVOKER
--                                         dispatch RPC, which runs as the caller,
--                                         so the caller genuinely needs EXECUTE.
--                                         Returns ids and nothing else.
--
-- get_my_paused_operations is absent on purpose: it is SECURITY INVOKER, so it is
-- not a leak this function can see and adding it would be noise.
--
-- Body copied from 20260907203755 (the migration immediately before this one),
-- which is itself a copy of the live definition. CREATE OR REPLACE takes the WHOLE
-- body, so basing this on anything older silently deletes every entry added since.
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
      -- FIVE; get_operator_time_detail was the fifth and is dropped in
      -- 20260825170421, so it leaves this list for the subdivide_location reason --
      -- an allowlist naming functions that no longer exist is how the list rots.
      -- cancel_operation_interval joined the group in 20260826105251: the step
      -- screen calls it directly to discard a running timer.
      -- void_open_intervals_for_operation joined in 20260828124806: the OFFICE
      -- discards someone else's, from the job page's Complete and the Still-running
      -- card's Stop.
      -- pause_operation_interval joined HERE (20260907203755): the step screen
      -- calls it directly to close a span the operator means to come back to. It
      -- is DEFINER for the same reason its two siblings are -- the browser has no
      -- INSERT or UPDATE grant on ended_at/close_reason at all, by construction
      -- (20260816203641's column-scoped GRANT UPDATE names three columns and these
      -- are not among them) -- and it asserts ownership itself.
      -- get_paused_operations joined in 20260907203956: the office card reads
      -- the other half of the forgotten-work channel. Admin-checked inside and
      -- returns no operator identity, exactly like get_open_intervals.
      'start_operation_interval', 'close_operation_interval',
      'cancel_operation_interval', 'pause_operation_interval',
      'void_open_intervals_for_operation',
      'get_operation_actuals', 'get_open_intervals', 'get_paused_operations',
      -- Added 20260903203741: outside-processing shipping. BOTH are browser
      -- callable on purpose. create_outside_shipment IS the send -- it mints
      -- VPS-{jobBase}-{n} under a per-job advisory lock and freezes the vendor
      -- address block, neither of which a PostgREST insert can do, which is why
      -- outside_shipments grants the browser SELECT and nothing else.
      -- void_outside_shipment must void the receipts BEFORE the shipment in one
      -- transaction, or the op -> part -> job cascade crosses the
      -- pg_trigger_depth() > 2 bail and freezes the job status silently.
      -- Both derive company_id from the row rather than taking it as an
      -- argument, and both call company_can_write by hand.
      'create_outside_shipment', 'void_outside_shipment',
      -- Added 20260906121901: the part page's heat-tracking toggle
      -- (`setPartLotTracking`). DEFINER because setting the flag and migrating the
      -- part's lot-less balances into a PRE-TRACKING lot must be one transaction.
      'set_part_lot_tracking',
      -- Called BY a browser-callable SECURITY INVOKER function, which runs as the
      -- caller — so the caller genuinely needs EXECUTE on this one.
      -- (generate_quote_number / generate_direct_job_number -> next_order_number)
      -- (get_ready_operations_for_station -> get_running_operation_ids_for_station,
      --  added 20260826010648, and -> get_paused_operation_ids_for_station,
      --  added 20260907203956 -- same contract, ids and nothing else)
      'next_order_number', 'get_running_operation_ids_for_station',
      'get_paused_operation_ids_for_station'
    )
  ORDER BY 1, 2;
$$;
