'use client';

import { useState, useEffect } from 'react';
import {
  Box,
  TextField,
  Button,
  Autocomplete,
  Typography,
} from '@mui/material';
import type { Operation } from '@/types/operations';

export interface OperationEditorValue {
  operation: Operation | null;
  setupTime: number;
  runTimePerUnit: number | null;
}

interface RoutingOperationRowEditorProps {
  operations: Operation[];
  /** When provided, the editor is in edit mode (operation picker is locked). */
  initial?: OperationEditorValue;
  onSave: (value: OperationEditorValue) => void;
  onCancel: () => void;
  /** Sequence number to render at the left, matching display row layout (1-based, optional). */
  index?: number;
}

export default function RoutingOperationRowEditor({
  operations,
  initial,
  onSave,
  onCancel,
  index,
}: RoutingOperationRowEditorProps) {
  const isEdit = !!initial;
  const [operation, setOperation] = useState<Operation | null>(initial?.operation ?? null);
  const [setupStr, setSetupStr] = useState(
    initial?.setupTime ? String(initial.setupTime) : ''
  );
  const [runStr, setRunStr] = useState(
    initial?.runTimePerUnit !== undefined && initial?.runTimePerUnit !== null
      ? String(initial.runTimePerUnit)
      : ''
  );
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    setOperation(initial?.operation ?? null);
    setSetupStr(initial?.setupTime ? String(initial.setupTime) : '');
    setRunStr(
      initial?.runTimePerUnit !== undefined && initial?.runTimePerUnit !== null
        ? String(initial.runTimePerUnit)
        : ''
    );
    setTouched(false);
  }, [initial]);

  const opError = touched && !operation;
  const setupParsed = setupStr === '' ? 0 : parseFloat(setupStr);
  const runParsed = runStr === '' ? null : parseFloat(runStr);
  const setupError =
    touched && setupStr !== '' && (!Number.isFinite(setupParsed) || setupParsed < 0);
  const runError =
    touched &&
    runStr !== '' &&
    (!Number.isFinite(runParsed as number) || (runParsed as number) < 0);
  const hasAnyTime =
    (Number.isFinite(setupParsed) && setupParsed > 0) ||
    (runParsed !== null && Number.isFinite(runParsed) && (runParsed as number) > 0);
  const atLeastOneError = touched && !hasAnyTime;

  const handleSave = () => {
    setTouched(true);
    if (!operation) return;
    if (setupError || runError || !hasAnyTime) return;
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
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1.5,
        p: 1.5,
        bgcolor: 'background.paper',
        border: '1px solid',
        borderColor: 'primary.main',
        borderRadius: 1,
        mb: 1,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
        {typeof index === 'number' && (
          <Typography
            variant="body2"
            sx={{ minWidth: 24, color: 'text.secondary', fontWeight: 600, mt: 1 }}
          >
            {index + 1}.
          </Typography>
        )}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Autocomplete
            size="small"
            options={operations}
            getOptionLabel={(op) => op.name}
            value={operation}
            onChange={(_, newValue) => setOperation(newValue)}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            disabled={isEdit}
            renderInput={(params) => (
              <TextField
                {...params}
                autoFocus={!isEdit}
                label="Operation"
                placeholder="Pick an operation…"
                error={opError}
                helperText={
                  opError
                    ? 'Pick an operation to continue.'
                    : isEdit
                    ? 'Operation type cannot be changed (delete and re-add to swap).'
                    : ' '
                }
              />
            )}
          />
        </Box>
      </Box>

      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
        <TextField
          size="small"
          label="Run time per unit (min)"
          type="text"
          inputMode="decimal"
          value={runStr}
          autoFocus={isEdit}
          onChange={(e) => {
            const v = e.target.value;
            if (v === '' || /^\d*\.?\d*$/.test(v)) setRunStr(v);
          }}
          placeholder="e.g. 2.5"
          error={!!runError}
          helperText={
            runError
              ? 'Enter a non-negative number.'
              : 'Repeated for every unit produced.'
          }
          sx={{ flex: 1, minWidth: 180 }}
        />
        <TextField
          size="small"
          label="Setup time (min)"
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
              ? 'Enter a non-negative number.'
              : 'One-time setup/changeover per batch.'
          }
          sx={{ flex: 1, minWidth: 180 }}
        />
      </Box>

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1,
          flexWrap: 'wrap',
        }}
      >
        <Typography
          variant="caption"
          sx={{ color: atLeastOneError ? 'error.main' : 'text.secondary' }}
        >
          Enter a run time, a setup time, or both.
        </Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button size="small" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="small" variant="contained" onClick={handleSave}>
            {isEdit ? 'Save changes' : 'Add to routing'}
          </Button>
        </Box>
      </Box>
    </Box>
  );
}
