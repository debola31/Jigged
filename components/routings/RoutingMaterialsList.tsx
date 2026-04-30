'use client';

import { useState, useEffect, useCallback } from 'react';
import { Box, Typography, Button, Alert, CircularProgress } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
import RoutingMaterialRow, { type MaterialRowData } from './RoutingMaterialRow';
import RoutingMaterialRowEditor, { type MaterialEditorValue } from './RoutingMaterialRowEditor';
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
 * Linear list of routing-level materials. Same UX pattern as operations:
 * inline-editor add at the bottom, inline-editor edit in place.
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
  const [editorState, setEditorState] = useState<
    | { mode: 'closed' }
    | { mode: 'add' }
    | { mode: 'edit'; rowIndex: number }
  >({ mode: 'closed' });

  useEffect(() => {
    getAllInventoryItems(companyId)
      .then(setInventoryItems)
      .catch((err) => {
        console.error('Failed to load inventory items:', err);
        setError('Failed to load inventory items.');
      })
      .finally(() => setLoading(false));
  }, [companyId]);

  const handleDelete = useCallback((index: number) => {
    onChange(rows.filter((_, i) => i !== index));
  }, [rows, onChange]);

  const handleEditorSave = (value: MaterialEditorValue) => {
    if (!value.item) return;
    if (editorState.mode === 'add') {
      const newRow: MaterialRowData = {
        tempId: generateTempId(),
        inventoryItemId: value.item.id,
        itemName: value.item.name,
        quantity: value.quantity,
        unit: value.unit,
      };
      onChange([...rows, newRow]);
    } else if (editorState.mode === 'edit') {
      const copy = [...rows];
      copy[editorState.rowIndex] = {
        ...copy[editorState.rowIndex],
        inventoryItemId: value.item.id,
        itemName: value.item.name,
        quantity: value.quantity,
        unit: value.unit,
      };
      onChange(copy);
    }
    setEditorState({ mode: 'closed' });
  };

  const editingRow = editorState.mode === 'edit' ? rows[editorState.rowIndex] : null;
  const editingInitial: MaterialEditorValue | undefined = editingRow
    ? {
        item: inventoryItems.find((it) => it.id === editingRow.inventoryItemId) || null,
        quantity: editingRow.quantity,
        unit: editingRow.unit,
      }
    : undefined;

  const isEditingExisting = editorState.mode === 'edit';
  const editorOpen = editorState.mode !== 'closed';

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5, gap: 1, flexWrap: 'wrap' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
          <Inventory2OutlinedIcon fontSize="small" color="primary" />
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Materials
          </Typography>
          {rows.length > 0 && (
            <Typography variant="caption" color="text.secondary">
              {rows.length} item{rows.length === 1 ? '' : 's'}
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
          <Inventory2OutlinedIcon sx={{ fontSize: 36, color: 'text.disabled', mb: 1 }} />
          <Typography variant="body2" color="text.secondary" gutterBottom>
            No materials yet.
          </Typography>
          <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mb: 1.5 }}>
            Add the materials each job for this part will need.
          </Typography>
        </Box>
      ) : (
        <>
          {rows.map((row, idx) =>
            isEditingExisting && editorState.rowIndex === idx ? (
              <RoutingMaterialRowEditor
                key={row.tempId}
                inventoryItems={inventoryItems}
                initial={editingInitial}
                onSave={handleEditorSave}
                onCancel={() => setEditorState({ mode: 'closed' })}
              />
            ) : (
              <RoutingMaterialRow
                key={row.tempId}
                row={row}
                onEdit={() => setEditorState({ mode: 'edit', rowIndex: idx })}
                onDelete={() => handleDelete(idx)}
                disabled={disabled || editorOpen}
              />
            )
          )}
          {editorState.mode === 'add' && (
            <RoutingMaterialRowEditor
              inventoryItems={inventoryItems}
              onSave={handleEditorSave}
              onCancel={() => setEditorState({ mode: 'closed' })}
            />
          )}
        </>
      )}
    </Box>
  );
}
