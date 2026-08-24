'use client';

import { useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import ErrorAlert from '@/components/common/ErrorAlert';
import CircularProgress from '@mui/material/CircularProgress';
import InputAdornment from '@mui/material/InputAdornment';
import Grid from '@mui/material/Grid';
import type { WorkCenter, WorkCenterFormData } from '@/types/workCenter';
import {
  createWorkCenter,
  updateWorkCenter,
  checkWorkCenterNameExists,
} from '@/utils/workCentersAccess';
import { parseOptionalNumber } from '@/lib/validators';

interface WorkCenterFormProps {
  mode: 'create' | 'edit';
  initialData: WorkCenterFormData;
  workCenterId?: string;
  /** Optional: companyId override for modal usage */
  companyId?: string;
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
  onSuccess,
  onCancel,
}: WorkCenterFormProps) {
  const router = useRouter();
  const params = useParams();
  const companyId = companyIdProp || (params.companyId as string);

  const [formData, setFormData] = useState<WorkCenterFormData>(initialData);
  const [loading, setLoading] = useState(false);
  // Holds the caught error, not a formatted string — ErrorAlert needs the object to tell
  // a billing block from an ordinary failure.
  const [error, setError] = useState<unknown>(null);
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

  const validateForm = async (): Promise<boolean> => {
    const errors: Record<string, string> = {};

    if (!formData.name.trim()) {
      errors.name = 'Name is required';
    }

    // Labor rate is now unconditionally required: every row in this table is an
    // in-house station, and a routing operation with no rate (and no per-op
    // override) cannot be priced — the cost function raises and the part shows
    // as unpriceable. Requiring it here stops that bad state at the source.
    if (!formData.labor_rate.trim()) {
      errors.labor_rate = 'Labor rate is required';
    } else {
      const rate = parseOptionalNumber(formData.labor_rate);
      if (rate === null || rate < 0) {
        errors.labor_rate = 'Labor rate must be a non-negative number';
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
      const submitData: WorkCenterFormData = formData;

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
      setError(err);
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
      {error != null && (
        <ErrorAlert
          error={error}
          entity="work center"
          fallback="Couldn't save this work center. Please try again."
          sx={{ mb: 3 }}
        />
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
                helperText={fieldErrors.name || ' '}
                disabled={loading}
              />
            </Grid>
            {/* The Internal/External toggle and its vendor picker are gone.
                Every row here is an in-house station, so labor rate is
                unconditional rather than one arm of a kind branch. An
                outsourced process is set up on the vendor that performs it. */}
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
                  inputLabel: { shrink: true },
                  input: {
                    startAdornment: <InputAdornment position="start">$</InputAdornment>,
                    endAdornment: <InputAdornment position="end">/hr</InputAdornment>,
                  },
                }}
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
                minRows={3}
                placeholder="Optional notes about this work center"
              />
            </Grid>
          </Grid>
        </CardContent>
      </Card>

      {/* Machine details.

          Withdrawn: "for internal work centers only — an outside vendor's process has no serial
          number." True as intent, never true as code: this card was gated on the
          `machine_maintenance` flag alone and never on `work_centers.kind`, and that column was
          dropped in the vendor-services split. An outside process is a `vendor_services` row now,
          so it does not reach this form at all and needs no condition here.

          EVERY FIELD IS OPTIONAL AND NOTHING VALIDATES THEM. There is no "you
          should fill this in", no completeness indicator, and no consequence for
          leaving the whole card empty. Asset data entry is a leading cause of
          CMMS abandonment: the tool arrives, the shop is asked to describe its
          equipment before it can do anything, and the project dies in the
          describing. The machines are already in Jigged as work centers, so the
          maintenance module starts with a complete asset list and an empty asset
          detail — which is the right way round.

          It lives here, in the office, rather than on the floor: somebody with a
          spec sheet in front of them is doing paperwork on purpose. */}
      <Card elevation={2} sx={{ mt: 3 }}>
        <CardContent>
          <Typography variant="h6" sx={{ mb: 0.5 }}>
            Machine details
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            All optional. Nothing depends on them.
          </Typography>
          <Grid container spacing={3}>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                fullWidth
                label="Make"
                value={formData.make}
                onChange={handleTextChange('make')}
                disabled={loading}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                fullWidth
                label="Model"
                value={formData.model}
                onChange={handleTextChange('model')}
                disabled={loading}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                fullWidth
                label="Serial number"
                value={formData.serial_number}
                onChange={handleTextChange('serial_number')}
                disabled={loading}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 3 }}>
              <TextField
                fullWidth
                label="Year"
                type="number"
                value={formData.year_built}
                onChange={handleTextChange('year_built')}
                disabled={loading}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 3 }}>
              <TextField
                fullWidth
                label="Purchased"
                type="date"
                value={formData.purchased_on}
                onChange={handleTextChange('purchased_on')}
                disabled={loading}
                slotProps={{ inputLabel: { shrink: true } }}
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
