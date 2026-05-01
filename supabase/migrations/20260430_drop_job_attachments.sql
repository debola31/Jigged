-- Drop job_attachments entirely. Same scope and rationale as the recent
-- quote_attachments removal: the attach-a-PDF-to-a-job concept doesn't fit
-- the salesperson/operator workflow we're shipping for the pilot.
--
-- The table has no inbound foreign keys (the only FK reference,
-- source_quote_attachment_id, was already dropped in 20260430_drop_quote_attachments.sql).
-- Cascading rules on its own FKs (job_id, company_id) drop with the table.

DROP TABLE IF EXISTS public.job_attachments;
