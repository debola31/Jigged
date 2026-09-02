-- `video_attached` joins the operator funnel.
--
-- The operator composer can now record a short clip in Jigged, and whether anyone
-- reaches for video AT ALL is the unknown the feature ships to find out. That
-- question is unreadable folded into `photo_attached`'s count, so it gets its own
-- kind. `note_saved_with_photo` deliberately does NOT get a sibling: it means
-- "saved with something attached", and splitting it would break the funnel it was
-- built to read -- the photoCount/videoCount context tells the two apart.
--
-- THE LIST BELOW IS COPIED FROM THE CONSTRAINT AS IT STANDS IN PRODUCTION, not from
-- the migration that first created it. `operator_events_kind_check` has been
-- rebuilt before (20260730015344 added the two machine kinds), so re-deriving it
-- from 20260728040701 would silently drop `machine_page_opened` and
-- `noticed_resolved` -- a whole module's instrumentation, failing at write time on
-- a surface nobody would think to re-test. Verified against prod before writing.
--
-- Mirrored by the `OperatorEventKind` union in utils/operatorEventsAccess.ts; the
-- two are kept in step by hand, which is what that type's comment says.

ALTER TABLE public.operator_events
  DROP CONSTRAINT IF EXISTS operator_events_kind_check;

ALTER TABLE public.operator_events
  ADD CONSTRAINT operator_events_kind_check CHECK (
    kind = ANY (ARRAY[
      'app_opened'::text,
      'station_selected'::text,
      'op_card_opened'::text,
      'prior_notes_opened'::text,
      'composer_focused'::text,
      'composer_abandoned'::text,
      'note_saved'::text,
      'note_saved_with_photo'::text,
      'photo_attached'::text,
      'video_attached'::text,
      'completion_recorded'::text,
      'machine_page_opened'::text,
      'noticed_resolved'::text
    ])
  );
