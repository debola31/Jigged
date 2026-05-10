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
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Autocomplete from '@mui/material/Autocomplete';
import BuildIcon from '@mui/icons-material/Build';
import LocalMallIcon from '@mui/icons-material/LocalMall';
import type { Part, PartFormData } from '@/types/part';
import {
  createPart,
  updatePart,
  deletePart,
  checkPartNameExists,
} from '@/utils/partsAccess';
import { getAllVendors } from '@/utils/vendorsAccess';
import type { Vendor } from '@/types/vendor';
import UnitOfMeasurementSelect from './UnitOfMeasurementSelect';
import { highContrastToggleSx } from '@/lib/highContrastToggleSx';

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

/**
 * Create / edit form for a Part.
 *
 * Layout: classification (Made/Bought + Stocked) sits at the top and
 * drives every conditional field below. UOM + Reorder Point appear when
 * is_stocked=true. Preferred Vendor appears when source='bought' (a
 * stocked sub-assembly is made in-shop, no vendor).
 *
 * What this form does NOT edit:
 *   - cost_per_unit. Made parts derive it from routing + BOM via
 *     recalculate_part_cost; bought parts get it from the Procurement
 *     Cost panel's tier sheets on the detail page. The form never writes
 *     this field (formDataToInsert strips it).
 *   - quantity. Only inventory_transactions ever changes the on-hand
 *     count, for audit-trail consistency.
 *   - Unit conversions. Managed inline on the Inventory panel of the
 *     detail page after the part exists.
 *
 * The Made/Bought toggle uses `highContrastToggleSx` (shared with the
 * work-center kind toggle) so the selected state pops on the dark theme
 * for shop-floor tablet use under bright lighting.
 */
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

  // Numeric handler for the form's remaining numeric field (reorder_point).
  // Empty input persists as null so the user can clear the threshold.
  const handleNumberChange =
    (field: 'reorder_point') =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value;
      const parsed: number | null =
        raw === '' ? null : Number.isFinite(Number(raw)) ? Number(raw) : null;
      setFormData((prev) => ({ ...prev, [field]: parsed }));
      if (fieldErrors[field]) {
        setFieldErrors((prev) => ({ ...prev, [field]: '' }));
      }
    };

  // ToggleButtonGroup for source. Null `next` happens when the user clicks
  // the already-selected button — ignore it (one of the two must always be
  // active).
  const handleSourceChange = (_e: unknown, next: 'made' | 'bought' | null) => {
    if (next === null) return;
    setFormData((prev) => ({ ...prev, source: next }));
  };

  const handleStockedChange = (_e: unknown, checked: boolean) => {
    setFormData((prev) => ({ ...prev, is_stocked: checked }));
    // Clear stocked-only validation if the user toggles off.
    if (!checked && fieldErrors.primary_unit) {
      setFieldErrors((prev) => ({ ...prev, primary_unit: '' }));
    }
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

    // DB CHECK: parts_stocked_requires_unit
    if (formData.is_stocked && !(formData.primary_unit && formData.primary_unit.trim())) {
      errors.primary_unit = 'Unit of measurement is required for stocked parts';
    }

    if (formData.reorder_point !== null && formData.reorder_point < 0) {
      errors.reorder_point = 'Reorder point cannot be negative';
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

    const payload: PartFormData = {
      ...formData,
      // Ensure null-vs-empty consistency for primary_unit on the way to the DB.
      primary_unit:
        formData.is_stocked && formData.primary_unit && formData.primary_unit.trim() !== ''
          ? formData.primary_unit.trim()
          : null,
      // `cost_per_unit` and `quantity` are stripped by formDataToInsert
      // before the DB write — cost is owned by recalculate_part_cost (made
      // parts) or the Procurement Cost panel's tier sheets (bought parts);
      // quantity only changes through inventory_transactions for audit. The
      // form never writes either, regardless of whatever value is in
      // formData.
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

  const showUomField = formData.is_stocked;
  // Preferred vendor is procurement-only — a stocked sub-assembly has no
  // vendor because you make it yourself. Gated on source, not on stocked.
  const showVendorPicker = formData.source === 'bought';

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

          {/* Classification: Made/Bought + Stocked. Drives every section
              below. */}
          <Box sx={{ mb: 3 }}>
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ mb: 1.5, fontWeight: 500 }}
            >
              Classification
            </Typography>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={2}
              alignItems={{ xs: 'flex-start', sm: 'center' }}
            >
              <ToggleButtonGroup
                value={formData.source}
                exclusive
                onChange={handleSourceChange}
                disabled={loading}
                aria-label="Source"
                color="primary"
                sx={highContrastToggleSx}
              >
                <ToggleButton value="made" aria-label="Made in-house">
                  <BuildIcon fontSize="small" sx={{ mr: 1 }} />
                  Made
                </ToggleButton>
                <ToggleButton value="bought" aria-label="Bought from vendor">
                  <LocalMallIcon fontSize="small" sx={{ mr: 1 }} />
                  Bought
                </ToggleButton>
              </ToggleButtonGroup>

              <FormControlLabel
                control={
                  <Switch
                    checked={formData.is_stocked}
                    onChange={handleStockedChange}
                    disabled={loading}
                    color="primary"
                  />
                }
                label="Stocked"
              />
            </Stack>
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

      {/* Stocked-only fields: UOM + reorder point. Quantity on hand is NOT
          edited here — it's managed through Add Stock / Remove Stock /
          Adjust on the part detail page so every change goes through
          inventory_transactions. UOM is the standard-units combobox (chunk
          14); unit conversions live on the part detail page, not here. */}
      {/* Inventory card combines stocking fields (UOM + reorder point) with
          the preferred vendor picker. UOM/reorder appear when is_stocked;
          vendor appears when source='bought' (a stocked sub-assembly is
          made in-shop and has no vendor). The card itself shows when at
          least one of those conditions is true. */}
      {(showUomField || showVendorPicker) && (
        <Card elevation={2} sx={{ mb: 3 }}>
          <CardContent>
            <Typography variant="h6" gutterBottom sx={{ fontWeight: 600, mb: 3 }}>
              Inventory
            </Typography>
            <Grid container spacing={3}>
              {showUomField && (
                <>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <UnitOfMeasurementSelect
                      value={formData.primary_unit}
                      onChange={(next) => {
                        setFormData((prev) => ({ ...prev, primary_unit: next }));
                        if (fieldErrors.primary_unit) {
                          setFieldErrors((prev) => ({ ...prev, primary_unit: '' }));
                        }
                      }}
                      companyId={companyId}
                      required
                      disabled={loading}
                      error={!!fieldErrors.primary_unit}
                      helperText={
                        fieldErrors.primary_unit ||
                        'Costs and quantities are denominated in this unit.'
                      }
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
                </>
              )}
              {showVendorPicker && (
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
                        helperText="Optional. The default supplier for this part."
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
              )}
            </Grid>
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
