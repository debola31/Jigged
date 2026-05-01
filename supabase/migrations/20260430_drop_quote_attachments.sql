-- Remove quote attachments entirely. The "attach a PDF to a quote" concept
-- doesn't fit the salesperson workflow we're building toward, so the table,
-- its policies, and its inbound foreign key on job_attachments all go.
--
-- Job attachments stay (they're independent of quotes and surface on the
-- job detail page). The only change there is dropping the legacy
-- source_quote_attachment_id column + its FK so the quote_attachments
-- table can be dropped cleanly.

ALTER TABLE public.job_attachments
  DROP CONSTRAINT IF EXISTS job_attachments_source_fkey;

ALTER TABLE public.job_attachments
  DROP COLUMN IF EXISTS source_quote_attachment_id;

DROP TABLE IF EXISTS public.quote_attachments;
