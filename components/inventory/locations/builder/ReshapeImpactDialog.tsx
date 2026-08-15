'use client';

/**
 * "Here is what changing this layout does." The last screen before a reshape is written.
 *
 * ## Why it is not `DeleteImpactDialog`
 *
 * It follows that component's contract deliberately — intro, bulleted impact lines, confirm set
 * apart from Cancel, error colour when something goes away — and is a separate component anyway,
 * because [`DeleteImpactDialog`](../../../common/DeleteImpactDialog.tsx)'s intro *is* archive
 * semantics: *"will be hidden from your lists… bring it back anytime by re-creating the same
 * name."* That is flatly false here. `inventory_locations` has no `deleted_at`; a removed location
 * is hard-deleted by `delete_location` and re-creating the name gives you a different location with
 * a different QR code. Parameterising that sentence away would make it conditional in the six other
 * call sites that rely on it being unconditional.
 *
 * ## Friction scales with what actually happens
 *
 * `docs/interaction-standards.md` §1 asks for friction proportional to impact, and a reshape spans
 * the whole range: adding four bins to a cabinet is routine, removing six that hold stock is the
 * most destructive thing on the Storage page. So the confirm is error-coloured **only when
 * something is being removed**. A purely additive reshape gets an ordinary primary button, because
 * dressing it in red would teach people to click red.
 *
 * ## What it deliberately does not say
 *
 * Re-ordering. "Re-ordering 12 locations" is not something anyone reads as information, and it
 * would sit above the line that matters. The plan carries it for the payload; the summary drops it.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';
import ViewQuiltOutlinedIcon from '@mui/icons-material/ViewQuiltOutlined';

export interface ReshapeImpactDialogProps {
  open: boolean;
  unitName: string;
  /** From `describeReshape`, plus the redistribution line when there is one. */
  impactLines: string[];
  /** How many locations keep exactly what they hold — the reassurance half of the summary. */
  untouched: number;
  /** Drives the confirm's colour. Removing something is what makes this destructive. */
  destructive: boolean;
  loading?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export default function ReshapeImpactDialog({
  open,
  unitName,
  impactLines,
  untouched,
  destructive,
  loading = false,
  onClose,
  onConfirm,
}: ReshapeImpactDialogProps) {
  return (
    <Dialog open={open} onClose={() => !loading && onClose()} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 2 }}>Change the layout of {unitName}?</DialogTitle>
      <DialogContent>
        <DialogContentText component="div">
          <Box component="ul" sx={{ m: 0, pl: 3 }}>
            {impactLines.map((line, i) => (
              <Typography
                component="li"
                variant="body2"
                key={i}
                sx={{ mb: 0.5, ...(/^Removing/.test(line) ? { color: 'error.main' } : {}) }}
              >
                {line}
              </Typography>
            ))}
          </Box>

          {/* The other half of the answer. Someone reshaping a 180-bin cabinet is mostly asking
              "what am I about to break?", and "nothing else" is the reassurance a list of changes
              cannot give on its own. */}
          {untouched > 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
              The other {untouched.toLocaleString()} location{untouched === 1 ? '' : 's'} keep what
              {untouched === 1 ? ' it holds' : ' they hold'}.
            </Typography>
          )}

          {destructive && (
            <Typography variant="body2" sx={{ mt: 2 }}>
              Removing a location can&apos;t be undone — its printed label stops working, though
              past activity is kept in history.
            </Typography>
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
          color={destructive ? 'error' : 'primary'}
          disabled={loading}
          startIcon={
            loading ? <CircularProgress size={16} color="inherit" /> : <ViewQuiltOutlinedIcon />
          }
        >
          {loading ? 'Applying…' : 'Apply changes'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
