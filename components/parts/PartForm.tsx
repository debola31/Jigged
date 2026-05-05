'use client';

import { useEffect, useState } from 'react';
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
import Snackbar from '@mui/material/Snackbar';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import IconButton from '@mui/material/IconButton';
import Autocomplete from '@mui/material/Autocomplete';
import InputAdornment from '@mui/material/InputAdornment';
import Chip from '@mui/material/Chip';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import type { Part, PartFormData, PartUnitConversionFormData } from '@/types/part';
import { partKind } from '@/types/part';
import {
  createPart,
  updatePart,
  deletePart,
  checkPartNameExists,
} from '@/utils/partsAccess';
import { getAllVendors } from '@/utils/vendorsAccess';
import type { Vendor } from '@/types/vendor';
import PartTypeChip from './PartTypeChip';

interface PartFormProps {
  mode: 'create' | 'edit';
  companyId: string;
  initialData: PartFormData;
  partId?: string;
  part?: Part; // Full Part with relations for delete dialog
  onSuccess?: (part?: Part) => void;
  onCancel?: () => void;
  /** When true, submit button reads "Create" or "Save" without redirect ownership. */
  hideHeading?: boolean;
}

const EMPTY_CONVERSION: PartUnitConversionFormData = {
  from_unit: '',
  to_primary_factor: 1,
};

export default function PartForm({
  mode,
  companyId,
  initialData,
  partId,
  part,
  onSuccess,
  onCancel,
  hideHeading = false,
}: PartFormProps) {
  const router = useRouter();

  const [formData, setFormData] = useState<PartFormData>(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: 'error' | 'success';
  }>({
    open: false,
    message: '',
    severity: 'error',
  });

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [vendorsLoading, setVendorsLoading] = useState(false);

  // Sync external initialData changes (e.g. when the search-first modal swaps
  // from create -> editing-existing as the user picks a suggestion).
  useEffect(() => {
    setFormData(initialData);
    setFieldErrors({});
    setError(null);
  }, [initialData]);

  useEffect(() => {
    let cancelled = false;
    async function loadVendors() {
      setVendorsLoading(true);
      try {
        const data = await getAllVendors(companyId);
        if (!cancelled) setVendors(data);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load vendors');
        }
      } finally {
        if (!cancelled) setVendorsLoading(false);
      }
    }
    loadVendors();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  // Generic text-change handler for top-level string fields.
  const handleTextChange =
    (field: keyof PartFormData) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value = e.target.value;
      setFormData((prev) => ({ ...prev, [field]: value }));
      if (fieldErrors[field as string]) {
        setFieldErrors((prev) => ({ ...prev, [field as string]: '' }));
      }
    };

  // Numeric handler that stores empty as null (so cost_per_unit can be cleared).
  // Keeps quantity as 0 when empty since it's NOT NULL in the schema.
  const handleNumberChange =
    (field: 'cost_per_unit' | 'reorder_point' | 'quantity') =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value;
      let parsed: number | null;
      if (raw === '') {
        parsed = field === 'quantity' ? 0 : null;
      } else {
        const num = Number(raw);
        parsed = Number.isFinite(num) ? num : null;
      }
      setFormData((prev) => ({ ...prev, [field]: parsed }));
      if (fieldErrors[field]) {
        setFieldErrors((prev) => ({ ...prev, [field]: '' }));
      }
    };

  const handleClassificationChange =
    (field: 'is_manufacturable' | 'is_stockable') =>
    (_e: unknown, checked: boolean) => {
      setFormData((prev) => ({ ...prev, [field]: checked }));
      // Clear any previously-shown stockable-only validation when the user
      // toggles off the corresponding section.
      if (field === 'is_stockable' && !checked && fieldErrors.primary_unit) {
        setFieldErrors((prev) => ({ ...prev, primary_unit: '' }));
      }
    };

  const handleConversionChange = (
    idx: number,
    field: keyof PartUnitConversionFormData,
    value: string,
  ) => {
    setFormData((prev) => {
      const conversions = [...prev.unit_conversions];
      const current = conversions[idx];
      if (field === 'to_primary_factor') {
        const num = Number(value);
        conversions[idx] = {
          ...current,
          to_primary_factor: Number.isFinite(num) ? num : 0,
        };
      } else {
        conversions[idx] = { ...current, [field]: value };
      }
      return { ...prev, unit_conversions: conversions };
    });
    const errKey = `unit_conversions.${idx}`;
    if (fieldErrors[errKey]) {
      setFieldErrors((prev) => ({ ...prev, [errKey]: '' }));
    }
  };

  const addConversion = () => {
    setFormData((prev) => ({
      ...prev,
      unit_conversions: [...prev.unit_conversions, { ...EMPTY_CONVERSION }],
    }));
  };

  const removeConversion = (idx: number) => {
    setFormData((prev) => ({
      ...prev,
      unit_conversions: prev.unit_conversions.filter((_, i) => i !== idx),
    }));
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next[`unit_conversions.${idx}`];
      return next;
    });
  };

  const validateForm = async (): Promise<boolean> => {
    const errors: Record<string, string> = {};

    if (!formData.part_name.trim()) {
      errors.part_name = 'Part name is required';
    }

    if (formData.part_name.trim() && !errors.part_name) {
      try {
        const exists = await checkPartNameExists(
          companyId,
          formData.part_name,
          mode === 'edit' ? partId : undefined,
        );
        if (exists) {
          errors.part_name = 'Part name already exists';
        }
      } catch {
        setError('Error validating part name');
        return false;
      }
    }

    // DB CHECK: parts_stockable_requires_unit
    if (formData.is_stockable && !(formData.primary_unit && formData.primary_unit.trim())) {
      errors.primary_unit = 'Primary unit is required for stockable parts';
    }

    // DB CHECK: quantity >= 0
    if (formData.quantity !== null && formData.quantity < 0) {
      errors.quantity = 'Quantity cannot be negative';
    }

    if (formData.cost_per_unit !== null && formData.cost_per_unit < 0) {
      errors.cost_per_unit = 'Cost cannot be negative';
    }

    if (formData.reorder_point !== null && formData.reorder_point < 0) {
      errors.reorder_point = 'Reorder point cannot be negative';
    }

    // Unit-conversion factors must be > 0 (DB CHECK to_primary_factor > 0).
    formData.unit_conversions.forEach((uc, idx) => {
      const fromBlank = !uc.from_unit.trim();
      const factorInvalid = !Number.isFinite(uc.to_primary_factor) || uc.to_primary_factor <= 0;
      if (fromBlank && factorInvalid) {
        // Empty placeholder row — drop it silently in the submit step instead
        // of erroring. We mark it for filtering below.
        return;
      }
      if (fromBlank) {
        errors[`unit_conversions.${idx}`] = 'From unit is required';
      } else if (factorInvalid) {
        errors[`unit_conversions.${idx}`] = 'Conversion factor must be greater than zero';
      }
    });

    // Check for duplicate from_unit values among non-blank conversions.
    const seenUnits = new Map<string, number>();
    formData.unit_conversions.forEach((uc, idx) => {
      const key = uc.from_unit.trim().toLowerCase();
      if (!key) return;
      if (seenUnits.has(key)) {
        errors[`unit_conversions.${idx}`] = `Duplicate "from unit" — "${uc.from_unit}" already listed`;
      } else {
        seenUnits.set(key, idx);
      }
    });

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

    // Drop any blank placeholder conversion rows before persisting.
    const cleanedConversions = formData.unit_conversions.filter(
      (uc) =>
        uc.from_unit.trim() !== '' &&
        Number.isFinite(uc.to_primary_factor) &&
        uc.to_primary_factor > 0,
    );

    const payload: PartFormData = {
      ...formData,
      // Ensure null-vs-empty consistency for primary_unit on the way to the DB.
      primary_unit:
        formData.primary_unit && formData.primary_unit.trim() !== ''
          ? formData.primary_unit.trim()
          : null,
      unit_conversions: cleanedConversions,
    };

    try {
      if (mode === 'create') {
        const newPart = await createPart(companyId, payload);
        if (onSuccess) onSuccess(newPart);
        else router.push(`/dashboard/${companyId}/parts/${newPart.id}`);
      } else if (partId) {
        const updatedPart = await updatePart(partId, payload);
        if (onSuccess) onSuccess(updatedPart);
        else router.push(`/dashboard/${companyId}/parts/${partId}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!partId) return;

    setLoading(true);
    try {
      await deletePart(partId);
      if (onSuccess) onSuccess();
      else router.push(`/dashboard/${companyId}/parts`);
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
    if (onCancel) onCancel();
    else router.push(`/dashboard/${companyId}/parts`);
  };

  const canDelete = !part || ((part.quotes_count ?? 0) === 0 && (part.jobs_count ?? 0) === 0);

  const selectedVendor =
    vendors.find((v) => v.id === formData.preferred_vendor_id) || null;

  const currentKind = partKind({
    is_manufacturable: formData.is_manufacturable,
    is_stockable: formData.is_stockable,
  });

  const showInventorySection = formData.is_stockable;
  const showManufacturingSection = formData.is_manufacturable;
  const showUnitConversions = formData.is_stockable || formData.is_manufacturable;

  return (
    <Box component="form" onSubmit={handleSubmit}>
      {error && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {error}
        </Alert>
      )}

      {/* Classification + identification */}
      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          {!hideHeading && (
            <Typography variant="h6" gutterBottom sx={{ fontWeight: 600, mb: 3 }}>
              Part Details
            </Typography>
          )}

          {/* Classification toggles up top: drives every section below. */}
          <Box sx={{ mb: 3 }}>
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ mb: 1, fontWeight: 500 }}
            >
              Classification
            </Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="center">
              <FormControlLabel
                control={
                  <Switch
                    checked={formData.is_manufacturable}
                    onChange={handleClassificationChange('is_manufacturable')}
                    disabled={loading}
                    color="primary"
                  />
                }
                label="Manufacturable"
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={formData.is_stockable}
                    onChange={handleClassificationChange('is_stockable')}
                    disabled={loading}
                    color="success"
                  />
                }
                label="Stockable"
              />
              <Box sx={{ flex: 1 }} />
              <PartTypeChip kind={currentKind} />
            </Stack>
            {currentKind === 'unclassified' && (
              <Box
                sx={{
                  mt: 1.5,
                  display: 'flex',
                  gap: 1,
                  alignItems: 'center',
                  color: 'text.secondary',
                }}
              >
                <WarningAmberIcon fontSize="small" sx={{ color: 'warning.main' }} />
                <Typography variant="caption">
                  Unclassified parts won&apos;t appear in the Manufactured or Inventory views.
                </Typography>
              </Box>
            )}
          </Box>

          <Grid container spacing={3}>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                fullWidth
                required
                label="Part Name"
                value={formData.part_name}
                onChange={handleTextChange('part_name')}
                error={!!fieldErrors.part_name}
                helperText={fieldErrors.part_name || 'Name for this part (must be unique)'}
                disabled={loading}
              />
            </Grid>
            <Grid size={{ xs: 12 }}>
              <TextField
                fullWidth
                label="Description"
                value={formData.description}
                onChange={handleTextChange('description')}
                disabled={loading}
                multiline
                rows={2}
                placeholder="Brief description of this part"
              />
            </Grid>
          </Grid>
        </CardContent>
      </Card>

      {/* Inventory section: visible when is_stockable=true */}
      {showInventorySection && (
        <Card elevation={2} sx={{ mb: 3 }}>
          <CardContent>
            <Typography variant="h6" gutterBottom sx={{ fontWeight: 600, mb: 3 }}>
              Inventory
            </Typography>
            <Grid container spacing={3}>
              <Grid size={{ xs: 12, sm: 6 }}>
                <TextField
                  fullWidth
                  required
                  label="Primary Unit"
                  value={formData.primary_unit ?? ''}
                  onChange={(e) => {
                    setFormData((prev) => ({
                      ...prev,
                      primary_unit: e.target.value,
                    }));
                    if (fieldErrors.primary_unit) {
                      setFieldErrors((prev) => ({ ...prev, primary_unit: '' }));
                    }
                  }}
                  error={!!fieldErrors.primary_unit}
                  helperText={
                    fieldErrors.primary_unit ||
                    'e.g. each, ft, lb, in. Costs and quantities are denominated in this unit.'
                  }
                  disabled={loading}
                />
              </Grid>
              <Grid size={{ xs: 12, sm: 6 }}>
                <TextField
                  fullWidth
                  label="Quantity on Hand"
                  type="number"
                  value={formData.quantity ?? 0}
                  onChange={handleNumberChange('quantity')}
                  error={!!fieldErrors.quantity}
                  helperText={fieldErrors.quantity || 'Current stock in primary unit'}
                  disabled={loading}
                  inputProps={{ min: 0, step: 'any' }}
                />
              </Grid>
              <Grid size={{ xs: 12, sm: 6 }}>
                <TextField
                  fullWidth
                  label="Reorder Point"
                  type="number"
                  value={formData.reorder_point ?? ''}
                  onChange={handleNumberChange('reorder_point')}
                  error={!!fieldErrors.reorder_point}
                  helperText={
                    fieldErrors.reorder_point || 'Optional. Triggers low-stock alerts when reached.'
                  }
                  disabled={loading}
                  inputProps={{ min: 0, step: 'any' }}
                />
              </Grid>
              <Grid size={{ xs: 12, sm: 6 }}>
                <TextField
                  fullWidth
                  label="Procurement Cost per Unit"
                  type="number"
                  value={formData.cost_per_unit ?? ''}
                  onChange={handleNumberChange('cost_per_unit')}
                  error={!!fieldErrors.cost_per_unit}
                  helperText={
                    fieldErrors.cost_per_unit ||
                    'What you pay your supplier per primary unit'
                  }
                  disabled={loading}
                  inputProps={{ min: 0, step: '0.0001' }}
                  slotProps={{
                    input: {
                      startAdornment: <InputAdornment position="start">$</InputAdornment>,
                    },
                  }}
                />
              </Grid>
              <Grid size={{ xs: 12 }}>
                <Autocomplete
                  options={vendors}
                  getOptionLabel={(opt) => opt.name}
                  value={selectedVendor}
                  loading={vendorsLoading}
                  onChange={(_event, newValue) => {
                    setFormData((prev) => ({
                      ...prev,
                      preferred_vendor_id: newValue ? newValue.id : null,
                    }));
                  }}
                  disabled={loading}
                  isOptionEqualToValue={(opt, val) => opt.id === val.id}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label="Preferred Vendor"
                      helperText="Optional. The default supplier when restocking this part."
                      slotProps={{
                        input: {
                          ...params.InputProps,
                          endAdornment: (
                            <>
                              {vendorsLoading ? (
                                <CircularProgress color="inherit" size={20} />
                              ) : null}
                              {params.InputProps.endAdornment}
                            </>
                          ),
                        },
                      }}
                    />
                  )}
                />
              </Grid>
            </Grid>
          </CardContent>
        </Card>
      )}

      {/* Manufacturing section: visible when is_manufacturable=true */}
      {showManufacturingSection && (
        <Card elevation={2} sx={{ mb: 3 }}>
          <CardContent>
            <Typography variant="h6" gutterBottom sx={{ fontWeight: 600, mb: 3 }}>
              Manufacturing
            </Typography>
            <Grid container spacing={3}>
              <Grid size={{ xs: 12, sm: 6 }}>
                <TextField
                  fullWidth
                  label="Cost per Unit"
                  type="number"
                  value={formData.cost_per_unit ?? ''}
                  onChange={handleNumberChange('cost_per_unit')}
                  error={!!fieldErrors.cost_per_unit}
                  helperText={
                    fieldErrors.cost_per_unit ||
                    'Use the Recalculate Cost button on the part detail page after defining a routing.'
                  }
                  disabled={loading}
                  inputProps={{ min: 0, step: '0.0001' }}
                  slotProps={{
                    input: {
                      startAdornment: <InputAdornment position="start">$</InputAdornment>,
                    },
                  }}
                />
              </Grid>
            </Grid>
          </CardContent>
        </Card>
      )}

      {/* Unit conversions: shared between stockable + manufacturable contexts. */}
      {showUnitConversions && (
        <Card elevation={2} sx={{ mb: 3 }}>
          <CardContent>
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                mb: 2,
              }}
            >
              <Typography variant="h6" sx={{ fontWeight: 600 }}>
                Unit Conversions
              </Typography>
              <Button
                size="small"
                variant="outlined"
                startIcon={<AddIcon />}
                onClick={addConversion}
                disabled={loading}
              >
                Add conversion
              </Button>
            </Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {formData.primary_unit && formData.primary_unit.trim() ? (
                <>
                  Conversions to the primary unit{' '}
                  <Chip label={formData.primary_unit.trim()} size="small" />
                  . Example: 1 ft &rarr; 12 in.
                </>
              ) : (
                'Add a primary unit above first; conversion factors map alternate units back to it.'
              )}
            </Typography>

            {formData.unit_conversions.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
                No conversions yet. Add one above if this part is bought or used in
                multiple units.
              </Typography>
            ) : (
              <Stack spacing={1.5}>
                {formData.unit_conversions.map((uc, idx) => {
                  const errKey = `unit_conversions.${idx}`;
                  const rowError = fieldErrors[errKey];
                  return (
                    <Box
                      key={idx}
                      sx={{
                        display: 'flex',
                        gap: 1.5,
                        alignItems: 'flex-start',
                      }}
                    >
                      <TextField
                        size="small"
                        label="From unit"
                        value={uc.from_unit}
                        onChange={(e) =>
                          handleConversionChange(idx, 'from_unit', e.target.value)
                        }
                        error={!!rowError}
                        disabled={loading}
                        sx={{ flex: 1 }}
                        placeholder="e.g. ft"
                      />
                      <TextField
                        size="small"
                        label="Factor to primary"
                        type="number"
                        value={
                          Number.isFinite(uc.to_primary_factor)
                            ? uc.to_primary_factor
                            : ''
                        }
                        onChange={(e) =>
                          handleConversionChange(idx, 'to_primary_factor', e.target.value)
                        }
                        error={!!rowError}
                        helperText={rowError || ' '}
                        disabled={loading}
                        inputProps={{ min: 0.0000001, step: 'any' }}
                        sx={{ flex: 1 }}
                      />
                      <IconButton
                        aria-label="Remove conversion"
                        onClick={() => removeConversion(idx)}
                        disabled={loading}
                        sx={{ mt: 0.5 }}
                      >
                        <DeleteOutlineIcon />
                      </IconButton>
                    </Box>
                  );
                })}
              </Stack>
            )}
          </CardContent>
        </Card>
      )}

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

      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)}>
        <DialogTitle>Delete Part?</DialogTitle>
        <DialogContent>
          <Typography sx={{ mb: 2 }}>
            {`Are you sure you want to delete "${formData.part_name}"?`}
          </Typography>
          {part && ((part.quotes_count ?? 0) > 0 || (part.jobs_count ?? 0) > 0) && (
            <Alert severity="error">
              This part has {part.quotes_count ?? 0} quote{(part.quotes_count ?? 0) !== 1 ? 's' : ''} and{' '}
              {part.jobs_count ?? 0} job{(part.jobs_count ?? 0) !== 1 ? 's' : ''}. You must remove these
              references before deleting.
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleDelete} color="error" variant="contained" disabled={!canDelete}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>

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
