-- Retire operator_sessions.notes.
--
-- Session-level notes are dead: job notes now live in the job_notes feed
-- (the job traveler). This column was written only by stopJob (never called
-- with a note) and never rendered in any UI. The new job_notes table is the
-- replacement. Nullable column with no constraints/indexes/triggers of its own.

ALTER TABLE "public"."operator_sessions" DROP COLUMN IF EXISTS "notes";
