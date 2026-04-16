'use client';

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Box,
  Typography,
  TextField,
  Button,
  Autocomplete,
  IconButton,
  CircularProgress,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import type { OperationWithGroup } from '@/types/operations';

export interface OperationModalValue {
  operation: OperationWithGroup | null;
  setupTime: number;
  runTimePerUnit: number | null;
}

interface AddOperationModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (value: OperationModalValue) => void;
  operations: OperationWithGroup[];
  /** When provided, the modal is in edit mode (title + initial values). */
  initial?: OperationModalValue;
  saving?: boolean;
}

/**
 * Modal for adding (or editing) a routing operation. Single screen with:
 *   - Operation picker (Autocomplete, grouped by resource group)
 *   - Setup time (text input, no spinner arrows)
 *   - Run time per unit (text input, no spinner arrows)
 *
 * Used in both Add and Edit flows. The shop owners we're targeting prefer
 * being walked through these fields explicitly rather than landing on a
 * cramped inline row.
 */
export default function AddOperationModal({
  open,
  onClose,
  onSave,
  operations,
  initial,
  saving = false,
}: AddOperationModalProps) {
  const [operation, setOperation] = useState<OperationWithGroup | null>(null);
  const [setupStr, setSetupStr] = useState('');
  const [runStr, setRunStr] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setOperation(initial?.operation ?? null);
      setSetupStr(initial?.setupTime ? String(initial.setupTime) : '');
      setRunStr(
        initial?.runTimePerUnit !== undefined && initial?.runTimePerUnit !== null
          ? String(initial.runTimePerUnit)
          : ''
      );
      setTouched(false);
    }
  }, [open, initial]);

  const isEdit = !!initial;
  const opError = touched && !operation;
  const setupParsed = setupStr === '' ? 0 : parseFloat(setupStr);
  const runParsed = runStr === '' ? null : parseFloat(runStr);
  const setupError = touched && setupStr !== '' && (!Number.isFinite(setupParsed) || setupParsed < 0);
  const runError =
    touched && runStr !== '' && (!Number.isFinite(runParsed as number) || (runParsed as number) < 0);
  const canSave = !!operation && !setupError && !runError;

  const handleSave = () => {
    setTouched(true);
    if (!operation) return;
    if (setupError || runError) return;
    onSave({
      operation,
      setupTime: Number.isFinite(setupParsed) ? Math.max(0, setupParsed) : 0,
      runTimePerUnit:
        runStr === '' || runParsed === null || !Number.isFinite(runParsed)
          ? null
          : Math.max(0, runParsed as number),
    });
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pr: 1 }}>
        {isEdit ? 'Edit Operation' : 'Add Operation'}
        <IconButton size="small" onClick={onClose} disabled={saving}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, pt: 1 }}>
          <Box>
            <Autocomplete
              size="small"
              options={operations}
              groupBy={(op) => op.resource_group?.name || 'Ungrouped'}
              getOptionLabel={(op) => op.name}
              value={operation}
              onChange={(_, newValue) => setOperation(newValue)}
              isOptionEqualToValue={(option, value) => option.id === value.id}
              disabled={saving || isEdit}
              renderInput={(params) => (
                <TextField
                  {...params}
                  autoFocus={!isEdit}
                  label="Operation"
                  placeholder="Pick an operation…"
                  error={opError}
                  helperText={opError ? 'Pick an operation to continue.' : isEdit ? 'Operation type cannot be changed (delete and re-add to swap).' : ' '}
                />
              )}
            />
          </Box>

          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
              Time per batch
            </Typography>
            <TextField
              size="small"
              fullWidth
              label="Setup time (minutes)"
              type="text"
              inputMode="decimal"
              value={setupStr}
              onChange={(e) => {
                const v = e.target.value;
                if (v === '' || /^\d*\.?\d*$/.test(v)) setSetupStr(v);
              }}
              placeholder="e.g. 10"
              error={!!setupError}
              helperText={
                setupError
                  ? 'Enter a non-negative number (or leave blank for 0).'
                  : 'One-time setup/changeover per batch.'
              }
              disabled={saving}
            />
          </Box>

          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
              Time per part
            </Typography>
            <TextField
              size="small"
              fullWidth
              label="Run time per unit (minutes)"
              type="text"
              inputMode="decimal"
              value={runStr}
              onChange={(e) => {
                const v = e.target.value;
                if (v === '' || /^\d*\.?\d*$/.test(v)) setRunStr(v);
              }}
              placeholder="e.g. 2.5"
              error={!!runError}
              helperText={
                runError
                  ? 'Enter a non-negative number (or leave blank if not yet known).'
                  : 'Repeated for every unit produced.'
              }
              disabled={saving}
            />
          </Box>
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={saving || (!isEdit && !canSave)}
          startIcon={saving ? <CircularProgress size={14} /> : null}
        >
          {isEdit ? 'Save changes' : 'Add to routing'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
