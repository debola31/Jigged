'use client';

import Typography from '@mui/material/Typography';

/**
 * "· edited" beside a note's timestamp (#628).
 *
 * Notes became editable, and `viewer_count` deliberately does NOT reset when one
 * is — resetting it would hand an author a timed read-oracle on their own notes
 * (see 20260801012019_notes_editable_body.sql). So a note can honestly say "7
 * people read this" while carrying words those 7 never saw. This mark is what
 * closes that gap: it tells a reader deciding whether to trust a note that the
 * text in front of them is not the original.
 *
 * NO TIMESTAMP, AND NO TOOLTIP, both deliberate:
 *
 *   - A tooltip is invisible on the operator surface, which is a phone with no
 *     hover. Putting the detail there would make it a desktop-only fact, which is
 *     the wrong way round — the shop floor is who reads notes to do work.
 *   - "When exactly did they change it" is a per-person audit question this
 *     product declines to answer elsewhere: note_viewers() returns names with no
 *     timestamps, precisely so an author cannot reconstruct who read what when.
 *     An edit time is a weaker version of the same signal and there is no reason
 *     to start now.
 *
 * Renders nothing when the note has never been edited, so callers can drop it in
 * unconditionally.
 */
export default function NoteEditedMark({ editedAt }: { editedAt: string | null }) {
  if (!editedAt) return null;

  return (
    <Typography component="span" variant="caption" color="text.secondary">
      {' · edited'}
    </Typography>
  );
}
