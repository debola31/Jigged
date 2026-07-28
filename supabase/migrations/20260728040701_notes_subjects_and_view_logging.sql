-- Attribution and the read-back loop, Iteration A.
--
-- THE PROBLEM THIS SOLVES. Every note in Jigged is job-scoped: job_notes.job_id is
-- NOT NULL, so a note an operator writes at the machine dies with the job. Nothing in
-- the schema says "this is how you run this part at this step" — that knowledge is
-- reconstructed at READ time by getPartPreviousNotes(), a heuristic that walks up to 10
-- prior completed jobs and matches steps by routing_operation_id with an
-- operation_name fallback (~22 round trips). So a motivated operator has nowhere to put
-- knowledge that outlives the job.
--
-- This migration creates the durable, job-independent subject that makes a note worth
-- reading twice, and the view-logging that measures whether it gets read.
--
--   job_notes      -> notes         (+ subject columns, provenance, counters)
--   job_note_media -> note_media
--   part_notes     -> part_comments (RENAME ONLY — different domain, see below)
--   + note_views, note_reactions, operator_events
--
-- WHY part_comments IS NOT FOLDED IN. part_notes is the manual half of an office
-- activity feed that also carries system-generated pricing entries; its audience is
-- office staff, not the shop floor, and it needs none of the view logging, reactions,
-- confirmations, corrections or media that notes need. It is renamed purely to free the
-- `notes` name. Folding it in would attach view counts to pricing entries and force
-- every knowledge surface to remember to filter change-log rows — the same
-- silent-filter bug class as a forgotten `deleted_at IS NULL`.
--
-- PRIVACY IS THE POINT, not a side concern. note_views has NO client-reachable read
-- path at all: no SELECT grant, plus a RESTRICTIVE deny-all so a future well-meaning
-- permissive policy still evaluates false. Authors get names via one SECURITY DEFINER
-- function; everyone else gets counts via a column. Rationale for each choice is
-- inline. If a shop owner can audit who reads notes, reading becomes an admission of
-- ignorance and the read side dies.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. RENAMES
-- ═══════════════════════════════════════════════════════════════════════════════
-- RENAME rather than create-and-copy so ids survive and job_note_media's FK keeps
-- resolving. Indexes, constraints, policies and grants all follow the table.

ALTER TABLE public.job_notes      RENAME TO notes;
ALTER TABLE public.job_note_media RENAME TO note_media;
ALTER TABLE public.part_notes     RENAME TO part_comments;

ALTER INDEX idx_job_notes_job_created   RENAME TO idx_notes_job_created;
ALTER INDEX idx_job_note_media_note     RENAME TO idx_note_media_note;
ALTER INDEX idx_part_notes_part_created RENAME TO idx_part_comments_part_created;

ALTER TABLE public.notes RENAME CONSTRAINT job_notes_pkey TO notes_pkey;
ALTER TABLE public.notes RENAME CONSTRAINT job_notes_company_id_fkey TO notes_company_fk;
ALTER TABLE public.notes RENAME CONSTRAINT job_notes_job_id_fkey TO notes_job_fk;
ALTER TABLE public.notes RENAME CONSTRAINT job_notes_author_id_fkey TO notes_author_fk;
ALTER TABLE public.notes RENAME CONSTRAINT job_notes_job_part_id_fkey TO notes_job_part_fk;
ALTER TABLE public.notes
  RENAME CONSTRAINT job_notes_job_operation_id_fkey TO notes_job_operation_fk;
ALTER TABLE public.notes
  RENAME CONSTRAINT job_notes_body_blank_or_null TO notes_body_blank_or_null;
ALTER TABLE public.notes
  RENAME CONSTRAINT job_notes_note_type_check TO notes_note_type_check;

ALTER TABLE public.note_media RENAME CONSTRAINT job_note_media_pkey TO note_media_pkey;
ALTER TABLE public.note_media
  RENAME CONSTRAINT job_note_media_note_id_fkey TO note_media_note_fk;
ALTER TABLE public.note_media
  RENAME CONSTRAINT job_note_media_company_id_fkey TO note_media_company_fk;
ALTER TABLE public.note_media
  RENAME CONSTRAINT job_note_media_kind_check TO note_media_kind_check;

ALTER TABLE public.part_comments RENAME CONSTRAINT part_notes_pkey TO part_comments_pkey;
ALTER TABLE public.part_comments
  RENAME CONSTRAINT part_notes_company_id_fkey TO part_comments_company_fk;
ALTER TABLE public.part_comments
  RENAME CONSTRAINT part_notes_part_id_fkey TO part_comments_part_fk;
ALTER TABLE public.part_comments
  RENAME CONSTRAINT part_notes_author_id_fkey TO part_comments_author_fk;
ALTER TABLE public.part_comments
  RENAME CONSTRAINT part_notes_body_not_blank TO part_comments_body_not_blank;
ALTER TABLE public.part_comments
  RENAME CONSTRAINT part_notes_note_type_check TO part_comments_note_type_check;

COMMENT ON TABLE public.notes IS
  'Shop-floor knowledge. Subject is one of job / part / work_center (subject_kind), each with an optional finer grain. A part-subject note with a routing_operation_id is DURABLE and job-independent: the next person running that part reads it directly, with no traversal of prior jobs. Distinct from part_comments, which is the office activity feed.';
COMMENT ON TABLE public.part_comments IS
  'Office activity feed on a part: manual comments plus system-generated pricing entries. Renamed from part_notes. NOT shop-floor knowledge — deliberately carries no view logging, reactions or media. See public.notes.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. NOTES: SUBJECT COLUMNS, PROVENANCE, COUNTERS
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.notes
  ADD COLUMN subject_kind text,                     -- NOT NULL after the backfill below
  -- The durable, job-independent subject.
  ADD COLUMN part_id              uuid,
  ADD COLUMN routing_operation_id uuid,
  ADD COLUMN work_center_id       uuid,
  -- PROVENANCE, NOT SUBJECT: where a part-subject note was captured, so it still shows
  -- in that job's feed. Deliberately excluded from notes_subject_valid below.
  ADD COLUMN captured_job_id           uuid,
  ADD COLUMN captured_job_operation_id uuid,
  -- Iteration B ships the UI; the column ships now so B needs no migration.
  ADD COLUMN corrects_note_id     uuid,
  -- Two maintained counts, two meanings. Both on the row so list rendering is one
  -- round trip, and both MONOTONIC (see the trigger in section 6).
  ADD COLUMN viewer_count integer NOT NULL DEFAULT 0,
  ADD COLUMN usage_count  integer NOT NULL DEFAULT 0;

ALTER TABLE public.notes
  ADD CONSTRAINT notes_part_fk FOREIGN KEY (part_id)
      REFERENCES public.parts(id) ON DELETE CASCADE,
  -- SET NULL, not CASCADE: deleting a routing step must degrade the note to part-level,
  -- never destroy accumulated knowledge. This is why part_id is stored even though
  -- routings.part_id is UNIQUE and would imply it.
  ADD CONSTRAINT notes_routing_operation_fk FOREIGN KEY (routing_operation_id)
      REFERENCES public.routing_operations(id) ON DELETE SET NULL,
  -- Work centers are soft-deleted (deleted_at), so CASCADE never fires; SET NULL would
  -- violate the subject CHECK. RESTRICT on a row that is never hard-deleted is honest.
  ADD CONSTRAINT notes_work_center_fk FOREIGN KEY (work_center_id)
      REFERENCES public.work_centers(id) ON DELETE RESTRICT,
  -- Provenance goes NULL if the job is deleted: the knowledge survives its origin.
  ADD CONSTRAINT notes_captured_job_fk FOREIGN KEY (captured_job_id)
      REFERENCES public.jobs(id) ON DELETE SET NULL,
  ADD CONSTRAINT notes_captured_job_operation_fk FOREIGN KEY (captured_job_operation_id)
      REFERENCES public.job_operations(id) ON DELETE SET NULL,
  ADD CONSTRAINT notes_corrects_fk FOREIGN KEY (corrects_note_id)
      REFERENCES public.notes(id) ON DELETE SET NULL,
  ADD CONSTRAINT notes_viewer_count_nonneg CHECK (viewer_count >= 0),
  ADD CONSTRAINT notes_usage_count_nonneg  CHECK (usage_count  >= 0),
  ADD CONSTRAINT notes_no_self_correction
      CHECK (corrects_note_id IS NULL OR corrects_note_id <> id);

-- Part- and work-center-subject notes have no job. Multi-tenancy is UNAFFECTED: every
-- policy resolves on notes.company_id (which stays NOT NULL), never through job_id.
ALTER TABLE public.notes ALTER COLUMN job_id DROP NOT NULL;

-- Every pre-existing row is genuinely job-scoped. There is no honest way to retro-anchor
-- one to a routing step — a wrong guess pins a note to the wrong step permanently — so
-- they stay 'job'. The finer columns already carry their grain.
UPDATE public.notes SET subject_kind = 'job';
ALTER TABLE public.notes ALTER COLUMN subject_kind SET NOT NULL;

ALTER TABLE public.notes DROP CONSTRAINT job_notes_operation_requires_part;
ALTER TABLE public.notes ADD CONSTRAINT notes_subject_valid CHECK (
  CASE subject_kind
    WHEN 'job' THEN
      job_id IS NOT NULL
      -- Preserves the old job_notes_operation_requires_part rule: job_operations is
      -- keyed by job_part_id, so an operation without a part is ambiguous.
      AND (job_operation_id IS NULL OR job_part_id IS NOT NULL)
      AND part_id IS NULL AND routing_operation_id IS NULL AND work_center_id IS NULL
    WHEN 'part' THEN
      -- routing_operation_id is the OPTIONAL step refinement, which is what lets a
      -- note survive its routing step being deleted (FK is SET NULL above).
      part_id IS NOT NULL
      AND work_center_id IS NULL
      AND job_id IS NULL AND job_part_id IS NULL AND job_operation_id IS NULL
    WHEN 'work_center' THEN
      work_center_id IS NOT NULL
      AND part_id IS NULL AND routing_operation_id IS NULL
      AND job_id IS NULL AND job_part_id IS NULL AND job_operation_id IS NULL
    ELSE false          -- an unknown kind is rejected, not silently allowed
  END
);

COMMENT ON COLUMN public.notes.subject_kind IS
  'job | part | work_center. Names the ROOT subject; the finer columns refine within it (job -> job_part -> job_operation, part -> routing_operation). Enforced by notes_subject_valid.';
COMMENT ON COLUMN public.notes.routing_operation_id IS
  'The routing TEMPLATE step (the same step across every run), not a job''s instance of it. This is what makes a part-subject note durable and job-independent.';
COMMENT ON COLUMN public.notes.captured_job_id IS
  'Provenance only: the job this note was written on, so it still appears in that job''s feed. Never a subject, never drives the Playbook.';
COMMENT ON COLUMN public.notes.viewer_count IS
  'Distinct PEOPLE who have read this note, excluding the author and accounts excluded from metrics. Maintained ONLY by note_views_bump_counts(). MONOTONIC: never decremented, so deleting a member cannot be used to difference out what they read.';
COMMENT ON COLUMN public.notes.usage_count IS
  'Distinct JOBS this note was consulted on (job-less reads do not count). The primary quality signal — a note used on 11 jobs is load-bearing, one read by 11 people once is curiosity. Same maintenance and monotonicity as viewer_count.';

-- ── Cross-table consistency (a Postgres CHECK cannot span tables) ──────────────
-- Closes two holes: a subject row belonging to a different company than the note
-- (pre-existing on job_notes — a member of companies A and B could insert a note with
-- company_id = A and one of B's jobs), and part_id drifting from the routing step's own
-- part. Legacy rows are not re-validated; this governs new writes only.
CREATE OR REPLACE FUNCTION public.notes_validate_subject()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_part uuid;
BEGIN
  IF NEW.job_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.jobs j
      WHERE j.id = NEW.job_id AND j.company_id = NEW.company_id)
  THEN
    RAISE EXCEPTION 'job % is not in company %', NEW.job_id, NEW.company_id;
  END IF;

  IF NEW.part_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.parts p
      WHERE p.id = NEW.part_id AND p.company_id = NEW.company_id)
  THEN
    RAISE EXCEPTION 'part % is not in company %', NEW.part_id, NEW.company_id;
  END IF;

  IF NEW.work_center_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.work_centers w
      WHERE w.id = NEW.work_center_id AND w.company_id = NEW.company_id)
  THEN
    RAISE EXCEPTION 'work center % is not in company %',
                    NEW.work_center_id, NEW.company_id;
  END IF;

  -- routing_operations has NO company_id; tenancy resolves through routings. The same
  -- query yields the part, so tenancy and part-consistency are checked together.
  IF NEW.routing_operation_id IS NOT NULL THEN
    SELECT r.part_id INTO v_part
    FROM public.routing_operations ro
    JOIN public.routings r ON r.id = ro.routing_id
    WHERE ro.id = NEW.routing_operation_id AND r.company_id = NEW.company_id;

    IF v_part IS NULL THEN
      RAISE EXCEPTION 'routing operation % is not in company %',
                      NEW.routing_operation_id, NEW.company_id;
    END IF;
    IF v_part IS DISTINCT FROM NEW.part_id THEN
      RAISE EXCEPTION 'routing operation % belongs to part %, not %',
                      NEW.routing_operation_id, v_part, NEW.part_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER notes_validate_subject_trg
  BEFORE INSERT OR UPDATE OF company_id, job_id, part_id, routing_operation_id,
                             work_center_id
  ON public.notes
  FOR EACH ROW EXECUTE FUNCTION public.notes_validate_subject();

-- ── Read-path indexes ─────────────────────────────────────────────────────────
-- THE read-back index: "notes for this part at this step", no job traversal at all.
CREATE INDEX idx_notes_part_step
  ON public.notes (part_id, routing_operation_id, created_at DESC)
  WHERE part_id IS NOT NULL;
CREATE INDEX idx_notes_work_center
  ON public.notes (work_center_id, created_at DESC)
  WHERE work_center_id IS NOT NULL;
-- The job feed unions job-subject rows with part-subject rows captured on that job.
CREATE INDEX idx_notes_captured_job
  ON public.notes (captured_job_id, created_at DESC)
  WHERE captured_job_id IS NOT NULL;
CREATE INDEX idx_notes_author
  ON public.notes (author_id)
  WHERE author_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. POLICIES + GRANTS ON THE RENAMED TABLES
-- ═══════════════════════════════════════════════════════════════════════════════
-- Policies survived the rename but still carry job_notes / part_notes names. Recreate
-- with current names and unchanged semantics.

DROP POLICY IF EXISTS "Users can view job_notes"                ON public.notes;
DROP POLICY IF EXISTS "Users can insert own job_notes"          ON public.notes;
DROP POLICY IF EXISTS "Authors and admins can delete job_notes" ON public.notes;

CREATE POLICY notes_select ON public.notes
    FOR SELECT TO authenticated
    USING (company_id IN (SELECT public.get_user_company_ids()));

CREATE POLICY notes_insert ON public.notes
    FOR INSERT TO authenticated
    WITH CHECK (
      company_id IN (SELECT public.get_user_company_ids())
      -- Author is always the acting member. There is no impersonation path: an admin
      -- cannot enter a note on someone else's behalf, by design.
      AND author_id = public.get_operator_access_id(company_id)
    );

CREATE POLICY notes_delete ON public.notes
    FOR DELETE TO authenticated
    USING (author_id = public.get_operator_access_id(company_id)
           OR public.is_company_admin(company_id));

-- No UPDATE policy, matching today's behaviour (notes are append-only). REVOKE anyway:
-- grants and RLS are independent layers, and an UPDATE grant with no policy is one
-- future permissive policy away from letting an operator write viewer_count = 999, or
-- an admin set a known value and watch it move — a one-bit read oracle per note.
-- If body editing is ever added it needs BOTH a permissive policy AND a column-scoped
-- grant that excludes viewer_count, usage_count, company_id, author_id and every
-- subject column.
REVOKE UPDATE ON public.notes FROM anon, authenticated;

DROP POLICY IF EXISTS "Users can view job_note_media"   ON public.note_media;
DROP POLICY IF EXISTS "Users can insert job_note_media" ON public.note_media;
DROP POLICY IF EXISTS "Authors and admins can delete job_note_media" ON public.note_media;

CREATE POLICY note_media_select ON public.note_media
    FOR SELECT TO authenticated
    USING (company_id IN (SELECT public.get_user_company_ids()));

CREATE POLICY note_media_insert ON public.note_media
    FOR INSERT TO authenticated
    WITH CHECK (
      company_id IN (SELECT public.get_user_company_ids())
      AND public.get_operator_access_id(company_id) IS NOT NULL
    );

CREATE POLICY note_media_delete ON public.note_media
    FOR DELETE TO authenticated
    USING (public.is_company_admin(company_id)
           OR EXISTS (SELECT 1 FROM public.notes n
                      WHERE n.id = note_media.note_id
                        AND n.author_id = public.get_operator_access_id(n.company_id)));

DROP POLICY IF EXISTS "Users can view part_notes"       ON public.part_comments;
DROP POLICY IF EXISTS "Users can insert own part_notes" ON public.part_comments;
DROP POLICY IF EXISTS "Authors and admins can delete part_notes" ON public.part_comments;

CREATE POLICY part_comments_select ON public.part_comments
    FOR SELECT TO authenticated
    USING (company_id IN (SELECT public.get_user_company_ids()));

CREATE POLICY part_comments_insert ON public.part_comments
    FOR INSERT TO authenticated
    WITH CHECK (
      company_id IN (SELECT public.get_user_company_ids())
      AND author_id = public.get_operator_access_id(company_id)
    );

CREATE POLICY part_comments_delete ON public.part_comments
    FOR DELETE TO authenticated
    USING (author_id = public.get_operator_access_id(company_id)
           OR public.is_company_admin(company_id));

-- The billing gate's policies are named billing_gate_* and also survived the rename;
-- re-apply so they are unambiguously attached to the current table names.
SELECT public.apply_billing_write_gate('public.notes');
SELECT public.apply_billing_write_gate('public.note_media');
SELECT public.apply_billing_write_gate('public.part_comments');

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. EXCLUDE-FROM-METRICS FLAG
-- ═══════════════════════════════════════════════════════════════════════════════
-- Two mechanisms, one evaluation point. Neither alone is sufficient: system_admins
-- cannot express "the shop owner's own account", and a per-membership column alone
-- means the founder must remember to flag every new company — and a forgotten flag
-- inflates a customer's numbers, a silent failure in the forbidden direction.

ALTER TABLE public.user_company_access
  ADD COLUMN excluded_from_metrics boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.user_company_access.excluded_from_metrics IS
  'When true, this membership never produces a note_views row, so it cannot inflate note read counts. Service-role only: NOT writable by any browser role (see the column-scoped grants below), because an admin who could flip it on everyone-but-one would learn what that one person reads by watching counts move.';

CREATE OR REPLACE FUNCTION public.viewer_excluded_from_metrics(p_access_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_company_access uca
    WHERE uca.id = p_access_id
      AND (uca.excluded_from_metrics OR public.is_system_admin(uca.user_id))
  );
$$;

REVOKE EXECUTE ON FUNCTION public.viewer_excluded_from_metrics(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.viewer_excluded_from_metrics(uuid) TO service_role;
-- Not granted to authenticated: it is only ever called from inside log_note_views(),
-- which runs as the table owner. Granting it would hand the browser a per-member probe.

-- RLS cannot scope a policy to a column; GRANT can. Without this, the existing
-- "Admins can update company access" policy lets an admin set excluded_from_metrics on
-- every member except one and read that person's entire history off the counters.
-- The only browser write to this table is `.update({ role })` from the team member page
-- (app/dashboard/[companyId]/team/members/[id]/page.tsx), plus name/email/pin_hash via
-- the own-row policy. Backend inserts use the service role; accept_invitation() is
-- SECURITY DEFINER. All unaffected by column-scoped grants.
REVOKE UPDATE ON public.user_company_access FROM anon, authenticated;
GRANT  UPDATE (name, role, email, pin_hash) ON public.user_company_access TO authenticated;

-- INSERT too, or an admin DELETEs a membership (they have that policy) and re-INSERTs
-- it with excluded_from_metrics = true.
REVOKE INSERT ON public.user_company_access FROM anon, authenticated;
GRANT  INSERT (user_id, company_id, role, name, email, pin_hash)
  ON public.user_company_access TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. NOTE_VIEWS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE public.note_views (
    id         uuid NOT NULL DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    note_id    uuid NOT NULL,
    -- user_company_access.id (the per-membership shop identity), matching notes.author_id.
    viewer_id  uuid NOT NULL,
    -- The read CONTEXT, and part of the key. NULL when read outside a job.
    job_id     uuid,
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT note_views_pkey PRIMARY KEY (id),

    -- THE dedupe. One row per (note, person, job-context), forever. Re-reading the same
    -- note while working the same job is still ONE row, so this records repeat USE
    -- (consulted again on a new job) and never repeat OPENS.
    --
    -- NULLS NOT DISTINCT is load-bearing, not decoration: job_id is nullable, and the
    -- SQL default (NULLS DISTINCT) treats every NULL as unequal — so repeated job-less
    -- reads by one person would insert unbounded rows and inflate every count.
    CONSTRAINT note_views_note_viewer_job_key
        UNIQUE NULLS NOT DISTINCT (note_id, viewer_id, job_id),

    CONSTRAINT note_views_company_fk FOREIGN KEY (company_id)
        REFERENCES public.companies(id) ON DELETE CASCADE,
    CONSTRAINT note_views_note_fk FOREIGN KEY (note_id)
        REFERENCES public.notes(id) ON DELETE CASCADE,
    -- CASCADE: a departing member's read history is erased, which is privacy-positive.
    -- Safe ONLY because the counters are monotonic (section 6).
    CONSTRAINT note_views_viewer_fk FOREIGN KEY (viewer_id)
        REFERENCES public.user_company_access(id) ON DELETE CASCADE,
    -- SET NULL: deleting a job must not delete the fact that someone read the note.
    CONSTRAINT note_views_job_fk FOREIGN KEY (job_id)
        REFERENCES public.jobs(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.note_views IS
  'Who has read which note. NO client read path by design: no SELECT grant to anon/authenticated, plus a RESTRICTIVE deny-all. Authors get names via note_viewers(); everyone else gets counts via notes.viewer_count / usage_count. Never expose a per-job read breakdown, and never add this table to the supabase_realtime publication or to the AI SQL allowlist — either would reconstruct a per-operator reading report.';

CREATE INDEX idx_note_views_company ON public.note_views (company_id);
-- DELIBERATELY ABSENT: indexes on (viewer_id) and (job_id). The only queries those
-- serve are "everything this person read" and "who read notes on job X" — the two
-- queries this product forbids. Without them, any future accidental implementation is
-- a seq scan: slow enough to be noticed in review or in prod metrics.

ALTER TABLE public.note_views ENABLE ROW LEVEL SECURITY;

-- The only policy. With no permissive policy the table already denies everything; the
-- value of writing this down is that RESTRICTIVE policies AND together, so a future
-- migration that adds a well-meaning permissive SELECT policy still evaluates false.
-- The guarantee survives someone else's good intentions.
--
-- jigged_ai_readonly is named EXPLICITLY, and that is not belt-and-braces. The AI SQL
-- path (api/tools/sql_executor.py) runs LLM-generated SQL as that role, and
-- docs/modules/ai-insights.md instructs anyone widening AI scope to add an
-- `ai_readonly_select ... USING (true)` policy to the table. On a table whose
-- RESTRICTIVE policy named only anon/authenticated, that instruction would silently
-- open the read log to "which operators read the setup notes?". Listing the role here
-- makes the deny survive that too.
CREATE POLICY note_views_no_client_access ON public.note_views
    AS RESTRICTIVE FOR ALL TO anon, authenticated, jigged_ai_readonly
    USING (false) WITH CHECK (false);

-- Grants are the load-bearing control here, more than RLS is. In particular there is no
-- SELECT grant, which is what blocks `HEAD ...?note_id=eq.X&viewer_id=eq.Y` with
-- `Prefer: count=exact` — a per-pair oracle that returns a count with an empty body and
-- that RLS is powerless against, because the count is over exactly the rows a policy
-- admitted. If SELECT is ever granted with ANY row-returning policy, that hole is open.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.note_views TO service_role;
REVOKE ALL ON public.note_views FROM anon, authenticated;

-- NOT a no-op, unlike the line above. baseline.sql:6431 sets
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--     GRANT SELECT ON TABLES TO jigged_ai_readonly;
-- so every new public table is granted to the AI role on creation. Without this
-- REVOKE the read log ships readable-by-grant, held shut only by RLS and a Python
-- denylist. Any new table in this family needs the same line.
REVOKE ALL ON public.note_views FROM jigged_ai_readonly;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. COUNTERS
-- ═══════════════════════════════════════════════════════════════════════════════
-- AFTER INSERT, not BEFORE: with ON CONFLICT DO NOTHING a conflicting row is never
-- inserted, so AFTER INSERT does not fire for a duplicate. A BEFORE trigger WOULD fire
-- and then have its row discarded.
--
-- A blind +1 is not available: with job_id in the dedupe key an insert no longer
-- implies a new person. A conditional increment races between two concurrent reads by
-- the same person on different jobs. So: recount, and GREATEST to stay monotonic.

CREATE OR REPLACE FUNCTION public.note_views_bump_counts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  -- Take the row lock as its OWN command, before counting. This is the whole trick.
  -- In READ COMMITTED a sub-SELECT inside an UPDATE's SET clause is evaluated against
  -- the statement's snapshot; when that UPDATE blocks on a concurrent writer and then
  -- unblocks, the target row is re-fetched but the subquery is NOT re-evaluated against
  -- the newly-committed data. Two people reading the same note concurrently would then
  -- both compute 1 and GREATEST(1,1) would leave it at 1 — an undercount that
  -- note_count_anomalies() would correctly flag, turning a legitimate race into a red
  -- build. Locking first means the UPDATE below is a NEW command whose snapshot is
  -- taken after the other transaction committed.
  PERFORM 1 FROM public.notes WHERE id = NEW.note_id FOR UPDATE;

  UPDATE public.notes SET
    viewer_count = GREATEST(viewer_count, (
      SELECT count(DISTINCT nv.viewer_id)
      FROM public.note_views nv WHERE nv.note_id = NEW.note_id)),
    usage_count  = GREATEST(usage_count, (
      SELECT count(DISTINCT nv.job_id)
      FROM public.note_views nv
      WHERE nv.note_id = NEW.note_id AND nv.job_id IS NOT NULL))
  WHERE id = NEW.note_id;

  RETURN NULL;
END;
$$;

CREATE TRIGGER note_views_bump_counts_trg
  AFTER INSERT ON public.note_views
  FOR EACH ROW EXECUTE FUNCTION public.note_views_bump_counts();

-- NO DECREMENT TRIGGER, and that is a security decision rather than laziness. An admin
-- can delete a membership (they have that policy); if the counters fell when the rows
-- cascaded, snapshotting every count, deleting one member, and snapshotting again would
-- name every note that person had read. GREATEST keeps that closed now that the value
-- is recomputed rather than incremented: a post-cascade recount can only be lower, and
-- lower loses.

-- One-sided drift check. Because the counters are monotonic, stored > live is EXPECTED
-- (departed members, purged jobs); stored < live means the trigger failed.
CREATE OR REPLACE FUNCTION public.note_count_anomalies()
RETURNS TABLE(note_id uuid, stored_viewers integer, live_viewers bigint,
                            stored_usage integer,   live_usage bigint)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT n.id, n.viewer_count, COALESCE(v.viewers, 0),
                n.usage_count,  COALESCE(v.usage, 0)
  FROM public.notes n
  LEFT JOIN (
    SELECT nv.note_id,
           count(DISTINCT nv.viewer_id) AS viewers,
           count(DISTINCT nv.job_id) FILTER (WHERE nv.job_id IS NOT NULL) AS usage
    FROM public.note_views nv
    GROUP BY nv.note_id
  ) v ON v.note_id = n.id
  WHERE n.viewer_count < COALESCE(v.viewers, 0)
     OR n.usage_count  < COALESCE(v.usage, 0)
  ORDER BY 1;
$$;

REVOKE EXECUTE ON FUNCTION public.note_count_anomalies() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.note_count_anomalies() TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. THE THREE CLIENT-FACING FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════════
-- PERMANENT RULE for this family: no function that touches note_views may ever accept
-- a viewer/member parameter. That is what keeps RPC probing closed.

-- ── 7a. Write path ────────────────────────────────────────────────────────────
-- Array-first so a screenful of notes is one round trip; callers must never loop it.
-- SECURITY DEFINER genuinely bypasses RLS and the RESTRICTIVE billing policies: inside
-- the body current_user is the function owner, which is also the table owner, and no
-- table in this schema has FORCE ROW LEVEL SECURITY. (Do not reason about this via the
-- TO clause — in Supabase, postgres is a member of authenticated, so a TO authenticated
-- policy WOULD apply if RLS were being enforced at all. The guarantee is owner
-- exemption.) That is also why note_views is on the billing-gate exempt list: a gate
-- here would be unreachable code.
CREATE OR REPLACE FUNCTION public.log_note_views(
  p_note_ids uuid[],
  p_job_id   uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_note      record;
  v_viewer_id uuid;
  v_job_ok    boolean;
  v_companies uuid[];
BEGIN
  IF p_note_ids IS NULL OR array_length(p_note_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  -- auth.uid() reads the request JWT GUC, which is set per-request independently of
  -- current_user, so it is still the real caller inside a SECURITY DEFINER body.
  SELECT array_agg(cid) INTO v_companies
  FROM (SELECT public.get_user_company_ids() AS cid) s;
  IF v_companies IS NULL THEN
    RETURN;                              -- not a member of anything
  END IF;

  FOR v_note IN
    -- Tenant validation by construction: a note outside the caller's companies simply
    -- does not resolve, so there is no "wrong company" branch to get wrong. DISTINCT
    -- absorbs a caller that passes the same id twice.
    SELECT DISTINCT n.id, n.company_id, n.author_id
    FROM public.notes n
    WHERE n.id = ANY(p_note_ids) AND n.company_id = ANY(v_companies)
  LOOP
    -- Resolved per-note because a multi-company user has a different access id per shop.
    v_viewer_id := public.get_operator_access_id(v_note.company_id);
    CONTINUE WHEN v_viewer_id IS NULL;

    -- Never the author viewing their own note. DB-enforced, and the client cannot opt
    -- out because the client has no INSERT grant at all.
    CONTINUE WHEN v_note.author_id IS NOT NULL AND v_viewer_id = v_note.author_id;

    -- Never an account excluded from metrics. Also DB-enforced.
    CONTINUE WHEN public.viewer_excluded_from_metrics(v_viewer_id);

    -- A job from another company, or a garbage uuid, degrades to NULL rather than
    -- raising: a bad job id must never cost us the read fact.
    SELECT EXISTS (
      SELECT 1 FROM public.jobs j
      WHERE j.id = p_job_id AND j.company_id = v_note.company_id
    ) INTO v_job_ok;

    INSERT INTO public.note_views (company_id, note_id, viewer_id, job_id)
    VALUES (v_note.company_id, v_note.id, v_viewer_id,
            CASE WHEN v_job_ok THEN p_job_id ELSE NULL END)
    -- The permanent dedupe. A repeat read is a no-op: no row, no trigger, no counter
    -- movement, no error. Idempotent, so the client needs no bookkeeping of its own.
    --
    -- Named constraint rather than a column list: with NULLS NOT DISTINCT, arbiter
    -- inference from (note_id, viewer_id, job_id) is subtle enough that naming the
    -- constraint removes the question entirely, and it fails loudly if the constraint
    -- is ever renamed instead of silently matching a different index.
    ON CONFLICT ON CONSTRAINT note_views_note_viewer_job_key DO NOTHING;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.log_note_views(uuid[], uuid) IS
  'Log that the caller read these notes. Returns void deliberately: a duplicate must be indistinguishable from a first view, so there is no state oracle keyed on (note, caller) and no body for a failed write to surface to the operator. Fire-and-forget from the client; report errors to Sentry, never to the user. Deliberately has no EXCEPTION handler — every expected condition already returns silently, and a genuine fault should raise so it is observed.';

REVOKE EXECUTE ON FUNCTION public.log_note_views(uuid[], uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.log_note_views(uuid[], uuid) TO authenticated;

-- ── 7b. The author's named list ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.note_viewers(p_note_id uuid)
RETURNS TABLE (viewer_name text, job_number text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  -- ONE ROW PER PERSON, collapsed by GROUP BY. With job_id in the dedupe key, someone
  -- who consulted this note on three jobs has three rows; the author must see them
  -- once. min(job_number) picks the representative job LEXICOGRAPHICALLY, not by time —
  -- an earliest-by-created_at pick would smuggle back exactly the timing signal the
  -- no-timestamps rule exists to deny. Deliberately NOT count(DISTINCT job_id) per
  -- person: "Kurtis keeps coming back to this" is repeat use attached to a name, which
  -- is the reader-watching we refuse. Repeat use is published in aggregate only, as
  -- notes.usage_count.
  SELECT uca.name, min(j.job_number)
  FROM public.notes n
  JOIN public.note_views v            ON v.note_id = n.id
  JOIN public.user_company_access uca ON uca.id = v.viewer_id
  LEFT JOIN public.jobs j             ON j.id = v.job_id
  WHERE n.id = p_note_id
    -- The caller must BE the author, and that is the ONLY test. author_id is
    -- nullable (ON DELETE SET NULL) and get_operator_access_id() is NULL for a
    -- non-member, so the IS NOT NULL guard prevents a NULL = NULL accident from
    -- ever mattering.
    --
    -- DELIBERATELY NOT role-dependent. An earlier draft excluded company admins,
    -- to block an admin authoring a must-read note and harvesting a named read
    -- list. That is dropped, because in a fifteen-person shop roles are fluid:
    -- an operator promoted to lead would silently stop seeing who used their own
    -- notes, losing the feedback loop that got them writing. Behaviour that
    -- changes when someone's role changes is worse than the speed bump it buys —
    -- and the bump was already defeatable, since anyone who can create accounts
    -- can author from a non-admin one.
    --
    -- The guarantee is now one sentence with no exceptions: you see who used YOUR
    -- notes; nobody sees who used anyone else's. The protection that actually
    -- matters — no shop-wide report of who read which notes — is unaffected, and
    -- lives in note_views having no client read path at all.
    AND n.author_id IS NOT NULL
    AND n.author_id = public.get_operator_access_id(n.company_id)
  GROUP BY uca.id, uca.name
  -- Ordered by NAME, never by time. No timestamp is returned at all.
  ORDER BY uca.name NULLS LAST;
$$;

REVOKE EXECUTE ON FUNCTION public.note_viewers(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.note_viewers(uuid) TO authenticated;

-- ── 7c. The login-banner digest ───────────────────────────────────────────────
-- Nothing else can produce this: both counters are all-time and monotonic, note_views
-- has no client read path, and note_viewers() deliberately returns no timestamps.
CREATE OR REPLACE FUNCTION public.my_note_view_digest(p_tz text)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  -- count DISTINCT viewer_id, not count(*). With job_id in the dedupe key three rows
  -- can be one person on three jobs, and count(*) would render "3 people used your
  -- notes" for a single reader — the exact overstatement this design exists to prevent.
  SELECT count(DISTINCT v.viewer_id)::integer
  FROM public.notes n
  JOIN public.note_views v ON v.note_id = n.id
  WHERE n.author_id IS NOT NULL
    AND n.author_id = public.get_operator_access_id(n.company_id)
    AND v.created_at >= (date_trunc('week', now() AT TIME ZONE p_tz) AT TIME ZONE p_tz);
$$;

COMMENT ON FUNCTION public.my_note_view_digest(text) IS
  'Distinct people who read the caller''s own notes since the start of the current week in the given IANA timezone. Takes a TIMEZONE, not an arbitrary window: a caller-supplied (from, to) would be a bisection oracle recovering WHEN a read happened, which is the timing signal note_viewers() refuses to give. Powers the operator login banner; renders nothing when zero.';

REVOKE EXECUTE ON FUNCTION public.my_note_view_digest(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.my_note_view_digest(text) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. NOTE_REACTIONS  (schema now, UI in Iteration B)
-- ═══════════════════════════════════════════════════════════════════════════════
-- Shaped as the deliberate OPPOSITE of note_views. A read log is an involuntary record
-- of ignorance; a reaction is a voluntary claim of endorsement. Publishing the latter
-- is the product.

CREATE TABLE public.note_reactions (
    id         uuid NOT NULL DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    note_id    uuid NOT NULL,
    -- Named reactor_id, not user_id: this is a user_company_access(id), and schema-wide
    -- user_id means auth.users(id). A column named user_id holding an access id is a
    -- bug waiting for its first JOIN.
    reactor_id uuid NOT NULL,
    kind       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT note_reactions_pkey PRIMARY KEY (id),
    -- Two values, and there is no negative option — not deferred, structurally absent.
    CONSTRAINT note_reactions_kind_check CHECK (kind IN ('helpful', 'confirmed')),
    CONSTRAINT note_reactions_note_reactor_kind_key UNIQUE (note_id, reactor_id, kind),
    CONSTRAINT note_reactions_company_fk FOREIGN KEY (company_id)
        REFERENCES public.companies(id) ON DELETE CASCADE,
    CONSTRAINT note_reactions_note_fk FOREIGN KEY (note_id)
        REFERENCES public.notes(id) ON DELETE CASCADE,
    CONSTRAINT note_reactions_reactor_fk FOREIGN KEY (reactor_id)
        REFERENCES public.user_company_access(id) ON DELETE CASCADE
);

COMMENT ON TABLE public.note_reactions IS
  'helpful = thumbs up (there is no thumbs down, ever). confirmed = "I ran this part and this note is still accurate", rendered as "confirmed by <name>, <month year>" with a coarse date. NEVER add a constraint or trigger requiring a note_views row before a reaction is allowed: it looks like tidy integrity and would turn this endpoint into a clean oracle for "has member X viewed note N".';

CREATE INDEX idx_note_reactions_note ON public.note_reactions (note_id);

ALTER TABLE public.note_reactions ENABLE ROW LEVEL SECURITY;

-- Attributable and public inside the shop — the deliberate opposite of note_views.
CREATE POLICY note_reactions_select ON public.note_reactions
    FOR SELECT TO authenticated
    USING (company_id IN (SELECT public.get_user_company_ids()));

CREATE POLICY note_reactions_insert ON public.note_reactions
    FOR INSERT TO authenticated
    WITH CHECK (
      company_id IN (SELECT public.get_user_company_ids())
      -- Own identity only: no forging "Kurtis confirmed this".
      AND reactor_id = public.get_operator_access_id(company_id)
      -- Not your own note: self-confirmation is noise.
      AND NOT EXISTS (
        SELECT 1 FROM public.notes n
        WHERE n.id = note_id
          AND n.author_id = public.get_operator_access_id(company_id))
    );

-- Un-react is yours alone. Admins deliberately CANNOT delete other people's reactions:
-- a boss who can curate the public record of what the shop found helpful is a worse
-- problem than a stale reaction.
CREATE POLICY note_reactions_delete ON public.note_reactions
    FOR DELETE TO authenticated
    USING (reactor_id = public.get_operator_access_id(company_id));

-- No UPDATE policy and no UPDATE grant: a reaction is created or removed, never edited
-- (an editable kind would let 'helpful' silently become 'confirmed').
GRANT SELECT, INSERT, DELETE         ON public.note_reactions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.note_reactions TO service_role;

-- A real browser write on a tenant table, so it gets the real gate.
SELECT public.apply_billing_write_gate('public.note_reactions');

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. OPERATOR_EVENTS  (funnel instrumentation)
-- ═══════════════════════════════════════════════════════════════════════════════
-- Distinguishes never-opened-the-app from opened-but-took-no-action from
-- started-capture-and-abandoned. Without it no adoption result is readable — and with
-- an empty starting corpus it is the ONLY instrument for the first weeks, because
-- note_views, the banner and reactions are all structurally silent until someone writes
-- something.

CREATE TABLE public.operator_events (
    id          uuid NOT NULL DEFAULT gen_random_uuid(),
    company_id  uuid NOT NULL,
    actor_id    uuid,
    kind        text NOT NULL,
    -- Loose context: { jobId, jobPartId, jobOperationId, workCenterId, ... }.
    -- NEVER note bodies, and NEVER the ids of notes the actor READ — that is
    -- note_views' job, and it is deliberately unreadable.
    context     jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT operator_events_pkey PRIMARY KEY (id),
    CONSTRAINT operator_events_company_fk FOREIGN KEY (company_id)
        REFERENCES public.companies(id) ON DELETE CASCADE,
    CONSTRAINT operator_events_actor_fk FOREIGN KEY (actor_id)
        REFERENCES public.user_company_access(id) ON DELETE SET NULL,
    -- CHECK-constrained rather than free text so a typo is a failed insert, not a
    -- silently uncounted funnel step.
    CONSTRAINT operator_events_kind_check CHECK (kind IN (
      'app_opened',
      'station_selected',
      'op_card_opened',
      'prior_notes_opened',      -- THAT they opened prior notes, never WHICH ones
      'composer_focused',
      'composer_abandoned',
      'note_saved',
      'note_saved_with_photo',
      'photo_attached',
      'completion_recorded'
    ))
);

COMMENT ON TABLE public.operator_events IS
  'Capture-funnel instrumentation. Service-role read only — NOT readable by the shop''s own admin, because a per-operator event log would reconstruct the reading behaviour that note_views'' RLS exists to prevent. Founder access is via the SQL editor. Written only through log_operator_event().';

CREATE INDEX idx_operator_events_company_time
  ON public.operator_events (company_id, occurred_at DESC);

ALTER TABLE public.operator_events ENABLE ROW LEVEL SECURITY;

-- Same shape as note_views, and for the same reasons — including naming
-- jigged_ai_readonly so a future ai_readonly_select policy cannot open a
-- per-operator behaviour log.
CREATE POLICY operator_events_no_client_access ON public.operator_events
    AS RESTRICTIVE FOR ALL TO anon, authenticated, jigged_ai_readonly
    USING (false) WITH CHECK (false);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.operator_events TO service_role;
REVOKE ALL ON public.operator_events FROM anon, authenticated;
-- Undoes the baseline's default GRANT to the AI role — see the note on note_views.
REVOKE ALL ON public.operator_events FROM jigged_ai_readonly;

CREATE OR REPLACE FUNCTION public.log_operator_event(
  p_company_id uuid,
  p_kind       text,
  p_context    jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_actor_id uuid;
BEGIN
  v_actor_id := public.get_operator_access_id(p_company_id);
  -- Not a member of this company: log nothing rather than raising. Instrumentation must
  -- never be able to break the interaction it is measuring.
  IF v_actor_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.operator_events (company_id, actor_id, kind, context)
  VALUES (p_company_id, v_actor_id, p_kind, COALESCE(p_context, '{}'::jsonb));
END;
$$;

REVOKE EXECUTE ON FUNCTION public.log_operator_event(uuid, text, jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.log_operator_event(uuid, text, jsonb) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 10. BILLING-GATE EXEMPT LIST
-- ═══════════════════════════════════════════════════════════════════════════════
-- note_views and operator_events both carry company_id, so the CI guard
-- (test_no_tenant_table_left_ungated) will flag them unless they are gated or exempt.
-- They are exempt, for two independent reasons each:
--
--   1. Mechanical. Their only writer is a SECURITY DEFINER function owned by the table
--      owner, so RLS is skipped entirely — permissive and RESTRICTIVE alike. A gate
--      would install policies that are never evaluated, and shipping decorative
--      policies is worse than an honest exempt entry: the next reader mistakes them for
--      protection.
--   2. Product. Reading is a read, and instrumentation must not stop. Gating would
--      silently zero counts during a billing lapse and resume afterwards, making every
--      count a lie about a period nobody remembers. The rule is bias to UNDERCOUNT,
--      not bias to lie.
--
-- Note the alternative that would have been WRONG: omitting company_id so the guard
-- cannot see the table. That evades the mechanism; this list is the reviewable record
-- of a deliberate decision, which is the entire point of the function.
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
      -- service-role-only / SELECT-only (writes never come from the browser)
      'auth_audit_log', 'job_fulfillment_audit', 'part_location_stock',
      'company_order_counters', 'quickbooks_connections', 'quickbooks_customer_map',
      'quickbooks_invoice_links', 'quickbooks_invoice_line_items',
      -- SECURITY DEFINER-only writers; see the block comment above
      'note_views', 'operator_events'
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

-- ═══════════════════════════════════════════════════════════════════════════════
-- 11. NO-CLIENT-ACCESS COMPLETENESS CHECK
-- ═══════════════════════════════════════════════════════════════════════════════
-- The tables in section 5 and 9 must be unreachable by every non-service role. The
-- non-obvious hazard is that one of those grants arrives BY DEFAULT: baseline.sql
-- runs
--     ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--       GRANT SELECT ON TABLES TO jigged_ai_readonly;
-- so a new table is granted to the AI SQL role at CREATE time, without anyone
-- writing a GRANT. Reading the migration will not reveal it — only the database
-- will — so this is a runtime check rather than a code-review convention.
--
-- Same idiom as tenant_tables_missing_write_gate(): a CI test asserts no rows, so a
-- future table in this family that forgets its REVOKE fails the build instead of
-- silently exposing a per-operator reading report.
CREATE OR REPLACE FUNCTION public.no_client_access_grant_leaks()
RETURNS TABLE(table_name text, grantee text, privilege_type text)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT g.table_name::text, g.grantee::text, g.privilege_type::text
  FROM information_schema.role_table_grants g
  WHERE g.table_schema = 'public'
    AND g.table_name IN ('note_views', 'operator_events')
    AND g.grantee IN ('anon', 'authenticated', 'jigged_ai_readonly', 'PUBLIC')
  ORDER BY 1, 2, 3;
$$;

COMMENT ON FUNCTION public.no_client_access_grant_leaks() IS
  'Lists any grant on the no-client-access tables (note_views, operator_events) to a browser or AI role. Must always be empty: those tables are readable only by service_role, and written only through SECURITY DEFINER functions. Catches the default-privilege GRANT to jigged_ai_readonly that lands automatically on every new public table.';

GRANT EXECUTE ON FUNCTION public.no_client_access_grant_leaks() TO service_role;
