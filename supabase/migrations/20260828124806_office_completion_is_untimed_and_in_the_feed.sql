-- Office-recorded completions: say which surface recorded them, let the shop floor
-- see them, and give the office a way to discard a timer it just overrode.
--
-- ── WHAT WENT WRONG, CONCRETELY ──────────────────────────────────────────────
-- Reported 2026-08-28 against J-0001. All four parts on that job route through
-- one work centre, so all four operations are NAMED 'HAAS VF-3SSYT'. One of them
-- (JAW 2) had an interval an operator opened at 09:49Z and never closed; another
-- (JAW 1) was complete. The office read the Still-running card, opened what
-- looked like the same step, and found it completed with no timer — two
-- different operations wearing one name, and a running clock that is invisible
-- to anyone but its owner (job_op_intervals_select_own).
--
-- The data was correct throughout. What was missing is a way to ACT on it: the
-- office could see the abandoned interval and could not touch it.
-- close_operation_interval and cancel_operation_interval both assert ownership,
-- get_operator_time_detail was dropped in 20260825170421, and
-- get_open_intervals's own COMMENT has claimed since 20260816203641 that it is
-- "the only route to an interval whose owner has gone home" — a claim that has
-- been FALSE the whole time, because the list it feeds renders no action.
-- Section 2 makes it true.
--
-- ── THE POLICY THIS ENCODES (decided 2026-08-28) ─────────────────────────────
-- Two people can reach for the same operation, and the rule is FIRST WRITE WINS.
--
--   * An office completion is always UNTIMED. The office was not standing at the
--     machine; it has no duration to report and will not invent one.
--   * If a timer is running on the step the office completes, that timer is
--     DISCARDED, not closed. Whoever started it is no longer the person ending
--     it, so its end time would be a fabrication — and a fabricated duration is
--     worse than a missing one, because the estimating loop reads it back as
--     measurement. Same argument the table header makes for never auto-closing.
--   * A second completion submitted against work someone else already recorded
--     is a CONFLICT, refused at submit so the loser sees the winner's state
--     rather than double-counting on top of it. That guard is in the app
--     (createOperationCompletion's expectedQtyGood) rather than here; what this
--     migration owes it is section 1, so the feed can show the row the loser
--     lost to.
--
-- ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────
-- No admin SELECT policy on job_operation_intervals, and no operator identity in
-- anything below. void_open_intervals_for_operation takes an OPERATION and
-- returns a COUNT: the office says "discard whatever is running on this step"
-- without ever learning whose it was. That keeps
-- docs/modules/operator-view.md#surveillance-guardrail-non-negotiable intact —
-- the office gains a correction, not a per-person view.


-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. WHICH SURFACE RECORDED A COMPLETION
-- ═══════════════════════════════════════════════════════════════════════════════
-- The job feed shows an operator their OWN completions and nobody else's, on
-- purpose (getMyCompletionsForJob): a job-scoped list of what each named person
-- finished would be a per-person production log available shop-wide. That rule is
-- about PEOPLE, and an office completion has no person in it — so it can be shown
-- to everyone without touching the guardrail, and it must be, or the office marks
-- a step done and the floor's own record of that step stays silent.
--
-- The column is what separates the two. NOT the actor's role: an admin standing
-- at a machine records through the operator surface, and classifying by role
-- would file their work as an office action. The SURFACE is the fact; the role is
-- an inference about it.
--
-- NULLABLE, AND THAT IS THE HONEST SHAPE FOR THE 149 ROWS ALREADY THERE. NULL
-- means "recorded before this column existed, surface unknown" — an explicit
-- no-data state, which CLAUDE.md prefers to a default that quietly asserts
-- 'operator' about rows nobody classified. The feed reads `= 'office'`, so NULL
-- rows keep behaving exactly as they do today and nothing at rest changes
-- meaning. Every new write names the surface (the TypeScript input makes it
-- required, so no caller can omit it).
ALTER TABLE public.job_operation_completions
    ADD COLUMN capture_source text;

ALTER TABLE public.job_operation_completions
    ADD CONSTRAINT job_op_completions_capture_source_check
        CHECK (capture_source IS NULL OR capture_source IN ('operator', 'office'));

-- The one part of the history that IS knowable, backfilled from a fact rather
-- than a guess: an interval closed by a completion proves an operator was timing
-- it, because only close_operation_interval writes completion_id and it asserts
-- the caller owns the interval. The remainder stays NULL — untimed completions
-- carry no evidence of which surface produced them, and inventing one would be
-- the exact silent fallback the nullability above exists to avoid.
--
-- FIRST RUN IS PRODUCTION. Every pre-merge gate replays this on an empty
-- database, so this UPDATE is a no-op in CI and its only real execution is the
-- prod push. Checked by hand against prod before writing: 149 completion rows,
-- 144 live, and job_operation_intervals holds 3 rows on one company — so this
-- touches at most a couple of rows and cannot be slow. It is ordered after the
-- ADD COLUMN and before anything reads the column, which is the only ordering
-- constraint it has.
UPDATE public.job_operation_completions c
   SET capture_source = 'operator'
 WHERE c.capture_source IS NULL
   AND EXISTS (
     SELECT 1 FROM public.job_operation_intervals i
      WHERE i.completion_id = c.id
   );

COMMENT ON COLUMN public.job_operation_completions.capture_source IS
  'Which surface recorded this completion: ''operator'' (the step screen on the shop floor) or ''office'' (the job page''s Complete button). NULL means recorded before 20260828124806, surface unknown — rows whose interval link proved operator capture were backfilled, the rest are honestly unknown rather than defaulted. Read by the job feed, which shows an operator their own completions plus every ''office'' one: the own-rows rule protects PEOPLE, and an office completion has no person in it. Do NOT derive this from the actor''s role — an admin at a machine records through the operator surface, and role is an inference about the surface rather than the surface itself.';


-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. THE OFFICE'S CORRECTION FOR AN ABANDONED TIMER
-- ═══════════════════════════════════════════════════════════════════════════════
-- Takes an OPERATION, not an interval id, and returns a COUNT, not rows. Both
-- choices are the guardrail:
--
--   * an operation is what the office is looking at (a step it is completing, or
--     a row on the Still-running list, which already carries job_operation_id);
--   * a count answers "did anything stop" without naming who was on it, and
--     plural is correct rather than defensive — an ad-hoc operation chains per
--     OPERATOR, so two people can hold open intervals on one such step at once.
--
-- VOIDS, NEVER CLOSES, and the distinction is the whole point of the function.
-- Stamping ended_at would assert when work stopped; nobody in the office knows
-- that, and the person who does is not here. voided_at with ended_at left NULL
-- says "this did not happen" instead, which is true, contributes to no total, and
-- frees the work centre's chain slot immediately (both partial unique indexes
-- carry voided_at IS NULL) so the next operator can start on the machine.
-- Identical reasoning, and identical row shape, to cancel_operation_interval —
-- this is that function with an admin gate instead of an ownership assertion.
CREATE OR REPLACE FUNCTION public.void_open_intervals_for_operation(
    p_job_operation_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_company_id uuid;
    v_actor_id uuid;
    v_count integer;
BEGIN
    SELECT jp.company_id INTO v_company_id
      FROM public.job_operations o
      JOIN public.job_parts jp ON jp.id = o.job_part_id
     WHERE o.id = p_job_operation_id;

    -- A step that does not exist has no timers to discard. Silent, like the
    -- idempotent returns in close_/cancel_operation_interval: the office calls
    -- this on every completion, most of which have nothing running.
    IF v_company_id IS NULL THEN
        RETURN 0;
    END IF;

    -- ADMIN, not ownership. Every other write path on this table asserts the
    -- caller owns the row precisely so one member cannot rewrite another's
    -- recorded hours — and that assertion is what leaves an abandoned interval
    -- unreachable. The exception is narrow by construction: this cannot rewrite
    -- an interval, cannot read one, and cannot touch a CLOSED one. Discarding is
    -- the only thing it can do, so the worst an admin can do with it is destroy
    -- an in-progress measurement, which is visible on the floor within seconds
    -- (the step screen's clock disappears) and is exactly the act being asked for.
    IF NOT public.is_company_admin(v_company_id) THEN
        RAISE EXCEPTION 'Only an admin can discard a running timer';
    END IF;

    -- THE BILLING GATE, BY HAND, because SECURITY DEFINER bypasses the RESTRICTIVE
    -- policy that would otherwise enforce it.
    --
    -- THE LITERAL `company_can_write` IN THIS BODY IS LOAD-BEARING FOR CI.
    -- definer_writers_missing_write_gate() matches on the STRING, not the
    -- behaviour: `pg_get_functiondef(p.oid) NOT LIKE '%company_can_write%'`.
    -- Hoisting this call into a helper turns the guard red for a reason nobody
    -- will be able to find from the error.
    IF NOT public.company_can_write(v_company_id) THEN
        RAISE EXCEPTION 'Your subscription is not active (billing_gate_update)'
            USING ERRCODE = '42501';
    END IF;

    -- voided_by IS A user_company_access.id, NOT AN auth.users ID — the trap
    -- 20260816203641 section 5 documents as "TRANSLATE the actor; do NOT copy
    -- it", because job_operation_completions.voided_by holds an auth id while
    -- this column FKs user_company_access(id). get_operator_access_id already
    -- returns the right kind. NULL when the caller is a system admin holding no
    -- membership row, which the FK permits (ON DELETE SET NULL) and which still
    -- records THAT the row was voided.
    v_actor_id := public.get_operator_access_id(v_company_id);

    UPDATE public.job_operation_intervals
       SET voided_at = now(),
           voided_by = v_actor_id
     WHERE job_operation_id = p_job_operation_id
       AND ended_at IS NULL
       AND voided_at IS NULL;

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.void_open_intervals_for_operation(uuid) IS
  'Discards every open interval on one operation, crossing ownership: stamps voided_at/voided_by and leaves ended_at and close_reason NULL, which frees the work centre''s chain slot without asserting an end nobody in the office knows. Admin-gated rather than owner-gated, and that is the point — close_operation_interval and cancel_operation_interval both refuse a non-owner, which is what left an interval whose owner has gone home unreachable and made get_open_intervals''s "only route" comment false since 20260816203641. Takes an operation and returns a COUNT, so the office can stop a timer without ever learning whose it was. Plural because an ad-hoc operation chains per operator. Called when the office completes a step someone was timing (first write wins, and a stranger''s end time would be fabricated) and from the dashboard Still-running list''s Stop control.';

-- Named roles rather than `FROM PUBLIC` alone: correct under either
-- default-privilege state, and #640 is what happens when a migration claims a
-- grant it never made.
REVOKE EXECUTE ON FUNCTION public.void_open_intervals_for_operation(uuid)
  FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.void_open_intervals_for_operation(uuid)
  TO authenticated, service_role;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. THE COMMENT THIS FINALLY MAKES TRUE
-- ═══════════════════════════════════════════════════════════════════════════════
-- 20260825170421 §6 set the precedent: when a change makes a COMMENT on a
-- SURVIVING object read wrong, correct it in the same migration.
--
-- This one was already wrong twice over. It still names get_operator_time_detail,
-- which 20260825170421 dropped — so it points at a function that does not exist.
-- And it has always called itself "the only route to an interval whose owner has
-- gone home" while offering no route at all: the list was read-only, so the
-- sentence described an intention rather than a capability. Section 2 supplies
-- the missing half, and the comment now says which function does it.
COMMENT ON FUNCTION public.get_open_intervals(uuid) IS
  'Admin-only list of intervals that are still open, oldest first — the forgotten-stop detection channel, and the route to an interval whose owner has gone home (close_operation_interval and cancel_operation_interval both refuse a non-owner by design). Acting on one is void_open_intervals_for_operation, added 20260828124806; until then this list was read-only and the "only route" claim in its previous comment was aspirational. Carries no operator identity, and NOTHING does: get_operator_time_detail, the one path that resolved an interval to a named person, was dropped in 20260825170421. An open interval is a fact about a machine.';


-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. THE LEAK ALLOWLIST
-- ═══════════════════════════════════════════════════════════════════════════════
-- RESTATED FROM 20260826105251, WHICH IS THE NEWEST DEFINITION. Checked rather
-- than assumed: the six migrations that landed after it (20260826112948,
-- 20260826124256, 20260826171255, 20260827114506, 20260827114551, 20260827114613)
-- were read for a CREATE OR REPLACE of this function and none carries one.
-- Restating from an older body silently reverts every entry added since — this
-- list has been reverted that way four times, which is why the source is named
-- here rather than left to be rediscovered.
--
-- ONE EDIT: 'void_open_intervals_for_operation' joins the operator cycle-time
-- group. The browser calls it directly, from two places: the job page's Complete
-- button (`completeJobOperation` in utils/jobsAccess.ts) and the dashboard
-- Still-running card's Stop control (`voidOpenIntervalsForOperation` in
-- utils/operationIntervalsAccess.ts) — exactly as it calls start, close and
-- cancel. It is SECURITY DEFINER because discarding another member's interval is
-- the whole feature, and it gates itself on is_company_admin.
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
      'start_operation_interval', 'close_operation_interval',
      'cancel_operation_interval', 'void_open_intervals_for_operation',
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
