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
import CircularProgress from '@mui/material/CircularProgress';
import CheckIcon from '@mui/icons-material/Check';

import type { JobOperation } from '@/types/job';

interface CompleteOperationModalProps {
  open: boolean;
  operation: JobOperation | null;
  onClose: () => void;
  onConfirm: (data: { notes?: string }) => void;
  loading?: boolean;
}

export default function CompleteOperationModal({
  open,
  operation,
  onClose,
  onConfirm,
  loading = false,
}: CompleteOperationModalProps) {
  const [notes, setNotes] = useState('');

  const handleConfirm = () => {
    const data: { notes?: string } = {};

    if (notes.trim()) {
      data.notes = notes.trim();
    }

    onConfirm(data);
  };

  if (!operation) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      // Reset the notes field each time the modal opens (house convention:
      // onEnter, not a reset useEffect, which would trip set-state-in-effect).
      TransitionProps={{ onEnter: () => setNotes('') }}
    >
      <DialogTitle>Complete Operation</DialogTitle>
      <DialogContent>
        <Box sx={{ mb: 3 }}>
          <Typography variant="body2" color="text.secondary">
            Operation
          </Typography>
          <Typography fontWeight={500}>
            {operation.sequence}. {operation.operation_name}
          </Typography>
        </Box>

        <TextField
          label="Notes (optional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          multiline
          rows={2}
          fullWidth
          size="small"
          placeholder="Any notes about this operation..."
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={loading}>
          Cancel
        </Button>
        <Button
          onClick={handleConfirm}
          variant="contained"
          color="success"
          disabled={loading}
          startIcon={loading ? <CircularProgress size={16} color="inherit" /> : <CheckIcon />}
        >
          {loading ? 'Completing...' : 'Complete'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
