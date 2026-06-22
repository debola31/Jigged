'use client';

import { useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import InputAdornment from '@mui/material/InputAdornment';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Grid from '@mui/material/Grid';
import FactoryIcon from '@mui/icons-material/Factory';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import type {
  WorkCenter,
  WorkCenterFormData,
  WorkCenterKind,
} from '@/types/workCenter';
import {
  createWorkCenter,
  updateWorkCenter,
  checkWorkCenterNameExists,
} from '@/utils/workCentersAccess';
import VendorAutocomplete from '@/components/vendors/VendorAutocomplete';
import { highContrastToggleSx } from '@/lib/highContrastToggleSx';
import { parseOptionalNumber } from '@/lib/validators';

interface WorkCenterFormProps {
  mode: 'create' | 'edit';
  initialData: WorkCenterFormData;
  workCenterId?: string;
  /** Optional: companyId override for modal usage */
  companyId?: string;
  /**
   * Number of routing operations referencing this work center (edit mode).
   * When > 0 the kind toggle is locked: pricing is read live from kind, so
   * flipping it would break the cost of every operation already using it.
   */
  routingOperationsCount?: number;
  /** Optional: Callback when work center is created/updated successfully */
  onSuccess?: (workCenter: WorkCenter) => void;
  /** Optional: Callback when cancel is clicked */
  onCancel?: () => void;
}

export default function WorkCenterForm({
  mode,
  initialData,
  workCenterId,
  companyId: companyIdProp,
  routingOperationsCount = 0,
  onSuccess,
  onCancel,
}: WorkCenterFormProps) {
  const router = useRouter();
  const params = useParams();
  const companyId = companyIdProp || (params.companyId as string);

  // Once a work center is used by routing operations, its kind is fixed:
  // costing reads kind live, so switching internal↔external would orphan the
  // pricing fields on every referencing operation (see Q1 in the PR).
  const kindLocked = mode === 'edit' && routingOperationsCount > 0;

  const [formData, setFormData] = useState<WorkCenterFormData>(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const handleTextChange = (field: keyof WorkCenterFormData) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    const value = e.target.value;
    setFormData((prev) => ({ ...prev, [field]: value }));
    if (fieldErrors[field]) {
      setFieldErrors((prev) => ({ ...prev, [field]: '' }));
    }
  };

  const handleKindChange = (
    _event: React.MouseEvent<HTMLElement>,
    newKind: WorkCenterKind | null,
  ) => {
    if (!newKind) return;
    setFormData((prev) => ({
      ...prev,
      kind: newKind,
      // Clear the field that no longer applies so we never submit an invalid combo.
      vendor_id: newKind === 'external' ? prev.vendor_id : null,
      labor_rate: newKind === 'internal' ? prev.labor_rate : '',
    }));
    setFieldErrors((prev) => ({ ...prev, vendor_id: '', labor_rate: '' }));
  };

  const validateForm = async (): Promise<boolean> => {
    const errors: Record<string, string> = {};

    if (!formData.name.trim()) {
      errors.name = 'Name is required';
    }

    // The DB CHECK constraint enforces this — we surface a clear error pre-submit
    // so the user isn't met with a raw Postgres "violates check constraint" dump.
    if (formData.kind === 'external' && !formData.vendor_id) {
      errors.vendor_id = 'Vendor is required for external work centers';
    }

    // Labor rate is required for internal work centers: an internal routing
    // operation with no rate (and no per-op override) cannot be priced — the
    // cost function raises and the part shows as unpriceable. Requiring it here
    // stops that bad state at the source. (External WCs price per operation, so
    // labor_rate stays hidden/empty for them.)
    if (formData.kind === 'internal') {
      if (!formData.labor_rate.trim()) {
        errors.labor_rate = 'Labor rate is required for internal work centers';
      } else {
        const rate = parseOptionalNumber(formData.labor_rate);
        if (rate === null || rate < 0) {
          errors.labor_rate = 'Labor rate must be a non-negative number';
        }
      }
    }

    if (formData.name.trim() && !errors.name) {
      try {
        const exists = await checkWorkCenterNameExists(
          companyId,
          formData.name,
          mode === 'edit' ? workCenterId : undefined,
        );
        if (exists) {
          errors.name = 'A work center with this name already exists';
        }
      } catch {
        setError('Error validating work center name');
        return false;
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
      // Defensive normalization: when kind='external' the form already hides
      // labor_rate and `handleKindChange` clears it on switch — but if the
      // submit ever runs with stale formData (e.g. someone wires a new code
      // path that doesn't go through the toggle handler), force null here so
      // we never persist a labor rate to an outsourced work center.
      const submitData: WorkCenterFormData =
        formData.kind === 'external'
          ? { ...formData, labor_rate: '' }
          : formData;

      if (mode === 'create') {
        const wc = await createWorkCenter(companyId, submitData);
        if (onSuccess) {
          onSuccess(wc);
        } else {
          router.push(`/dashboard/${companyId}/work-centers/${wc.id}`);
        }
      } else if (workCenterId) {
        const wc = await updateWorkCenter(workCenterId, submitData);
        if (onSuccess) {
          onSuccess(wc);
        } else {
          router.push(`/dashboard/${companyId}/work-centers/${workCenterId}`);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    if (onCancel) {
      onCancel();
    } else if (mode === 'edit' && workCenterId) {
      router.push(`/dashboard/${companyId}/work-centers/${workCenterId}`);
    } else {
      router.push(`/dashboard/${companyId}/work-centers`);
    }
  };

  return (
    <Box component="form" onSubmit={handleSubmit}>
      {error && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {error}
        </Alert>
      )}

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
                label="Name"
                value={formData.name}
                onChange={handleTextChange('name')}
                error={!!fieldErrors.name}
                helperText={
                  fieldErrors.name ||
                  'e.g. "HURCO Mill", "Mazak Lathe", "PerformCoat"'
                }
                disabled={loading}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <Box>
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ mb: 1, fontWeight: 500 }}
                >
                  Kind
                </Typography>
                <ToggleButtonGroup
                  value={formData.kind}
                  exclusive
                  onChange={handleKindChange}
                  disabled={loading || kindLocked}
                  fullWidth
                  color="primary"
                  size="medium"
                  sx={highContrastToggleSx}
                >
                  <ToggleButton value="internal" sx={{ gap: 1 }}>
                    <FactoryIcon fontSize="small" />
                    Internal
                  </ToggleButton>
                  <ToggleButton value="external" sx={{ gap: 1 }}>
                    <LocalShippingIcon fontSize="small" />
                    External
                  </ToggleButton>
                </ToggleButtonGroup>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ mt: 0.5, display: 'block' }}
                >
                  {kindLocked
                    ? `Locked — used by ${routingOperationsCount} routing operation${
                        routingOperationsCount === 1 ? '' : 's'
                      }. Changing the kind would break their pricing.`
                    : formData.kind === 'internal'
                      ? 'Runs in your shop. Has a labor rate.'
                      : 'Performed by an outside vendor.'}
                </Typography>
              </Box>
            </Grid>

            {/* Kind-conditional fields: only one of these is valid at a time per the DB CHECK constraint.
                External work centers price per routing operation (external_unit_price +
                external_setup_cost), so labor_rate is hidden entirely — see hint below. */}
            {formData.kind === 'internal' && (
              <Grid size={{ xs: 12, sm: 6 }}>
                <TextField
                  fullWidth
                  required
                  label="Labor Rate"
                  value={formData.labor_rate}
                  onChange={handleTextChange('labor_rate')}
                  error={!!fieldErrors.labor_rate}
                  helperText={fieldErrors.labor_rate || 'Hourly rate in dollars. Required for quoting.'}
                  disabled={loading}
                  type="number"
                  inputProps={{ min: 0, step: '0.01', inputMode: 'decimal' }}
                  slotProps={{
                    input: {
                      startAdornment: <InputAdornment position="start">$</InputAdornment>,
                      endAdornment: <InputAdornment position="end">/hr</InputAdornment>,
                    },
                  }}
                />
              </Grid>
            )}

            {formData.kind === 'external' && (
              <Grid size={{ xs: 12 }}>
                <Alert
                  severity="info"
                  icon={<InfoOutlinedIcon />}
                  sx={{ alignItems: 'flex-start' }}
                >
                  <Typography variant="body2" sx={{ fontWeight: 500, mb: 0.5 }}>
                    External work centers price per routing operation
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Set <strong>external_unit_price</strong> and{' '}
                    <strong>external_setup_cost</strong> on each routing operation
                    that uses this work center, not on the work center itself.
                  </Typography>
                </Alert>
              </Grid>
            )}

            {formData.kind === 'external' && (
              <Grid size={{ xs: 12, sm: 6 }}>
                <VendorAutocomplete
                  companyId={companyId}
                  valueId={formData.vendor_id}
                  onChange={(vendor) => {
                    setFormData((prev) => ({
                      ...prev,
                      vendor_id: vendor ? vendor.id : null,
                    }));
                    if (fieldErrors.vendor_id) {
                      setFieldErrors((prev) => ({ ...prev, vendor_id: '' }));
                    }
                  }}
                  disabled={loading}
                  required
                  label="Vendor"
                  error={!!fieldErrors.vendor_id}
                  helperText={
                    fieldErrors.vendor_id || 'Vendor performing this outside operation'
                  }
                />
              </Grid>
            )}

            <Grid size={{ xs: 12 }}>
              <TextField
                fullWidth
                label="Description"
                value={formData.description}
                onChange={handleTextChange('description')}
                disabled={loading}
                multiline
                minRows={3}
                placeholder="Optional notes about this work center"
              />
            </Grid>
          </Grid>
        </CardContent>
      </Card>

      <Box sx={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>
        <Button variant="outlined" onClick={handleCancel} disabled={loading}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="contained"
          disabled={loading}
          startIcon={loading ? <CircularProgress size={20} /> : null}
        >
          {loading
            ? 'Saving...'
            : mode === 'create'
              ? 'Create Work Center'
              : 'Save Changes'}
        </Button>
      </Box>
    </Box>
  );
}
