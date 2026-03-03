'use client';

import { useState, useEffect } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import { completeJob } from '@/utils/operatorAccess';
import { formatDuration } from '@/types/operator';

interface JobCompleteModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  jobId: string;
  operatorId: string | null;
  sessionStartedAt: string | null;
}

/**
 * Job Complete Confirmation Modal.
 *
 * Shows:
 * - Time spent summary
 * - Quantity completed input
 * - Quantity scrapped input
 * - Notes field
 */
export default function JobCompleteModal({
  open,
  onClose,
  onConfirm,
  jobId,
  operatorId,
  sessionStartedAt,
}: JobCompleteModalProps) {
  const [quantityCompleted, setQuantityCompleted] = useState<number>(1);
  const [quantityScrapped, setQuantityScrapped] = useState<number>(0);
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  // Update elapsed time while modal is open
  useEffect(() => {
    if (!open || !sessionStartedAt) return;

    const start = new Date(sessionStartedAt).getTime();

    const updateElapsed = () => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    };

    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);

    return () => clearInterval(interval);
  }, [open, sessionStartedAt]);

  // Reset form when opening
  useEffect(() => {
    if (open) {
      setQuantityCompleted(1);
      setQuantityScrapped(0);
      setNotes('');
      setError(null);
    }
  }, [open]);

  const handleConfirm = async () => {
    if (!operatorId) {
      setError('Operator not found. Please log in again.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await completeJob(jobId, operatorId, {
        quantity_completed: quantityCompleted,
        quantity_scrapped: quantityScrapped,
        notes: notes.trim() || undefined,
      });
      onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to complete job');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      PaperProps={{
        sx: {
          bgcolor: 'rgba(17, 20, 57, 0.98)',
          backdropFilter: 'blur(10px)',
        },
      }}
    >
      <DialogTitle sx={{ textAlign: 'center', pb: 1 }}>
        Complete Operation
      </DialogTitle>

      <DialogContent>
        {/* Time Summary */}
        {sessionStartedAt && (
          <Box
            sx={{
              textAlign: 'center',
              mb: 3,
              py: 2,
              bgcolor: 'rgba(70, 130, 180, 0.1)',
              borderRadius: 2,
            }}
          >
            <Typography variant="overline" color="text.secondary">
              Time Spent
            </Typography>
            <Typography
              variant="h4"
              component="div"
              sx={{ fontFamily: 'monospace', fontWeight: 600, color: 'primary.main' }}
            >
              {formatDuration(elapsed)}
            </Typography>
          </Box>
        )}

        {/* Error */}
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {/* Quantity Completed */}
        <TextField
          label="Quantity Completed"
          type="number"
          fullWidth
          value={quantityCompleted}
          onChange={(e) =>
            setQuantityCompleted(Math.max(0, parseInt(e.target.value) || 0))
          }
          inputProps={{ min: 0 }}
          sx={{ mb: 2 }}
        />

        {/* Quantity Scrapped */}
        <TextField
          label="Quantity Scrapped"
          type="number"
          fullWidth
          value={quantityScrapped}
          onChange={(e) =>
            setQuantityScrapped(Math.max(0, parseInt(e.target.value) || 0))
          }
          inputProps={{ min: 0 }}
          sx={{ mb: 2 }}
        />

        {/* Notes */}
        <TextField
          label="Notes (optional)"
          multiline
          rows={3}
          fullWidth
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Any issues or comments about this operation..."
        />
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 3, pt: 1 }}>
        <Button onClick={onClose} disabled={loading} sx={{ minWidth: 100 }}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleConfirm}
          disabled={loading || !operatorId}
          sx={{ minWidth: 140, minHeight: 48 }}
        >
          {loading ? <CircularProgress size={24} /> : 'Confirm Complete'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
