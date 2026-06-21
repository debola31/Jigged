-- Part-level notes for the part workspace History tab.
--
-- Free-text notes about a part (not tied to any job or operation), authored by
-- company members. Modeled as an append-only feed: many notes by different
-- people over time, shown newest-first and merged into the part activity feed.
-- Intentionally NOT a single overwritten parts.notes column. Mirrors job_notes.

CREATE TABLE IF NOT EXISTS "public"."part_notes"
(
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL,
    "part_id" uuid NOT NULL,
    -- Author's user_company_access row. Nullable + ON DELETE SET NULL so a note
    -- survives if the author's access is later removed; the UI falls back to
    -- "Unknown" for the name.
    "author_id" uuid,
    "body" text NOT NULL,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "part_notes_pkey" PRIMARY KEY (id),
    CONSTRAINT "part_notes_company_id_fkey" FOREIGN KEY (company_id)
        REFERENCES "public"."companies" (id) ON DELETE CASCADE,
    CONSTRAINT "part_notes_part_id_fkey" FOREIGN KEY (part_id)
        REFERENCES "public"."parts" (id) ON DELETE CASCADE,
    CONSTRAINT "part_notes_author_id_fkey" FOREIGN KEY (author_id)
        REFERENCES "public"."user_company_access" (id) ON DELETE SET NULL,
    CONSTRAINT "part_notes_body_not_blank" CHECK (length(btrim(body)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_part_notes_part_created
    ON public.part_notes USING btree (part_id, created_at DESC);

ALTER TABLE "public"."part_notes" ENABLE ROW LEVEL SECURITY;

-- Any company member can read the company's part notes.
DROP POLICY IF EXISTS "Users can view part_notes" ON "public"."part_notes";
CREATE POLICY "Users can view part_notes"
    ON "public"."part_notes"
    FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

-- A company member can add a note, but only as themselves (author_id must be
-- their own access row for the company).
DROP POLICY IF EXISTS "Users can insert own part_notes" ON "public"."part_notes";
CREATE POLICY "Users can insert own part_notes"
    ON "public"."part_notes"
    FOR INSERT
    WITH CHECK (
        (company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids))
        AND (author_id = get_operator_access_id(company_id))
    );

-- Authors can delete their own notes; company admins can delete any.
DROP POLICY IF EXISTS "Authors and admins can delete part_notes" ON "public"."part_notes";
CREATE POLICY "Authors and admins can delete part_notes"
    ON "public"."part_notes"
    FOR DELETE
    USING (
        (author_id = get_operator_access_id(company_id))
        OR is_company_admin(company_id)
    );
