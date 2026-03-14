'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Grid from '@mui/material/Grid';
import IconButton from '@mui/material/IconButton';
import Snackbar from '@mui/material/Snackbar';
import MenuItem from '@mui/material/MenuItem';
import InputAdornment from '@mui/material/InputAdornment';
import Divider from '@mui/material/Divider';
import ListItemIcon from '@mui/material/ListItemIcon';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import type {
  InventoryItem,
  InventoryItemWithRelations,
  InventoryItemFormData,
  UnitConversionFormData,
  CompanyCustomUnit,
} from '@/types/inventory';
import {
  createInventoryItem,
  updateInventoryItem,
  deleteInventoryItem,
  checkSkuExists,
  getCompanyCustomUnits,
  createCompanyCustomUnit,
} from '@/utils/inventoryAccess';
import {
  UNITS_BY_CATEGORY,
  ALL_UNITS,
} from '@/lib/unitPresets';

interface InventoryFormProps {
  mode: 'create' | 'edit';
  companyId: string;
  initialData: InventoryItemFormData;
  itemId?: string;
  item?: InventoryItemWithRelations;
  onSuccess?: (item?: InventoryItem) => void;
  onCancel?: () => void;
}

// Sentinel value for the "Create Custom Unit" action in the dropdown
const CREATE_CUSTOM_UNIT_ACTION = '__create_custom_unit__';

export default function InventoryForm({
  mode,
  companyId,
  initialData,
  itemId,
  item,
  onSuccess,
  onCancel,
}: InventoryFormProps) {
  const router = useRouter();

  const [formData, setFormData] = useState<InventoryItemFormData>(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'error' | 'success' }>({
    open: false,
    message: '',
    severity: 'error',
  });

  // Company custom units
  const [customUnits, setCustomUnits] = useState<CompanyCustomUnit[]>([]);
  const [customUnitDialogOpen, setCustomUnitDialogOpen] = useState(false);
  const [newUnitName, setNewUnitName] = useState('');
  const [newUnitError, setNewUnitError] = useState<string | null>(null);
  const [creatingUnit, setCreatingUnit] = useState(false);

  // Fetch company custom units on mount
  useEffect(() => {
    getCompanyCustomUnits(companyId)
      .then(setCustomUnits)
      .catch((err) => console.error('Error fetching custom units:', err));
  }, [companyId]);

  // All known unit names (for validation)
  const allStandardUnits = new Set(ALL_UNITS);

  const handleChange =
    (field: keyof InventoryItemFormData) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value = e.target.value;
      if (field === 'quantity' || field === 'cost_per_unit') {
        setFormData((prev) => ({
          ...prev,
          [field]: value === '' ? (field === 'quantity' ? 0 : null) : parseFloat(value),
        }));
      } else {
        setFormData((prev) => ({ ...prev, [field]: value }));
      }
      if (fieldErrors[field]) {
        setFieldErrors((prev) => ({ ...prev, [field]: '' }));
      }
    };

  const handleUnitChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newUnit = e.target.value;

    // Intercept the "Create Custom Unit" action
    if (newUnit === CREATE_CUSTOM_UNIT_ACTION) {
      setCustomUnitDialogOpen(true);
      return;
    }

    setFormData((prev) => ({ ...prev, primary_unit: newUnit }));
    if (fieldErrors.primary_unit) {
      setFieldErrors((prev) => ({ ...prev, primary_unit: '' }));
    }
  };

  // Custom unit creation
  const handleCreateCustomUnit = async () => {
    const trimmed = newUnitName.trim().toLowerCase();

    if (!trimmed) {
      setNewUnitError('Unit name is required');
      return;
    }

    if (allStandardUnits.has(trimmed)) {
      setNewUnitError('This is already a standard unit');
      return;
    }

    if (customUnits.some((cu) => cu.unit_name === trimmed)) {
      setNewUnitError('This custom unit already exists');
      return;
    }

    setCreatingUnit(true);
    setNewUnitError(null);

    try {
      const created = await createCompanyCustomUnit(companyId, trimmed);
      setCustomUnits((prev) => [...prev, created].sort((a, b) => a.unit_name.localeCompare(b.unit_name)));
      setFormData((prev) => ({ ...prev, primary_unit: created.unit_name }));
      setCustomUnitDialogOpen(false);
      setNewUnitName('');
    } catch (err) {
      setNewUnitError(err instanceof Error ? err.message : 'Error creating unit');
    } finally {
      setCreatingUnit(false);
    }
  };

  // Unit conversion handlers
  const handleAddConversion = () => {
    setFormData((prev) => ({
      ...prev,
      unit_conversions: [
        ...prev.unit_conversions,
        { from_unit: '', to_primary_factor: 1 },
      ],
    }));
  };

  const handleRemoveConversion = (index: number) => {
    setFormData((prev) => ({
      ...prev,
      unit_conversions: prev.unit_conversions.filter((_, i) => i !== index),
    }));
  };

  const handleConversionChange = (
    index: number,
    field: keyof UnitConversionFormData,
    value: string
  ) => {
    setFormData((prev) => ({
      ...prev,
      unit_conversions: prev.unit_conversions.map((conv, i) => {
        if (i !== index) return conv;
        if (field === 'from_unit') {
          return { ...conv, from_unit: value };
        } else {
          return { ...conv, to_primary_factor: parseFloat(value) || 1 };
        }
      }),
    }));
  };

  const validateForm = async (): Promise<boolean> => {
    const errors: Record<string, string> = {};

    if (!formData.name.trim()) {
      errors.name = 'Item name is required';
    }

    if (!formData.primary_unit.trim()) {
      errors.primary_unit = 'Primary unit is required';
    }

    if (formData.quantity < 0) {
      errors.quantity = 'Quantity cannot be negative';
    }

    if (formData.cost_per_unit !== null && formData.cost_per_unit < 0) {
      errors.cost_per_unit = 'Cost cannot be negative';
    }

    if (formData.sku.trim()) {
      try {
        const exists = await checkSkuExists(companyId, formData.sku, mode === 'edit' ? itemId : undefined);
        if (exists) {
          errors.sku = 'This SKU is already in use';
        }
      } catch {
        setError('Error validating SKU');
        return false;
      }
    }

    // Validate unit conversions
    const conversionUnits = new Set<string>();
    for (let i = 0; i < formData.unit_conversions.length; i++) {
      const conv = formData.unit_conversions[i];
      if (!conv.from_unit) {
        errors[`conversion_${i}_unit`] = 'Unit is required';
      } else if (conv.from_unit === formData.primary_unit) {
        errors[`conversion_${i}_unit`] = 'Cannot convert from primary unit';
      } else if (conversionUnits.has(conv.from_unit)) {
        errors[`conversion_${i}_unit`] = 'Duplicate unit';
      } else {
        conversionUnits.add(conv.from_unit);
      }

      if (conv.to_primary_factor <= 0) {
        errors[`conversion_${i}_factor`] = 'Factor must be positive';
      }
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setError(null);

    const isValid = await validateForm();
    if (!isValid) return;

    setLoading(true);

    try {
      if (mode === 'create') {
        const newItem = await createInventoryItem(companyId, formData);
        if (onSuccess) {
          onSuccess(newItem);
        } else {
          router.push(`/dashboard/${companyId}/inventory/${newItem.id}`);
        }
      } else if (itemId) {
        const updatedItem = await updateInventoryItem(itemId, formData);
        if (onSuccess) {
          onSuccess(updatedItem);
        } else {
          router.push(`/dashboard/${companyId}/inventory/${itemId}`);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!itemId) return;

    setLoading(true);
    try {
      await deleteInventoryItem(itemId);
      if (onSuccess) {
        onSuccess();
      } else {
        router.push(`/dashboard/${companyId}/inventory`);
      }
    } catch (err) {
      setSnackbar({
        open: true,
        message: err instanceof Error ? err.message : 'An error occurred',
        severity: 'error',
      });
      setDeleteDialogOpen(false);
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    if (onCancel) {
      onCancel();
    } else {
      router.push(`/dashboard/${companyId}/inventory`);
    }
  };

  return (
    <Box component="form" onSubmit={handleSubmit}>
      {error && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {error}
        </Alert>
      )}

      {/* Basic Information */}
      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom sx={{ fontWeight: 600, mb: 3 }}>
            Basic Information
          </Typography>
          <Grid container spacing={3}>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                fullWidth
                required
                label="Item Name"
                value={formData.name}
                onChange={handleChange('name')}
                error={!!fieldErrors.name}
                helperText={fieldErrors.name || 'e.g., "4140 Steel Bar", "Aluminum 6061 Sheet"'}
                disabled={loading}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                fullWidth
                label="SKU"
                value={formData.sku}
                onChange={handleChange('sku')}
                error={!!fieldErrors.sku}
                helperText={fieldErrors.sku || 'Optional internal identifier code'}
                disabled={loading}
              />
            </Grid>
            <Grid size={{ xs: 12 }}>
              <TextField
                fullWidth
                label="Description"
                value={formData.description}
                onChange={handleChange('description')}
                disabled={loading}
                multiline
                rows={2}
                placeholder="Detailed description of this inventory item"
              />
            </Grid>
          </Grid>
        </CardContent>
      </Card>

      {/* Units & Quantity */}
      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom sx={{ fontWeight: 600, mb: 3 }}>
            Units & Quantity
          </Typography>
          <Grid container spacing={3}>
            <Grid size={{ xs: 12, sm: 4 }}>
              <TextField
                select
                fullWidth
                required
                label="Primary Unit"
                value={formData.primary_unit}
                onChange={handleUnitChange}
                error={!!fieldErrors.primary_unit}
                helperText={fieldErrors.primary_unit || 'Base unit for this item'}
                disabled={loading || (mode === 'edit' && (item?.transaction_count || 0) > 0)}
              >
                {/* Standard unit categories */}
                {UNITS_BY_CATEGORY.map((category) => [
                  <MenuItem key={`header-${category.category}`} disabled sx={{ fontWeight: 600, opacity: 1 }}>
                    {category.category}
                  </MenuItem>,
                  ...category.units.map((unit) => (
                    <MenuItem key={unit} value={unit} sx={{ pl: 4 }}>
                      {unit}
                    </MenuItem>
                  )),
                ])}

                {/* Company custom units */}
                {customUnits.length > 0 && [
                  <Divider key="custom-divider" />,
                  <MenuItem key="header-custom" disabled sx={{ fontWeight: 600, opacity: 1 }}>
                    Custom
                  </MenuItem>,
                  ...customUnits.map((cu) => (
                    <MenuItem key={`custom-${cu.id}`} value={cu.unit_name} sx={{ pl: 4 }}>
                      {cu.unit_name}
                    </MenuItem>
                  )),
                ]}

                {/* Create custom unit action */}
                <Divider />
                <MenuItem value={CREATE_CUSTOM_UNIT_ACTION} sx={{ color: 'primary.main' }}>
                  <ListItemIcon sx={{ color: 'primary.main', minWidth: 32 }}>
                    <AddIcon fontSize="small" />
                  </ListItemIcon>
                  Create Custom Unit
                </MenuItem>
              </TextField>
            </Grid>
            <Grid size={{ xs: 12, sm: 4 }}>
              <TextField
                fullWidth
                label="Quantity"
                type="number"
                value={formData.quantity}
                onChange={handleChange('quantity')}
                error={!!fieldErrors.quantity}
                helperText={fieldErrors.quantity || (mode === 'edit' ? 'Use transactions to adjust' : 'Initial quantity')}
                disabled={loading || mode === 'edit'}
                InputProps={{
                  endAdornment: formData.primary_unit ? (
                    <InputAdornment position="end">{formData.primary_unit}</InputAdornment>
                  ) : undefined,
                }}
                inputProps={{ min: 0, step: 0.01 }}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 4 }}>
              <TextField
                fullWidth
                label="Cost per Unit"
                type="number"
                value={formData.cost_per_unit ?? ''}
                onChange={handleChange('cost_per_unit')}
                error={!!fieldErrors.cost_per_unit}
                helperText={fieldErrors.cost_per_unit || 'Cost per primary unit'}
                disabled={loading}
                InputProps={{
                  startAdornment: <InputAdornment position="start">$</InputAdornment>,
                }}
                inputProps={{ min: 0, step: 0.01 }}
              />
            </Grid>
          </Grid>

          {/* Custom unit conversions — inline, inside Units & Quantity card */}
          <Box sx={{ mt: 2 }}>
            {formData.unit_conversions.length > 0 && (
              <>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                  Custom Unit Conversions
                </Typography>
                {formData.unit_conversions.map((conv, index) => (
                  <Box
                    key={`conv-${conv.from_unit}-${conv.to_primary_factor}-${index}`}
                    sx={{
                      display: 'flex',
                      gap: 1.5,
                      alignItems: 'center',
                      mb: 1.5,
                    }}
                  >
                    <Typography variant="body2" sx={{ whiteSpace: 'nowrap' }}>
                      1
                    </Typography>
                    <TextField
                      size="small"
                      label="Unit"
                      value={conv.from_unit}
                      onChange={(e) => handleConversionChange(index, 'from_unit', e.target.value)}
                      disabled={loading}
                      error={!!fieldErrors[`conversion_${index}_unit`]}
                      helperText={fieldErrors[`conversion_${index}_unit`]}
                      sx={{ width: 140 }}
                    />
                    <Typography variant="body2" sx={{ whiteSpace: 'nowrap' }}>
                      =
                    </Typography>
                    <TextField
                      size="small"
                      type="number"
                      label="Factor"
                      value={conv.to_primary_factor}
                      onChange={(e) => handleConversionChange(index, 'to_primary_factor', e.target.value)}
                      disabled={loading}
                      error={!!fieldErrors[`conversion_${index}_factor`]}
                      helperText={fieldErrors[`conversion_${index}_factor`]}
                      inputProps={{ min: 0.0001, step: 0.0001 }}
                      sx={{ width: 120 }}
                    />
                    <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
                      {formData.primary_unit || '?'}
                    </Typography>
                    <IconButton
                      size="small"
                      onClick={() => handleRemoveConversion(index)}
                      disabled={loading}
                      color="error"
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Box>
                ))}
              </>
            )}

            <Button
              size="small"
              startIcon={<AddIcon />}
              onClick={handleAddConversion}
              disabled={loading}
            >
              Add Custom Conversion
            </Button>
          </Box>
        </CardContent>
      </Card>

      {/* Actions */}
      <Box sx={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>
        {mode === 'edit' && (
          <Button
            variant="outlined"
            color="error"
            onClick={() => setDeleteDialogOpen(true)}
            disabled={loading}
          >
            Delete
          </Button>
        )}
        <Box sx={{ flex: 1 }} />
        <Button variant="outlined" onClick={handleCancel} disabled={loading}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="contained"
          disabled={loading}
          startIcon={loading ? <CircularProgress size={20} /> : null}
        >
          {loading ? 'Saving...' : 'Save'}
        </Button>
      </Box>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)}>
        <DialogTitle>Delete Inventory Item?</DialogTitle>
        <DialogContent>
          <Typography sx={{ mb: 2 }}>
            Are you sure you want to delete &quot;{formData.name}&quot;?
          </Typography>
          <Alert severity="warning" sx={{ mb: 2 }}>
            This action cannot be undone. Transaction history will remain for audit purposes
            but will no longer be linked to this item.
          </Alert>
          {item && (item.transaction_count || 0) > 0 && (
            <Alert severity="info">
              This item has {item.transaction_count} transaction
              {item.transaction_count !== 1 ? 's' : ''} in its history.
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleDelete} color="error" variant="contained">
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* Create Custom Unit Dialog */}
      <Dialog
        open={customUnitDialogOpen}
        onClose={() => {
          setCustomUnitDialogOpen(false);
          setNewUnitName('');
          setNewUnitError(null);
        }}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Create Custom Unit</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Create a unit of measurement for your company. It will be available for all inventory items.
          </Typography>
          {newUnitError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {newUnitError}
            </Alert>
          )}
          <TextField
            autoFocus
            fullWidth
            label="Unit Name"
            value={newUnitName}
            onChange={(e) => {
              setNewUnitName(e.target.value);
              setNewUnitError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleCreateCustomUnit();
              }
            }}
            placeholder='e.g., "bar", "sheet", "roll", "spool"'
            disabled={creatingUnit}
          />
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setCustomUnitDialogOpen(false);
              setNewUnitName('');
              setNewUnitError(null);
            }}
            disabled={creatingUnit}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleCreateCustomUnit}
            disabled={creatingUnit || !newUnitName.trim()}
            startIcon={creatingUnit ? <CircularProgress size={16} /> : null}
          >
            {creatingUnit ? 'Creating...' : 'Create'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Error Snackbar */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={6000}
        onClose={() => setSnackbar((prev) => ({ ...prev, open: false }))}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          onClose={() => setSnackbar((prev) => ({ ...prev, open: false }))}
          severity={snackbar.severity}
          sx={{ width: '100%' }}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
}
