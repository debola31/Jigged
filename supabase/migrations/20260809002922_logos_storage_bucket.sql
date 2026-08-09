-- Create the `logos` storage bucket and bring its policies under migration control.
--
-- **The company logo has never rendered on any PDF, anywhere, including production.**
-- `loadLogoAsDataUrl` in utils/packingSlipPdf.ts reads `storage.from('logos')`, and no migration
-- has ever created that bucket — it is referenced nowhere else in the repo. Every call returned
-- "Bucket not found", the function swallowed it (by design, so a missing logo never breaks a
-- document), and the layout fell back to the company name in bold. Nothing was broken enough to
-- notice, and `companies.logo_url` had no UI to set it either, so nothing ever pointed at the
-- bucket to prove it was absent.
--
-- This is the same failure `20260728212230_create_attachments_storage_bucket.sql` fixed for
-- `attachments`, which had existed only as a dashboard-created row captured in a prod schema
-- snapshot. That one was invisible in dev and worked in prod; this one is invisible everywhere.
--
-- A DEDICATED BUCKET rather than a folder inside `attachments`, for one reason that a client-side
-- check cannot supply: `allowed_mime_types` and `file_size_limit` are enforced by Postgres. A logo
-- is always a small PNG or JPEG, so the bucket can say so and refuse anything else no matter what
-- calls it. `attachments` is deliberately NULL/NULL because it carries STEP, DWG and PDF drawings
-- of unbounded size; widening it to police logos would weaken it for its actual job.
--
--   public = false          — signed URLs only; company scoping comes from the policies below
--   file_size_limit = 2 MB  — a logo that needs more than this is the wrong asset for a header
--   allowed_mime_types      — PNG for transparency, JPEG for photographed marks. Nothing else:
--                             SVG in particular is a scripting surface and jsPDF cannot embed it.
--
-- ON CONFLICT DO NOTHING so replaying is a no-op and never rewrites a live bucket's settings.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('logos', 'logos', false, 2097152, ARRAY['image/png', 'image/jpeg'])
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────── RLS on storage.objects ───────────────────────────
-- Same shape as the `attachments` policies (20260725210136, 20260730045322): the FIRST PATH
-- SEGMENT is the company id, and `generateCompanyLogoPath` is the only writer — it emits
-- `{companyId}/company/logo_{uuid}_{name}`.
--
-- The `bucket_id` test comes first in every policy so a non-logos or non-uuid path never reaches
-- the ::uuid cast.
--
-- No UPDATE policy, deliberately: every upload mints a fresh uuid path and the previous object is
-- deleted, so nothing is ever overwritten in place. That also gives free cache-busting on the
-- signed URL, which matters because a replaced logo must not keep printing the old one.

DROP POLICY IF EXISTS "Users can read logos from their company folder" ON storage.objects;
CREATE POLICY "Users can read logos from their company folder"
    ON storage.objects
    FOR SELECT
    TO authenticated
    USING (
        bucket_id = 'logos'
        AND (storage.foldername(name))[1] IN (
            SELECT company_id::text FROM public.user_company_access
             WHERE user_id = auth.uid()
        )
    );

-- Reads are tenant-scoped but NOT billing-gated, matching docs/modules/billing.md §4 and the
-- attachments SELECT policy: a lapsed shop can always look at its own data, and more concretely,
-- it must still be able to print a packing slip for goods already on a truck. Writes below DO
-- carry `company_can_write`.

DROP POLICY IF EXISTS "Users can upload logos to their company folder" ON storage.objects;
CREATE POLICY "Users can upload logos to their company folder"
    ON storage.objects
    FOR INSERT
    TO authenticated
    WITH CHECK (
        bucket_id = 'logos'
        AND (storage.foldername(name))[1] IN (
            SELECT company_id::text FROM public.user_company_access
             WHERE user_id = auth.uid()
        )
        AND public.company_can_write(((storage.foldername(name))[1])::uuid)
    );

DROP POLICY IF EXISTS "Users can delete logos from their company folder" ON storage.objects;
CREATE POLICY "Users can delete logos from their company folder"
    ON storage.objects
    FOR DELETE
    TO authenticated
    USING (
        bucket_id = 'logos'
        AND (storage.foldername(name))[1] IN (
            SELECT company_id::text FROM public.user_company_access
             WHERE user_id = auth.uid()
        )
        AND public.company_can_write(((storage.foldername(name))[1])::uuid)
    );
