'use client';

import { useState, useMemo } from 'react';
import Box from '@mui/material/Box';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import MenuItem from '@mui/material/MenuItem';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Chip from '@mui/material/Chip';
import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import TuneIcon from '@mui/icons-material/Tune';
import type { Part, PartUnitConversion } from '@/types/part';
import type { InventoryTransactionType, TransactionFormData } from '@/types/partTransaction';
import { addPartStock, removePartStock, adjustPartStock } from '@/utils/partsAccess';
import { convertToBaseUnit, getStandardUnitsForUnit } from '@/lib/unitPresets';

interface PartTransactionModalProps {
  open: boolean;
  onClose: () => void;
  part: Part;
  /** The part's unit conversions (fetched separately by the parent). */
  unitConversions: PartUnitConversion[];
  onSuccess?: () => void;
  /** Pre-select action type */
  defaultType?: InventoryTransactionType;
}

export default function PartTransactionModal({
  open,
  onClose,
  part,
  unitConversions,
  onSuccess,
  defaultType = 'addition',
}: PartTransactionModalProps) {
  const primaryUnit = part.primary_unit ?? '';

  const [formData, setFormData] = useState<TransactionFormData>({
    type: defaultType,
    quantity: 0,
    unit: primaryUnit,
    notes: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when modal opens
  const handleOpen = () => {
    setFormData({
      type: defaultType,
      quantity: 0,
      unit: primaryUnit,
      notes: '',
    });
    setError(null);
  };

  // Available units for this part (primary + standard same-category + custom conversions)
  const availableUnits = useMemo(() => {
    const units: { value: string; label: string; isPrimary: boolean; group: 'primary' | 'standard' | 'custom' }[] = [];
    const addedUnits = new Set<string>();
    if (primaryUnit) {
      units.push({ value: primaryUnit, label: primaryUnit, isPrimary: true, group: 'primary' });
      addedUnits.add(primaryUnit);

      // Auto-include all standard units from the same category
      const standardUnits = getStandardUnitsForUnit(primaryUnit);
      for (const unit of standardUnits) {
        if (!addedUnits.has(unit)) {
          units.push({ value: unit, label: unit, isPrimary: false, group: 'standard' });
          addedUnits.add(unit);
        }
      }
    }

    // Include custom (cross-category) conversions
    for (const conv of unitConversions) {
      if (!addedUnits.has(conv.from_unit)) {
        units.push({ value: conv.from_unit, label: conv.from_unit, isPrimary: false, group: 'custom' });
        addedUnits.add(conv.from_unit);
      }
    }

    return units;
  }, [primaryUnit, unitConversions]);

  // Calculate preview of converted quantity
  const convertedQuantity = useMemo(() => {
    if (formData.quantity <= 0 || !primaryUnit) return 0;
    return convertToBaseUnit(
      formData.quantity,
      formData.unit,
      primaryUnit,
      unitConversions,
    );
  }, [formData.quantity, formData.unit, primaryUnit, unitConversions]);

  // Preview new quantity after transaction
  const previewNewQuantity = useMemo(() => {
    if (formData.type === 'addition') {
      return part.quantity + convertedQuantity;
    } else if (formData.type === 'depletion') {
      return part.quantity - convertedQuantity;
    } else {
      // Adjustment sets to specific value
      return convertedQuantity;
    }
  }, [formData.type, part.quantity, convertedQuantity]);

  // Check if transaction would result in negative quantity
  const wouldGoNegative = previewNewQuantity < 0;

  const handleTypeChange = (
    _: React.MouseEvent<HTMLElement>,
    newType: InventoryTransactionType | null,
  ) => {
    if (newType) {
      setFormData((prev) => ({ ...prev, type: newType }));
      setError(null);
    }
  };

  const handleSubmit = async () => {
    setError(null);

    if (!primaryUnit) {
      setError('This part has no primary unit; set one before recording a transaction.');
      return;
    }
    if (formData.quantity <= 0) {
      setError('Quantity must be greater than 0');
      return;
    }

    if (wouldGoNegative) {
      setError(
        `Cannot remove ${convertedQuantity} ${primaryUnit}. Only ${part.quantity} ${primaryUnit} available.`,
      );
      return;
    }

    setLoading(true);

    try {
      if (formData.type === 'addition') {
        await addPartStock(part.id, formData.quantity, formData.unit, formData.notes);
      } else if (formData.type === 'depletion') {
        await removePartStock(part.id, formData.quantity, formData.unit, formData.notes);
      } else {
        await adjustPartStock(part.id, formData.quantity, formData.unit, formData.notes);
      }

      onSuccess?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const getTypeLabel = (type: InventoryTransactionType) => {
    switch (type) {
      case 'addition':
        return 'Add Stock';
      case 'depletion':
        return 'Remove Stock';
      case 'adjustment':
        return 'Adjust To';
    }
  };

  const getTypeDescription = (type: InventoryTransactionType) => {
    switch (type) {
      case 'addition':
        return 'Add new stock to inventory (e.g., received delivery)';
      case 'depletion':
        return 'Remove stock from inventory (e.g., used in production)';
      case 'adjustment':
        return 'Set quantity to a specific value (e.g., after physical count)';
    }
  };

  return (
    <Dialog
      open={open}
      onClose={loading ? undefined : onClose}
      maxWidth="sm"
      fullWidth
      TransitionProps={{ onEnter: handleOpen }}
    >
      <DialogTitle>
        Inventory Transaction
        <Typography variant="body2" color="text.secondary">
          {part.part_name}
        </Typography>
      </DialogTitle>

      <DialogContent dividers>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {/* Current Quantity Display */}
        <Box
          sx={{
            mb: 3,
            p: 2,
            bgcolor: 'background.paper',
            borderRadius: 1,
            border: '1px solid',
            borderColor: 'divider',
          }}
        >
          <Typography variant="body2" color="text.secondary">
            Current Quantity
          </Typography>
          <Typography variant="h4" sx={{ fontWeight: 600 }}>
            {part.quantity.toLocaleString()} {primaryUnit}
          </Typography>
        </Box>

        {/* Transaction Type Selector */}
        <Box sx={{ mb: 3 }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Action Type
          </Typography>
          <ToggleButtonGroup
            value={formData.type}
            exclusive
            onChange={handleTypeChange}
            fullWidth
            disabled={loading}
          >
            <ToggleButton value="addition" color="success">
              <AddIcon sx={{ mr: 1 }} />
              Add
            </ToggleButton>
            <ToggleButton value="depletion" color="error">
              <RemoveIcon sx={{ mr: 1 }} />
              Remove
            </ToggleButton>
            <ToggleButton value="adjustment" color="info">
              <TuneIcon sx={{ mr: 1 }} />
              Adjust
            </ToggleButton>
          </ToggleButtonGroup>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            {getTypeDescription(formData.type)}
          </Typography>
        </Box>

        {/* Quantity & Unit */}
        <Box sx={{ display: 'flex', gap: 2, mb: 3 }}>
          <TextField
            label={formData.type === 'adjustment' ? 'New Quantity' : 'Quantity'}
            type="number"
            value={formData.quantity || ''}
            onChange={(e) =>
              setFormData((prev) => ({ ...prev, quantity: parseFloat(e.target.value) || 0 }))
            }
            disabled={loading}
            InputLabelProps={{ shrink: true }}
            inputProps={{ min: 0, step: 0.01, inputMode: 'decimal' }}
            sx={{ flex: 2 }}
            autoFocus
          />
          <TextField
            select
            label="Unit"
            value={formData.unit}
            onChange={(e) => setFormData((prev) => ({ ...prev, unit: e.target.value }))}
            disabled={loading}
            sx={{ flex: 1 }}
          >
            {availableUnits.map((u) => (
              <MenuItem key={u.value} value={u.value}>
                {u.label}
                {u.isPrimary && <Chip label="Primary" size="small" sx={{ ml: 1 }} />}
              </MenuItem>
            ))}
            {availableUnits.length <= 1 && (
              <MenuItem disabled>
                <Typography variant="caption" color="text.secondary">
                  No compatible units available
                </Typography>
              </MenuItem>
            )}
          </TextField>
        </Box>

        {/* Conversion Preview */}
        {formData.unit !== primaryUnit && formData.quantity > 0 && (
          <Alert severity="info" sx={{ mb: 3 }}>
            {formData.quantity} {formData.unit} = {convertedQuantity.toFixed(4)} {primaryUnit}
          </Alert>
        )}

        {/* New Quantity Preview */}
        {formData.quantity > 0 && (
          <Box
            sx={{
              mb: 3,
              p: 2,
              bgcolor: wouldGoNegative ? 'error.dark' : 'success.dark',
              borderRadius: 1,
              opacity: wouldGoNegative ? 0.8 : 1,
            }}
          >
            <Typography variant="body2" sx={{ opacity: 0.8 }}>
              {formData.type === 'adjustment' ? 'New Quantity' : 'After Transaction'}
            </Typography>
            <Typography variant="h5" sx={{ fontWeight: 600 }}>
              {wouldGoNegative ? (
                'Insufficient Stock'
              ) : (
                <>
                  {previewNewQuantity.toLocaleString(undefined, { maximumFractionDigits: 4 })}{' '}
                  {primaryUnit}
                </>
              )}
            </Typography>
            {!wouldGoNegative && formData.type !== 'adjustment' && (
              <Typography variant="body2" sx={{ opacity: 0.8 }}>
                {formData.type === 'addition' ? '+' : '-'}
                {convertedQuantity.toLocaleString(undefined, { maximumFractionDigits: 4 })}{' '}
                {primaryUnit}
              </Typography>
            )}
          </Box>
        )}

        {/* Notes */}
        <TextField
          fullWidth
          label="Notes"
          value={formData.notes}
          onChange={(e) => setFormData((prev) => ({ ...prev, notes: e.target.value }))}
          disabled={loading}
          multiline
          rows={2}
          placeholder="Optional notes about this transaction"
        />
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose} disabled={loading}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={loading || formData.quantity <= 0 || wouldGoNegative}
          startIcon={loading ? <CircularProgress size={20} /> : null}
          // Primary action = blue; the one exception is depletion (removing
          // stock), which stays red like every other destructive action. The
          // mode's semantic color lives on the ToggleButtonGroup above, not on
          // this action button.
          color={formData.type === 'depletion' ? 'error' : 'primary'}
        >
          {loading ? 'Processing...' : getTypeLabel(formData.type)}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
