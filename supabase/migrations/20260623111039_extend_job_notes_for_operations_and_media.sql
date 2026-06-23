-- Extend job_notes so the one job feed can carry operation-scoped notes (a
-- "step tag") and pure-photo notes, plus a note_type for future auto-logged
-- events. Mirrors the part_notes.note_type precedent.
--
-- All new columns are nullable / defaulted so every existing job_notes row
-- stays valid at rest (no backfill, no read-path fallback — see CLAUDE.md
-- "No silent runtime fallbacks for data-at-rest issues").
--
-- job_operation_id is the optional step tag. It MUST be nullable: existing rows
-- are job-level (the old traveler composer wrote notes with no operation) and
-- there is no valid operation to backfill them to. A job note is legitimately
-- either job-level (operation NULL) or step-level. The operation-page composer
-- always sets the tag for new operator captures (enforced in the access layer),
-- so the intent is guaranteed at the capture surface — not via a NOT NULL that
-- would break existing data. job_id stays NOT NULL on every row: it is the
-- rollup key the job feed reads on (operation-level notes roll up automatically
-- because they still carry job_id).

ALTER TABLE "public"."job_notes"
    ADD COLUMN "job_part_id" uuid,
    ADD COLUMN "job_operation_id" uuid,
    -- 'user' default keeps all existing rows valid; 'event' is reserved for
    -- future auto-logged feed entries (e.g. "operation completed").
    ADD COLUMN "note_type" text NOT NULL DEFAULT 'user'
        CHECK (note_type IN ('user', 'event'));

ALTER TABLE "public"."job_notes"
    ADD CONSTRAINT "job_notes_job_part_id_fkey" FOREIGN KEY (job_part_id)
        REFERENCES "public"."job_parts" (id) ON DELETE CASCADE,
    ADD CONSTRAINT "job_notes_job_operation_id_fkey" FOREIGN KEY (job_operation_id)
        REFERENCES "public"."job_operations" (id) ON DELETE CASCADE;

-- A step-tagged note must also name the part it belongs to (job_operations is
-- keyed by job_part_id; a job can have multiple parts, so operation alone is
-- ambiguous). Job-level notes leave both NULL.
ALTER TABLE "public"."job_notes"
    ADD CONSTRAINT "job_notes_operation_requires_part"
        CHECK (job_operation_id IS NULL OR job_part_id IS NOT NULL);

-- Allow pure-photo notes (media but no text). body may be NULL, but if present
-- must be non-blank. Replaces the original NOT-NULL + non-blank constraint.
ALTER TABLE "public"."job_notes" ALTER COLUMN "body" DROP NOT NULL;
ALTER TABLE "public"."job_notes" DROP CONSTRAINT IF EXISTS "job_notes_body_not_blank";
ALTER TABLE "public"."job_notes"
    ADD CONSTRAINT "job_notes_body_blank_or_null"
        CHECK (body IS NULL OR length(btrim(body)) > 0);

-- The feed reads WHERE job_id=$1 ORDER BY created_at DESC; the existing
-- idx_job_notes_job_created already covers it. RLS policies are unchanged
-- (they key on company_id / author_id, which are untouched).
