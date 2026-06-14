-- Job-level notes for the operator job traveler view.
--
-- These are general notes about a job (not tied to any operation or station),
-- authored by operators/admins on the shop floor. Modeled as an append-only
-- feed: many notes by different people over time, shown newest-first. This is
-- intentionally NOT a single overwritten jobs.notes column.

CREATE TABLE IF NOT EXISTS "public"."job_notes"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "job_id" uuid NOT NULL,
    -- Author's user_company_access row (mirrors operator_sessions.operator_id).
    -- Nullable + ON DELETE SET NULL so a note survives if the author's access
    -- is later removed; the UI falls back to "Unknown" for the name.
    "author_id" uuid,
    "body" text NOT NULL,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "job_notes_pkey" PRIMARY KEY (id),
    CONSTRAINT "job_notes_company_id_fkey" FOREIGN KEY (company_id)
        REFERENCES "public"."companies" (id) ON DELETE CASCADE,
    CONSTRAINT "job_notes_job_id_fkey" FOREIGN KEY (job_id)
        REFERENCES "public"."jobs" (id) ON DELETE CASCADE,
    CONSTRAINT "job_notes_author_id_fkey" FOREIGN KEY (author_id)
        REFERENCES "public"."user_company_access" (id) ON DELETE SET NULL,
    CONSTRAINT "job_notes_body_not_blank" CHECK (length(btrim(body)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_job_notes_job_created
    ON public.job_notes USING btree (job_id, created_at DESC);

ALTER TABLE "public"."job_notes" ENABLE ROW LEVEL SECURITY;

-- Any company member (operators + admins) can read the company's job notes.
DROP POLICY IF EXISTS "Users can view job_notes" ON "public"."job_notes";
CREATE POLICY "Users can view job_notes"
    ON "public"."job_notes"
    FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

-- A company member can add a note, but only as themselves (author_id must be
-- their own access row for the company).
DROP POLICY IF EXISTS "Users can insert own job_notes" ON "public"."job_notes";
CREATE POLICY "Users can insert own job_notes"
    ON "public"."job_notes"
    FOR INSERT
    WITH CHECK (
        (company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids))
        AND (author_id = get_operator_access_id(company_id))
    );

-- Authors can delete their own notes; company admins can delete any.
DROP POLICY IF EXISTS "Authors and admins can delete job_notes" ON "public"."job_notes";
CREATE POLICY "Authors and admins can delete job_notes"
    ON "public"."job_notes"
    FOR DELETE
    USING (
        (author_id = get_operator_access_id(company_id))
        OR is_company_admin(company_id)
    );
