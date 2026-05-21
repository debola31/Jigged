-- ============================================================================
-- Drop jobs.related_to_job_id and its same-company trigger
-- ============================================================================
--
-- Context. PR 6 (migration 20260525) shipped the column + a
-- "Create Reorder" UI surface on the job detail page on the
-- assumption it satisfied PRD §8 Flow F's "salesperson creates a new
-- job with a 'related to' link to the original."
--
-- On review, neither Flow F nor FR-21 required a button. FR-21 only
-- required: "Closed jobs cannot be reopened. New work for the same
-- part creates a new job." The data-model link was an implementation
-- detail that's been removed from the PRD along with the button.
--
-- This migration removes:
--   - the same-company enforcement trigger + function
--   - the partial index on related_to_job_id
--   - the column itself (which carries the FK to jobs(id) ON DELETE
--     SET NULL — Postgres drops the constraint with the column)
--
-- The PR 6 search_jobs_by_identifier RPC + the pg_trgm indexes are
-- separate concerns and stay — they're still wired up to the jobs-list
-- search experience.
--
-- IDEMPOTENT. DROP IF EXISTS on trigger, function, index, column.
-- Re-running on a fully-migrated DB is a no-op.
--
-- Forward-only; not reversible without losing reorder-link data. Any
-- production rows with related_to_job_id set are dropped silently here
-- — the UI has been removed so nothing reads them anyway.

BEGIN;


DROP TRIGGER IF EXISTS enforce_jobs_related_to_same_company_trg
    ON public.jobs;

DROP FUNCTION IF EXISTS public.enforce_jobs_related_to_same_company();

DROP INDEX IF EXISTS public.idx_jobs_related_to_job_id;

ALTER TABLE public.jobs
    DROP COLUMN IF EXISTS related_to_job_id;


COMMIT;
