-- ═══════════════════════════════════════════════════════════════════════════════
-- AN OPERATOR CAN PAUSE AND RESUME AN ACTIVITY
-- ═══════════════════════════════════════════════════════════════════════════════
-- THIS REVERSES A RECORDED NON-GOAL, and the reversal is the point of this header.
-- docs/modules/operator-view.md's non-goal table said "No pause / resume ... and
-- will not", on this reasoning:
--
--   > A paused state is one more thing to remember to undo, and the chain already
--   > expresses "I stopped doing this" as "I started doing something else".
--
-- The second clause is the load-bearing one and it is CONDITIONALLY true: the
-- chain expresses the stop only when there IS a next thing. Walking away has no
-- expression at all. So an operator going to lunch had exactly two moves, and both
-- corrupt something:
--
--   * `Cancel activity` (20260826105251) DISCARDS the span, so real measured
--     minutes are thrown away to stop a clock;
--   * leave it open, which holds the work centre's chain slot against everyone
--     else and lands on the office Still-running list as a forgotten timer.
--
-- The first clause -- "one more thing to remember to undo" -- is a REAL cost and
-- is not withdrawn. It is answered rather than denied, by two things shipped
-- alongside this: a paused step stays on the operator's dispatch list (the fourth
-- eligibility branch, added in the migration that follows this one) and shows in
-- the office's unfinished-work card. A paused step that nobody resumes is visible
-- from both sides, which is the property the objection was actually asking for.
--
-- WHY 'paused' CLOSES THE SPAN RATHER THAN FLAGGING THE ROW. A `paused_at` column
-- on an open row was considered and rejected: both partial unique indexes key on
-- `ended_at IS NULL AND voided_at IS NULL`, so a paused-but-open row would keep
-- holding the work centre's chain slot -- an operator at lunch would block the
-- machine for everyone. Closing the span frees the slot immediately, and
-- get_operation_actuals already SUMs every closed non-voided span per operation,
-- so a pause/resume/pause/finish sequence totals correctly with no change there.
--
-- WHY THERE IS NO resume_operation_interval. Resume is start_operation_interval,
-- unchanged: it opens a new span on the same operation and chain-closes whatever
-- holds the work centre. A dedicated function would be that one with a different
-- name and a second place for the membership, billing and outside-op guards to
-- drift out of sync.
--
-- WHY IT TAKES NO REASON, AND WHY THAT IS NOT f3aeab33 AGAIN. f3aeab33 (2026-08-18)
-- removed `Stop without finishing` and its `done_for_day` / `left_running` reasons
-- because they asked the operator to CLASSIFY a stop -- a second decision on top of
-- the one that matters. This is a single unlabelled tap. The `No downtime /
-- stoppage reasons` non-goal SURVIVES this migration; what changes is only that it
-- no longer follows automatically from the absence of a paused state, so it now
-- stands on its own reasoning and is recorded that way in the doc.
--
-- WHAT DELIBERATELY DOES NOT CHANGE, both because a reader will ask:
--
--   * void_intervals_with_completion (20260816203641 §5) is scoped by
--     completion_id. A paused span carries none, so undoing a completion voids the
--     final span and leaves the paused ones standing -- exactly the treatment
--     `switched` spans already get, and for the same reason: that is real work no
--     completion ever claimed.
--   * void_open_intervals_for_operation (20260828124806) touches `ended_at IS NULL`
--     rows only, so the office completing a paused step keeps its recorded minutes
--     rather than discarding them.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ── 1. THE CLOSE REASON WIDENS BY ONE ────────────────────────────────────────
-- Additive: every existing row carries 'completed', 'switched' or NULL and still
-- satisfies the new form, so there is nothing to backfill.
--
-- job_op_intervals_close_reason_iff_ended is untouched and still binds -- a paused
-- span sets `ended_at` and `close_reason` together, which is what makes 'paused' a
-- legal reason where `cancel_operation_interval`'s discard could not use one
-- (it leaves both NULL, and 20260826105251 says so at length).
ALTER TABLE public.job_operation_intervals
    DROP CONSTRAINT job_op_intervals_close_reason_check;

ALTER TABLE public.job_operation_intervals
    ADD CONSTRAINT job_op_intervals_close_reason_check
        CHECK (close_reason IS NULL
               OR close_reason IN ('completed', 'switched', 'paused'));

COMMENT ON COLUMN public.job_operation_intervals.close_reason IS
  'Why a span ended. ''completed'' -- the operator recorded what they finished (close_operation_interval). ''switched'' -- the chain took the work centre for someone else (start_operation_interval). ''paused'' -- the operator stopped deliberately and intends to come back (pause_operation_interval, 20260907203755); resuming opens a NEW span rather than reopening this one, so the feed reads as a log and get_operation_actuals sums the spans. NULL means still running, or discarded by cancel_operation_interval / void_open_intervals_for_operation, which leave ended_at NULL on purpose.';


-- ── 2. pause_operation_interval ──────────────────────────────────────────────
-- Modelled line for line on cancel_operation_interval (20260826105251): idempotent
-- on a row that is already closed or voided, OWNER-ASSERTED, and calling
-- company_can_write by hand because SECURITY DEFINER bypasses the RESTRICTIVE
-- billing-gate policy (the literal name is also what definer_writers_missing_
-- write_gate() greps pg_get_functiondef for).
--
-- OWNER-ASSERTED RATHER THAN CHAIN-CROSSING, unlike start_operation_interval.
-- Pausing is a statement about your own intent to come back; nobody else can make
-- it for you. A second operator who needs the machine STARTS on it, and the chain
-- closes yours as 'switched' -- the shift handoff, unchanged.
CREATE OR REPLACE FUNCTION public.pause_operation_interval(p_interval_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_company_id uuid;
    v_operator_id uuid;
    v_owner_id uuid;
    v_started_at timestamptz;
BEGIN
    SELECT company_id, operator_id, started_at
      INTO v_company_id, v_owner_id, v_started_at
      FROM public.job_operation_intervals
     WHERE id = p_interval_id AND ended_at IS NULL AND voided_at IS NULL;

    -- Already closed, already discarded, or not visible: nothing to pause. Silent
    -- like its siblings, so a gloved double-tap and a retry after a dropped
    -- cellular response are both harmless.
    IF v_company_id IS NULL THEN
        RETURN;
    END IF;

    v_operator_id := public.get_operator_access_id(v_company_id);
    IF v_operator_id IS NULL OR v_operator_id IS DISTINCT FROM v_owner_id THEN
        RAISE EXCEPTION 'You can only pause an activity you started';
    END IF;

    IF NOT public.company_can_write(v_company_id) THEN
        RAISE EXCEPTION 'Your subscription is not active (billing_gate_update)'
            USING ERRCODE = '42501';
    END IF;

    -- job_op_intervals_ordered is STRICT (`ended_at > started_at`), so a pause in
    -- the same instant as the start would abort the transaction with a constraint
    -- name the operator cannot act on. Refuse it here in words instead, and point
    -- at the control that IS right for it: a pause zero seconds after a start is a
    -- mis-tap, and `Cancel activity` is Undo for a timer. Do NOT "fix" this by
    -- nudging ended_at forward a second -- that fabricates a measurement, which is
    -- the thing this whole table refuses to do.
    IF now() <= v_started_at THEN
        RAISE EXCEPTION 'This step has only just started — cancel the activity instead of pausing it.';
    END IF;

    UPDATE public.job_operation_intervals
       SET ended_at = now(),
           close_reason = 'paused'
     WHERE id = p_interval_id;
END;
$$;

COMMENT ON FUNCTION public.pause_operation_interval(uuid) IS
  'Closes a running span as ''paused'': the operator stopped deliberately and means to come back. Frees the work centre''s chain slot immediately (both partial unique indexes key on ended_at IS NULL), so a machinist at lunch does not block the machine. Resume is start_operation_interval -- a NEW span on the same operation -- and get_operation_actuals already sums them, so no total changes. Asserts the caller OWNS the interval, like close_operation_interval and cancel_operation_interval: pausing states YOUR intent to return, and nobody can state it for you; a colleague who needs the machine starts on it and the chain closes yours as ''switched''. Idempotent on an already-closed or already-discarded row. Refuses a zero-length span in words rather than letting job_op_intervals_ordered abort with a constraint name, and rather than nudging the end forward, which would fabricate a measurement. Added 20260907203755, reversing the "No pause / resume" non-goal -- see the migration header for which half of that reasoning was wrong and which half is answered rather than denied.';

REVOKE EXECUTE ON FUNCTION public.pause_operation_interval(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.pause_operation_interval(uuid) TO authenticated, service_role;


-- ── 3. THE CI ALLOWLIST ──────────────────────────────────────────────────────
-- function_execute_leaks() (20260801024552) lists SECURITY DEFINER functions a
-- browser role may EXECUTE and that nobody has justified. One new entry.
--
-- WARNING, restated because it has already cost a debugging cycle in this family:
-- CREATE OR REPLACE takes the WHOLE body, so basing a new version on an older
-- migration silently deletes every entry added since. This body was copied from
--   SELECT pg_get_functiondef('public.function_execute_leaks()'::regprocedure);
-- against a database with every prior migration applied (the newest restatement is
-- 20260906153732, NOT 20260906151902 or 20260906121901 -- check, do not assume).
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
      'start_operation_interval', 'close_operation_interval',
      'cancel_operation_interval', 'pause_operation_interval',
      'void_open_intervals_for_operation',
      'get_operation_actuals', 'get_open_intervals',
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
      --  added 20260826010648)
      'next_order_number', 'get_running_operation_ids_for_station'
    )
  ORDER BY 1, 2;
$$;
