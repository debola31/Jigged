-- ONE definition of "late", called by the jobs list AND by the insights AI.
--
-- The bug this closes. Asked "how many jobs are late right now?", the chat answered 7
-- where the dashboard showed 6, on every demo company. Neither was malfunctioning:
-- there were two definitions, written eighteen days apart, neither aware of the other.
--
--   jobs list   production_status IN ('not_started','in_progress')   -- 174e549c, 2026-07-06
--   chat        production_status <> 'cancelled'                     -- semantics.md, 2026-08-25
--
-- They differ on exactly one job: production finished, not yet fully shipped, past its
-- date. J-0021 in each demo company. The jobs list says the floor is done with it, so it
-- is not late; semantics.md says "delivery is the promise", so it is.
--
-- RESOLVED IN FAVOUR OF DELIVERY, which reverses 174e549c. That commit's own message
-- shows it was unifying three surfaces that disagreed and picked the dashboard's existing
-- rule to unify ON -- not a rule anyone had argued for. A customer waiting on parts that
-- are sitting finished on a bench is waiting exactly as long as one whose parts are still
-- on the mill, and the jobs list is where you go to find out who to call.
--
-- WHY A FUNCTION AND NOT A COMMENT SAYING "KEEP THESE IN SYNC". There were already three
-- copies of this rule (two SQL, one TypeScript) and a fourth in prose, and nothing
-- compared any of them; the same PR deletes a doc sentence claiming two OTHER copies
-- "must not drift", which nothing enforced either. A scalar function is the smallest
-- object both a PostgREST caller and an AI-written SELECT can share.
--
-- IMMUTABLE and taking p_today rather than reading CURRENT_DATE: the caller's day
-- boundary is a parameter everywhere in this system, because Postgres is UTC and a shop
-- in Halifax rolls over three hours later. search_jobs_by_identifier already threaded
-- p_today from the browser; this migration gives the AI the same treatment via $2.
--
-- STRICT is deliberately NOT used. A job with no due_date was never promised and so is
-- never late -- that has to be FALSE, not NULL, or `WHERE is_job_late(...)` silently
-- drops it from a count of "not late" too.

CREATE OR REPLACE FUNCTION public.is_job_late(
    p_due_date           date,
    p_production_status  text,
    p_fulfillment_status text,
    p_today              date
) RETURNS boolean
    LANGUAGE sql
    IMMUTABLE
    PARALLEL SAFE
AS $$
    SELECT p_due_date IS NOT NULL
       AND p_today    IS NOT NULL
       AND p_due_date < p_today
       AND p_fulfillment_status IS DISTINCT FROM 'fully_shipped'
       AND p_production_status  IS DISTINCT FROM 'cancelled'
$$;

COMMENT ON FUNCTION public.is_job_late(date, text, text, date) IS
  'The single definition of a late job: past its promised date and not yet delivered. '
  'Finished-but-unshipped counts as late -- delivery is the promise, and the customer is '
  'waiting either way. Cancelled jobs do not (nobody is waiting) and a job with no '
  'due_date never does (nothing was promised). p_today is the CALLER''s local date, never '
  'CURRENT_DATE: the database is UTC and would call a job late hours early for a shop in '
  'the Americas. Called by search_jobs_by_identifier''s overdue filter, by the insights '
  'AI as public.is_job_late(due_date, production_status, fulfillment_status, $2), and '
  'mirrored in TypeScript by isJobOverdue() in types/job.ts -- the mirror is pinned to '
  'this function by a shared golden-case fixture, __tests__/fixtures/lateJobCases.json.';

-- Browser roles need EXECUTE (the jobs list calls it through search_jobs_by_identifier,
-- which is SECURITY INVOKER), and so does the insights sandbox, which writes it into its
-- own SELECT. REVOKE FROM PUBLIC takes jigged_ai_readonly with it -- it is a member of
-- PUBLIC like every other role -- so that grant is not optional decoration.
REVOKE EXECUTE ON FUNCTION public.is_job_late(date, text, text, date) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.is_job_late(date, text, text, date)
    TO authenticated, service_role, jigged_ai_readonly;
