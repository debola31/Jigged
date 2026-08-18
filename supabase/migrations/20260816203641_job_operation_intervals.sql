-- Operator cycle-time capture: chained work-centre intervals, editable with provenance.
--
-- REVERSES A DELIBERATE DECISION, and says so. 20260621132129 dropped
-- operator_sessions and job_operations.actual_*; 20260708225938 dropped
-- job_operations.started_at as "WRITE-ONLY ... nothing ever read it" after it had
-- survived as a zombie for 17 days. docs/modules/operator-view.md wrote the
-- reversal condition in advance: "Capturing actual time and showing it to the
-- operator is the trigger that reverses that decision." This is that trigger,
-- taken knowingly. What survives from the original decision is its EVIDENCE —
-- manual real-time tracking is unreliable — and it is why the model below chains
-- rather than asking for a Stop, and never invents an end.
--
-- EVERY TIMESTAMP HERE HAS A READER IN THIS SAME PR (the operator's journal, the
-- office Still-running list, and the per-operation actual-vs-estimate rollup), so
-- the started_at zombie does not recur.
--
-- ── The four decisions this schema encodes ───────────────────────────────────
--
-- 1. THE CHAIN KEY IS THE WORK CENTRE, NOT THE OPERATOR. Cost is charged at
--    work_centers.labor_rate through job_operations.work_center_id /
--    labor_rate_snapshot — we cost MACHINE time, not operator attention. Keyed on
--    the operator, a machinist tending three spindles would have OP 30 on Mill-2
--    silently closed the moment they tapped into OP 40 on Lathe-1: not a
--    forgotten-stop correction, a FABRICATED stop, and the modal shape of a
--    precision shop. Keyed on the work centre, three spindles are three truthful
--    open intervals and the operator is an attribute of each.
--
-- 2. RAW AND ADJUSTED ARE SEPARATE COLUMNS, and the raw pair is immutable. This is
--    E2/Shoptech's model — "Actual Clock In/Out" beside "Adjusted Clock In/Out",
--    only Adjusted editable, only Adjusted feeding payroll. effective_* is
--    GENERATED so the read path has ONE shape and no "if adjusted is null" branch
--    anywhere in the access layer.
--
-- 3. WRITES ARE RPC-ONLY. The chain close crosses row ownership — a shift handoff,
--    where operator B starts on the machine A forgot to close, is routine and not
--    an edge case. Under an own-rows UPDATE policy B is blocked by the unique
--    index and denied by RLS: a dead end. And close-then-insert from the browser
--    is two statements, so it is not atomic. Both problems have one fix, and it is
--    start_operation_interval() below.
--
-- 4. AN OPEN INTERVAL IS NEVER AUTO-CLOSED. Fabricating an end is a silent runtime
--    fallback for a data-at-rest problem (CLAUDE.md). Open intervals stay open,
--    loud on the office Still-running list, and excluded from every rollup until a
--    human says when it actually ended.
--
-- NOT IN THIS MIGRATION, deliberately: no setup/run phase column. An 18-vendor
-- sweep found nobody shipping a SETUP/RUN toggle inside a running timer — it is a
-- UI mode that fails silently into the office's numbers. The split is solvable
-- office-side from data this table already produces (T = setup + q x cycle across
-- runs of the same part-operation, with the existing estimates as priors), which
-- costs zero operator taps. Adding a phase column now would be a second zombie.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. THE TABLE
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE public.job_operation_intervals (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    job_operation_id uuid NOT NULL,
    -- denormalized-from-operation, matching job_operation_completions.
    job_part_id uuid NOT NULL,

    -- THE CHAIN KEY. Nullable: an ad-hoc operation carries no work centre, and
    -- those fall back to a per-operator chain (see the second unique index).
    work_center_id uuid,

    -- AN ATTRIBUTE OF THE INTERVAL, NEVER ITS KEY. See decision 1 in the header.
    -- user_company_access(id), like notes.author_id — NOT auth.users(id) — because
    -- get_operator_access_id() is what every policy and RPC here resolves.
    operator_id uuid NOT NULL,

    -- ── RAW: what actually happened, server-stamped, immutable ────────────────
    -- No browser role can write either of these (section 3), and the guard trigger
    -- in section 5 refuses it a second way. They are the record the adjusted pair
    -- exists to sit BESIDE rather than overwrite.
    started_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz,

    -- ── ADJUSTED: the operator's correction. NULL = untouched ─────────────────
    adjusted_started_at timestamptz,
    adjusted_ended_at timestamptz,
    -- NOT NAMED updated_at, and that is not bikeshedding (same reasoning as
    -- notes.edited_at, 20260801012019): this column is a CLAIM MADE TO OTHER
    -- READERS — "these are not the times that were recorded" — rather than
    -- bookkeeping. Naming it updated_at invites a future generic touch trigger to
    -- set it on a write that is not an adjustment, at which point it starts lying.
    -- This table HAS an updated_at, and they mean different things on purpose.
    adjusted_at timestamptz,
    adjusted_by uuid,

    -- ── EFFECTIVE: the single-shape read path ─────────────────────────────────
    -- Generated, so no caller anywhere can forget the COALESCE and read the raw
    -- value as though it were the corrected one. Costing, the rollups and the
    -- journal all read effective_*; only the audit surfaces read the raw pair.
    effective_started_at timestamptz
        GENERATED ALWAYS AS (COALESCE(adjusted_started_at, started_at)) STORED,
    effective_ended_at timestamptz
        GENERATED ALWAYS AS (COALESCE(adjusted_ended_at, ended_at)) STORED,

    -- How the interval ended, and there are only two ways. 'completed' is the
    -- operator recording what they finished; 'switched' is the chain closing this
    -- one because the next start took the work centre.
    --
    -- No 'done_for_day' and no 'left_running'. Both were built and removed: they
    -- asked the operator to classify a stop, which is a second decision on top of
    -- the one that matters, and an interval left open is already legible as
    -- exactly that on the office Still-running list. An operator who walks away
    -- leaves it running and corrects the times from the job feed afterwards.
    close_reason text,

    -- Ships now, with a reader now, so sensor rows land in THIS shape rather than
    -- needing a parallel table later. An interval left open overnight is exactly
    -- where a sensor interval will contradict a labour one, and without a common
    -- shape there is nothing to express the disagreement in.
    capture_source text NOT NULL DEFAULT 'operator',

    -- WHICH COMPLETION CLOSED THIS INTERVAL. Set by close_operation_interval;
    -- NULL on an interval the chain closed ('switched') or one still running.
    --
    -- Two things need it. The feed's "Finished …" row shows the quantity that
    -- was recorded, which is only knowable through this link. And voiding a
    -- completion has to void the time it closed (see the trigger in section 5),
    -- which needs to know WHICH intervals belong to it — a per-operation sweep
    -- would also discard 'switched' intervals, and those are real work that no
    -- completion ever claimed.
    completion_id uuid,

    note text,

    -- Correction of last resort, mirroring job_operation_completions: void, never
    -- delete. Filtered everywhere from day one.
    voided_at timestamptz,
    voided_by uuid,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT job_operation_intervals_pkey PRIMARY KEY (id),

    CONSTRAINT job_op_intervals_capture_source_check
        CHECK (capture_source IN ('operator', 'sensor', 'system')),
    CONSTRAINT job_op_intervals_close_reason_check
        CHECK (close_reason IS NULL OR close_reason IN ('completed', 'switched')),
    -- A closed interval has a reason and an open one does not: the two columns are
    -- one fact and may not disagree.
    CONSTRAINT job_op_intervals_close_reason_iff_ended
        CHECK ((ended_at IS NULL) = (close_reason IS NULL)),
    CONSTRAINT job_op_intervals_ordered
        CHECK (ended_at IS NULL OR ended_at > started_at),
    CONSTRAINT job_op_intervals_adjusted_ordered
        CHECK (adjusted_ended_at IS NULL
               OR COALESCE(adjusted_started_at, started_at) < adjusted_ended_at),
    -- An adjusted END may only exist on a closed interval: otherwise
    -- effective_ended_at would claim a finish that never happened.
    --
    -- An adjusted START is deliberately allowed WHILE RUNNING. "I actually
    -- started twenty minutes before I tapped" is the single most common
    -- correction there is, and it is knowable immediately — making the operator
    -- wait until they finish to record it means holding it in their head, which
    -- is how it turns into a recall estimate. An earlier draft of this constraint
    -- blocked both and made the feed's Adjust affordance unimplementable on a
    -- running interval.
    CONSTRAINT job_op_intervals_adjusted_end_only_when_closed
        CHECK (ended_at IS NOT NULL OR adjusted_ended_at IS NULL),
    CONSTRAINT job_op_intervals_note_not_blank
        CHECK (note IS NULL OR length(btrim(note)) > 0),

    CONSTRAINT job_op_intervals_company_fk FOREIGN KEY (company_id)
        REFERENCES public.companies(id) ON DELETE CASCADE,
    CONSTRAINT job_op_intervals_operation_fk FOREIGN KEY (job_operation_id)
        REFERENCES public.job_operations(id) ON DELETE CASCADE,
    CONSTRAINT job_op_intervals_job_part_fk FOREIGN KEY (job_part_id)
        REFERENCES public.job_parts(id) ON DELETE CASCADE,
    -- RESTRICT, unlike the CASCADEs above: work centres are archived
    -- (deleted_at), never hard-deleted, and a hard delete that silently took the
    -- shop's time history with it would be a data-loss path with no warning.
    CONSTRAINT job_op_intervals_work_center_fk FOREIGN KEY (work_center_id)
        REFERENCES public.work_centers(id) ON DELETE RESTRICT,
    CONSTRAINT job_op_intervals_operator_fk FOREIGN KEY (operator_id)
        REFERENCES public.user_company_access(id) ON DELETE CASCADE,
    -- SET NULL, not CASCADE: completions are voided rather than deleted, so this
    -- only fires if one is ever hard-deleted — and losing the link should not
    -- silently delete the record of time somebody worked.
    CONSTRAINT job_op_intervals_completion_fk FOREIGN KEY (completion_id)
        REFERENCES public.job_operation_completions(id) ON DELETE SET NULL,
    CONSTRAINT job_op_intervals_adjusted_by_fk FOREIGN KEY (adjusted_by)
        REFERENCES public.user_company_access(id) ON DELETE SET NULL,
    CONSTRAINT job_op_intervals_voided_by_fk FOREIGN KEY (voided_by)
        REFERENCES public.user_company_access(id) ON DELETE SET NULL
);

-- ── THE CHAIN INVARIANT, ENFORCED STRUCTURALLY ───────────────────────────────
-- With RPC-only writes these are defence in depth rather than the primary
-- mechanism — start_operation_interval() closes before it inserts, so it never
-- collides. They stay because they make an overlap at one work centre
-- UNREPRESENTABLE: a future caller that forgets the close gets an error rather
-- than two rows claiming the same machine was running two jobs at once.
CREATE UNIQUE INDEX job_op_intervals_one_open_per_work_center
    ON public.job_operation_intervals (company_id, work_center_id)
    WHERE ended_at IS NULL AND voided_at IS NULL AND work_center_id IS NOT NULL;

-- Ad-hoc operations have no work centre, so there is no machine to serialize on.
-- Fall back to the operator: one open ad-hoc interval per person. (A plain
-- multi-column index would not do it — SQL NULLs are distinct, so every
-- null-work-centre row would be unique against every other.)
CREATE UNIQUE INDEX job_op_intervals_one_open_adhoc
    ON public.job_operation_intervals (company_id, operator_id)
    WHERE ended_at IS NULL AND voided_at IS NULL AND work_center_id IS NULL;

CREATE INDEX idx_job_op_intervals_operation
    ON public.job_operation_intervals (job_operation_id)
    WHERE voided_at IS NULL;
-- The operator's own journal: their rows, newest first.
CREATE INDEX idx_job_op_intervals_operator_recent
    ON public.job_operation_intervals (company_id, operator_id, effective_started_at DESC)
    WHERE voided_at IS NULL;
-- The office Still-running list.
CREATE INDEX idx_job_op_intervals_open
    ON public.job_operation_intervals (company_id, started_at)
    WHERE ended_at IS NULL AND voided_at IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. THE PER-PERSON ACCESS LOG
-- ═══════════════════════════════════════════════════════════════════════════════
-- Owner reports are aggregate by default; resolving time to a NAMED person is a
-- deliberate, reason-coded act that leaves a record. That is not decoration: the
-- documented failure mode of shop-floor time capture is that reported times drift
-- toward the estimate once operators know the numbers are read per person, at
-- which point the estimating loop reads its own assumptions back as evidence.
-- Making per-person access possible but visible is what keeps the data honest
-- without pretending the owner never has a legitimate need.
CREATE TABLE public.operator_time_access_log (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    accessed_by uuid NOT NULL,
    subject_operator_id uuid NOT NULL,
    reason text NOT NULL,
    accessed_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT operator_time_access_log_pkey PRIMARY KEY (id),
    CONSTRAINT operator_time_access_log_reason_not_blank
        CHECK (length(btrim(reason)) > 0),
    CONSTRAINT operator_time_access_log_company_fk FOREIGN KEY (company_id)
        REFERENCES public.companies(id) ON DELETE CASCADE,
    CONSTRAINT operator_time_access_log_actor_fk FOREIGN KEY (accessed_by)
        REFERENCES public.user_company_access(id) ON DELETE CASCADE,
    CONSTRAINT operator_time_access_log_subject_fk FOREIGN KEY (subject_operator_id)
        REFERENCES public.user_company_access(id) ON DELETE CASCADE
);

CREATE INDEX idx_operator_time_access_log_company
    ON public.operator_time_access_log (company_id, accessed_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. GRANTS
-- ═══════════════════════════════════════════════════════════════════════════════
-- Stated from scratch so the whole intended privilege set reads in one place.
-- REVOKE first, or the column-scoped UPDATE is taken straight back off again.
ALTER TABLE public.job_operation_intervals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operator_time_access_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.job_operation_intervals FROM anon, authenticated;

-- SELECT only. NO INSERT: starting and closing are start_operation_interval() and
-- close_operation_interval(), because both must cross row ownership or be atomic.
GRANT SELECT ON public.job_operation_intervals TO authenticated;

-- THE ONLY BROWSER-WRITABLE COLUMNS, and the grant NAMES them rather than
-- excluding a list — so a column added to this table next year is non-updatable by
-- default instead of needing someone to remember a denylist.
--
-- ended_at IS DELIBERATELY ABSENT and that is the load-bearing omission. If the
-- browser could write ended_at, an operator could rewrite the raw close time
-- directly and adjusted_ended_at would have no purpose: the pair would be only
-- half immutable, and the provenance this whole table exists to keep would be
-- provenance of nothing. Same for started_at, capture_source and close_reason.
-- adjusted_at / adjusted_by are absent too — section 5 stamps them, and the one
-- party with a motive to suppress an adjustment marker must not be able to write it.
GRANT UPDATE (adjusted_started_at, adjusted_ended_at, note)
    ON public.job_operation_intervals TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_operation_intervals TO service_role;

-- The access log is written only by get_operator_time_detail() (SECURITY DEFINER)
-- and read only by service_role. A browser role that could INSERT here could
-- manufacture a plausible audit trail; one that could SELECT could enumerate who
-- has been looked at.
REVOKE ALL ON public.operator_time_access_log FROM anon, authenticated;
GRANT SELECT, INSERT ON public.operator_time_access_log TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. POLICIES
-- ═══════════════════════════════════════════════════════════════════════════════
-- THIS IS WHERE "AGGREGATE BY DEFAULT" GETS TEETH, and it is a policy decision
-- rather than a UI one on purpose. A SELECT policy that exposed operator_id to
-- admins WOULD BE a per-person report — PostgREST hands them the grouping for
-- free — so there is no admin-readable path to these rows at all. Office
-- reporting goes through the definer functions in section 6, which return no
-- operator identity, and the one function that does return it logs every call.
-- Same reasoning as note_views (20260728040701), one step less absolute: an
-- operator may always read their own rows, because withholding a worker's own
-- punches while the office reviews them is itself an asymmetry.

CREATE POLICY job_op_intervals_select_own ON public.job_operation_intervals
    FOR SELECT TO authenticated
    USING (
      company_id IN (SELECT public.get_user_company_ids())
      AND operator_id = public.get_operator_access_id(company_id)
    );

-- No INSERT policy: there is no INSERT grant to attach one to.

CREATE POLICY job_op_intervals_update_own ON public.job_operation_intervals
    FOR UPDATE TO authenticated
    USING (
      company_id IN (SELECT public.get_user_company_ids())
      AND operator_id = public.get_operator_access_id(company_id)
      AND voided_at IS NULL
    )
    WITH CHECK (
      company_id IN (SELECT public.get_user_company_ids())
      AND operator_id = public.get_operator_access_id(company_id)
    );

-- The billing gate. It creates a billing_gate_insert policy that will never be
-- evaluated (there is no INSERT grant), which is harmless and is also what
-- tenant_tables_missing_write_gate() looks for — so this table is covered by the
-- CI guard rather than needing an entry on its exempt list. The RPCs in section 6
-- call company_can_write() THEMSELVES, because SECURITY DEFINER bypasses RLS and
-- would otherwise bypass this gate silently.
SELECT public.apply_billing_write_gate('public.job_operation_intervals');

-- operator_time_access_log is DELIBERATELY NOT GATED, and the distinction is the
-- one 20260801150944 drew when it REMOVED part_location_stock from the exempt
-- list. That table holds tenant data — stock levels, the thing the shop pays for
-- — written from the browser through a definer RPC, so exempting it hid #645.
--
-- This one is an AUDIT RECORD with no browser write path at all: the grants below
-- give INSERT to service_role only, so the gate would never be evaluated. Same
-- family as note_views and operator_events, which are exempt for exactly this
-- reason.
--
-- And gating it would be actively harmful rather than merely useless. The write
-- is incidental to a READ, and reads stay open when billing lapses. A gate here
-- would mean a lapsed shop either cannot look at all, or looks WITHOUT the look
-- being recorded — and an audit log that stops writing precisely when the
-- account is in trouble is the worst version of this table.
--
-- It is added to the exempt list below rather than left to fail the CI guard.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. THE GUARD TRIGGER
-- ═══════════════════════════════════════════════════════════════════════════════
-- Backstop for the column-scoped grant above, in the shape
-- notes_restrict_update_to_body() established (20260801012019): stamp first for
-- every role, then restrict columns for browser roles only.
--
-- THREE SUBTRACTIONS IN THE DIFF, AND EVERY ONE IS LOAD-BEARING:
--
--   * adjusted_at / adjusted_by — we set them ourselves, immediately above.
--   * updated_at — set by the moddatetime-style trigger on this table. Same-level
--     BEFORE ROW triggers fire in ALPHABETICAL ORDER BY TRIGGER NAME, so whether
--     this guard sees updated_at already touched is a name-collation accident.
--     Subtracting removes the accident. (The notes equivalent could skip this only
--     because that table has no updated_at; ours does, deliberately, beside
--     adjusted_at.)
--   * effective_started_at / effective_ended_at — GENERATED columns are computed
--     AFTER all BEFORE triggers, so NEW.effective_* is NULL in here while
--     OLD.effective_* holds the stored value. Without the subtraction the diff
--     would ALWAYS differ and EVERY adjustment would raise. This is not a
--     hypothetical: it is the first thing that breaks if someone "tidies" the
--     subtraction list.
CREATE OR REPLACE FUNCTION public.job_op_intervals_restrict_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  -- ── THE STAMP: every role, no exceptions ────────────────────────────────────
  -- Before the role check, and that ordering is the correctness of this function.
  -- An adjustment made by anything other than the browser — the backend, a data
  -- fix, a future admin tool — must still mark the row adjusted. A marker that is
  -- absent when the values DID change is worse than no marker: it is the column
  -- asserting "these are the recorded times" about times that are not.
  --
  -- Fires only on an ACTUAL change, so re-saving identical values is not an
  -- adjustment and the marker never appears for nothing.
  IF NEW.adjusted_started_at IS DISTINCT FROM OLD.adjusted_started_at
     OR NEW.adjusted_ended_at IS DISTINCT FROM OLD.adjusted_ended_at THEN
    NEW.adjusted_at := now();
    NEW.adjusted_by := COALESCE(
      public.get_operator_access_id(NEW.company_id),
      OLD.adjusted_by
    );
  ELSE
    NEW.adjusted_at := OLD.adjusted_at;
    NEW.adjusted_by := OLD.adjusted_by;
  END IF;

  -- ── THE COLUMN RESTRICTION: browser roles only ──────────────────────────────
  -- The RPCs below run as the table owner and the backend runs as service_role;
  -- neither is the threat model, and blocking either would break closing an
  -- interval entirely. current_user is the discriminator rather than role
  -- membership, because in Supabase postgres is a member of authenticated.
  IF current_user IN ('anon', 'authenticated') THEN
    IF (to_jsonb(OLD) - 'adjusted_started_at' - 'adjusted_ended_at' - 'note'
                      - 'adjusted_at' - 'adjusted_by' - 'updated_at'
                      - 'effective_started_at' - 'effective_ended_at')
       IS DISTINCT FROM
       (to_jsonb(NEW) - 'adjusted_started_at' - 'adjusted_ended_at' - 'note'
                      - 'adjusted_at' - 'adjusted_by' - 'updated_at'
                      - 'effective_started_at' - 'effective_ended_at')
    THEN
      RAISE EXCEPTION 'Only the adjusted times and note can be edited on a recorded interval';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.job_op_intervals_restrict_update() IS
  'Backstop for the column-scoped UPDATE grant on public.job_operation_intervals: refuses any browser UPDATE touching a column other than adjusted_started_at/adjusted_ended_at/note, and stamps adjusted_at/adjusted_by itself. The raw started_at/ended_at pair is the record the adjusted pair sits beside; if either became writable the provenance would be provenance of nothing.';

-- Named with a leading z so it sorts AFTER the updated_at touch trigger, making
-- the firing order deterministic rather than a collation accident. The diff
-- subtracts updated_at anyway — belt and braces, because the failure mode of
-- getting this wrong is every adjustment being rejected.
CREATE TRIGGER job_op_intervals_updated_at
    BEFORE UPDATE ON public.job_operation_intervals
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

/**
 * Voiding a completion voids the time it closed.
 *
 * DECIDED 2026-08-18: Undo means "that did not happen", so the interval goes
 * with the completion rather than surviving as an orphan claiming work that was
 * retracted. Without this, repeatedly recording and undoing left a growing stack
 * of "Finished …" rows in the job feed — and once those rows carry the recorded
 * QUANTITY, an orphan is not merely clutter, it is a false statement about
 * production.
 *
 * The cost, accepted knowingly: real measured minutes are discarded because a
 * COUNT was wrong. An operator who typed 10 instead of 12 loses the timing of
 * work they genuinely did, and re-recording produces a fresh, shorter interval
 * that understates it.
 *
 * A TRIGGER RATHER THAN CLIENT CODE, for two reasons. It is atomic with the void
 * — there is no window where the completion is retracted and its time is not.
 * And `revertOperationCompletion` is called from BOTH the operator undo and the
 * office-side undo, so putting it here means neither caller has to know, and a
 * third caller added later cannot forget.
 *
 * Scoped by completion_id, NOT by operation. A per-operation sweep would also
 * void 'switched' intervals, which are real work that no completion ever claimed
 * and that no undo is retracting.
 */
CREATE OR REPLACE FUNCTION public.void_intervals_with_completion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  -- TRANSLATE the actor; do NOT copy it. The two voided_by columns are not the
  -- same kind of id, which is easy to miss because they share a name:
  -- job_operation_completions.voided_by holds an auth.users id and carries no FK
  -- at all, while this table's voided_by references user_company_access(id) so
  -- that it lines up with operator_id. Copying one into the other raises 23503,
  -- which PostgREST returns as 409. The whole UPDATE aborts, so the UNDO ITSELF
  -- fails: the completion stays, the time stays, and the operator gets
  -- "Failed to undo that completion." with nothing they can do about it.
  --
  -- NULL when the actor holds no membership row for this company (a system admin
  -- undoing on someone's behalf). That is already a representable state — the FK
  -- is ON DELETE SET NULL — and voided_at still records that it was retracted.
  UPDATE public.job_operation_intervals
     SET voided_at = NEW.voided_at,
         voided_by = (
           SELECT uca.id
             FROM public.user_company_access uca
            WHERE uca.company_id = NEW.company_id
              AND uca.user_id    = NEW.voided_by
            LIMIT 1
         )
   WHERE completion_id = NEW.id
     AND voided_at IS NULL;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.void_intervals_with_completion() IS
  'Voids the time intervals a completion closed, when that completion is voided. Undo means "that did not happen", and an interval left behind would claim production that was retracted. Scoped by completion_id so ''switched'' intervals — real work no completion claimed — survive.';

-- AFTER UPDATE OF voided_at, and only on the transition into voided. Completions
-- are never un-voided, so there is no inverse to handle.
CREATE TRIGGER job_operation_completions_void_intervals
    AFTER UPDATE OF voided_at ON public.job_operation_completions
    FOR EACH ROW
    WHEN (OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL)
    EXECUTE FUNCTION public.void_intervals_with_completion();

REVOKE EXECUTE ON FUNCTION public.void_intervals_with_completion()
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.void_intervals_with_completion() TO service_role;

CREATE TRIGGER zz_job_op_intervals_restrict_update
    BEFORE UPDATE ON public.job_operation_intervals
    FOR EACH ROW EXECUTE FUNCTION public.job_op_intervals_restrict_update();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. THE RPCs
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 6a. START ────────────────────────────────────────────────────────────────
-- Closes whatever was open at this work centre — REGARDLESS OF OWNER — and opens
-- the new interval, in one statement.
--
-- Crossing ownership is the POINT, not a compromise. The shift handoff is the
-- routine case: A forgets to close on Mill-2, B walks up and starts the next job.
-- Under an own-rows rule B is blocked by the unique index and denied by RLS with
-- no way forward. A's row closes as 'switched' and is flagged for correction —
-- and it is the OWNER who corrects it from the Still-running list, never B,
-- because B does not know when A stopped.
CREATE OR REPLACE FUNCTION public.start_operation_interval(p_job_operation_id uuid)
RETURNS TABLE(interval_id uuid, started_at timestamptz, server_now timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_company_id uuid;
    v_job_part_id uuid;
    v_work_center_id uuid;
    v_work_center_kind text;
    v_operator_id uuid;
    v_new_id uuid;
    v_started timestamptz;
BEGIN
    SELECT jp.company_id, o.job_part_id, o.work_center_id, wc.kind
      INTO v_company_id, v_job_part_id, v_work_center_id, v_work_center_kind
      FROM public.job_operations o
      JOIN public.job_parts jp ON jp.id = o.job_part_id
      LEFT JOIN public.work_centers wc ON wc.id = o.work_center_id
     WHERE o.id = p_job_operation_id;

    IF v_company_id IS NULL THEN
        RAISE EXCEPTION 'Operation not found';
    END IF;

    -- Membership. SECURITY DEFINER bypasses RLS, so this is the only thing
    -- standing between a caller and another company's data.
    v_operator_id := public.get_operator_access_id(v_company_id);
    IF v_operator_id IS NULL THEN
        RAISE EXCEPTION 'You do not have access to this company';
    END IF;

    -- THE BILLING GATE, BY HAND. company_can_write is enforced through a
    -- RESTRICTIVE RLS policy, and SECURITY DEFINER bypasses RLS — so without this
    -- line a lapsed shop could still write, and test_no_tenant_table_left_ungated
    -- would not catch it, because the TABLE is gated. The bypass is the hole, not
    -- the table.
    IF NOT public.company_can_write(v_company_id) THEN
        RAISE EXCEPTION 'Your subscription is not active (billing_gate_insert)'
            USING ERRCODE = '42501';
    END IF;

    -- Outside (external-vendor) operations are done off-site and use the
    -- send/receive lifecycle, never a clock. Mirrors the guard in
    -- createOperationCompletion (utils/operationCompletionsAccess.ts).
    IF v_work_center_kind = 'external' THEN
        RAISE EXCEPTION 'This is an outside (vendor) operation — it has no shop time to record.';
    END IF;

    -- Close whatever holds this chain slot. Two branches because the ad-hoc chain
    -- keys on the operator instead of the machine, exactly matching the two
    -- partial unique indexes.
    IF v_work_center_id IS NOT NULL THEN
        UPDATE public.job_operation_intervals
           SET ended_at = now(), close_reason = 'switched'
         WHERE company_id = v_company_id
           AND work_center_id = v_work_center_id
           AND ended_at IS NULL
           AND voided_at IS NULL;
    ELSE
        UPDATE public.job_operation_intervals
           SET ended_at = now(), close_reason = 'switched'
         WHERE company_id = v_company_id
           AND operator_id = v_operator_id
           AND work_center_id IS NULL
           AND ended_at IS NULL
           AND voided_at IS NULL;
    END IF;

    INSERT INTO public.job_operation_intervals
        (company_id, job_operation_id, job_part_id, work_center_id, operator_id)
    VALUES
        (v_company_id, p_job_operation_id, v_job_part_id, v_work_center_id, v_operator_id)
    RETURNING id, job_operation_intervals.started_at INTO v_new_id, v_started;

    RETURN QUERY SELECT v_new_id, v_started, now();
END;
$$;

COMMENT ON FUNCTION public.start_operation_interval(uuid) IS
  'Opens a time interval on an operation, atomically closing whatever was open at the same work centre (close_reason=''switched'') regardless of who owned it — the shift handoff is routine, and an own-rows rule would dead-end it. Returns the new id, its server started_at, and now() so the client can compute clock skew rather than trusting the phone. Enforces company membership, company_can_write (RLS is bypassed here) and the external-op exclusion itself.';

-- ── 6b. CLOSE ────────────────────────────────────────────────────────────────
-- THE ONLY EXPLICIT CLOSE: recording what was finished. 'switched' belongs to
-- the chain and only start_ writes it.
--
-- OWNERSHIP IS ASSERTED IN-FUNCTION, and the asymmetry with start_ is deliberate.
-- start_ crosses ownership because the machine has to be usable by the next
-- person. An explicit close carries adjusted times and a note, so without this
-- check any member could rewrite anyone's recorded hours by id, with RLS bypassed
-- and nothing to stop them.
CREATE OR REPLACE FUNCTION public.close_operation_interval(
    p_interval_id uuid,
    p_completion_id uuid DEFAULT NULL,
    p_adjusted_started_at timestamptz DEFAULT NULL,
    p_adjusted_ended_at timestamptz DEFAULT NULL,
    p_note text DEFAULT NULL
)
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

    -- Idempotent: closing an already-closed interval is a no-op rather than an
    -- error. A gloved double-tap and a retry after a dropped cellular response
    -- both land here, and neither is a mistake worth surfacing.
    IF v_company_id IS NULL THEN
        RETURN;
    END IF;

    v_operator_id := public.get_operator_access_id(v_company_id);
    IF v_operator_id IS NULL OR v_operator_id IS DISTINCT FROM v_owner_id THEN
        RAISE EXCEPTION 'You can only close an interval you started';
    END IF;

    IF NOT public.company_can_write(v_company_id) THEN
        RAISE EXCEPTION 'Your subscription is not active (billing_gate_update)'
            USING ERRCODE = '42501';
    END IF;

    UPDATE public.job_operation_intervals
       SET ended_at = now(),
           close_reason = 'completed',
           completion_id = p_completion_id,
           adjusted_started_at = p_adjusted_started_at,
           adjusted_ended_at = p_adjusted_ended_at,
           note = NULLIF(btrim(COALESCE(p_note, '')), '')
     WHERE id = p_interval_id;
END;
$$;

COMMENT ON FUNCTION public.close_operation_interval(uuid, uuid, timestamptz, timestamptz, text) IS
  'Closes an interval as completed, with optional adjusted times and note. Asserts the caller OWNS the interval — unlike start_operation_interval, which crosses ownership by design — because with RLS bypassed an unchecked id parameter would let any member rewrite anyone''s recorded hours. Idempotent on an already-closed interval so a double-tap or a retry is not an error.';

-- ── 6c. AGGREGATE READ: actual vs estimate, per operation ────────────────────
-- The office reporting path, and it returns NO OPERATOR IDENTITY. That is the
-- whole reason it exists rather than a SELECT policy for admins.
--
-- OPEN INTERVALS ARE EXCLUDED, not estimated. An interval with no end has no
-- duration, and inventing one — clamping to now(), to a shift length, to
-- anything — would be a silent runtime fallback for a data-at-rest problem. The
-- honest report is "3h 20m recorded, 1 interval still open", which is what
-- open_count is for.
CREATE OR REPLACE FUNCTION public.get_operation_actuals(p_job_operation_ids uuid[])
RETURNS TABLE(
    job_operation_id uuid,
    actual_minutes numeric,
    interval_count integer,
    open_count integer,
    adjusted_count integer,
    first_started_at timestamptz,
    last_ended_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT i.job_operation_id,
         ROUND(SUM(
           CASE WHEN i.effective_ended_at IS NOT NULL
                THEN EXTRACT(EPOCH FROM (i.effective_ended_at - i.effective_started_at)) / 60
                ELSE 0 END
         )::numeric, 2)                                                   AS actual_minutes,
         COUNT(*) FILTER (WHERE i.effective_ended_at IS NOT NULL)::int    AS interval_count,
         COUNT(*) FILTER (WHERE i.ended_at IS NULL)::int                  AS open_count,
         COUNT(*) FILTER (WHERE i.adjusted_at IS NOT NULL)::int           AS adjusted_count,
         MIN(i.effective_started_at)                                      AS first_started_at,
         MAX(i.effective_ended_at)                                        AS last_ended_at
    FROM public.job_operation_intervals i
   WHERE i.job_operation_id = ANY(p_job_operation_ids)
     AND i.voided_at IS NULL
     -- Membership, re-derived per row rather than trusted from a parameter.
     AND i.company_id IN (SELECT public.get_user_company_ids())
   GROUP BY i.job_operation_id;
$$;

COMMENT ON FUNCTION public.get_operation_actuals(uuid[]) IS
  'Per-operation recorded time for the office, aggregated and carrying NO operator identity — which is why it exists instead of an admin SELECT policy, since a row-returning policy exposing operator_id would BE a per-person report. Open intervals are counted, never estimated: an interval with no end has no duration, and inventing one would be a silent fallback. Browser-callable: every job page reads it.';

-- ── 6d. THE STILL-RUNNING LIST ───────────────────────────────────────────────
-- The forgotten-stop detection channel, and the ONLY correction path for an
-- interval whose owner has gone home — close_operation_interval refuses a
-- non-owner, by design, so somebody has to be able to see it.
--
-- Also carries no operator identity. An open interval is a fact about a machine
-- ("Mill-2 has been running since Friday 4pm"), and that is the fact the office
-- needs to act on. Whose it was is a separate question with a separate, logged
-- function.
CREATE OR REPLACE FUNCTION public.get_open_intervals(p_company_id uuid)
RETURNS TABLE(
    interval_id uuid,
    job_operation_id uuid,
    job_id uuid,
    job_number text,
    part_name text,
    operation_name text,
    work_center_name text,
    started_at timestamptz,
    capture_source text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT i.id, i.job_operation_id, j.id, j.job_number, p.part_name,
         o.operation_name, wc.name, i.started_at, i.capture_source
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

COMMENT ON FUNCTION public.get_open_intervals(uuid) IS
  'Admin-only list of intervals that are still open, oldest first — the forgotten-stop detection channel, and the only route to an interval whose owner has gone home (close_operation_interval refuses a non-owner by design). Carries no operator identity: an open interval is a fact about a machine, and whose it was is a separate question answered by get_operator_time_detail, which logs.';

-- ── 6e. THE LOGGED PER-PERSON PATH ───────────────────────────────────────────
-- The one function here that returns operator identity, and it writes a row
-- saying who looked, at whom, and why, before it returns anything.
--
-- It ships now rather than "later, if needed" for a reason worth recording: an
-- owner who cannot get this number AT ALL will ask for a permissive view of the
-- underlying table, and that request is much harder to refuse than to pre-empt.
-- A narrow, logged, reason-coded door is what keeps the wide one shut.
CREATE OR REPLACE FUNCTION public.get_operator_time_detail(
    p_company_id uuid,
    p_operator_id uuid,
    p_reason text
)
RETURNS TABLE(
    interval_id uuid,
    job_operation_id uuid,
    operation_name text,
    job_number text,
    started_at timestamptz,
    ended_at timestamptz,
    effective_started_at timestamptz,
    effective_ended_at timestamptz,
    adjusted_at timestamptz,
    close_reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_actor uuid;
BEGIN
    IF NOT public.is_company_admin(p_company_id) THEN
        RAISE EXCEPTION 'Only an admin can view an individual''s recorded time';
    END IF;
    IF length(btrim(COALESCE(p_reason, ''))) = 0 THEN
        RAISE EXCEPTION 'A reason is required to view an individual''s recorded time';
    END IF;

    v_actor := public.get_operator_access_id(p_company_id);

    -- BEFORE the read, not after: a failure partway through must not produce an
    -- unlogged look at the data.
    INSERT INTO public.operator_time_access_log
        (company_id, accessed_by, subject_operator_id, reason)
    VALUES (p_company_id, v_actor, p_operator_id, btrim(p_reason));

    RETURN QUERY
      SELECT i.id, i.job_operation_id, o.operation_name, j.job_number,
             i.started_at, i.ended_at,
             i.effective_started_at, i.effective_ended_at,
             i.adjusted_at, i.close_reason
        FROM public.job_operation_intervals i
        JOIN public.job_operations o ON o.id = i.job_operation_id
        JOIN public.job_parts jp ON jp.id = i.job_part_id
        JOIN public.jobs j ON j.id = jp.job_id
       WHERE i.company_id = p_company_id
         AND i.operator_id = p_operator_id
         AND i.voided_at IS NULL
       ORDER BY i.effective_started_at DESC;
END;
$$;

COMMENT ON FUNCTION public.get_operator_time_detail(uuid, uuid, text) IS
  'The ONLY path that resolves recorded time to a named person. Admin-only, requires a non-blank reason, and writes an operator_time_access_log row BEFORE returning anything so a partial failure cannot yield an unlogged look. Exists so the narrow logged door stays open and the wide one — an admin SELECT policy on job_operation_intervals — stays shut.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. EXECUTE GRANTS
-- ═══════════════════════════════════════════════════════════════════════════════
-- FROM PUBLIC, anon, authenticated — not just PUBLIC, which does not work here:
-- the public schema still carries ALTER DEFAULT PRIVILEGES ... GRANT ALL ON
-- FUNCTIONS TO anon/authenticated, so a new function is created with an explicit
-- grant to both browser roles and REVOKE ... FROM PUBLIC does not remove it
-- (issue #640). Revoke first, then grant back exactly what is needed.
REVOKE EXECUTE ON FUNCTION public.start_operation_interval(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.close_operation_interval(uuid, uuid, timestamptz, timestamptz, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_operation_actuals(uuid[])
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_open_intervals(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_operator_time_detail(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.job_op_intervals_restrict_update()
  FROM PUBLIC, anon, authenticated;

-- authenticated only. anon gets nothing: every one of these runs signed in.
GRANT EXECUTE ON FUNCTION public.start_operation_interval(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.close_operation_interval(uuid, uuid, timestamptz, timestamptz, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_operation_actuals(uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_open_intervals(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_operator_time_detail(uuid, uuid, text) TO authenticated, service_role;
-- The guard trigger function needs no grant at all: permission on a trigger
-- function is checked when the trigger is CREATED, not when it fires.
GRANT EXECUTE ON FUNCTION public.job_op_intervals_restrict_update() TO service_role;

-- ── The CI allowlist ─────────────────────────────────────────────────────────
-- function_execute_leaks() (20260801024552) lists SECURITY DEFINER functions a
-- browser role can execute and that nobody has justified. Five new entries, and
-- CLAUDE.md is explicit that adding one requires saying why in the PR:
--
--   start_operation_interval    — the operator taps a step; the chain close
--                                 crosses row ownership, which RLS cannot express.
--   close_operation_interval    — same write path; asserts ownership itself.
--   get_operation_actuals       — every job page reads it; returns no identity.
--   get_open_intervals          — the office Still-running list; admin-checked
--                                 inside; returns no identity.
--   get_operator_time_detail    — THE ONE THAT MATTERS. It is the only function in
--                                 this schema that resolves time to a named
--                                 person. It is browser-callable because the
--                                 owner's legitimate need is real and the
--                                 alternative is a permissive table policy with no
--                                 audit trail at all. It is admin-gated, demands a
--                                 reason, and logs before it reads. If a future
--                                 change removes any one of those three, it does
--                                 not belong on this list.
--
-- WARNING FOR WHOEVER EDITS THIS NEXT, because it cost a debugging cycle here:
-- this function has now been restated by TEN migrations, and CREATE OR REPLACE
-- takes the whole body. Basing a new version on the migration that FIRST created
-- it (20260801024552) silently deletes every entry added since — the first draft
-- of this file did exactly that, dropping bulk_put_away, mark_reactions_seen,
-- create_location_tree and apply_location_layout, and resurrecting two names
-- 20260802015101 had removed. The failure is invisible in review and only shows
-- up as a red test. Copy the LIVE definition
-- (SELECT pg_get_functiondef('public.function_execute_leaks()'::regprocedure))
-- from a database with every prior migration applied, then add your entries.
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
      -- Added HERE: operator cycle-time capture. See the block comment above this
      -- function for why each of the five needs to be browser-callable.
      'start_operation_interval', 'close_operation_interval',
      'get_operation_actuals', 'get_open_intervals', 'get_operator_time_detail',
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

-- ── The tenant-gate exempt list ──────────────────────────────────────────────
-- Restated from the LIVE definition (not from 20260726033616, which created it —
-- six migrations have amended the list since, and rebuilding from the original
-- would silently drop every later entry; see the warning above
-- function_execute_leaks). Only `operator_time_access_log` is added.
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
      -- Added HERE. An audit record of who looked at whose recorded time, written
      -- only by get_operator_time_detail and granted to service_role alone. The
      -- write is incidental to a read, and reads stay open when billing lapses —
      -- gating it would mean a lapsed shop either cannot look, or looks unlogged.
      -- NOTE the contrast with job_operation_intervals, which IS gated and whose
      -- two definer writers call company_can_write by hand: that one is tenant
      -- data, which is the line 20260801150944 drew.
      'operator_time_access_log'
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_policies p
      WHERE p.schemaname = 'public'
        AND p.tablename = c.relname
        AND p.policyname = 'billing_gate_insert'
    )
  ORDER BY 1;
$$;

-- ── The definer-writer exempt list ───────────────────────────────────────────
-- Restated from the LIVE definition in 20260801150944, which is the ONLY migration
-- that has ever defined this function — verified by grep across supabase/migrations,
-- so unlike function_execute_leaks above, rebasing here cannot silently drop a later
-- entry. Only `void_intervals_with_completion` is added.
--
-- Why it is exempt, in the same category as the two triggers already listed: it is
-- an AFTER UPDATE trigger on job_operation_completions, and that table carries
-- billing_gate_update (20260726033616) — RESTRICTIVE, FOR UPDATE, TO authenticated.
-- Undo is a plain browser `.update()` (utils/operationCompletionsAccess.ts), so a
-- lapsed shop is refused by RLS before the trigger can fire. It has no other caller:
-- EXECUTE is revoked from the browser roles and nothing invokes it directly.
--
-- The contrast with the two RPCs is the whole point. start_/close_operation_interval
-- are browser-callable SECURITY DEFINER entry points, so RLS never runs for them and
-- they call company_can_write by hand. This one is not an entry point; it only ever
-- runs downstream of a write that was already gated. Gating it again would re-check a
-- condition already proven, and the failure mode of the redundant check — a raise
-- inside the trigger — would abort a completion undo that RLS had already allowed.
CREATE OR REPLACE FUNCTION public.definer_writers_missing_write_gate()
RETURNS TABLE(function_name text)
LANGUAGE sql
STABLE
AS $$
  WITH gated AS (
    SELECT DISTINCT tablename FROM pg_policies
    WHERE schemaname = 'public' AND policyname = 'billing_gate_insert'
  )
  SELECT p.proname::text
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prokind = 'f'
    AND p.prosecdef
    AND EXISTS (
      SELECT 1 FROM gated g
      WHERE pg_get_functiondef(p.oid) ~* ('(insert into|update)\s+(public\.)?' || g.tablename)
    )
    AND pg_get_functiondef(p.oid) NOT LIKE '%company_can_write%'
    AND pg_get_functiondef(p.oid) NOT LIKE '%inv_assert_can_write%'
    AND p.proname NOT IN (
      -- triggers: the statement that fired them was gated
      'auto_track_stocked_part', 'note_views_bump_counts',
      'void_intervals_with_completion',
      -- internal helpers: no browser EXECUTE, always called post-assertion
      'inv_get_or_create_unassigned', 'recompute_part_quantity_from_locations',
      'enable_location_tracking_for_company',
      -- demo bootstrap: company_can_write() is true for is_demo by design
      'seed_demo_data',
      -- known gap, filed separately: browser-callable, genuinely ungated
      'create_shipment_with_line_items'
    )
  ORDER BY 1;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. COMMENTS
-- ═══════════════════════════════════════════════════════════════════════════════
COMMENT ON TABLE public.job_operation_intervals IS
  'Recorded time on an operation. Chained on the WORK CENTRE (cost is charged at work_centers.labor_rate, so this measures machine time, not operator attention): at most one open interval per work centre, enforced by a partial unique index, so the next start closes the previous one and an overlap is unrepresentable. started_at/ended_at are the raw record and immutable to browser roles; adjusted_* is the operator''s correction; effective_* is generated so every reader has one shape. Never auto-closed — an open interval stays open and excluded from rollups until a human says when it ended.';
COMMENT ON COLUMN public.job_operation_intervals.operator_id IS
  'Who was on it. An ATTRIBUTE, never the chain key — see the table comment. Not exposed by any aggregate reader; get_operator_time_detail is the only path that returns it, and it logs.';
COMMENT ON COLUMN public.job_operation_intervals.capture_source IS
  'operator | sensor | system. Ships with the operator path so sensor-derived intervals land in this same shape rather than a parallel table; an interval left open overnight is where the two will first disagree.';
COMMENT ON COLUMN public.job_operation_intervals.adjusted_at IS
  'When the times were last corrected. NULL = never. Deliberately not updated_at (which this table also has, for bookkeeping): this is a claim made to other readers. Stamped by the guard trigger and granted to no browser role.';
COMMENT ON TABLE public.operator_time_access_log IS
  'One row per call to get_operator_time_detail: who resolved recorded time to a named person, at whom, and why. Written before the read returns, so a partial failure cannot yield an unlogged look. Not readable or writable by any browser role.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- Reversibility (documentation — the branching pipeline is forward-only)
-- ═══════════════════════════════════════════════════════════════════════════════
-- Purely additive. NO BACKFILL IS POSSIBLE OR ATTEMPTED: there is no historical
-- interval data anywhere, and operations predating this genuinely have no recorded
-- time. The read path renders an explicit "no time recorded" rather than a
-- computed stand-in — Katana copies planned time into actual when a task closes,
-- and that fabricated number is later read back as measurement. Every existing row
-- satisfies the new invariant at rest, because the invariant is about rows in a
-- table that starts empty.
--
-- To revert, in a new migration:
--   DROP FUNCTION IF EXISTS public.get_operator_time_detail(uuid, uuid, text);
--   DROP FUNCTION IF EXISTS public.get_open_intervals(uuid);
--   DROP FUNCTION IF EXISTS public.get_operation_actuals(uuid[]);
--   DROP FUNCTION IF EXISTS public.close_operation_interval(uuid, uuid, timestamptz, timestamptz, text);
--   DROP FUNCTION IF EXISTS public.start_operation_interval(uuid);
--   DROP TRIGGER IF EXISTS job_operation_completions_void_intervals ON public.job_operation_completions;
--   DROP FUNCTION IF EXISTS public.void_intervals_with_completion();
--   DROP TABLE IF EXISTS public.job_operation_intervals;   -- takes its triggers
--   DROP FUNCTION IF EXISTS public.job_op_intervals_restrict_update();
--   DROP TABLE IF EXISTS public.operator_time_access_log;
--   -- and restore function_execute_leaks() to its 20260801024552 allowlist,
--   -- tenant_tables_missing_write_gate() and definer_writers_missing_write_gate()
--   -- to theirs (both restated above, minus the entries this file added).
--
-- Nothing outside this file depends on these objects: costing and quoting still
-- read only the estimated fields, exactly as 20260621132129 left them.
