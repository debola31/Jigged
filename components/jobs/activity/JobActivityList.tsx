'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

import JobActivityCompletionRow from './JobActivityCompletionRow';
import JobActivityInvoiceRow from './JobActivityInvoiceRow';
import JobActivityMovementRow from './JobActivityMovementRow';
import JobActivityNoteRow from './JobActivityNoteRow';
import JobActivityRow from './JobActivityRow';
import JobActivityShipmentRow from './JobActivityShipmentRow';
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
  onUndoCompletion: (completion: JobActivityCompletion) => void;
  /** Which completion is mid-undo, so only that row's button disables. */
  undoingCompletionId?: string | null;
  /** Opens a VENDOR slip (`VPS-`). Not the customer's — see below. */
  onViewSlip?: (shipmentId: string) => void;
  /** Opens a CUSTOMER packing slip (`PS-`). A separate handler on purpose: the
   *  two are different documents in different dialogs, and one callback taking
   *  both ids would be a coin toss over which preview opens. */
  onViewPackingSlip?: (shipmentId: string) => void;
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
  onUndoCompletion,
  undoingCompletionId,
  onViewSlip,
  onViewPackingSlip,
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
              onUndo={onUndoCompletion}
              undoing={undoingCompletionId === item.completion.id}
            />
          );
        }

        if (item.kind === 'movement') {
          return (
            <JobActivityMovementRow
              key={item.key}
              movement={item.movement}
              onViewSlip={onViewSlip}
            />
          );
        }

        if (item.kind === 'shipment') {
          return (
            <JobActivityShipmentRow
              key={item.key}
              item={item}
              onViewPackingSlip={onViewPackingSlip}
            />
          );
        }

        if (item.kind === 'invoice') {
          return <JobActivityInvoiceRow key={item.key} item={item} />;
        }

        /* THE JOB'S OWN BEGINNING, rendered inline rather than as a row
           component of its own. The others carry data, actions and conditional
           content; this one is a timestamp and a sentence, and a file of its own
           would be more ceremony than the row is worth.

           EVERY OTHER KIND MUST BE HANDLED ABOVE. This is a bare fallthrough,
           not a `kind === 'created'` branch, so a new union member that forgets
           its `if` lands here and renders the words "Job created" — it compiles,
           it does not throw, and it is wrong. */
        return (
          <JobActivityRow key={item.key} tone="muted" at={item.at} title="Job created" />
        );
      })}
    </Box>
  );
}
