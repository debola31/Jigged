-- Notes become editable and deletable — issue #628.
--
-- Until now no note in Jigged could be corrected from the UI on any surface. That
-- was deliberate: `20260728040701_notes_subjects_and_view_logging.sql:282-289`
-- revoked UPDATE outright, because a writable viewer_count is a one-bit read
-- oracle per note and the whole note_views privacy design rests on those counters
-- being unwritable and monotonic. That same comment wrote down, in advance, what a
-- safe body edit would need:
--
--   "If body editing is ever added it needs BOTH a permissive policy AND a
--    column-scoped grant that excludes viewer_count, usage_count, company_id,
--    author_id and every subject column."
--
-- This migration is that. It grants exactly one column.
--
-- WHAT WAS CONSIDERED AND REJECTED: resetting viewer_count on edit, so a note that
-- changed would not carry reach earned by its old wording. Three reasons it is not
-- here, and they are worth writing down because the idea is a natural one.
--
--   1. It would not stick. note_views_bump_counts() RECOUNTS rather than
--      increments (GREATEST over count(DISTINCT viewer_id) across all note_views
--      rows), so a reset to 0 is undone by the very next read. Making it stick
--      needs the note_views rows purged, which breaks the ON CONFLICT dedupe — the
--      same person re-reading then logs a fresh row — and destroys usage_count.
--   2. A WORKING reset is precisely the oracle this subsystem refuses, assembled
--      from parts already shipped. my_note_digest() gives an author their running
--      total and NoteUsageBanner stores the last-acknowledged value client-side and
--      renders the delta. An author-triggered reset closes the loop: edit at 9:00,
--      glance at 9:15, and any increment says somebody read it in those fifteen
--      minutes — then note_viewers() supplies the name. That function is
--      name-ordered and deliberately carries NO timestamp; a reset would supply the
--      missing one. Silent, repeatable, available to anyone who can make an account.
--   3. Monotonicity was never protecting the counter from edits. It protects it
--      from DIFFERENCING. Editing `body` under a column-scoped grant never goes
--      near a counter, so the property is untouched.
--
-- The honesty cost of editing without a reset — "7 people read this" now refers to
-- 7 people who read different words — is carried by edited_at and the "· edited"
-- marker instead. A reset would not have undone the fact that 7 people read the old
-- text; it would only have stopped reporting it.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. THE MARKER
-- ═══════════════════════════════════════════════════════════════════════════════
-- Nullable, no default, no backfill. NULL means "never edited", which is the true
-- state of every existing row — nothing is inconsistent at rest, so this is not the
-- silent-fallback case CLAUDE.md forbids. A NOT NULL DEFAULT now() would make every
-- historical note claim to have been edited the day this shipped.
--
-- NOT NAMED updated_at, and that is not bikeshedding. This column is a CLAIM MADE
-- TO OTHER READERS — "this is not what was originally written" — rather than
-- bookkeeping. Calling it updated_at invites some future generic touch trigger to
-- set it on writes that are not edits, at which point the marker starts lying.

ALTER TABLE public.notes         ADD COLUMN edited_at timestamptz;
ALTER TABLE public.part_comments ADD COLUMN edited_at timestamptz;

COMMENT ON COLUMN public.notes.edited_at IS
  'When the body was last changed by its author. NULL = never edited. Stamped by notes_restrict_update_to_body() and granted to NO browser role: the marker is an integrity claim made to other readers, so the one person who benefits from suppressing it must not be able to write it.';
COMMENT ON COLUMN public.part_comments.edited_at IS
  'When the body was last changed by its author. NULL = never edited. Stamped by part_comments_restrict_update_to_body(); not writable by any browser role. See public.notes.edited_at.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. GRANTS
-- ═══════════════════════════════════════════════════════════════════════════════
-- Both ACLs are restated from scratch rather than amended, so the whole intended
-- privilege set for these tables reads in one place. REVOKE must come first, or it
-- takes the column-scoped UPDATE straight back off again.

-- notes still carried TRUNCATE/REFERENCES/TRIGGER/MAINTAIN for the browser roles:
-- the 2026-07 REVOKE took only UPDATE, and the 2026-07-16 default-privilege
-- alignment left those four in the ON TABLES default. TRUNCATE bypasses RLS
-- entirely. It is unreachable through PostgREST (which exposes no TRUNCATE verb),
-- so this is not a live hole — but we are rewriting this table's ACL anyway.
REVOKE ALL ON public.notes FROM anon, authenticated;

-- anon gets nothing at all: RLS denies it every row, and no logged-out surface
-- reads notes.
GRANT SELECT, INSERT, DELETE ON public.notes TO authenticated;

-- THE GRANT THE 2026-07 COMMENT ASKED FOR. It NAMES one column rather than
-- EXCLUDING a list, which is the stronger form: the exclusion is satisfied by
-- construction, so a column added to `notes` next year is non-updatable by default
-- instead of needing someone to remember to add it to a denylist.
--
-- edited_at is deliberately absent — the trigger in section 4 stamps it.
GRANT UPDATE (body) ON public.notes TO authenticated;

-- part_comments predates the 2026-07-16 alignment and still carried a blanket
-- GRANT ALL. That already included UPDATE — so this table's append-only-ness was
-- UI convention and never enforcement — and TRUNCATE.
--
-- This IS the "REVOKE-down-from-ALL" idiom CLAUDE.md warns against, and the warning
-- does not apply here: that rule addresses NEW tables under the current default,
-- where nothing was granted in the first place and a REVOKE would be theatre. Here
-- the privileges genuinely exist, and REVOKE is the only way to remove them.
REVOKE ALL ON public.part_comments FROM anon, authenticated;

GRANT SELECT, INSERT, DELETE ON public.part_comments TO authenticated;
GRANT UPDATE (body)          ON public.part_comments TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. POLICIES
-- ═══════════════════════════════════════════════════════════════════════════════
-- AUTHOR ONLY, with no admin branch — deliberately asymmetric with delete, which
-- keeps its author-or-admin shape below.
--
-- An admin who could rewrite somebody else's note could change what it says without
-- changing who it is attributed to. Deleting is visibly destructive and the author
-- notices; silently editing under another person's name is neither. This mirrors
-- notes_insert, which already refuses admin-on-behalf-of authoring for exactly the
-- same reason (20260728040701:272-274).
--
-- note_type appears in BOTH clauses, and both are load-bearing: USING stops an
-- auto-logged row being selected for edit, WITH CHECK stops note_type from being
-- the thing you edit it into. (The trigger below refuses that too — defence in
-- depth, since a policy and a trigger fail for different reasons.)

CREATE POLICY notes_update_body ON public.notes
    FOR UPDATE TO authenticated
    USING (
      company_id IN (SELECT public.get_user_company_ids())
      AND note_type = 'user'
      AND author_id = public.get_operator_access_id(company_id)
    )
    WITH CHECK (
      company_id IN (SELECT public.get_user_company_ids())
      AND note_type = 'user'
      AND author_id = public.get_operator_access_id(company_id)
    );

CREATE POLICY part_comments_update_body ON public.part_comments
    FOR UPDATE TO authenticated
    USING (
      company_id IN (SELECT public.get_user_company_ids())
      AND note_type = 'user'
      AND author_id = public.get_operator_access_id(company_id)
    )
    WITH CHECK (
      company_id IN (SELECT public.get_user_company_ids())
      AND note_type = 'user'
      AND author_id = public.get_operator_access_id(company_id)
    );

-- DELETE keeps its author-or-admin shape and gains the auto-logged exclusion.
--
-- 'event' notes are the order-quantity-change audit trail; 'pricing' part comments
-- are written automatically on a pricing save. Both stamp the ACTING member as
-- author_id, so without this clause an author could already delete their own audit
-- line — a privilege that has never been exercised, because until this PR neither
-- delete path had a UI caller at all.
DROP POLICY notes_delete ON public.notes;
CREATE POLICY notes_delete ON public.notes
    FOR DELETE TO authenticated
    USING (
      note_type = 'user'
      AND (author_id = public.get_operator_access_id(company_id)
           OR public.is_company_admin(company_id))
    );

DROP POLICY part_comments_delete ON public.part_comments;
CREATE POLICY part_comments_delete ON public.part_comments
    FOR DELETE TO authenticated
    USING (
      note_type = 'user'
      AND (author_id = public.get_operator_access_id(company_id)
           OR public.is_company_admin(company_id))
    );

-- The restrictive billing_gate_update policy already exists on both tables
-- (apply_billing_write_gate, re-applied at 20260728040701:335-337). Restrictive
-- policies AND with permissive ones, so a lapsed shop cannot edit and there is
-- nothing to add here.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. GUARD TRIGGERS
-- ═══════════════════════════════════════════════════════════════════════════════
-- THE HAZARD THIS FUNCTION IS SHAPED AROUND, and the reason the role check is the
-- first statement rather than a nicety:
--
--   note_views_bump_counts() (20260728040701:481) is an AFTER INSERT trigger on
--   note_views that issues `UPDATE public.notes SET viewer_count = …`. A guard that
--   raised on any viewer_count change would make EVERY NOTE READ throw.
--
-- It is SECURITY DEFINER owned by the table owner, so inside it current_user is the
-- owner and not the PostgREST role — that is the discriminator below. Do not
-- "simplify" this check away, and do not reason about it via a policy TO clause:
-- in Supabase postgres is a member of authenticated, so role MEMBERSHIP is the
-- wrong test. current_user is the right one.

CREATE OR REPLACE FUNCTION public.notes_restrict_update_to_body()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  -- ── THE STAMP: every role, no exceptions ────────────────────────────────────
  -- Deliberately BEFORE the role check below, and that ordering is the whole
  -- correctness of this function. An earlier draft returned early for non-browser
  -- roles and stamped afterwards, which meant a body change made by anything other
  -- than the browser — the backend, an RPC, a future admin tool, a data fix —
  -- silently did NOT mark the note edited. A marker that is absent when the text
  -- did change is worse than no marker at all: it is the column asserting "this is
  -- the original" about text that is not.
  --
  -- The property is "a body change is an edit, whoever made it", which has nothing
  -- to do with which role is trusted to change other columns. Those are two
  -- separate concerns and they get two separate blocks.
  --
  -- SERVER-AUTHORED, overwriting whatever the client sent. The client cannot send
  -- one today — there is no UPDATE grant on edited_at — but a future widened grant
  -- must not silently make the marker forgeable by the one party with a motive to
  -- suppress it.
  --
  -- Fires only on an ACTUAL change: re-saving identical text is not an edit, and a
  -- marker that appears when nothing changed teaches readers to ignore it. This is
  -- also what makes the stamp a no-op for note_views_bump_counts(), which changes
  -- the counters and never the body.
  NEW.edited_at := CASE
    WHEN NEW.body IS DISTINCT FROM OLD.body THEN now()
    ELSE OLD.edited_at
  END;

  -- ── THE COLUMN RESTRICTION: browser roles only ──────────────────────────────
  -- Counter maintenance runs as the table owner and the FastAPI backend runs as
  -- service_role; neither is the threat model, and blocking either breaks view
  -- logging or the backend outright.
  IF current_user IN ('anon', 'authenticated') THEN
    -- DIVERGENCE FROM restrict_transaction_update_to_notes() (baseline.sql:1449),
    -- which enumerates thirteen columns by name. An enumeration is correct only
    -- until somebody adds a fourteenth — and `notes` has gained subject_kind,
    -- captured_job_id, corrects_note_id, viewer_count, maintenance_kind and
    -- resolves_note_id since it was created, so that is not hypothetical here. The
    -- jsonb diff is complete by construction: a future column is immutable by
    -- default, which is the direction a mistake should fail in.
    --
    -- edited_at is subtracted because we just set it ourselves a few lines up.
    IF (to_jsonb(OLD) - 'body' - 'edited_at')
       IS DISTINCT FROM
       (to_jsonb(NEW) - 'body' - 'edited_at')
    THEN
      RAISE EXCEPTION 'Only a note''s body can be edited';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.notes_restrict_update_to_body() IS
  'Backstop for the column-scoped UPDATE grant on public.notes: refuses any browser UPDATE that changes a column other than body, and stamps edited_at itself. Skips non-browser roles because note_views_bump_counts() legitimately writes viewer_count/usage_count as the table owner — without that skip, every note read throws.';

CREATE TRIGGER notes_restrict_update_to_body_trg
  BEFORE UPDATE ON public.notes
  FOR EACH ROW EXECUTE FUNCTION public.notes_restrict_update_to_body();

-- part_comments has no counters and no SECURITY DEFINER writer — nothing legitimate
-- updates this table from any role — so this one is UNCONDITIONAL. The asymmetry
-- with notes above is deliberate and load-bearing; do not "make them consistent".
CREATE OR REPLACE FUNCTION public.part_comments_restrict_update_to_body()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF (to_jsonb(OLD) - 'body' - 'edited_at')
     IS DISTINCT FROM
     (to_jsonb(NEW) - 'body' - 'edited_at')
  THEN
    RAISE EXCEPTION 'Only a comment''s body can be edited';
  END IF;

  NEW.edited_at := CASE
    WHEN NEW.body IS DISTINCT FROM OLD.body THEN now()
    ELSE OLD.edited_at
  END;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.part_comments_restrict_update_to_body() IS
  'Backstop for the column-scoped UPDATE grant on public.part_comments: refuses any UPDATE that changes a column other than body, and stamps edited_at itself. Unconditional, unlike the notes equivalent — no SECURITY DEFINER writer touches this table.';

CREATE TRIGGER part_comments_restrict_update_to_body_trg
  BEFORE UPDATE ON public.part_comments
  FOR EACH ROW EXECUTE FUNCTION public.part_comments_restrict_update_to_body();

-- ── Trigger inventory, checked rather than assumed ────────────────────────────
-- The jsonb diff above is only safe if nothing else writes these rows on UPDATE.
-- At the time of writing: `notes` has exactly ONE other trigger,
-- notes_validate_subject_trg, and `part_comments` has none. Neither table has an
-- updated_at column, so there is no moddatetime-style touch trigger to collide
-- with.
--
-- THE FORWARD INVARIANT, because this is not obvious: same-level BEFORE ROW
-- triggers fire in ALPHABETICAL ORDER BY TRIGGER NAME. A touch trigger sorting
-- before this guard would modify NEW and make the guard reject every legitimate
-- edit; one sorting after would drift unchecked. Which you got would be a name
-- collation accident. So: ADDING A TOUCH TRIGGER OR AN updated_at COLUMN TO EITHER
-- TABLE REQUIRES UPDATING THE EXCLUSION LIST ABOVE. The failure mode is loud (every
-- edit rejected), not silent, which is the acceptable direction.
--
-- notes_validate_subject_trg itself does not interact: it fires only on
-- UPDATE OF company_id, job_id, part_id, routing_operation_id, work_center_id,
-- resolves_note_id, maintenance_kind (20260730015344:159-163), and we name only
-- `body`. Do NOT add `body` to its column list — the guard above already refuses
-- every column in it.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. THE CI GUARD FOR THE PRIVILEGE THAT MATTERS
-- ═══════════════════════════════════════════════════════════════════════════════
-- no_client_access_grant_leaks() (20260728040701:949) covers whole tables that must
-- be invisible. This is the COLUMN-level sibling, and it is the assertion the entire
-- design above rests on: a browser role must never be able to write a counter.
--
-- has_column_privilege() rather than information_schema.column_privileges, because
-- it answers for column-level AND table-level grants together — so a future blanket
-- `GRANT ALL ON public.notes TO authenticated` is caught, not just a careless
-- column grant. That is the regression this is actually guarding against: blanket
-- grants are the thing this repo has historically got wrong.

CREATE OR REPLACE FUNCTION public.note_counter_write_leaks()
RETURNS TABLE(role_name text, column_name text)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT r.rolname::text, c.col::text
  FROM (VALUES ('anon'), ('authenticated')) AS r(rolname)
  CROSS JOIN LATERAL (
    SELECT a.attname AS col
    FROM pg_attribute a
    WHERE a.attrelid = 'public.notes'::regclass
      AND a.attnum > 0
      AND NOT a.attisdropped
      -- `body` is the ONE column an author may edit. Everything else — counters,
      -- tenancy, authorship, every subject column, and edited_at itself — must be
      -- unwritable. Derived from the catalog rather than listed, so a column added
      -- later is covered without anyone remembering to add it here.
      AND a.attname <> 'body'
  ) AS c
  WHERE has_column_privilege(r.rolname, 'public.notes'::regclass, c.col, 'UPDATE')
  ORDER BY 1, 2;
$$;

COMMENT ON FUNCTION public.note_counter_write_leaks() IS
  'Lists any browser-role UPDATE privilege on a public.notes column other than `body`. Must always be empty. viewer_count and usage_count are the load-bearing entries: a writable counter is a one-bit read oracle per note (see 20260728040701:282-289 and docs/modules/operator-view.md). A CI test asserts this returns no rows, so a future blanket GRANT fails the build instead of silently reopening the oracle.';

-- FROM PUBLIC, anon, authenticated — not just PUBLIC, which is the idiom used
-- elsewhere in this schema and does NOT work. The public schema still carries
-- `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon/authenticated` (the
-- 2026-07-16 alignment revoked the ON TABLES defaults only), so a new function is
-- created with an EXPLICIT grant to both browser roles, and REVOKE ... FROM PUBLIC
-- does not remove an explicit role grant. Tracked as issue #640.
REVOKE EXECUTE ON FUNCTION public.note_counter_write_leaks()
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.note_counter_write_leaks() TO service_role;
