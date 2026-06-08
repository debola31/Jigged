'use client';

import { useState, useEffect } from 'react';
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
import { parseOptionalNumber } from '@/lib/validators';

interface CompleteOperationModalProps {
  open: boolean;
  operation: JobOperation | null;
  onClose: () => void;
  onConfirm: (data: {
    actual_setup_minutes?: number;
    actual_run_minutes?: number;
    notes?: string;
  }) => void;
  loading?: boolean;
}

export default function CompleteOperationModal({
  open,
  operation,
  onClose,
  onConfirm,
  loading = false,
}: CompleteOperationModalProps) {
  const [actualSetupMinutes, setActualSetupMinutes] = useState<string>('');
  const [actualRunMinutes, setActualRunMinutes] = useState<string>('');
  const [notes, setNotes] = useState('');

  // Reset form when modal opens with a new operation
  useEffect(() => {
    if (open && operation) {
      // Pre-fill with estimated hours as suggestions
      setActualSetupMinutes('');
      setActualRunMinutes('');
      setNotes('');
    }
  }, [open, operation?.id]);

  const handleConfirm = () => {
    const data: {
      actual_setup_minutes?: number;
      actual_run_minutes?: number;
      notes?: string;
    } = {};

    const setupParsed = parseOptionalNumber(actualSetupMinutes);
    if (setupParsed !== null && setupParsed >= 0) {
      data.actual_setup_minutes = setupParsed;
    }

    const runParsed = parseOptionalNumber(actualRunMinutes);
    if (runParsed !== null && runParsed >= 0) {
      data.actual_run_minutes = runParsed;
    }

    if (notes.trim()) {
      data.notes = notes.trim();
    }

    onConfirm(data);
  };

  if (!operation) return null;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
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

        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Optionally enter actual time spent on this operation:
        </Typography>

        <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
          <TextField
            label="Actual Setup (min)"
            type="number"
            value={actualSetupMinutes}
            onChange={(e) => setActualSetupMinutes(e.target.value)}
            placeholder={String(operation.estimated_setup_minutes || 0)}
            helperText={`Estimated: ${operation.estimated_setup_minutes || 0} min`}
            size="small"
            fullWidth
            inputProps={{ min: 0, step: 1, inputMode: 'numeric' }}
          />
          <TextField
            label="Actual Run (min)"
            type="number"
            value={actualRunMinutes}
            onChange={(e) => setActualRunMinutes(e.target.value)}
            placeholder={String(operation.estimated_run_minutes_per_unit || 0)}
            helperText={`Estimated: ${operation.estimated_run_minutes_per_unit || 0} min/unit`}
            size="small"
            fullWidth
            inputProps={{ min: 0, step: 1, inputMode: 'numeric' }}
          />
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
