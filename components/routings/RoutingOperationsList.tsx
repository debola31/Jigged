'use client';

import { useState, useEffect, useCallback } from 'react';
import { Box, Typography, Button, Alert, CircularProgress } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import BuildIcon from '@mui/icons-material/Build';
import RoutingOperationRow, { type OperationRowData } from './RoutingOperationRow';
import RoutingOperationRowEditor, {
  type OperationEditorValue,
  type WorkCenterOption,
} from './RoutingOperationRowEditor';
import { getWorkCentersForRouting } from '@/utils/workCentersAccess';
import { formatTime } from '@/types/routings';

const generateTempId = () => `temp-op-${crypto.randomUUID()}`;

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
 *  - Add Operation expands an inline editor row at the end of the list.
 *  - Edit pencil expands the existing row in place into the same editor.
 */
export default function RoutingOperationsList({
  rows,
  onChange,
  companyId,
  disabled = false,
}: RoutingOperationsListProps) {
  const [workCenters, setWorkCenters] = useState<WorkCenterOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editorState, setEditorState] = useState<
    | { mode: 'closed' }
    | { mode: 'add' }
    | { mode: 'edit'; rowIndex: number }
  >({ mode: 'closed' });

  useEffect(() => {
    getWorkCentersForRouting(companyId)
      .then(setWorkCenters)
      .catch((err: unknown) => {
        console.error('Failed to load work centers:', err);
        setError('Failed to load work centers.');
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

  const handleEditorSave = (value: OperationEditorValue) => {
    if (!value.workCenter) return;
    if (editorState.mode === 'add') {
      const newRow: OperationRowData = {
        tempId: generateTempId(),
        workCenterId: value.workCenter.id,
        workCenterName: value.workCenter.name,
        workCenterKind: value.workCenter.kind,
        vendorName: value.workCenter.vendor_name,
        setupMinutes: value.setupMinutes,
        cycleMinutesPerUnit: value.cycleMinutesPerUnit,
        laborRateOverride: value.laborRateOverride,
        externalUnitPrice: value.externalUnitPrice,
        externalSetupCost: value.externalSetupCost,
        instructions: value.instructions,
      };
      onChange([...rows, newRow]);
    } else if (editorState.mode === 'edit') {
      const copy = [...rows];
      copy[editorState.rowIndex] = {
        ...copy[editorState.rowIndex],
        // work center is locked in edit mode (delete + re-add to swap)
        setupMinutes: value.setupMinutes,
        cycleMinutesPerUnit: value.cycleMinutesPerUnit,
        laborRateOverride: value.laborRateOverride,
        externalUnitPrice: value.externalUnitPrice,
        externalSetupCost: value.externalSetupCost,
        instructions: value.instructions,
      };
      onChange(copy);
    }
    setEditorState({ mode: 'closed' });
  };

  const editingRow = editorState.mode === 'edit' ? rows[editorState.rowIndex] : null;
  const editingInitial: OperationEditorValue | undefined = editingRow
    ? {
        workCenter:
          workCenters.find((wc) => wc.id === editingRow.workCenterId) ||
          (editingRow.workCenterId
            ? {
                id: editingRow.workCenterId,
                name: editingRow.workCenterName,
                kind: editingRow.workCenterKind,
                labor_rate: null,
                vendor_name: editingRow.vendorName,
              }
            : null),
        setupMinutes: editingRow.setupMinutes,
        cycleMinutesPerUnit: editingRow.cycleMinutesPerUnit,
        laborRateOverride: editingRow.laborRateOverride,
        externalUnitPrice: editingRow.externalUnitPrice,
        externalSetupCost: editingRow.externalSetupCost,
        instructions: editingRow.instructions,
      }
    : undefined;

  const isEditingExisting = editorState.mode === 'edit';
  const editorOpen = editorState.mode !== 'closed';

  // Sum internal-only time across the routing for the header caption.
  // External operations price by unit (not time) and contribute zero minutes.
  let setupMinutesTotal = 0;
  let cycleMinutesTotal = 0;
  for (const r of rows) {
    if (r.workCenterKind === 'external') continue;
    setupMinutesTotal += r.setupMinutes ?? 0;
    cycleMinutesTotal += r.cycleMinutesPerUnit ?? 0;
  }

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
              {rows.length} step{rows.length === 1 ? '' : 's'} • setup{' '}
              {formatTime(setupMinutesTotal)} + run {formatTime(cycleMinutesTotal)}/unit
            </Typography>
          )}
        </Box>
        <Button
          size="small"
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => setEditorState({ mode: 'add' })}
          disabled={disabled || loading || editorOpen}
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
      ) : rows.length === 0 && !editorOpen ? (
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
        <>
          {rows.map((row, idx) =>
            isEditingExisting && editorState.rowIndex === idx ? (
              <RoutingOperationRowEditor
                key={row.tempId}
                workCenters={workCenters}
                initial={editingInitial}
                index={idx}
                onSave={handleEditorSave}
                onCancel={() => setEditorState({ mode: 'closed' })}
              />
            ) : (
              <RoutingOperationRow
                key={row.tempId}
                row={row}
                index={idx}
                totalRows={rows.length}
                onMoveUp={() => handleMoveUp(idx)}
                onMoveDown={() => handleMoveDown(idx)}
                onEdit={() => setEditorState({ mode: 'edit', rowIndex: idx })}
                onDelete={() => handleDelete(idx)}
                disabled={disabled || editorOpen}
              />
            )
          )}
          {editorState.mode === 'add' && (
            <RoutingOperationRowEditor
              workCenters={workCenters}
              index={rows.length}
              onSave={handleEditorSave}
              onCancel={() => setEditorState({ mode: 'closed' })}
            />
          )}
        </>
      )}
    </Box>
  );
}
