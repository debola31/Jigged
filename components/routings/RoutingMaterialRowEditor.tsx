'use client';

import { useState, useEffect, useMemo } from 'react';
import {
  Box,
  TextField,
  Button,
  Autocomplete,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Typography,
} from '@mui/material';
import type { InventoryItem } from '@/types/inventory';
import { getStandardUnitsForUnit } from '@/lib/unitPresets';

export interface MaterialEditorValue {
  item: InventoryItem | null;
  quantity: number;
  unit: string;
}

interface RoutingMaterialRowEditorProps {
  inventoryItems: InventoryItem[];
  initial?: MaterialEditorValue;
  onSave: (value: MaterialEditorValue) => void;
  onCancel: () => void;
}

export default function RoutingMaterialRowEditor({
  inventoryItems,
  initial,
  onSave,
  onCancel,
}: RoutingMaterialRowEditorProps) {
  const isEdit = !!initial;
  const [item, setItem] = useState<InventoryItem | null>(initial?.item ?? null);
  const [qtyStr, setQtyStr] = useState(initial?.quantity ? String(initial.quantity) : '');
  const [unit, setUnit] = useState(initial?.unit ?? '');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    setItem(initial?.item ?? null);
    setQtyStr(initial?.quantity ? String(initial.quantity) : '');
    setUnit(initial?.unit ?? '');
    setTouched(false);
  }, [initial]);

  useEffect(() => {
    if (item && !unit) setUnit(item.primary_unit);
  }, [item, unit]);

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

      <Box sx={{ display: 'flex', gap: 1.5 }}>
        <TextField
          size="small"
          label="Quantity"
          type="text"
          inputMode="decimal"
          value={qtyStr}
          autoFocus={isEdit}
          onChange={(e) => {
            const v = e.target.value;
            if (v === '' || /^\d*\.?\d*$/.test(v)) setQtyStr(v);
          }}
          placeholder="e.g. 2.5"
          error={!!qtyError}
          helperText={qtyError ? 'Enter a number greater than 0.' : ' '}
          sx={{ flex: 1 }}
        />
        <FormControl size="small" sx={{ minWidth: 130 }} disabled={!item} error={!!unitError}>
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

      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
        <Button size="small" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="small" variant="contained" onClick={handleSave}>
          {isEdit ? 'Save changes' : 'Add to routing'}
        </Button>
      </Box>
    </Box>
  );
}
