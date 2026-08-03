'use client';

import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';

/**
 * Confirm deleting one note (#628).
 *
 * A note delete is an immediately-persisted HARD delete — `notes` has no
 * `deleted_at`, so this is not the archive-everything path in Architecture §16 and
 * there is no restore. docs/interaction-standards.md puts that squarely in
 * "immediately-persisted row delete → lightweight confirmation dialog", and its
 * audience floor explicitly rejects the alternative: an inline delete plus an
 * auto-dismissing Undo snackbar is a documented accessibility liability for a
 * 50–60 year old audience, and worse again on a phone on a shop floor with divided
 * attention. Recovery would have to be durable to replace the dialog, and here it
 * cannot be.
 *
 * Same shape and copy register as the routing-operation confirm, deliberately, so
 * the two read as one product rather than two.
 */
export default function NoteDeleteDialog({
  open,
  noun = 'note',
  /**
   * Extra consequence beyond losing the text. The machine logbook passes one:
   * deleting an entry that RESOLVES an open item puts that item back in Needs
   * attention, because "open" is derived from the absence of a resolver rather
   * than stored. That is correct behaviour, but it is not guessable from "delete",
   * so it gets said out loud before the fact rather than discovered after.
   */
  consequence,
  deleting = false,
  error = null,
  onConfirm,
  onClose,
}: {
  open: boolean;
  noun?: string;
  consequence?: string | null;
  deleting?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={deleting ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>Delete this {noun}?</DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        <Typography>
          The text and any photos on it go for good. This cannot be undone.
        </Typography>
        {consequence && (
          <Typography sx={{ mt: 1.5 }} color="warning.main">
            {consequence}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        {/* Delete kept away from Cancel, per the proximity rule in
            docs/interaction-standards.md. */}
        <Button onClick={onClose} disabled={deleting} sx={{ minHeight: 48 }}>
          Cancel
        </Button>
        <Button
          onClick={onConfirm}
          color="error"
          variant="contained"
          disabled={deleting}
          sx={{ minHeight: 48 }}
        >
          {deleting ? 'Deleting…' : 'Delete'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
