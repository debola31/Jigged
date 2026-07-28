-- Create the `attachments` storage bucket.
--
-- It has existed in production for a long time — created out-of-band, via the
-- dashboard — and was captured in supabase/schema.prod.sql. But schema.prod.sql
-- is a SNAPSHOT of prod, not something that gets applied: only
-- supabase/migrations/ is replayed. So the bucket existed in exactly one place.
--
-- Consequence, confirmed on a preview deployment: every file upload fails with
-- "Bucket not found" on every Supabase preview branch and on any freshly reset
-- local stack. Photo capture, job attachments and part attachments have only
-- ever worked in production.
--
-- That is also why job_note_media.thumbnail_path was never populated and nobody
-- noticed: the photo path could not be exercised anywhere it was safe to look.
-- A defect you cannot reach in dev is a defect you find in front of a customer.
--
-- The storage.objects RLS policies were already migration-managed (see
-- 20260725210136_stripe_write_enforcement.sql), so preview branches have been
-- carrying policies that guard a bucket which does not exist.
--
-- Idempotent, and deliberately matching the prod row exactly:
--   public = false            — signed URLs only; the bucket is company-scoped by
--                               the storage.objects policies, not by being public
--   file_size_limit = NULL    — inherits the project default (50 MB); the client
--                               compresses to ~1.5 MB before upload anyway
--   allowed_mime_types = NULL — job/part attachments carry drawings and STEP
--                               files, not only images
--
-- ON CONFLICT DO NOTHING so replaying against prod (which already has it) is a
-- no-op and never rewrites the live bucket's settings.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('attachments', 'attachments', false, NULL, NULL)
ON CONFLICT (id) DO NOTHING;
