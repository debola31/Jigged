'use client';

import { useState, useEffect, useMemo } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Box,
  TextField,
  Button,
  Autocomplete,
  IconButton,
  CircularProgress,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import type { InventoryItem } from '@/types/inventory';
import { getStandardUnitsForUnit } from '@/lib/unitPresets';

export interface MaterialModalValue {
  item: InventoryItem | null;
  quantity: number;
  unit: string;
}

interface AddMaterialModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (value: MaterialModalValue) => void;
  inventoryItems: InventoryItem[];
  initial?: MaterialModalValue;
  saving?: boolean;
}

/**
 * Modal for adding (or editing) a routing material. Single screen with:
 *   - Inventory item picker (Autocomplete)
 *   - Quantity (text input, no spinner arrows)
 *   - Unit (dropdown with primary + standard secondary units)
 */
export default function AddMaterialModal({
  open,
  onClose,
  onSave,
  inventoryItems,
  initial,
  saving = false,
}: AddMaterialModalProps) {
  const [item, setItem] = useState<InventoryItem | null>(null);
  const [qtyStr, setQtyStr] = useState('');
  const [unit, setUnit] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setItem(initial?.item ?? null);
      setQtyStr(initial?.quantity ? String(initial.quantity) : '');
      setUnit(initial?.unit ?? '');
      setTouched(false);
    }
  }, [open, initial]);

  // When item changes (and user hasn't picked a unit yet), default to primary.
  useEffect(() => {
    if (item && !unit) setUnit(item.primary_unit);
  }, [item, unit]);

  const isEdit = !!initial;

  const availableUnits = useMemo(() => {
    if (!item) return unit ? [unit] : [];
    const units = new Set<string>([item.primary_unit]);
    for (const u of getStandardUnitsForUnit(item.primary_unit)) units.add(u);
    if (unit) units.add(unit);
    return Array.from(units);
  }, [item, unit]);

  const itemError = touched && !item;
  const qtyParsed = qtyStr === '' ? NaN : parseFloat(qtyStr);
  const qtyError = touched && (!Number.isFinite(qtyParsed) || qtyParsed <= 0);
  const unitError = touched && !unit;
  const canSave = !!item && Number.isFinite(qtyParsed) && qtyParsed > 0 && !!unit;

  const handleSave = () => {
    setTouched(true);
    if (!canSave) return;
    onSave({ item: item!, quantity: qtyParsed, unit });
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pr: 1 }}>
        {isEdit ? 'Edit Material' : 'Add Material'}
        <IconButton size="small" onClick={onClose} disabled={saving}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, pt: 1 }}>
          <Autocomplete
            size="small"
            options={inventoryItems}
            getOptionLabel={(it) => it.name}
            value={item}
            onChange={(_, newValue) => {
              setItem(newValue);
              if (newValue) setUnit(newValue.primary_unit);
            }}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            disabled={saving}
            renderInput={(params) => (
              <TextField
                {...params}
                autoFocus={!isEdit}
                label="Inventory item"
                placeholder="Pick a material…"
                error={itemError}
                helperText={itemError ? 'Pick an item.' : ' '}
              />
            )}
          />

          <Box sx={{ display: 'flex', gap: 2 }}>
            <TextField
              size="small"
              label="Quantity"
              type="text"
              inputMode="decimal"
              value={qtyStr}
              onChange={(e) => {
                const v = e.target.value;
                if (v === '' || /^\d*\.?\d*$/.test(v)) setQtyStr(v);
              }}
              placeholder="e.g. 2.5"
              error={!!qtyError}
              helperText={qtyError ? 'Enter a number greater than 0.' : ' '}
              disabled={saving}
              sx={{ flex: 1 }}
            />
            <FormControl size="small" sx={{ minWidth: 130 }} disabled={saving || !item} error={!!unitError}>
              <InputLabel>Unit</InputLabel>
              <Select
                value={unit}
                label="Unit"
                onChange={(e) => setUnit(e.target.value)}
                displayEmpty
              >
                {availableUnits.map((u) => (
                  <MenuItem key={u} value={u}>
                    {u}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>

          {item && item.cost_per_unit !== null && item.cost_per_unit !== undefined && (
            <Typography variant="caption" color="text.secondary">
              Stock: {item.quantity} {item.primary_unit} • Cost ${Number(item.cost_per_unit).toFixed(2)}/{item.primary_unit}
            </Typography>
          )}
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={saving}
          startIcon={saving ? <CircularProgress size={14} /> : null}
        >
          {isEdit ? 'Save changes' : 'Add to routing'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
