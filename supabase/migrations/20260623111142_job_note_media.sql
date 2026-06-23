-- Photos (and later short videos) attached to a job_notes entry. A note has
-- 0..n media. File bytes live in the private `attachments` storage bucket under
-- {companyId}/jobs/{jobId}/... (see utils/storageHelpers.ts, whose bucket RLS
-- already gates by the company folder — so no new storage policy is needed).
-- This table is the metadata index; the feed renders thumbnails via signed URLs.
--
-- Authorship lives on the parent job_notes row (author_id), so this table has
-- no uploaded_by — the delete policy reuses the parent note's author. The schema
-- accommodates video now (kind='video', duration_seconds); P1 only writes
-- kind='photo'.

CREATE TABLE IF NOT EXISTS "public"."job_note_media"
(
    "id"               uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id"       uuid NOT NULL,
    "note_id"          uuid NOT NULL,
    "storage_path"     text NOT NULL,
    -- Poster/thumbnail key. Nullable: a photo may render from its own image.
    "thumbnail_path"   text,
    "kind"             text NOT NULL DEFAULT 'photo',
    "mime_type"        text,
    "size_bytes"       bigint,
    "width"            integer,
    "height"           integer,
    -- Video only; NULL for photos.
    "duration_seconds" numeric,
    "created_at"       timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "job_note_media_pkey" PRIMARY KEY (id),
    CONSTRAINT "job_note_media_company_id_fkey" FOREIGN KEY (company_id)
        REFERENCES "public"."companies" (id) ON DELETE CASCADE,
    CONSTRAINT "job_note_media_note_id_fkey" FOREIGN KEY (note_id)
        REFERENCES "public"."job_notes" (id) ON DELETE CASCADE,
    CONSTRAINT "job_note_media_kind_check"
        CHECK (kind IN ('photo', 'video'))
);

CREATE INDEX IF NOT EXISTS idx_job_note_media_note
    ON public.job_note_media USING btree (note_id);

ALTER TABLE "public"."job_note_media" ENABLE ROW LEVEL SECURITY;

-- Any company member can read the company's job-note media.
DROP POLICY IF EXISTS "Users can view job_note_media" ON "public"."job_note_media";
CREATE POLICY "Users can view job_note_media"
    ON "public"."job_note_media"
    FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

-- A company member can attach media (must be an actual member of the company;
-- authorship is enforced on the parent note's INSERT policy).
DROP POLICY IF EXISTS "Users can insert job_note_media" ON "public"."job_note_media";
CREATE POLICY "Users can insert job_note_media"
    ON "public"."job_note_media"
    FOR INSERT
    WITH CHECK (
        (company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids))
        AND (get_operator_access_id(company_id) IS NOT NULL)
    );

-- The parent note's author can delete its media; company admins can delete any.
DROP POLICY IF EXISTS "Authors and admins can delete job_note_media" ON "public"."job_note_media";
CREATE POLICY "Authors and admins can delete job_note_media"
    ON "public"."job_note_media"
    FOR DELETE
    USING (
        is_company_admin(company_id)
        OR EXISTS (
            SELECT 1 FROM "public"."job_notes" n
            WHERE n.id = job_note_media.note_id
              AND n.author_id = get_operator_access_id(company_id)
        )
    );
