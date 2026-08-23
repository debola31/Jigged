'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import InputAdornment from '@mui/material/InputAdornment';
import Grid from '@mui/material/Grid';
import ErrorAlert from '@/components/common/ErrorAlert';

import type { VendorService, VendorServiceFormData } from '@/types/vendorService';
import {
  createVendorService,
  updateVendorService,
  checkVendorServiceNameExists,
} from '@/utils/vendorServicesAccess';
import { parseOptionalNumber } from '@/lib/validators';
import posthog from 'posthog-js';

interface VendorServiceFormProps {
  mode: 'create' | 'edit';
  companyId: string;
  vendorId: string;
  vendorName: string;
  /** Edit mode only. */
  serviceId?: string;
  initialData: VendorServiceFormData;
  onSuccess?: (service: VendorService) => void;
  onCancel?: () => void;
}

/**
 * Create / edit one of a vendor's services.
 *
 * A page, not a modal, matching `WorkCenterForm` and `VendorForm`.
 *
 * **There is no vendor field, and that absence is the rehome.** You no longer
 * pick a vendor from a list the way the old external-work-centre form made you;
 * you are standing on one. The old form's `VendorAutocomplete` is what this
 * screen exists to delete.
 */
export default function VendorServiceForm({
  mode,
  companyId,
  vendorId,
  vendorName,
  serviceId,
  initialData,
  onSuccess,
  onCancel,
}: VendorServiceFormProps) {
  const router = useRouter();

  const [formData, setFormData] = useState<VendorServiceFormData>(initialData);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleTextChange =
    (field: keyof VendorServiceFormData) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const { value } = e.target;
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

    // Price is OPTIONAL. A shop often adds the service before it has agreed a
    // price, and blocking that would push them back to leaving the process
    // unnamed. An unpriced service surfaces as "Not set" and makes any part
    // routed through it unpriceable, which is the honest state.
    if (formData.unit_price.trim()) {
      const price = parseOptionalNumber(formData.unit_price);
      if (price === null || price < 0) {
        errors.unit_price = 'Price must be a non-negative number';
      }
    }

    if (formData.name.trim() && !errors.name) {
      try {
        const exists = await checkVendorServiceNameExists(
          vendorId,
          formData.name,
          mode === 'edit' ? serviceId : undefined,
        );
        if (exists) {
          errors.name = `${vendorName} already has a service called "${formData.name.trim()}".`;
        }
      } catch {
        setError('Error validating the service name');
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

    if (!(await validateForm())) return;

    setLoading(true);
    try {
      const service =
        mode === 'create'
          ? await createVendorService(companyId, vendorId, formData)
          : await updateVendorService(serviceId as string, formData);

      if (mode === 'create') {
        // Shape of the interaction, never the customer's business data: whether
        // a price was set, not what it is or whose it is.
        posthog.capture('vendor service created', {
          has_price: formData.unit_price.trim().length > 0,
        });
      }

      if (onSuccess) {
        onSuccess(service);
      } else {
        router.push(`/dashboard/${companyId}/vendors/${vendorId}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box component="form" onSubmit={handleSubmit} noValidate>
      {error && <ErrorAlert error={error} entity="service" />}

      <Card elevation={2}>
        <CardContent>
          <Typography variant="h6" sx={{ mb: 0.5 }}>
            {mode === 'create' ? 'Add a service' : 'Edit service'}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Performed by {vendorName}.
          </Typography>

          <Grid container spacing={3}>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                fullWidth
                required
                autoFocus={mode === 'create'}
                label="Service"
                placeholder="Anodize"
                value={formData.name}
                onChange={handleTextChange('name')}
                error={!!fieldErrors.name}
                helperText={fieldErrors.name || 'What this vendor does to your parts.'}
                disabled={loading}
                slotProps={{ inputLabel: { shrink: true } }}
              />
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                fullWidth
                label="Price per piece"
                value={formData.unit_price}
                onChange={handleTextChange('unit_price')}
                error={!!fieldErrors.unit_price}
                helperText={
                  fieldErrors.unit_price ||
                  'Used on every routing step for this service. You can change it on any step.'
                }
                disabled={loading}
                type="number"
                inputProps={{ min: 0, step: '0.01', inputMode: 'decimal' }}
                slotProps={{
                  inputLabel: { shrink: true },
                  input: {
                    startAdornment: <InputAdornment position="start">$</InputAdornment>,
                    endAdornment: <InputAdornment position="end">/pc</InputAdornment>,
                  },
                }}
              />
            </Grid>

            <Grid size={{ xs: 12 }}>
              <TextField
                fullWidth
                multiline
                minRows={3}
                label="Notes for whoever ships it"
                value={formData.description}
                onChange={handleTextChange('description')}
                helperText="Spec or callout, packaging, anything the person boxing these parts needs to know."
                disabled={loading}
                slotProps={{ inputLabel: { shrink: true } }}
              />
            </Grid>
          </Grid>

          <Box sx={{ display: 'flex', gap: 2, mt: 4, justifyContent: 'flex-end' }}>
            <Button
              onClick={
                onCancel ?? (() => router.push(`/dashboard/${companyId}/vendors/${vendorId}`))
              }
              disabled={loading}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="contained"
              disabled={loading}
              startIcon={loading ? <CircularProgress size={18} color="inherit" /> : undefined}
            >
              Save service
            </Button>
          </Box>
        </CardContent>
      </Card>
    </Box>
  );
}
