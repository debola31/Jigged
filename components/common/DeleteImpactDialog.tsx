'use client';

import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
  CircularProgress,
  Box,
  Typography,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';

export interface DeleteImpactDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  /** Disables the buttons and shows a spinner while the delete runs. */
  loading?: boolean;
  /** Singular entity label, e.g. "part", "customer", "work center". */
  entityLabel: string;
  /** How many items are being deleted. */
  count: number;
  /**
   * Optional consequence lines (e.g. "3 are used on quotes — kept for history",
   * "5 other parts' costs will change"). Rendered as a bulleted list under the
   * intro. Never used to *block* — deletion (archive) always proceeds.
   */
  impactLines?: string[];
  /**
   * True (default) when reusing the entity's name later restores it (catalog
   * entities). False for records with no name-reuse path (e.g. jobs/quotes),
   * which drops the "bring it back by re-creating the name" reassurance.
   */
  revivableByName?: boolean;
}

/**
 * Confirmation dialog for the universal archive ("Delete") action. It explains
 * that deletion hides the row but keeps everything that references it, and shows
 * an optional impact summary. It never blocks — the primary button always
 * archives. Reused across the parts / customers / vendors / work-center / jobs /
 * quotes list pages.
 */
export default function DeleteImpactDialog({
  open,
  onClose,
  onConfirm,
  loading = false,
  entityLabel,
  count,
  impactLines,
  revivableByName = true,
}: DeleteImpactDialogProps) {
  const plural = count === 1 ? entityLabel : `${entityLabel}s`;
  const subject = count === 1 ? 'This' : 'These';
  const object = count === 1 ? 'it' : 'them';
  const one = count === 1 ? 'it' : 'one';

  return (
    <Dialog
      open={open}
      onClose={() => !loading && onClose()}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle sx={{ pb: 2 }}>
        Delete {count} {plural}?
      </DialogTitle>
      <DialogContent>
        <DialogContentText component="div">
          <Typography variant="body1">
            {subject} {plural} will be removed from your lists. Anything that already
            references {object} — quotes, jobs, and BOMs — keeps working; nothing is
            permanently destroyed.
            {revivableByName
              ? ` You can bring ${one} back later by re-creating or re-importing the same name.`
              : ''}
          </Typography>

          {impactLines && impactLines.length > 0 && (
            <Box component="ul" sx={{ m: 0, mt: 2, pl: 3 }}>
              {impactLines.map((line, i) => (
                <Typography component="li" variant="body2" key={i} sx={{ mb: 0.5 }}>
                  {line}
                </Typography>
              ))}
            </Box>
          )}
        </DialogContentText>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={loading}>
          Cancel
        </Button>
        <Button
          onClick={onConfirm}
          variant="contained"
          color="error"
          disabled={loading}
          startIcon={
            loading ? <CircularProgress size={16} color="inherit" /> : <DeleteIcon />
          }
        >
          {loading ? 'Deleting…' : 'Delete'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
