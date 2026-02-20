'use client';

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  IconButton,
  Box,
  Typography,
  CircularProgress,
  Autocomplete,
  Select,
  MenuItem,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import type { RoutingNodeFormData, OperationNodeData, RoutingNodeMaterial } from '@/types/routings';
import type { InventoryItem } from '@/types/inventory';
import { getAllInventoryItems } from '@/utils/inventoryAccess';

interface NodeEditModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: RoutingNodeFormData) => Promise<void>;
  nodeData: OperationNodeData | null;
  companyId: string;
}

/**
 * Modal for editing routing node details (time, instructions, and materials).
 * The operation type cannot be changed here - nodes must be deleted and re-added.
 */
export default function NodeEditModal({
  open,
  onClose,
  onSave,
  nodeData,
  companyId,
}: NodeEditModalProps) {
  const [formData, setFormData] = useState<RoutingNodeFormData>({
    operation_type_id: '',
    run_time_per_unit: '',
    instructions: '',
    materials: [],
  });
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Inventory items for material selection
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);
  const [inventoryLoading, setInventoryLoading] = useState(false);

  // Reset form when modal opens with new data
  useEffect(() => {
    if (open && nodeData) {
      setFormData({
        operation_type_id: nodeData.operationTypeId,
        run_time_per_unit:
          nodeData.runTimePerUnit !== null ? String(nodeData.runTimePerUnit) : '',
        instructions: nodeData.instructions || '',
        materials: nodeData.materials || [],
      });
      setErrors({});
    }
  }, [open, nodeData]);

  // Fetch inventory items when modal opens
  useEffect(() => {
    if (open && companyId) {
      setInventoryLoading(true);
      getAllInventoryItems(companyId)
        .then(setInventoryItems)
        .catch((err) => console.error('Error fetching inventory items:', err))
        .finally(() => setInventoryLoading(false));
    }
  }, [open, companyId]);

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};

    // Validate run_time_per_unit if provided
    if (formData.run_time_per_unit && isNaN(parseFloat(formData.run_time_per_unit))) {
      newErrors.run_time_per_unit = 'Must be a valid number';
    } else if (
      formData.run_time_per_unit &&
      parseFloat(formData.run_time_per_unit) < 0
    ) {
      newErrors.run_time_per_unit = 'Cannot be negative';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;

    setSaving(true);
    try {
      await onSave(formData);
      onClose();
    } catch (err) {
      console.error('Error saving node:', err);
    } finally {
      setSaving(false);
    }
  };

  // Materials handlers
  const handleAddMaterial = () => {
    setFormData((prev) => ({
      ...prev,
      materials: [
        ...prev.materials,
        { inventory_item_id: '', quantity: 1, unit: '' },
      ],
    }));
  };

  const handleRemoveMaterial = (index: number) => {
    setFormData((prev) => ({
      ...prev,
      materials: prev.materials.filter((_, i) => i !== index),
    }));
  };

  const handleMaterialChange = (
    index: number,
    field: keyof RoutingNodeMaterial,
    value: string | number
  ) => {
    setFormData((prev) => ({
      ...prev,
      materials: prev.materials.map((m, i) => {
        if (i !== index) return m;
        const updated = { ...m, [field]: value };
        // When inventory item changes, set the default unit
        if (field === 'inventory_item_id') {
          const item = inventoryItems.find((inv) => inv.id === value);
          if (item) {
            updated.unit = item.primary_unit;
          }
        }
        return updated;
      }),
    }));
  };

  const getAvailableUnits = (itemId: string): string[] => {
    const item = inventoryItems.find((inv) => inv.id === itemId);
    if (!item) return [];
    // Primary unit is always available
    return [item.primary_unit];
  };

  if (!nodeData) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      PaperProps={{
        sx: {
          bgcolor: 'background.paper',
        },
      }}
    >
      <DialogTitle
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          pb: 1,
        }}
      >
        <Box>
          <Typography variant="h6" component="span">
            Edit Operation
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ display: 'block', mt: 0.5 }}
          >
            {nodeData.operationName}
          </Typography>
        </Box>
        <IconButton onClick={onClose} size="small" sx={{ color: 'text.secondary' }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <DialogContent sx={{ pt: 2 }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, mt: 1 }}>
          {/* Time Estimate Section */}
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 2, fontWeight: 600 }}>
              Time Estimate
            </Typography>
            <TextField
              label="Run Time per Unit"
              value={formData.run_time_per_unit}
              onChange={(e) =>
                setFormData((prev) => ({
                  ...prev,
                  run_time_per_unit: e.target.value,
                }))
              }
              type="number"
              inputProps={{ min: 0, step: 0.1 }}
              error={!!errors.run_time_per_unit}
              helperText={errors.run_time_per_unit || 'Minutes per unit'}
              disabled={saving}
              fullWidth
            />
          </Box>

          {/* Instructions Section */}
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 2, fontWeight: 600 }}>
              Work Instructions
            </Typography>
            <TextField
              label="Instructions"
              value={formData.instructions}
              onChange={(e) =>
                setFormData((prev) => ({ ...prev, instructions: e.target.value }))
              }
              multiline
              rows={4}
              fullWidth
              placeholder="Enter work instructions for this operation..."
              disabled={saving}
              helperText="Notes or instructions for operators performing this operation"
            />
          </Box>

          {/* Materials Section */}
          <Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                Materials
              </Typography>
              <Button
                size="small"
                startIcon={<AddIcon />}
                onClick={handleAddMaterial}
                disabled={saving || inventoryLoading}
              >
                Add Material
              </Button>
            </Box>

            {formData.materials.length === 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 2 }}>
                No materials assigned to this operation
              </Typography>
            )}

            {formData.materials.map((material, index) => (
              <Box
                key={index}
                sx={{
                  display: 'flex',
                  gap: 1,
                  mb: 1.5,
                  alignItems: 'flex-start',
                }}
              >
                <Autocomplete
                  size="small"
                  sx={{ flex: 2 }}
                  options={inventoryItems}
                  getOptionLabel={(option) => option.name}
                  value={inventoryItems.find((inv) => inv.id === material.inventory_item_id) || null}
                  onChange={(_, newValue) => {
                    handleMaterialChange(index, 'inventory_item_id', newValue?.id || '');
                  }}
                  loading={inventoryLoading}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label="Item"
                      placeholder="Search inventory..."
                    />
                  )}
                  disabled={saving}
                  isOptionEqualToValue={(option, value) => option.id === value.id}
                />
                <TextField
                  size="small"
                  label="Qty"
                  type="number"
                  value={material.quantity}
                  onChange={(e) =>
                    handleMaterialChange(index, 'quantity', parseFloat(e.target.value) || 0)
                  }
                  inputProps={{ min: 0, step: 0.1 }}
                  disabled={saving}
                  sx={{ width: 80 }}
                />
                <Select
                  size="small"
                  value={material.unit}
                  onChange={(e) => handleMaterialChange(index, 'unit', e.target.value)}
                  disabled={saving || !material.inventory_item_id}
                  sx={{ width: 100 }}
                  displayEmpty
                >
                  {!material.unit && (
                    <MenuItem value="" disabled>
                      Unit
                    </MenuItem>
                  )}
                  {getAvailableUnits(material.inventory_item_id).map((unit) => (
                    <MenuItem key={unit} value={unit}>
                      {unit}
                    </MenuItem>
                  ))}
                </Select>
                <IconButton
                  size="small"
                  onClick={() => handleRemoveMaterial(index)}
                  disabled={saving}
                  color="error"
                  sx={{ mt: 0.5 }}
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Box>
            ))}
          </Box>

          {/* Labor Rate Display (read-only) */}
          {nodeData.laborRate !== null && (
            <Box
              sx={{
                p: 2,
                bgcolor: 'rgba(70, 130, 180, 0.1)',
                borderRadius: 1,
                border: '1px solid rgba(70, 130, 180, 0.2)',
              }}
            >
              <Typography variant="body2" color="text.secondary">
                Labor Rate: ${nodeData.laborRate.toFixed(2)}/hr
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Set in Operations configuration
              </Typography>
            </Box>
          )}
        </Box>
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 3 }}>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={saving}
          startIcon={saving ? <CircularProgress size={16} /> : null}
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
