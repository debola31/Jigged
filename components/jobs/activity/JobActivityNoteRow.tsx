'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

import JobActivityRow from './JobActivityRow';
import NoteActionsMenu from '@/components/notes/NoteActionsMenu';
import NoteEditedMark from '@/components/notes/NoteEditedMark';
import NoteMediaGallery from '@/components/operator/NoteMediaGallery';
import type { JobNote } from '@/types/operator';

/**
 * One note in the office rail.
 *
 * DELIBERATELY NOT components/operator/JobFeed.tsx's note branch, and the
 * distance is not styling. That one attaches `useNoteDwell` to every body it
 * renders, which calls `log_note_views()` — a function that excludes only the
 * author, not the office — so an admin scrolling this rail would inflate the
 * author's "N people used this" count. It also renders NoteReactions, an
 * operator endorsement loop whose guardrail reasoning has not been done for an
 * office surface. Neither belongs here, and neither is a prop away.
 *
 * The kebab is the repo's rule for a new note surface
 * (docs/interaction-standards.md) — and a 320px rail has a phone's width
 * problem even though it is an office screen, so hover-revealed icons would have
 * nowhere to sit.
 */
export default function JobActivityNoteRow({
  note,
  canEdit,
  canDelete,
  onEdit,
  onDelete,
}: {
  note: JobNote;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: (note: JobNote) => void;
  onDelete: (note: JobNote) => void;
}) {
  // 'event' rows are the auto-logged audit trail, not somebody's writing. RLS
  // carries note_type = 'user' in both notes_update_body and notes_delete, so
  // offering the menu here would ship a button guaranteed to 42501.
  const isUserNote = note.note_type === 'user';
  const showMenu = isUserNote && (canEdit || canDelete);

  return (
    <JobActivityRow
      tone="note"
      at={note.created_at}
      title={note.author_name ?? 'Unknown member'}
      meta={note.operation_label ?? 'On the job'}
    >
      {note.body ? (
        <Typography
          variant="body2"
          sx={{ mt: 0.5, color: 'text.primary', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
        >
          {note.body}
        </Typography>
      ) : null}

      {note.media && note.media.length > 0 ? (
        <Box sx={{ mt: 0.75 }}>
          <NoteMediaGallery media={note.media} />
        </Box>
      ) : null}

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.25 }}>
        <NoteEditedMark editedAt={note.edited_at} />
        {showMenu ? (
          <Box sx={{ ml: 'auto' }}>
            <NoteActionsMenu
              canEdit={canEdit}
              canDelete={canDelete}
              onEdit={() => onEdit(note)}
              onDelete={() => onDelete(note)}
              noun="note"
            />
          </Box>
        ) : null}
      </Box>
    </JobActivityRow>
  );
}
