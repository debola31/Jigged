'use client';

import { useState, useEffect, useCallback } from 'react';
import { Box, Typography, Button, Alert, CircularProgress } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import BuildIcon from '@mui/icons-material/Build';
import RoutingOperationRow, { type OperationRowData } from './RoutingOperationRow';
import AddOperationModal, { type OperationModalValue } from './AddOperationModal';
import { getAllOperations } from '@/utils/operationsAccess';
import type { OperationWithGroup } from '@/types/operations';
import { calculateRoutingTime, formatTime } from '@/types/routings';

const generateTempId = () => `temp-node-${crypto.randomUUID()}`;

export interface RoutingOperationsListProps {
  rows: OperationRowData[];
  onChange: (next: OperationRowData[]) => void;
  companyId: string;
  disabled?: boolean;
}

/**
 * Linear list of routing operations.
 *  - Reorder via up/down arrow buttons (no drag-and-drop — too unfamiliar
 *    for the small-shop owners we're targeting).
 *  - Add Operation opens a modal asking for operation + setup + run time.
 *  - Edit row opens the same modal pre-populated.
 */
export default function RoutingOperationsList({
  rows,
  onChange,
  companyId,
  disabled = false,
}: RoutingOperationsListProps) {
  const [operations, setOperations] = useState<OperationWithGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalState, setModalState] = useState<
    | { mode: 'closed' }
    | { mode: 'add' }
    | { mode: 'edit'; rowIndex: number }
  >({ mode: 'closed' });

  useEffect(() => {
    getAllOperations(companyId)
      .then(setOperations)
      .catch((err) => {
        console.error('Failed to load operations:', err);
        setError('Failed to load operations.');
      })
      .finally(() => setLoading(false));
  }, [companyId]);

  const handleMoveUp = useCallback((index: number) => {
    if (index <= 0) return;
    const copy = [...rows];
    [copy[index - 1], copy[index]] = [copy[index], copy[index - 1]];
    onChange(copy);
  }, [rows, onChange]);

  const handleMoveDown = useCallback((index: number) => {
    if (index >= rows.length - 1) return;
    const copy = [...rows];
    [copy[index + 1], copy[index]] = [copy[index], copy[index + 1]];
    onChange(copy);
  }, [rows, onChange]);

  const handleDelete = useCallback((index: number) => {
    onChange(rows.filter((_, i) => i !== index));
  }, [rows, onChange]);

  const handleModalSave = (value: OperationModalValue) => {
    if (!value.operation) return;
    if (modalState.mode === 'add') {
      const newRow: OperationRowData = {
        tempId: generateTempId(),
        operationTypeId: value.operation.id,
        operationName: value.operation.name,
        resourceGroupName: value.operation.resource_group?.name || null,
        laborRate: value.operation.labor_rate,
        runTimePerUnit: value.runTimePerUnit,
        setupTime: value.setupTime,
        instructions: null,
      };
      onChange([...rows, newRow]);
    } else if (modalState.mode === 'edit') {
      const copy = [...rows];
      copy[modalState.rowIndex] = {
        ...copy[modalState.rowIndex],
        // operation type is locked in edit mode (delete + re-add to swap)
        runTimePerUnit: value.runTimePerUnit,
        setupTime: value.setupTime,
      };
      onChange(copy);
    }
    setModalState({ mode: 'closed' });
  };

  const editingRow = modalState.mode === 'edit' ? rows[modalState.rowIndex] : null;
  const editingInitial: OperationModalValue | undefined = editingRow
    ? {
        operation: operations.find((o) => o.id === editingRow.operationTypeId) || null,
        setupTime: editingRow.setupTime,
        runTimePerUnit: editingRow.runTimePerUnit,
      }
    : undefined;

  const time = calculateRoutingTime(
    rows.map((r) => ({
      id: r.tempId,
      routing_id: '',
      operation_type_id: r.operationTypeId,
      run_time_per_unit: r.runTimePerUnit,
      setup_time: r.setupTime,
      instructions: r.instructions,
      metadata: {},
      sequence: 0,
      created_at: '',
      updated_at: '',
      operation_type: r.operationTypeId
        ? { id: r.operationTypeId, name: r.operationName, labor_rate: r.laborRate, resource_group_id: null }
        : null,
    }))
  );

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5, gap: 1, flexWrap: 'wrap' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
          <BuildIcon fontSize="small" color="primary" />
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Operations
          </Typography>
          {rows.length > 0 && (
            <Typography variant="caption" color="text.secondary">
              {rows.length} step{rows.length === 1 ? '' : 's'} • setup {formatTime(time.setupTime)} + run {formatTime(time.runTime)}/unit
            </Typography>
          )}
        </Box>
        <Button
          size="small"
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => setModalState({ mode: 'add' })}
          disabled={disabled || loading}
        >
          Add Operation
        </Button>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
          <CircularProgress size={20} />
        </Box>
      ) : rows.length === 0 ? (
        <Box
          sx={{
            textAlign: 'center',
            py: 4,
            border: '1px dashed',
            borderColor: 'divider',
            borderRadius: 1,
          }}
        >
          <BuildIcon sx={{ fontSize: 36, color: 'text.disabled', mb: 1 }} />
          <Typography variant="body2" color="text.secondary" gutterBottom>
            No operations yet.
          </Typography>
          <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mb: 1.5 }}>
            Click &quot;Add Operation&quot; to start building this routing.
          </Typography>
        </Box>
      ) : (
        rows.map((row, idx) => (
          <RoutingOperationRow
            key={row.tempId}
            row={row}
            index={idx}
            totalRows={rows.length}
            onMoveUp={() => handleMoveUp(idx)}
            onMoveDown={() => handleMoveDown(idx)}
            onEdit={() => setModalState({ mode: 'edit', rowIndex: idx })}
            onDelete={() => handleDelete(idx)}
            disabled={disabled}
          />
        ))
      )}

      <AddOperationModal
        open={modalState.mode !== 'closed'}
        onClose={() => setModalState({ mode: 'closed' })}
        onSave={handleModalSave}
        operations={operations}
        initial={editingInitial}
      />
    </Box>
  );
}
