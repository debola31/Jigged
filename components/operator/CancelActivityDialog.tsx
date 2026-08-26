'use client';

import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';
import { formatClockTime } from '@/lib/duration';

/**
 * Confirm discarding a running timer.
 *
 * WHY A DIALOG AT ALL, when `Undo all` right below it has none.
 * docs/interaction-standards.md scales friction by RECOVERABILITY, and these two
 * sit on opposite sides of that line: an undone completion can be re-recorded from
 * the same screen, while a discarded interval cannot be un-discarded from any
 * surface in the product. That is the "immediately-persisted, no restore" row of
 * the table, and its audience floor rules out the alternative — an Undo snackbar
 * that auto-dismisses is a documented liability for a 50–60 year old audience, and
 * worse on a phone on a shop floor with divided attention.
 *
 * NOT `NoteDeleteDialog`, though this is the same shape and register on purpose.
 * That component hardcodes "Delete this {noun}?" and "The text and any photos on
 * it go for good", and both are wrong here — nothing is deleted, and no note is
 * touched. Parameterising it into a general confirm would make two callers share a
 * component whose only remaining commonality is a Dialog with two buttons.
 *
 * THE SECOND SENTENCE OF THE BODY IS THE LOAD-BEARING ONE. "Activity" also names a
 * dashboard nav section and the operator notes-and-photos feed, so `Cancel
 * activity` on a step called EDM could plausibly read as cancelling the STEP.
 * Saying "the step stays where it is" closes that ambiguity at the only moment the
 * operator is deciding.
 */
export default function CancelActivityDialog({
  open,
  /** When the timer started, so the copy names the span being thrown away. */
  startedAt,
  cancelling = false,
  error = null,
  onConfirm,
  onClose,
}: {
  open: boolean;
  startedAt: string | null;
  cancelling?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={cancelling ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>Cancel this activity?</DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        <Typography>
          {/* The clock time, not a duration. It is what the operator can check against
              their own memory of the shift — "did I start this at 3?" — whereas a
              duration is a figure about them rather than about the work. */}
          The time recorded{startedAt ? ` since ${formatClockTime(startedAt)}` : ''} will not be
          kept. This cannot be undone.
        </Typography>
        <Typography sx={{ mt: 1.5 }} color="text.secondary">
          The step stays where it is, and anything you have already finished on it is
          unaffected.
        </Typography>
      </DialogContent>
      <DialogActions>
        {/* Confirm kept away from the dismiss button, per the proximity rule in
            docs/interaction-standards.md. "Keep timing" rather than "Cancel",
            because on a dialog headed "Cancel this activity?" a button reading
            "Cancel" is genuinely ambiguous about which cancel it means. */}
        <Button onClick={onClose} disabled={cancelling} sx={{ minHeight: 48 }}>
          Keep timing
        </Button>
        <Button
          onClick={onConfirm}
          color="error"
          variant="contained"
          disabled={cancelling}
          sx={{ minHeight: 48 }}
        >
          {cancelling ? 'Cancelling…' : 'Cancel activity'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
