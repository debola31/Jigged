-- part_playbook_notes(): the read-back query, in one round trip.
--
-- REPLACES getPartPreviousNotes() (utils/operatorAccess.ts), which issued
-- 1 (job_parts) + 1 (step identity) + 2N (getJobNotes + matchingStepOperationIds per
-- prior run) round trips — up to 22 for the default maxRuns of 10 — then sorted and
-- capped in JS. On shop wifi nobody waited for that, which is a large part of why the
-- seeded knowledge in the last usability session went unread.
--
-- After the subject migration, most of this is no longer needed at all: a note whose
-- subject is (part_id, routing_operation_id) is DURABLE and job-independent, so the
-- next person running the part reads it from a single index hit on idx_notes_part_step
-- with no traversal of prior jobs. The prior-run walk survives only as branch 2, for
-- notes written BEFORE that migration, and it shrinks in relevance every month. When
-- the pre-migration corpus stops mattering, delete branch 2 and this becomes a plain
-- PostgREST select.
--
-- SECURITY INVOKER is deliberate. Running as `authenticated` means notes / jobs /
-- job_parts RLS still applies, so tenant isolation is free — there is no hand-written
-- `company_id IN (SELECT get_user_company_ids())` to forget and no way for this to
-- become a cross-tenant oracle. It reads no privileged table: viewer_count and
-- usage_count are columns on notes, and note_views is never touched. log_note_views()
-- and note_viewers() must be DEFINER precisely because they DO touch note_views;
-- keeping DEFINER to only those two is what holds the audit surface to two functions.

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
             'name', u.name,
             'created_at', x.created_at
           )) AS reactions
    FROM public.note_reactions x
    JOIN public.user_company_access u ON u.id = x.reactor_id
    WHERE x.note_id = c.id
  ) rx ON true
  ORDER BY c.created_at DESC;
$$;

COMMENT ON FUNCTION public.part_playbook_notes(uuid, uuid, text, uuid, integer) IS
  'Everything known about running this part (optionally scoped to one routing step), newest first, in one round trip. Unions durable part-subject notes (a single index hit) with legacy job-scoped notes from recent completed runs. SECURITY INVOKER so notes/jobs/job_parts RLS still enforces tenancy. Replaces getPartPreviousNotes and its ~22 round trips.';

REVOKE EXECUTE ON FUNCTION public.part_playbook_notes(uuid, uuid, text, uuid, integer) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.part_playbook_notes(uuid, uuid, text, uuid, integer) TO authenticated;
