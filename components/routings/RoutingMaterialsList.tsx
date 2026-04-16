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
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
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
import RoutingMaterialRow, { type MaterialRowData } from './RoutingMaterialRow';
import { getAllInventoryItems } from '@/utils/inventoryAccess';
import type { InventoryItem } from '@/types/inventory';

const generateTempId = () => `temp-material-${crypto.randomUUID()}`;

export interface RoutingMaterialsListProps {
  rows: MaterialRowData[];
  onChange: (next: MaterialRowData[]) => void;
  companyId: string;
  disabled?: boolean;
}

/**
 * Linear list of routing-level materials with drag-to-reorder and inline edit.
 * Materials are routing-level (job-level shopping list) — not per-operation.
 */
export default function RoutingMaterialsList({
  rows,
  onChange,
  companyId,
  disabled = false,
}: RoutingMaterialsListProps) {
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoFocusId, setAutoFocusId] = useState<string | null>(null);

  useEffect(() => {
    getAllInventoryItems(companyId)
      .then(setInventoryItems)
      .catch((err) => {
        console.error('Failed to load inventory items:', err);
        setError('Failed to load inventory items.');
      })
      .finally(() => setLoading(false));
  }, [companyId]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleAdd = () => {
    const newRow: MaterialRowData = {
      tempId: generateTempId(),
      inventoryItemId: '',
      itemName: '',
      quantity: 0,
      unit: '',
    };
    onChange([...rows, newRow]);
    setAutoFocusId(newRow.tempId);
  };

  const handleRowChange = (index: number, next: MaterialRowData) => {
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

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Inventory2OutlinedIcon fontSize="small" color="primary" />
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Materials
          </Typography>
          {rows.length > 0 && (
            <Typography variant="caption" color="text.secondary">
              ({rows.length} item{rows.length === 1 ? '' : 's'})
            </Typography>
          )}
        </Box>
        <Button
          size="small"
          variant="contained"
          startIcon={<AddIcon />}
          onClick={handleAdd}
          disabled={disabled || loading}
        >
          Add Material
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
          <Inventory2OutlinedIcon sx={{ fontSize: 36, color: 'text.disabled', mb: 1 }} />
          <Typography variant="body2" color="text.secondary" gutterBottom>
            No materials yet.
          </Typography>
          <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mb: 1.5 }}>
            Add the materials each job for this part will need.
          </Typography>
        </Box>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext
            items={rows.map((r) => r.tempId)}
            strategy={verticalListSortingStrategy}
          >
            {rows.map((row, idx) => (
              <RoutingMaterialRow
                key={row.tempId}
                row={row}
                index={idx}
                inventoryItems={inventoryItems}
                inventoryLoading={loading}
                autoFocus={autoFocusId === row.tempId}
                onChange={(next) => {
                  handleRowChange(idx, next);
                  if (autoFocusId === row.tempId && next.inventoryItemId) {
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
