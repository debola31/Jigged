'use client';

import { useState, useEffect } from 'react';
import {
  Box,
  TextField,
  IconButton,
  Autocomplete,
  Typography,
  CircularProgress,
} from '@mui/material';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { OperationWithGroup } from '@/types/operations';

export interface OperationRowData {
  tempId: string;
  operationTypeId: string;
  operationName: string;
  resourceGroupName: string | null;
  laborRate: number | null;
  runTimePerUnit: number | null;
  setupTime: number;
  instructions: string | null;
}

interface RoutingOperationRowProps {
  row: OperationRowData;
  index: number;
  operations: OperationWithGroup[];
  operationsLoading: boolean;
  /** Auto-focus the operation picker on mount (used after appending a new row). */
  autoFocus?: boolean;
  onChange: (next: OperationRowData) => void;
  onDelete: () => void;
  disabled?: boolean;
}

/**
 * One row in the operations list. Inline-edited (no modal):
 *   [drag] N. [operation picker]  setup [n] min  run [n] min/unit  [delete]
 */
export default function RoutingOperationRow({
  row,
  index,
  operations,
  operationsLoading,
  autoFocus = false,
  onChange,
  onDelete,
  disabled = false,
}: RoutingOperationRowProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row.tempId,
    disabled,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  // Local editable strings for time fields (so users can type freely)
  const [setupStr, setSetupStr] = useState<string>(row.setupTime ? String(row.setupTime) : '');
  const [runStr, setRunStr] = useState<string>(
    row.runTimePerUnit !== null ? String(row.runTimePerUnit) : ''
  );

  useEffect(() => {
    setSetupStr(row.setupTime ? String(row.setupTime) : '');
  }, [row.setupTime]);
  useEffect(() => {
    setRunStr(row.runTimePerUnit !== null ? String(row.runTimePerUnit) : '');
  }, [row.runTimePerUnit]);

  const selectedOperation =
    operations.find((op) => op.id === row.operationTypeId) || null;

  const commitSetup = () => {
    const parsed = setupStr === '' ? 0 : parseFloat(setupStr);
    onChange({ ...row, setupTime: Number.isFinite(parsed) ? Math.max(0, parsed) : 0 });
  };
  const commitRun = () => {
    if (runStr === '') {
      onChange({ ...row, runTimePerUnit: null });
      return;
    }
    const parsed = parseFloat(runStr);
    onChange({
      ...row,
      runTimePerUnit: Number.isFinite(parsed) ? Math.max(0, parsed) : null,
    });
  };

  return (
    <Box
      ref={setNodeRef}
      style={style}
      sx={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1,
        p: 1,
        bgcolor: isDragging ? 'action.selected' : 'background.paper',
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        mb: 1,
        flexWrap: isMobile ? 'wrap' : 'nowrap',
      }}
    >
      <IconButton
        size="small"
        sx={{ cursor: 'grab', mt: 0.5, touchAction: 'none' }}
        {...attributes}
        {...listeners}
        aria-label="Drag to reorder"
      >
        <DragIndicatorIcon fontSize="small" />
      </IconButton>

      <Typography
        variant="body2"
        sx={{ minWidth: 24, mt: 1.5, color: 'text.secondary', fontWeight: 600 }}
      >
        {index + 1}.
      </Typography>

      <Autocomplete
        size="small"
        sx={{ flex: isMobile ? '1 1 100%' : '2 1 220px', minWidth: 200 }}
        options={operations}
        groupBy={(op) => op.resource_group?.name || 'Ungrouped'}
        getOptionLabel={(op) => op.name}
        value={selectedOperation}
        onChange={(_, newValue) => {
          onChange({
            ...row,
            operationTypeId: newValue?.id || '',
            operationName: newValue?.name || '',
            resourceGroupName: newValue?.resource_group?.name || null,
            laborRate: newValue?.labor_rate || null,
          });
        }}
        loading={operationsLoading}
        disabled={disabled}
        isOptionEqualToValue={(option, value) => option.id === value.id}
        openOnFocus={autoFocus}
        renderInput={(params) => (
          <TextField
            {...params}
            label="Operation"
            placeholder="Pick an operation…"
            autoFocus={autoFocus}
            InputProps={{
              ...params.InputProps,
              endAdornment: (
                <>
                  {operationsLoading ? <CircularProgress size={16} /> : null}
                  {params.InputProps.endAdornment}
                </>
              ),
            }}
          />
        )}
      />

      <TextField
        size="small"
        label="Setup (min)"
        type="number"
        value={setupStr}
        onChange={(e) => setSetupStr(e.target.value)}
        onBlur={commitSetup}
        inputProps={{ min: 0, step: 0.5 }}
        sx={{ width: isMobile ? '48%' : 110 }}
        disabled={disabled}
      />

      <TextField
        size="small"
        label="Run (min/unit)"
        type="number"
        value={runStr}
        onChange={(e) => setRunStr(e.target.value)}
        onBlur={commitRun}
        inputProps={{ min: 0, step: 0.5 }}
        sx={{ width: isMobile ? '48%' : 130 }}
        disabled={disabled}
      />

      <IconButton
        size="small"
        color="error"
        onClick={onDelete}
        disabled={disabled}
        aria-label="Delete operation"
        sx={{ mt: 0.5 }}
      >
        <DeleteOutlineIcon fontSize="small" />
      </IconButton>
    </Box>
  );
}
