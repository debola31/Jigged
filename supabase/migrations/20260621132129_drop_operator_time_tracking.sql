-- Remove the operator start/stop time-tracking machinery.
--
-- Operators now complete an operation in a single tap (no start/pause/resume),
-- so there are no operator_sessions and no reliable per-operation actual time to
-- record. Costing/quoting uses only the ESTIMATED fields
-- (job_operations.estimated_setup_minutes / estimated_run_minutes_per_unit,
-- routing_operations.setup_minutes / cycle_minutes_per_unit, work_centers.labor_rate),
-- which are untouched. No SQL function/trigger/view references the objects dropped here.

-- operator_sessions has only outbound FKs (nothing references it), so a plain
-- DROP is safe; its indexes, RLS policies, and updated_at trigger drop with it.
DROP TABLE IF EXISTS public.operator_sessions;

-- The job_operations "actual time" columns were fed only by the (now removed)
-- session-folding and the retired admin manual-entry UI.
ALTER TABLE public.job_operations
  DROP COLUMN IF EXISTS actual_run_minutes,
  DROP COLUMN IF EXISTS actual_setup_minutes;
