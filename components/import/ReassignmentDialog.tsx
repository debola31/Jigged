'use client';

import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import type { ReassignmentDialogProps } from './types';

/**
 * Confirmation dialog shown when user tries to assign a field
 * that is already mapped to another CSV column.
 */
export default function ReassignmentDialog({
  open,
  csvColumn,
  newDbField: _newDbField,
  existingCsvColumn,
  fieldLabel,
  onCancel,
  onConfirm,
}: ReassignmentDialogProps) {
  return (
    <Dialog open={open} onClose={onCancel}>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <WarningAmberIcon color="warning" />
        Field Already Assigned
      </DialogTitle>
      <DialogContent>
        <Typography variant="body1">
          <strong>{fieldLabel}</strong> is already mapped to{' '}
          <strong>&quot;{existingCsvColumn}&quot;</strong>.
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          Do you want to reassign it to <strong>&quot;{csvColumn}&quot;</strong>?
          The previous mapping will be removed.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} color="inherit">
          Cancel
        </Button>
        <Button onClick={onConfirm} variant="contained">
          Reassign
        </Button>
      </DialogActions>
    </Dialog>
  );
}
