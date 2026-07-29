-- ═══════════════════════════════════════════════════════════════════════════════
-- my_note_view_digest: a running total, not a weekly window
-- ═══════════════════════════════════════════════════════════════════════════════
-- The login banner used to say "N people viewed your notes THIS WEEK". The week
-- was arbitrary — nobody asked for a weekly rhythm, it just had to be *some*
-- window — and it forced the client to carry a matching per-week dismissal key.
--
-- What an author actually wants to know is "has anything happened since I last
-- looked". The obvious way to build that is to store a "last opened" timestamp on
-- the client and pass it in as a window start. THAT SHAPE IS FORBIDDEN, and this
-- migration is the reason it does not have to be built:
--
--   A caller-supplied (from, to) is a bisection oracle. Repeat with narrowing
--   windows and you recover WHEN a read happened on your own notes. Combined with
--   note_viewers() handing you the reader's NAME, that reconstructs "Kurtis had to
--   look this up on Tuesday afternoon" — precisely the reading-surveillance the
--   whole note_views design exists to prevent.
--
-- So: return a RUNNING TOTAL and let the client subtract. The client stores the
-- number it last acknowledged (a number the server already told it) and renders
-- the difference as "N new views". Nothing about time ever crosses the wire, and
-- the delta is computed where it is harmless.
--
-- Two further simplifications fall out of this, both worth having:
--
--   1. It no longer reads note_views AT ALL. notes.viewer_count is a maintained
--      aggregate on a row the caller can already SELECT, so this drops from
--      SECURITY DEFINER to SECURITY INVOKER — one fewer privileged function
--      touching the read log, and RLS on `notes` now does the tenant scoping for
--      free. The DEFINER family is back down to two: log_note_views (must write
--      the table) and note_viewers (must read it).
--   2. No timezone parameter, so no week boundary to get wrong, and no reliance
--      on the browser reporting a sane IANA zone.
--
-- SUM(viewer_count) is per (person, note) — the same definition My work already
-- displays as its "views" total, so the banner's number and the number on the
-- screen it opens onto can never disagree. It is NOT count(*) over note_views,
-- which is per (person, note, job) and would tick up when one colleague consults
-- the same note on a second job. Both counters are monotonic, so the running
-- total never goes backwards and the client's delta can never be negative.

DROP FUNCTION IF EXISTS public.my_note_view_digest(text);

CREATE OR REPLACE FUNCTION public.my_note_view_digest()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT COALESCE(SUM(n.viewer_count), 0)::integer
  FROM public.notes n
  WHERE n.author_id IS NOT NULL
    AND n.author_id = public.get_operator_access_id(n.company_id);
$$;

COMMENT ON FUNCTION public.my_note_view_digest() IS
  'Running total of views across the caller''s OWN notes (SUM of notes.viewer_count — the same definition My work shows as "views"). Takes no arguments on purpose: a caller-supplied time window would be a bisection oracle recovering WHEN a note was read, which is the timing signal note_viewers() refuses to give. The login banner stores the total it last acknowledged and renders the difference as "N new views", so the delta is computed on the client and no instant ever crosses the wire. SECURITY INVOKER — it reads a maintained aggregate on notes, never note_views, so RLS does the tenant scoping.';

REVOKE EXECUTE ON FUNCTION public.my_note_view_digest() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.my_note_view_digest() TO authenticated;
