-- part_playbook_notes(): return edited_at, so the Playbook can render "· edited".
--
-- Companion to 20260801012019_notes_editable_body.sql (issue #628). The Playbook
-- sheet is the one note surface that reads through an RPC rather than a PostgREST
-- select, so the new column has to be threaded through by hand.
--
-- WHY THIS IS A DROP AND NOT A CREATE OR REPLACE: the RETURNS TABLE shape changes,
-- and Postgres will not replace a function whose OUT parameters differ. Same reason
-- 20260729133520 had to drop it.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- READ THIS BEFORE THE NEXT TIME SOMEBODY DROPS THIS FUNCTION
-- ═══════════════════════════════════════════════════════════════════════════════
-- A DROP destroys the function's ACL and its COMMENT along with the body, and
-- neither comes back with "copy the definition". That already went wrong here:
--
--   20260728041800:167-168  set the intended ACL —
--                             REVOKE EXECUTE ... FROM PUBLIC;
--                             GRANT  EXECUTE ... TO authenticated;
--   20260729133520:14       DROPped the function to widen RETURNS TABLE, recreated
--                           it, and never re-issued either. The ACL reverted to the
--                           default, and the COMMENT was lost.
--   20260729161455          used CREATE OR REPLACE, so it inherited that state
--                           rather than fixing it.
--
-- Confirmed on a migration-replayed database: part_playbook_notes' ACL carries the
-- `=X/postgres` PUBLIC entry that its sibling functions lack. It has been callable
-- by anon since 2026-07-29.
--
-- That is harmless TODAY — the function is SECURITY INVOKER, and anon is a member
-- of no company, so get_user_company_ids() returns empty and the query yields no
-- rows. It stops being harmless the moment anyone makes this SECURITY DEFINER.
--
-- So this migration re-issues the ACL and the COMMENT below. If you drop this
-- function again: bring all four of body, attributes, ACL and COMMENT with you.

DROP FUNCTION IF EXISTS public.part_playbook_notes(uuid, uuid, text, uuid, integer);

CREATE OR REPLACE FUNCTION public.part_playbook_notes(
  p_part_id              uuid,
  -- The step, when scoping to one. NULL returns everything known about the part.
  p_routing_operation_id uuid    DEFAULT NULL,
  -- Legacy step-name fallback, for prior-run job notes whose job_operation has no
  -- routing_operation_id (an ad-hoc step added to a job). Mirrors the fallback that
  -- matchingStepOperationIds() used.
  p_operation_name       text    DEFAULT NULL,
  -- The current job: its own notes are already in the job feed, so they are not
  -- "previous" notes.
  p_exclude_job_id       uuid    DEFAULT NULL,
  -- Bounds branch 2 only. Branch 1 needs no cap — it is one indexed lookup.
  p_max_runs             integer DEFAULT 10
)
RETURNS TABLE (
  id                   uuid,
  body                 text,
  created_at           timestamptz,
  -- NEW: NULL unless the author has corrected the wording. The sheet renders a
  -- quiet "· edited" beside the timestamp, because a reader deciding whether to
  -- trust a note is entitled to know the text is not the original. No time is
  -- shown with it — see NoteEditedMark for why.
  edited_at            timestamptz,
  note_type            text,
  subject_kind         text,
  routing_operation_id uuid,
  corrects_note_id     uuid,
  viewer_count         integer,
  usage_count          integer,
  -- The reaction UI must not offer a thumbs-up on your own note — RLS forbids it,
  -- so the button would be a guaranteed 42501. Only an id can decide that; matching
  -- on author_name breaks the moment a shop has two Daves. Now also decides whether
  -- to offer Edit and Delete.
  author_id            uuid,
  author_name          text,
  job_number           text,
  operation_label      text,
  media                jsonb,
  reactions            jsonb
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $$
  WITH durable AS (
    -- BRANCH 1 — the durable subject. One index hit on idx_notes_part_step. No prior
    -- runs, no step-name heuristic, no cap. This is every note written after the
    -- subject migration, and it is what makes the read-back loop possible at all.
    SELECT
      n.id, n.body, n.created_at, n.edited_at, n.note_type, n.subject_kind,
      n.routing_operation_id,
      n.corrects_note_id, n.viewer_count, n.usage_count, n.author_id,
      cj.job_number AS src_job_number,
      CASE
        WHEN ro.id IS NULL THEN NULL
        ELSE 'Op ' || ro.sequence::text ||
             COALESCE(' · ' || wc.name, '')
      END AS src_operation_label
    FROM public.notes n
    LEFT JOIN public.jobs cj              ON cj.id = n.captured_job_id
    LEFT JOIN public.routing_operations ro ON ro.id = n.routing_operation_id
    LEFT JOIN public.work_centers wc       ON wc.id = ro.work_center_id
    WHERE n.subject_kind = 'part'
      AND n.part_id = p_part_id
      AND (p_routing_operation_id IS NULL
           OR n.routing_operation_id = p_routing_operation_id)
      -- Captured on the job the operator is standing in front of: already visible in
      -- that job's feed, so showing it again as "previous" is noise.
      AND (p_exclude_job_id IS NULL
           OR n.captured_job_id IS DISTINCT FROM p_exclude_job_id)
  ),
  runs AS (
    -- BRANCH 2 scaffolding — the most recent completed runs of this part.
    SELECT jp.job_id, j.job_number
    FROM public.job_parts jp
    JOIN public.jobs j ON j.id = jp.job_id
    WHERE jp.part_id = p_part_id
      AND jp.production_status = 'completed'
      AND (p_exclude_job_id IS NULL OR jp.job_id <> p_exclude_job_id)
    ORDER BY jp.completed_at DESC NULLS LAST
    LIMIT p_max_runs
  ),
  legacy AS (
    -- BRANCH 2 — pre-migration notes, which are all subject_kind = 'job'. Step match
    -- by routing_operation_id, falling back to operation_name when the job's step has
    -- no routing link. Delete this branch once the old corpus stops mattering.
    SELECT
      n.id, n.body, n.created_at, n.edited_at, n.note_type, n.subject_kind,
      n.routing_operation_id,
      n.corrects_note_id, n.viewer_count, n.usage_count, n.author_id,
      r.job_number AS src_job_number,
      CASE
        WHEN jo.id IS NULL THEN NULL
        WHEN jo.sequence IS NULL THEN jo.operation_name
        ELSE 'Op ' || jo.sequence::text || ' · ' || jo.operation_name
      END AS src_operation_label
    FROM runs r
    JOIN public.notes n ON n.job_id = r.job_id AND n.subject_kind = 'job'
    LEFT JOIN public.job_operations jo ON jo.id = n.job_operation_id
    WHERE p_routing_operation_id IS NULL
       OR jo.routing_operation_id = p_routing_operation_id
       OR (jo.routing_operation_id IS NULL
           AND p_operation_name IS NOT NULL
           AND jo.operation_name = p_operation_name)
  ),
  combined AS (
    SELECT * FROM durable
    UNION ALL
    SELECT * FROM legacy
  )
  SELECT
    c.id, c.body, c.created_at, c.edited_at, c.note_type, c.subject_kind,
    c.routing_operation_id,
    c.corrects_note_id, c.viewer_count, c.usage_count,
    c.author_id,
    a.name AS author_name,
    c.src_job_number,
    c.src_operation_label,
    COALESCE(m.media, '[]'::jsonb),
    COALESCE(rx.reactions, '[]'::jsonb)
  FROM combined c
  LEFT JOIN public.user_company_access a ON a.id = c.author_id
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
             'id', md.id,
             'storage_path', md.storage_path,
             'thumbnail_path', md.thumbnail_path,
             'kind', md.kind,
             'mime_type', md.mime_type,
             'width', md.width,
             'height', md.height
           ) ORDER BY md.created_at) AS media
    FROM public.note_media md
    WHERE md.note_id = c.id
  ) m ON true
  LEFT JOIN LATERAL (
    -- Reactions embed here because they are PUBLIC within the shop — the deliberate
    -- opposite of note_views, which has no read path at any level. Names and counts
    -- both derive from this one array client-side, so the number and the names can
    -- never disagree; that is why there is no denormalized reaction counter.
    SELECT jsonb_agg(jsonb_build_object(
             'kind', x.kind,
             -- WITHOUT THIS the reader can never be found in the array, so the
             -- thumbs-up renders un-pressed on a note they have already marked
             -- helpful, and tapping it again just re-inserts a duplicate. The
             -- reaction was persisting the whole time; it simply could not be
             -- recognised as theirs. Costs nothing extra: the join is already here.
             'reactor_id', x.reactor_id,
             'name', u.name,
             'created_at', x.created_at
           )) AS reactions,
           count(*) FILTER (WHERE x.kind = 'helpful') AS helpful_count
    FROM public.note_reactions x
    JOIN public.user_company_access u ON u.id = x.reactor_id
    WHERE x.note_id = c.id
  ) rx ON true
  -- RANKING: the load-bearing note first, EXCEPT that nothing recent gets buried.
  --
  -- Newest-first was safe but wrong on a part with several notes: the one that has
  -- actually been consulted on eleven jobs could sit fourth, below three that were
  -- read once out of curiosity. Ranking by usefulness fixes that.
  --
  -- The recency guard is not a nicety. Pure usefulness ranking sinks a note written
  -- this morning about a changed fixture below an old note with a long history —
  -- and on a shop floor the fresh correction is the one that must be seen. The
  -- original plan solved this with a 'confirmed' reaction and visual decay of stale
  -- entries; both were dropped, so the guard carries that weight alone.
  --
  -- 14 days is a judgement, not a finding: long enough to cover a part that runs
  -- monthly, short enough that the pinned group stays small. Worth revisiting with
  -- real data.
  --
  -- DELIBERATELY ORDERS ON created_at, NEVER edited_at. Now that notes are editable
  -- (#628), ordering on edited_at would let a one-character typo fix bump a note
  -- back into the recent group ahead of genuinely new knowledge — a free way to
  -- re-pin your own note to the top of everyone's Playbook. "Recent" here means
  -- recently WRITTEN, which is the claim the guard is actually making.
  ORDER BY
    (c.created_at >= now() - interval '14 days') DESC,
    -- Within the recent group, newest first. NULL for older notes, which the first
    -- key has already partitioned below, so they tie here and fall through.
    CASE WHEN c.created_at >= now() - interval '14 days' THEN c.created_at END DESC,
    -- Distinct JOBS it was consulted on: behavioural, and the strongest signal we
    -- have. It beats helpful because it records someone reaching for the note while
    -- doing the work, not an opinion offered afterwards.
    c.usage_count DESC,
    COALESCE(rx.helpful_count, 0) DESC,
    c.created_at DESC;
$$;

COMMENT ON FUNCTION public.part_playbook_notes(uuid, uuid, text, uuid, integer) IS
  'Everything known about running this part (optionally scoped to one routing step), ranked by usefulness with a 14-day recency guard, in one round trip. Unions durable part-subject notes (a single index hit) with legacy job-scoped notes from recent completed runs. Returns author_id as well as author_name so the UI can suppress the thumbs-up on the reader''s own notes (RLS forbids self-reaction) and offer Edit/Delete only on them, and edited_at so a corrected note renders "· edited". Orders on created_at and never edited_at, so a typo fix cannot re-pin a note to the top. SECURITY INVOKER so notes/jobs/job_parts RLS still enforces tenancy.';

-- RESTORING the ACL that 20260728041800 intended and the 2026-07-29 DROP destroyed.
--
-- `FROM PUBLIC, anon` rather than `FROM PUBLIC` alone: the schema still carries
-- ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon/authenticated, so the
-- CREATE above lands with an EXPLICIT anon grant that a REVOKE FROM PUBLIC would
-- leave in place. The original migration had that same gap, which is why the goal
-- here is the ACL that migration INTENDED rather than the one it produced. The
-- general fix is tracked as issue #640.
REVOKE EXECUTE ON FUNCTION public.part_playbook_notes(uuid, uuid, text, uuid, integer)
  FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.part_playbook_notes(uuid, uuid, text, uuid, integer)
  TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- THE DURABLE HALF: a CI guard, because the repair above only fixes TODAY
-- ═══════════════════════════════════════════════════════════════════════════════
-- Restoring the ACL is worth little on its own — the last DROP destroyed it
-- silently and nothing noticed for three days, because an OVER-granted function
-- breaks nothing you would ever see. Only a test catches that class of mistake.
--
-- Same idiom as no_client_access_grant_leaks() and note_counter_write_leaks():
-- returns rows only when something is wrong, and a pytest asserts it is empty.

CREATE OR REPLACE FUNCTION public.playbook_rpc_execute_leaks()
RETURNS TABLE(role_name text)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  -- `authenticated` is SUPPOSED to hold EXECUTE and is deliberately not listed.
  -- anon is the one that must never: the function is SECURITY INVOKER today, so
  -- anon getting nothing back is a property of RLS rather than of the ACL, and
  -- the ACL is the layer that would still hold if that ever changed.
  SELECT r.rolname::text
  FROM (VALUES ('anon')) AS r(rolname)
  WHERE has_function_privilege(
          r.rolname,
          'public.part_playbook_notes(uuid, uuid, text, uuid, integer)',
          'EXECUTE');
$$;

COMMENT ON FUNCTION public.playbook_rpc_execute_leaks() IS
  'Lists browser roles that hold EXECUTE on part_playbook_notes but should not (anon). Must always be empty. Exists because a DROP FUNCTION destroys a function''s ACL, which already happened once (20260729133520) and shipped the Playbook RPC anon-executable for three days without any visible symptom. See issue #640 for the wider case: the ON FUNCTIONS default privileges were never revoked, so REVOKE ... FROM PUBLIC alone does not close a function.';

REVOKE EXECUTE ON FUNCTION public.playbook_rpc_execute_leaks()
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.playbook_rpc_execute_leaks() TO service_role;
