-- Drop two dead columns on job_operations:
--
--   * assigned_to  — never read or written by any app code, SQL function, or
--     trigger (only surfaced in generated types + one test fixture). It has an
--     FK (job_operations_assigned_to_fkey) and index (idx_job_ops_assigned),
--     both of which drop automatically with the column. An operator-assignment
--     feature was never built.
--   * started_at   — WRITE-ONLY. completeOperation / completeJobOperation stamped
--     it and undoJobOperation cleared it, but nothing ever read it (operator
--     time-tracking was removed in 20260621132129). It duplicated completed_at
--     for completed rows. Those writes are removed in the same PR as this
--     migration.
--
-- Dropping a column also drops any single-column index and FK on it, so no
-- separate DROP INDEX / DROP CONSTRAINT is needed.

ALTER TABLE public.job_operations
  DROP COLUMN IF EXISTS assigned_to,
  DROP COLUMN IF EXISTS started_at;
