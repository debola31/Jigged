-- Job attachments: customer-supplied PDFs (e.g. the PO document) referenced on a
-- job. The file bytes live in the existing private `attachments` storage bucket
-- under {companyId}/jobs/{jobId}/... (see utils/storageHelpers.ts, whose bucket
-- RLS already gates access by company folder). This table is the metadata index.
--
-- uploaded_by mirrors jobs.created_by (auth.users id). RLS is company-scoped for
-- read/write, matching the simplest per-company pattern (cf. job_notes SELECT).

CREATE TABLE IF NOT EXISTS "public"."job_attachments"
(
    "id"           uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id"   uuid NOT NULL,
    "job_id"       uuid NOT NULL,
    "storage_path" text NOT NULL,
    "file_name"    text NOT NULL,
    "mime_type"    text,
    "size_bytes"   bigint,
    "uploaded_by"  uuid,
    "created_at"   timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "job_attachments_pkey" PRIMARY KEY (id),
    CONSTRAINT "job_attachments_company_id_fkey" FOREIGN KEY (company_id)
        REFERENCES "public"."companies" (id) ON DELETE CASCADE,
    CONSTRAINT "job_attachments_job_id_fkey" FOREIGN KEY (job_id)
        REFERENCES "public"."jobs" (id) ON DELETE CASCADE,
    CONSTRAINT "job_attachments_uploaded_by_fkey" FOREIGN KEY (uploaded_by)
        REFERENCES "auth"."users" (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_job_attachments_job
    ON public.job_attachments USING btree (job_id);

ALTER TABLE "public"."job_attachments" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their company's job_attachments" ON "public"."job_attachments";
CREATE POLICY "Users can view their company's job_attachments"
    ON "public"."job_attachments"
    FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can insert their company's job_attachments" ON "public"."job_attachments";
CREATE POLICY "Users can insert their company's job_attachments"
    ON "public"."job_attachments"
    FOR INSERT
    WITH CHECK ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can delete their company's job_attachments" ON "public"."job_attachments";
CREATE POLICY "Users can delete their company's job_attachments"
    ON "public"."job_attachments"
    FOR DELETE
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));
