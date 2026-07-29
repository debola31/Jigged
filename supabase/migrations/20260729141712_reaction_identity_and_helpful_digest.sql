-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. part_playbook_notes(): the reactions array must say WHO reacted
-- ═══════════════════════════════════════════════════════════════════════════════
-- Observed on the preview: marking a previous-run note helpful appeared not to
-- persist. It always did. The array this function returns carried kind, name and
-- created_at but NOT reactor_id, so the reader could never be found in it —
-- the thumbs-up rendered un-pressed on a note they had already marked, and a
-- second tap re-inserted, which the client correctly treats as a no-op duplicate.
--
-- The job feed was unaffected: it reads through a PostgREST embed that selects
-- reactor_id. Only this RPC, written in Iteration A when nothing consumed the
-- array, was missing it.
--
-- Signature and return type are unchanged, so CREATE OR REPLACE is enough and
-- types/database.ts is untouched by this half.

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
  note_type            text,
  subject_kind         text,
  routing_operation_id uuid,
  corrects_note_id     uuid,
  viewer_count         integer,
  usage_count          integer,
  -- NEW: the reaction UI must not offer a thumbs-up on your own note — RLS
  -- forbids it, so the button would be a guaranteed 42501. Only an id can decide
  -- that; matching on author_name breaks the moment a shop has two Daves.
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
      n.id, n.body, n.created_at, n.note_type, n.subject_kind, n.routing_operation_id,
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
      n.id, n.body, n.created_at, n.note_type, n.subject_kind, n.routing_operation_id,
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
    c.id, c.body, c.created_at, c.note_type, c.subject_kind, c.routing_operation_id,
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
           )) AS reactions
    FROM public.note_reactions x
    JOIN public.user_company_access u ON u.id = x.reactor_id
    WHERE x.note_id = c.id
  ) rx ON true
  ORDER BY c.created_at DESC;
$$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. my_note_digest(): views AND helpful, because both are what came back
-- ═══════════════════════════════════════════════════════════════════════════════
-- The login banner reported views only. Being marked helpful is the stronger
-- signal of the two — a view is someone needing to look something up, a helpful
-- is a colleague choosing to say it was worth reading — so the banner should
-- carry it.
--
-- Renamed from my_note_view_digest: a function returning helpful counts under a
-- "view_digest" name is a lie the next reader has to discover. DROP + CREATE
-- because the return type changes from a scalar to a row; types/database.ts is
-- updated in the same commit, since the backend job diffs a byte-exact regen.
--
-- Still argument-free, permanently. A caller-supplied window would be a bisection
-- oracle recovering WHEN a note was read; the banner subtracts running totals on
-- the client, so no instant ever crosses the wire.
--
-- SECURITY INVOKER: `views` reads notes.viewer_count, a maintained aggregate on a
-- row the caller can already SELECT, and `helpful` counts note_reactions, which is
-- public inside the shop by policy. Neither touches note_views, so the privileged
-- family stays at two (log_note_views, note_viewers).
--
-- helpful is counted, not denormalized, deliberately: reactions have no counter
-- column precisely so a count and its names can never disagree.

DROP FUNCTION IF EXISTS public.my_note_view_digest();

CREATE OR REPLACE FUNCTION public.my_note_digest()
RETURNS TABLE (views integer, helpful integer)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $$
  WITH mine AS (
    SELECT n.id, n.viewer_count
    FROM public.notes n
    WHERE n.author_id IS NOT NULL
      AND n.author_id = public.get_operator_access_id(n.company_id)
  )
  SELECT
    COALESCE((SELECT SUM(m.viewer_count) FROM mine m), 0)::integer,
    COALESCE((
      SELECT count(*)
      FROM public.note_reactions x
      JOIN mine m ON m.id = x.note_id
      WHERE x.kind = 'helpful'
    ), 0)::integer;
$$;

COMMENT ON FUNCTION public.my_note_digest() IS
  'Running totals of what came back on the caller''s OWN notes: views (SUM of notes.viewer_count — the same definition My work shows) and helpful marks. Takes no arguments on purpose: a caller-supplied time window would be a bisection oracle recovering WHEN a note was read. The login banner stores the totals it last acknowledged and renders the differences, so the deltas are computed on the client and no instant ever crosses the wire. SECURITY INVOKER — reads only aggregates the caller may already select, never note_views.';

REVOKE EXECUTE ON FUNCTION public.my_note_digest() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.my_note_digest() TO authenticated;
