'use client';

import { useState, useEffect } from 'react';
import {
  Box,
  TextField,
  IconButton,
  Autocomplete,
  Typography,
  CircularProgress,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
} from '@mui/material';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { InventoryItem } from '@/types/inventory';
import { getStandardUnitsForUnit } from '@/lib/unitPresets';

export interface MaterialRowData {
  tempId: string;
  inventoryItemId: string;
  itemName: string;
  quantity: number;
  unit: string;
}

interface RoutingMaterialRowProps {
  row: MaterialRowData;
  index: number;
  inventoryItems: InventoryItem[];
  inventoryLoading: boolean;
  autoFocus?: boolean;
  onChange: (next: MaterialRowData) => void;
  onDelete: () => void;
  disabled?: boolean;
}

/**
 * One row in the materials list. Inline-edited:
 *   [drag] N. [inventory picker]  qty [n]  unit [▾]  [delete]
 */
export default function RoutingMaterialRow({
  row,
  index,
  inventoryItems,
  inventoryLoading,
  autoFocus = false,
  onChange,
  onDelete,
  disabled = false,
}: RoutingMaterialRowProps) {
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

  const [qtyStr, setQtyStr] = useState<string>(row.quantity ? String(row.quantity) : '');
  useEffect(() => {
    setQtyStr(row.quantity ? String(row.quantity) : '');
  }, [row.quantity]);

  const selectedItem =
    inventoryItems.find((item) => item.id === row.inventoryItemId) || null;

  const availableUnits = (() => {
    if (!selectedItem) return [row.unit].filter(Boolean);
    const units = new Set<string>([selectedItem.primary_unit]);
    for (const u of getStandardUnitsForUnit(selectedItem.primary_unit)) {
      units.add(u);
    }
    if (row.unit) units.add(row.unit);
    return Array.from(units);
  })();

  const commitQty = () => {
    const parsed = qtyStr === '' ? 0 : parseFloat(qtyStr);
    onChange({ ...row, quantity: Number.isFinite(parsed) ? Math.max(0, parsed) : 0 });
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
        options={inventoryItems}
        getOptionLabel={(item) => item.name}
        value={selectedItem}
        onChange={(_, newValue) => {
          // When picking a new item, default the unit to its primary_unit.
          onChange({
            ...row,
            inventoryItemId: newValue?.id || '',
            itemName: newValue?.name || '',
            unit: newValue ? newValue.primary_unit : '',
          });
        }}
        loading={inventoryLoading}
        disabled={disabled}
        isOptionEqualToValue={(option, value) => option.id === value.id}
        openOnFocus={autoFocus}
        renderInput={(params) => (
          <TextField
            {...params}
            label="Inventory item"
            placeholder="Pick a material…"
            autoFocus={autoFocus}
            InputProps={{
              ...params.InputProps,
              endAdornment: (
                <>
                  {inventoryLoading ? <CircularProgress size={16} /> : null}
                  {params.InputProps.endAdornment}
                </>
              ),
            }}
          />
        )}
      />

      <TextField
        size="small"
        label="Qty"
        type="number"
        value={qtyStr}
        onChange={(e) => setQtyStr(e.target.value)}
        onBlur={commitQty}
        inputProps={{ min: 0, step: 0.1 }}
        sx={{ width: isMobile ? '40%' : 100 }}
        disabled={disabled}
      />

      <FormControl
        size="small"
        sx={{ width: isMobile ? '40%' : 110 }}
        disabled={disabled || !row.inventoryItemId}
      >
        <InputLabel>Unit</InputLabel>
        <Select
          value={row.unit}
          label="Unit"
          onChange={(e) => onChange({ ...row, unit: e.target.value })}
          displayEmpty
        >
          {availableUnits.map((u) => (
            <MenuItem key={u} value={u}>
              {u}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <IconButton
        size="small"
        color="error"
        onClick={onDelete}
        disabled={disabled}
        aria-label="Delete material"
        sx={{ mt: 0.5 }}
      >
        <DeleteOutlineIcon fontSize="small" />
      </IconButton>
    </Box>
  );
}
