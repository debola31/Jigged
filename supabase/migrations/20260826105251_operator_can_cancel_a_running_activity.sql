-- ═══════════════════════════════════════════════════════════════════════════════
-- AN OPERATOR CAN CANCEL A RUNNING ACTIVITY
-- ═══════════════════════════════════════════════════════════════════════════════
-- THE DEAD END THIS CLOSES. An operator who starts a step and produces nothing
-- cannot stop the clock. Every route is shut:
--
--   * close_operation_interval asserts ownership, so the office cannot close it;
--   * the OWNER's only close path is createOperationCompletion, floored at
--     `quantity_good > 0` by job_op_completions_quantity_positive (20260721023953);
--   * `Stop without finishing` was built and removed in f3aeab33 (2026-08-18);
--   * `Complete without timing` renders only when primaryAction === 'start', so it
--     is hidden while a timer runs;
--   * `Adjust` is absent from a running row (job_op_intervals_adjust_only_when_closed).
--
-- So the honest answer to "I started this by mistake" was: type a quantity you did
-- not produce, or wait for someone else to take the machine.
--
-- THE EVIDENCE THAT THIS IS REAL RATHER THAN THEORETICAL. Nobody had to imagine
-- the workaround -- it is already in the test suite and already in production.
-- e2e/operator-time-capture.spec.ts's stopTimer() helper says it out loud:
--
--   > COMPLETE, THEN UNDO. There is no stop-without-completing control any more --
--   > an interval closes by being completed or by the chain, and nothing else. So
--   > the only way for a test to leave the timer closed AND the seeded quantities
--   > untouched is to record a completion and then void it.
--
-- And of the three intervals that had ever existed in production when this was
-- written, TWO were 21-second and 8-second runs on J-0013 EDM at 01:49 and 01:50
-- UTC on 2026-08-26, each with a completion attached and each voided. Start, fake
-- completion, undo -- done by hand, by a person, because there was no other way.
-- That laundering path is what this removes.
--
-- WHY VOID RATHER THAN CLOSE, AND THE ARGUMENT NOT TO MAKE. It is tempting to say
-- "we do not know when the work stopped, so closing at now() would fabricate an
-- end, and an honest absence beats a plausible fabrication." DO NOT SAY THAT --
-- this schema fabricates exactly that end routinely. start_operation_interval
-- closes whatever holds the chain slot at now() every time the next start lands
-- (20260816203641, section 6a), and it did so to the row that prompted this work:
-- J-0118 / OP 30 EDM is now a 408-minute `switched` interval, unvoided, summed
-- into that operation's actual-vs-estimate by get_operation_actuals.
--
-- The true framing is simpler: THIS IS UNDO FOR A TIMER. void_intervals_with_
-- completion (20260816203641, section 5) is Undo for a completion, and it voids.
-- This is the same act one step earlier, so it voids too.
--
-- WHY IT IS NOT A REVERT OF f3aeab33. That commit removed a control that asked the
-- operator to CLASSIFY a stop (`done_for_day` / `left_running`) and that CLOSED the
-- interval, preserving the measured span under a label. This one takes no reason
-- and DISCARDS. Different act, and the opposite direction on data preservation.
-- f3aeab33's objection -- "a second decision on top of the one that matters" --
-- does not apply to a reason-less discard, because there is no second decision.
--
-- A NEW ROW STATE ARRIVES WITH THIS MIGRATION: `voided_at IS NOT NULL AND ended_at
-- IS NULL`. Until now every voided interval was also closed, because the only
-- voider fires from a completion and completions only ever attach to closed rows.
-- It is safe, and every reader was checked by hand before writing this line --
-- get_operation_actuals, get_open_intervals, get_running_operation_ids_for_station,
-- and getInterval / getMyOpenIntervals / getMyIntervalsForJob / getMyIntervalJournal
-- in utils/operationIntervalsAccess.ts all filter `voided_at IS NULL`. It is
-- written down because it is a shape a future reader would otherwise assume away.


-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. THE RPC
-- ═══════════════════════════════════════════════════════════════════════════════
-- SECURITY DEFINER because the browser cannot write this column and must not be
-- able to. The column grant is `GRANT UPDATE (adjusted_started_at,
-- adjusted_ended_at, note)` (20260816203641, section 3) and it NAMES the writable
-- columns, so `voided_at` is unwritable by construction rather than by omission;
-- job_op_intervals_restrict_update() then raises on any other column diff for
-- anon/authenticated. An RPC is the only route, exactly as it is for close.
--
-- Mirrors close_operation_interval statement for statement so the two read as one
-- family. The only differences are the verb and what it writes.
CREATE OR REPLACE FUNCTION public.cancel_operation_interval(p_interval_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_company_id uuid;
    v_operator_id uuid;
    v_owner_id uuid;
BEGIN
    SELECT company_id, operator_id INTO v_company_id, v_owner_id
      FROM public.job_operation_intervals
     WHERE id = p_interval_id AND ended_at IS NULL AND voided_at IS NULL;

    -- Idempotent, for the same two reasons close_operation_interval is: a gloved
    -- double-tap on a phone, and a retry after a dropped cellular response. An
    -- already-cancelled or already-closed interval is not a mistake worth an error.
    IF v_company_id IS NULL THEN
        RETURN;
    END IF;

    -- Ownership. SECURITY DEFINER bypasses RLS, so this assertion is the only thing
    -- between a caller and someone else's recorded hours -- the same reason
    -- close_operation_interval asserts it and start_operation_interval does not.
    v_operator_id := public.get_operator_access_id(v_company_id);
    IF v_operator_id IS NULL OR v_operator_id IS DISTINCT FROM v_owner_id THEN
        RAISE EXCEPTION 'You can only cancel an activity you started';
    END IF;

    -- THE BILLING GATE, BY HAND, because SECURITY DEFINER bypasses the RESTRICTIVE
    -- policy that would otherwise enforce it.
    --
    -- THE LITERAL `company_can_write` IN THIS BODY IS LOAD-BEARING FOR CI.
    -- definer_writers_missing_write_gate() matches on the STRING, not the
    -- behaviour: `pg_get_functiondef(p.oid) NOT LIKE '%company_can_write%'`. Hoist
    -- this call into a helper and the guard goes red for a reason nobody will be
    -- able to find from the error.
    IF NOT public.company_can_write(v_company_id) THEN
        RAISE EXCEPTION 'Your subscription is not active (billing_gate_update)'
            USING ERRCODE = '42501';
    END IF;

    -- `ended_at` and `close_reason` are deliberately left NULL, which is what makes
    -- this need no constraint change:
    --
    --   * job_op_intervals_close_reason_iff_ended asserts
    --     `(ended_at IS NULL) = (close_reason IS NULL)` -- both stay NULL, satisfied.
    --     A `close_reason = 'cancelled'` would instead need
    --     job_op_intervals_close_reason_check widened, since it permits only
    --     'completed', 'switched' and NULL.
    --   * both partial unique indexes -- job_op_intervals_one_open_per_work_center
    --     and job_op_intervals_one_open_adhoc -- carry `voided_at IS NULL` in their
    --     predicates, so stamping voided_at FREES THE CHAIN SLOT. The machine is
    --     immediately available to the next start, which is the behaviour the floor
    --     needs and the reason this is not merely cosmetic.
    --   * job_op_intervals_adjust_only_when_closed permanently forbids adjusting a
    --     row in this state. Correct: there is no end to correct against.
    --
    -- voided_by IS A user_company_access.id, NOT AN auth.users ID. The two
    -- voided_by columns in this family are different kinds -- 20260816203641,
    -- section 5 carries a trigger that TRANSLATES between them with the comment
    -- "TRANSLATE the actor; do NOT copy it", because
    -- job_operation_completions.voided_by holds an auth id and carries no FK while
    -- this column references user_company_access(id). Writing auth.uid() here
    -- raises 23503. v_operator_id is already the right kind -- it is the same value
    -- operator_id holds.
    UPDATE public.job_operation_intervals
       SET voided_at = now(),
           voided_by = v_operator_id
     WHERE id = p_interval_id;
END;
$$;

COMMENT ON FUNCTION public.cancel_operation_interval(uuid) IS
  'Discards a running interval: stamps voided_at/voided_by and leaves ended_at and close_reason NULL, which frees the work centre''s chain slot (both partial unique indexes carry voided_at IS NULL) without asserting an end nobody knows. This is Undo for a timer — the sibling of void_intervals_with_completion, which is Undo for a completion. Asserts the caller OWNS the interval, like close_operation_interval and for the same reason. Idempotent on an already-cancelled or already-closed row. Added 20260826105251 to close the dead end where an operator who produced nothing could only stop the clock by recording a quantity they had not made and then undoing it.';

-- Named roles rather than `FROM PUBLIC` alone: correct under either default-privilege
-- state, and #640 is what happens when eight migrations claim a grant they never made.
REVOKE EXECUTE ON FUNCTION public.cancel_operation_interval(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.cancel_operation_interval(uuid) TO authenticated, service_role;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. THE COMMENT THIS FALSIFIES
-- ═══════════════════════════════════════════════════════════════════════════════
-- 20260825170421 section 6 set the precedent: when a change makes a COMMENT on a
-- SURVIVING object read wrong, correct it in the same migration, because a comment
-- that is merely out of date is worse than none.
--
-- close_operation_interval's comment is not wrong -- it still closes as completed
-- and still asserts ownership -- but it was written when closing was the only
-- deliberate way to end an interval. It now has a sibling that ends one without
-- closing it, and the next reader deciding "how do intervals end" should find both
-- from either.
COMMENT ON FUNCTION public.close_operation_interval(uuid, uuid, timestamptz, timestamptz, text) IS
  'Closes an interval as completed, with optional adjusted times and note. Asserts the caller OWNS the interval — unlike start_operation_interval, which crosses ownership by design — because with RLS bypassed an unchecked id parameter would let any member rewrite anyone''s recorded hours. Idempotent on an already-closed interval so a double-tap or a retry is not an error. As of 20260826105251 this is no longer the only deliberate end: cancel_operation_interval discards a running interval without closing it (voided_at set, ended_at left NULL), for the operator who started a step and produced nothing.';


-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. THE LEAK ALLOWLIST
-- ═══════════════════════════════════════════════════════════════════════════════
-- RESTATED FROM 20260826010648, THE NEWEST DEFINITION. Checked rather than assumed:
-- 20260826010319 (the AI read-access guard) landed between that migration and this
-- one and adds three functions, all SECURITY INVOKER, so it does not touch this
-- list. Restating from an older body silently reverts every entry added since --
-- this list has been reverted that way four times, which is why the source is named
-- here instead of left to be rediscovered.
--
-- ONE EDIT: 'cancel_operation_interval' joins the operator cycle-time group. The
-- browser calls it directly from the step screen (`cancelOperationInterval` in
-- utils/operationIntervalsAccess.ts), exactly as it calls start and close.
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
      -- cancel_operation_interval joined the group in 20260826105251: the step
      -- screen calls it directly to discard a running timer.
      'start_operation_interval', 'close_operation_interval',
      'cancel_operation_interval',
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
-- Reversibility (documentation -- the branching pipeline is forward-only)
-- ═══════════════════════════════════════════════════════════════════════════════
-- DROP FUNCTION public.cancel_operation_interval(uuid); then restate
-- function_execute_leaks() without its entry and restore
-- close_operation_interval's COMMENT from 20260816203641:681.
--
-- Rows already cancelled would NOT come back: `voided_at IS NOT NULL AND ended_at
-- IS NULL` would become an orphan state with no writer, though every reader
-- already filters it out, so the effect is that the time stays discarded. That is
-- the correct outcome anyway -- the operator said the timing was wrong.
