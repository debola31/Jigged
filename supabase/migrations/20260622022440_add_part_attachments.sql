-- Part attachments: engineering files referenced on a part — drawings (PDF),
-- CAD models (STEP), and legacy CAD (DWG). File bytes live in the private
-- `attachments` storage bucket under {companyId}/parts/{partId}/... (see
-- utils/storageHelpers.ts, whose bucket RLS already gates by the company folder).
-- This table is the metadata index. `kind` is computed from the file extension
-- at upload time and stored so the Files-tab viewer can dispatch
-- (PDF iframe / STEP 3D viewer / DWG download) without re-parsing filenames.
-- uploaded_by mirrors part_notes.author_id (user_company_access) so the
-- uploader-or-admin delete policy can reuse get_operator_access_id +
-- is_company_admin.

CREATE TABLE IF NOT EXISTS "public"."part_attachments"
(
    "id"           uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id"   uuid NOT NULL,
    "part_id"      uuid NOT NULL,
    "storage_path" text NOT NULL,
    "file_name"    text NOT NULL,
    "kind"         text NOT NULL DEFAULT 'other',
    "mime_type"    text,
    "size_bytes"   bigint,
    -- Uploader's user_company_access row. Nullable + ON DELETE SET NULL so the
    -- attachment survives if their access is later removed (UI shows "Unknown").
    "uploaded_by"  uuid,
    "created_at"   timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "part_attachments_pkey" PRIMARY KEY (id),
    CONSTRAINT "part_attachments_company_id_fkey" FOREIGN KEY (company_id)
        REFERENCES "public"."companies" (id) ON DELETE CASCADE,
    CONSTRAINT "part_attachments_part_id_fkey" FOREIGN KEY (part_id)
        REFERENCES "public"."parts" (id) ON DELETE CASCADE,
    CONSTRAINT "part_attachments_uploaded_by_fkey" FOREIGN KEY (uploaded_by)
        REFERENCES "public"."user_company_access" (id) ON DELETE SET NULL,
    CONSTRAINT "part_attachments_kind_check"
        CHECK (kind IN ('pdf', 'step', 'dwg', 'other'))
);

CREATE INDEX IF NOT EXISTS idx_part_attachments_part_created
    ON public.part_attachments USING btree (part_id, created_at DESC);

ALTER TABLE "public"."part_attachments" ENABLE ROW LEVEL SECURITY;

-- Any company member can read the company's part attachments.
DROP POLICY IF EXISTS "Users can view part_attachments" ON "public"."part_attachments";
CREATE POLICY "Users can view part_attachments"
    ON "public"."part_attachments"
    FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

-- A company member can upload, but only as themselves.
DROP POLICY IF EXISTS "Users can insert own part_attachments" ON "public"."part_attachments";
CREATE POLICY "Users can insert own part_attachments"
    ON "public"."part_attachments"
    FOR INSERT
    WITH CHECK (
        (company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids))
        AND (uploaded_by = get_operator_access_id(company_id))
    );

-- Uploaders can delete their own files; company admins can delete any.
DROP POLICY IF EXISTS "Uploaders and admins can delete part_attachments" ON "public"."part_attachments";
CREATE POLICY "Uploaders and admins can delete part_attachments"
    ON "public"."part_attachments"
    FOR DELETE
    USING (
        (uploaded_by = get_operator_access_id(company_id))
        OR is_company_admin(company_id)
    );
