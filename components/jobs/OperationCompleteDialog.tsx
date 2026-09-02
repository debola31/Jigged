'use client';

import { useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';

import {
  operationCompletionConsequence,
  completionConsequenceCaption,
} from '@/components/operations/operationMath';

interface OperationCompleteDialogProps {
  open: boolean;
  operationName: string;
  target: number;
  qtyGood: number;
  remaining: number;
  /**
   * How many timers are running on this step right now. Non-zero means Record
   * will DISCARD them — see the warning below for why the office is told before
   * it clicks rather than after.
   */
  openTimerCount?: number;
  busy?: boolean;
  onClose: () => void;
  /** Record the entered good quantity (defaults to the full remaining balance). */
  onRecord: (quantityGood: number) => void;
}

/**
 * Admin-side quantity entry for completing an operation. Mirrors the operator
 * action page: the field defaults to the remaining balance (states its own
 * outcome), a partial leaves the rest outstanding, and over-completion is warned
 * but allowed. "Complete all remaining" is the one-click full-case shortcut.
 *
 * IT MIRRORS THE `Complete without timing` PATH SPECIFICALLY, and the running-
 * timer warning is where that becomes visible. This dialog never records a
 * duration — the office was not at the machine — so a step somebody IS timing
 * cannot be completed here without the measurement being thrown away. Saying so
 * before the click rather than in the snackbar after is the difference between a
 * decision and a surprise: docs/interaction-standards.md treats a destructive
 * consequence discovered afterwards as the failure, not the destruction itself.
 */
export default function OperationCompleteDialog({
  open,
  operationName,
  target,
  qtyGood,
  remaining,
  openTimerCount = 0,
  busy = false,
  onClose,
  onRecord,
}: OperationCompleteDialogProps) {
  // The dialog is mounted fresh each open (the parent renders it only while an op
  // is selected), so initialising from the remaining balance is enough — no
  // reset effect, no setState-in-effect cascade.
  const [qtyInput, setQtyInput] = useState(() => (remaining > 0 ? String(remaining) : ''));

  const consequence = operationCompletionConsequence(qtyInput, remaining);
  const qty = Number(qtyInput);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Complete operation</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {operationName}
        </Typography>
        {qtyGood > 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {qtyGood} of {target} good so far · {remaining} remaining
          </Typography>
        )}
        {openTimerCount > 0 && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {/* NO NAME, and that is the schema's doing rather than this
                component's restraint: get_operation_actuals returns a count and
                no operator identity, so there is nobody to name here. The fact
                the office needs is that a machine is running, not who is on it. */}
            {openTimerCount === 1
              ? 'Someone is timing this step right now.'
              : `${openTimerCount} timers are running on this step right now.`}{' '}
            Recording here does not stop the clock — it discards it. No time will
            be recorded against this step, because the finish time is not yours to
            state.
          </Alert>
        )}
        <Box sx={{ mt: 1 }}>
          <TextField
            autoFocus
            label="Good pieces finished"
            type="number"
            value={qtyInput}
            onChange={(e) => setQtyInput(e.target.value)}
            inputProps={{ min: 0, inputMode: 'numeric' }}
            fullWidth
            error={consequence.kind === 'over'}
            helperText={
              consequence.kind === 'none'
                ? `Order qty ${target}`
                : completionConsequenceCaption(consequence)
            }
            FormHelperTextProps={{
              sx: {
                color:
                  consequence.kind === 'over'
                    ? 'error.main'
                    : consequence.kind === 'partial'
                      ? 'warning.main'
                      : consequence.kind === 'full'
                        ? 'success.main'
                        : 'text.secondary',
              },
            }}
          />
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
        <Button onClick={onClose} disabled={busy} color="inherit">
          Cancel
        </Button>
        <Button
          variant="contained"
          color="primary"
          onClick={() => onRecord(qty)}
          disabled={busy || !(qty > 0)}
        >
          Record
        </Button>
      </DialogActions>
    </Dialog>
  );
}
