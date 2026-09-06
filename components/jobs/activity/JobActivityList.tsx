'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

import JobActivityCompletionRow from './JobActivityCompletionRow';
import JobActivityMovementRow from './JobActivityMovementRow';
import JobActivityNoteRow from './JobActivityNoteRow';
import type { JobActivityItem } from './jobActivityTimeline';
import type { JobNote } from '@/types/operator';
import type { JobActivityCompletion } from '@/utils/operationCompletionsAccess';

export interface JobActivityListProps {
  items: JobActivityItem[];
  /** The signed-in member, for the own-note edit/delete gates. Null until resolved. */
  memberId: string | null;
  isAdmin: boolean;
  onEditNote: (note: JobNote) => void;
  onDeleteNote: (note: JobNote) => void;
  onVoidCompletion: (completion: JobActivityCompletion) => void;
  /** Which completion is mid-void, so only that row's button disables. */
  voidingCompletionId?: string | null;
  onViewSlip?: (shipmentId: string) => void;
  /** Shown instead of the list when there is nothing — worded by the caller. */
  emptyMessage?: string;
}

/**
 * The chronological list itself, with no chrome of its own.
 *
 * Rendered by BOTH rail branches — the docked column and the overlay drawer —
 * so neither can drift from the other. It owns the scroll, because the rail's
 * header and composer must stay put while the history moves under them.
 */
export default function JobActivityList({
  items,
  memberId,
  isAdmin,
  onEditNote,
  onDeleteNote,
  onVoidCompletion,
  voidingCompletionId,
  onViewSlip,
  emptyMessage = 'Nothing has been recorded on this job yet.',
}: JobActivityListProps) {
  if (items.length === 0) {
    return (
      <Typography variant="body2" sx={{ color: 'text.secondary', py: 3, px: 0.5 }}>
        {emptyMessage}
      </Typography>
    );
  }

  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        // The divider lives between siblings rather than on each row, so the
        // first row has no rule above it whatever kind it happens to be.
        '& > * + *': { borderTop: '1px solid rgba(255,255,255,0.08)' },
      }}
    >
      {items.map((item) => {
        if (item.kind === 'note') {
          const note = item.note;
          return (
            <JobActivityNoteRow
              key={item.key}
              note={note}
              // Mirrors RLS exactly (notes_update_body / notes_delete): the
              // author may edit, the author or an admin may delete.
              canEdit={memberId !== null && note.author_id === memberId}
              canDelete={memberId !== null && (note.author_id === memberId || isAdmin)}
              onEdit={onEditNote}
              onDelete={onDeleteNote}
            />
          );
        }

        if (item.kind === 'completion') {
          return (
            <JobActivityCompletionRow
              key={item.key}
              completion={item.completion}
              onVoid={onVoidCompletion}
              voiding={voidingCompletionId === item.completion.id}
            />
          );
        }

        return (
          <JobActivityMovementRow
            key={item.key}
            movement={item.movement}
            onViewSlip={onViewSlip}
          />
        );
      })}
    </Box>
  );
}
