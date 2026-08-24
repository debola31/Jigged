'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Typography,
  Button,
  Alert,
  CircularProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import BuildIcon from '@mui/icons-material/Build';
import RoutingOperationRow, { type OperationRowData } from './RoutingOperationRow';
import RoutingOperationRowEditor, {
  type OperationEditorValue,
  type StepTargetOption,
} from './RoutingOperationRowEditor';
import { getWorkCentersForRouting } from '@/utils/workCentersAccess';
import { getVendorServicesForRouting } from '@/utils/vendorServicesAccess';
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
  const [workCenters, setWorkCenters] = useState<StepTargetOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editorState, setEditorState] = useState<
    | { mode: 'closed' }
    | { mode: 'add' }
    | { mode: 'edit'; rowIndex: number }
  >({ mode: 'closed' });
  // Index of the operation pending delete-confirmation. Deleting a row
  // auto-saves immediately (the parent persists on `onChange`) with no undo,
  // so we gate it behind a lightweight confirm — consistent with the BOM
  // material delete, and the only safety net for an otherwise silent,
  // unrecoverable removal. See docs/interaction-standards.md §1.
  const [pendingDeleteIndex, setPendingDeleteIndex] = useState<number | null>(null);

  // One picker, two sources. They stay separate calls because a station and a
  // service carry different money (an hourly rate vs a price per piece) and a
  // union query would have to invent a shape that flattens that apart again.
  // `target` is stamped here, from which call the row came — never inferred
  // downstream from a null.
  useEffect(() => {
    Promise.all([
      getWorkCentersForRouting(companyId),
      getVendorServicesForRouting(companyId),
    ])
      .then(([stations, services]) => {
        setWorkCenters([
          ...stations.map((wc) => ({
            id: wc.id,
            name: wc.name,
            target: 'station' as const,
            labor_rate: wc.labor_rate,
            unit_price: null,
            vendor_name: null,
          })),
          ...services.map((vs) => ({
            id: vs.id,
            name: vs.name,
            target: 'service' as const,
            labor_rate: null,
            unit_price: vs.unit_price,
            vendor_name: vs.vendor_name,
          })),
        ]);
      })
      .catch((err: unknown) => {
        console.error('Failed to load routing step targets:', err);
        setError('Failed to load work centers and outside services.');
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

  const confirmDelete = useCallback(() => {
    if (pendingDeleteIndex === null) return;
    onChange(rows.filter((_, i) => i !== pendingDeleteIndex));
    setPendingDeleteIndex(null);
  }, [pendingDeleteIndex, rows, onChange]);

  const handleEditorSave = (value: OperationEditorValue) => {
    if (!value.workCenter) return;
    if (editorState.mode === 'add') {
      const isService = value.workCenter.target === 'service';
      const newRow: OperationRowData = {
        tempId: generateTempId(),
        workCenterId: isService ? null : value.workCenter.id,
        vendorServiceId: isService ? value.workCenter.id : null,
        workCenterName: value.workCenter.name,
        vendorName: value.workCenter.vendor_name,
        workCenterLaborRate: value.workCenter.labor_rate,
        vendorServiceUnitPrice: value.workCenter.unit_price,
        setupMinutes: value.setupMinutes,
        cycleMinutesPerUnit: value.cycleMinutesPerUnit,
        laborRateOverride: value.laborRateOverride,
        externalUnitPrice: value.externalUnitPrice,
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
          workCenters.find(
            (wc) => wc.id === (editingRow.vendorServiceId ?? editingRow.workCenterId),
          ) ||
          // Fallback for a target that has since been archived: it is gone from
          // the picker but the step still points at it, and the editor must
          // still render rather than blanking the row.
          (editingRow.vendorServiceId || editingRow.workCenterId
            ? {
                id: (editingRow.vendorServiceId ?? editingRow.workCenterId) as string,
                name: editingRow.workCenterName,
                target: editingRow.vendorServiceId ? ('service' as const) : ('station' as const),
                labor_rate: editingRow.workCenterLaborRate,
                unit_price: editingRow.vendorServiceUnitPrice,
                vendor_name: editingRow.vendorName,
              }
            : null),
        setupMinutes: editingRow.setupMinutes,
        cycleMinutesPerUnit: editingRow.cycleMinutesPerUnit,
        laborRateOverride: editingRow.laborRateOverride,
        externalUnitPrice: editingRow.externalUnitPrice,
        instructions: editingRow.instructions,
      }
    : undefined;

  const isEditingExisting = editorState.mode === 'edit';
  const editorOpen = editorState.mode !== 'closed';

  // Sum in-house time across the routing for the header caption. Outside steps
  // price by the piece (not by time) and contribute zero minutes.
  let setupMinutesTotal = 0;
  let cycleMinutesTotal = 0;
  for (const r of rows) {
    if (r.vendorServiceId) continue;
    setupMinutesTotal += r.setupMinutes ?? 0;
    cycleMinutesTotal += r.cycleMinutesPerUnit ?? 0;
  }

  // Placeholder rows have no chosen work center yet, so fall back to a
  // generic noun in the confirm copy.
  const pendingRow = pendingDeleteIndex !== null ? rows[pendingDeleteIndex] : null;
  const pendingName =
    pendingRow?.workCenterId || pendingRow?.vendorServiceId ? pendingRow.workCenterName : null;

  return (
    <Box>
      {/* The card-level "Operations" title already names this section, so
          the inline label + spanner icon were redundant. Just the summary
          text + Add button. */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5, gap: 1, flexWrap: 'wrap' }}>
        <Typography variant="body2" color="text.secondary">
          {rows.length > 0
            ? `${rows.length} step${rows.length === 1 ? '' : 's'} · setup ${formatTime(setupMinutesTotal)} + run ${formatTime(cycleMinutesTotal)}/unit`
            : ''}
        </Typography>
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
                onDelete={() => setPendingDeleteIndex(idx)}
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

      <Dialog open={pendingDeleteIndex !== null} onClose={() => setPendingDeleteIndex(null)}>
        <DialogTitle>Remove operation?</DialogTitle>
        <DialogContent>
          <Typography>
            Remove{' '}
            {pendingName ? (
              <>
                <strong>{pendingName}</strong> from this routing
              </>
            ) : (
              'this operation'
            )}
            ? This cannot be undone, but you can re-add the operation later.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingDeleteIndex(null)}>Cancel</Button>
          <Button onClick={confirmDelete} color="error" variant="contained">
            Remove
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
