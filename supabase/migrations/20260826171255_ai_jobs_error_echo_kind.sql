-- ai_jobs.error_kind gains 'error_echo'.
--
-- WHY A NEW KIND RATHER THAN 'provider' OR 'internal'. The insights loop now
-- refuses a final turn that carries no answer and no successful query behind it
-- -- the shape every local model arm produced in the A/B, where the last thing
-- the model said was "The column total_price does not exist..." and the job
-- settled `succeeded` with that in it. That failure is neither of the kinds
-- already here: the provider answered on time and our own code did not
-- misbehave. Filing it as either would bury the one number this change exists
-- to make countable -- how often an arm reaches the end holding nothing.
--
-- WHY THIS IS A MIGRATION AT ALL. error_kind is an allowlist, so a Python-only
-- change would have raised 23514 inside mark_failed, lost the UPDATE, and left
-- the row `running` until the sweep collected it as a timeout -- showing the
-- user "offline" for a failure that had nothing to do with the box being off.
--
-- Rebuilt from the constraint's NEWEST definition (still 20260825135302, its
-- creating migration -- verified, not assumed) so no entry is silently dropped.
-- No backfill: every existing row already satisfies the wider check.

ALTER TABLE public.ai_jobs DROP CONSTRAINT ai_jobs_error_kind_check;

ALTER TABLE public.ai_jobs ADD CONSTRAINT ai_jobs_error_kind_check
    CHECK (error_kind IS NULL OR error_kind IN
        ('ai_offline', 'provider', 'schema', 'timeout', 'page_out_of_range',
         'internal', 'error_echo'));
