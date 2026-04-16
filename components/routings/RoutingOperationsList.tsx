'use client';

import { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  Button,
  Alert,
  CircularProgress,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import BuildIcon from '@mui/icons-material/Build';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import RoutingOperationRow, { type OperationRowData } from './RoutingOperationRow';
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
 * Linear list of routing operations with drag-to-reorder and inline editing.
 * "Add Operation" appends a new row whose operation picker auto-focuses, so
 * the user can immediately pick an op and tab into the time fields.
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
  const [autoFocusId, setAutoFocusId] = useState<string | null>(null);

  useEffect(() => {
    getAllOperations(companyId)
      .then(setOperations)
      .catch((err) => {
        console.error('Failed to load operations:', err);
        setError('Failed to load operations.');
      })
      .finally(() => setLoading(false));
  }, [companyId]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleAddOperation = () => {
    const newRow: OperationRowData = {
      tempId: generateTempId(),
      operationTypeId: '',
      operationName: '',
      resourceGroupName: null,
      laborRate: null,
      runTimePerUnit: null,
      setupTime: 0,
      instructions: null,
    };
    onChange([...rows, newRow]);
    setAutoFocusId(newRow.tempId);
  };

  const handleRowChange = (index: number, next: OperationRowData) => {
    const copy = [...rows];
    copy[index] = next;
    onChange(copy);
  };

  const handleRowDelete = (index: number) => {
    onChange(rows.filter((_, i) => i !== index));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = rows.findIndex((r) => r.tempId === active.id);
    const newIndex = rows.findIndex((r) => r.tempId === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    onChange(arrayMove(rows, oldIndex, newIndex));
  };

  // Build node-shape for time calculator
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
        ? {
            id: r.operationTypeId,
            name: r.operationName,
            labor_rate: r.laborRate,
            resource_group_id: null,
          }
        : null,
    }))
  );

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <BuildIcon fontSize="small" color="primary" />
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Operations
          </Typography>
          {rows.length > 0 && (
            <Typography variant="caption" color="text.secondary">
              ({rows.length} step{rows.length === 1 ? '' : 's'} • setup{' '}
              {formatTime(time.setupTime)} + run {formatTime(time.runTime)}/unit)
            </Typography>
          )}
        </Box>
        <Button
          size="small"
          variant="contained"
          startIcon={<AddIcon />}
          onClick={handleAddOperation}
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
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext
            items={rows.map((r) => r.tempId)}
            strategy={verticalListSortingStrategy}
          >
            {rows.map((row, idx) => (
              <RoutingOperationRow
                key={row.tempId}
                row={row}
                index={idx}
                operations={operations}
                operationsLoading={loading}
                autoFocus={autoFocusId === row.tempId}
                onChange={(next) => {
                  handleRowChange(idx, next);
                  if (autoFocusId === row.tempId && next.operationTypeId) {
                    setAutoFocusId(null);
                  }
                }}
                onDelete={() => handleRowDelete(idx)}
                disabled={disabled}
              />
            ))}
          </SortableContext>
        </DndContext>
      )}
    </Box>
  );
}
