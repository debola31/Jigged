-- Part notes are gaining a type so the Notes feed can mix manual notes with
-- auto-logged events (currently: pricing changes). 'user' is the default so
-- every existing row is valid at rest — no backfill needed, no read-path
-- fallback (see CLAUDE.md "No silent runtime fallbacks").
ALTER TABLE part_notes
  ADD COLUMN note_type text NOT NULL DEFAULT 'user'
  CHECK (note_type IN ('user', 'pricing'));
