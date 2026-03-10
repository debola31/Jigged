-- ============================================================
-- Remove quantity_completed and quantity_scrapped from job_operations
-- Created: 2026-03-09
--
-- Material consumption is now tracked through inventory
-- transactions linked to job operations, not through
-- quantity fields on the operation itself.
-- ============================================================

BEGIN;

ALTER TABLE public.job_operations
    DROP COLUMN IF EXISTS quantity_completed;

ALTER TABLE public.job_operations
    DROP COLUMN IF EXISTS quantity_scrapped;

COMMIT;
