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
import Grid from '@mui/material/Grid';
import type { Vendor, VendorFormData } from '@/types/vendor';
import {
  createVendor,
  updateVendor,
  checkVendorNameExists,
} from '@/utils/vendorsAccess';

interface VendorFormProps {
  mode: 'create' | 'edit';
  initialData: VendorFormData;
  vendorId?: string;
  /** Optional: companyId override for modal usage */
  companyId?: string;
  /** Optional: Callback when vendor is created/updated successfully */
  onSuccess?: (vendor: Vendor) => void;
  /** Optional: Callback when cancel is clicked */
  onCancel?: () => void;
}

/**
 * Vendor form for create + edit. Mirrors WorkCenterForm and CustomerForm in
 * structure (Basic / Contact / Address / Notes cards).
 *
 * Intentionally has NO capability checkboxes ("supplies materials" / "performs
 * outside operations"). What a vendor does is derived from references:
 *   - parts.preferred_vendor_id → "supplies materials"
 *   - work_centers.vendor_id    → "performs outside operations"
 * Storing capability flags here would be a second source of truth and could
 * silently diverge from reality.
 */
export default function VendorForm({
  mode,
  initialData,
  vendorId,
  companyId: companyIdProp,
  onSuccess,
  onCancel,
}: VendorFormProps) {
  const router = useRouter();
  const params = useParams();
  const companyId = companyIdProp || (params.companyId as string);

  const [formData, setFormData] = useState<VendorFormData>(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const handleChange =
    (field: keyof VendorFormData) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setFormData((prev) => ({ ...prev, [field]: e.target.value }));
      if (fieldErrors[field]) {
        setFieldErrors((prev) => ({ ...prev, [field]: '' }));
      }
    };

  const validateForm = async (): Promise<boolean> => {
    const errors: Record<string, string> = {};

    if (!formData.name.trim()) {
      errors.name = 'Vendor name is required';
    }

    if (
      formData.contact_email.trim() &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.contact_email)
    ) {
      errors.contact_email = 'Invalid email format';
    }

    if (formData.name.trim() && !errors.name) {
      try {
        const exists = await checkVendorNameExists(
          companyId,
          formData.name,
          mode === 'edit' ? vendorId : undefined,
        );
        if (exists) {
          errors.name = 'A vendor with this name already exists';
        }
      } catch {
        setError('Error validating vendor name');
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
      if (mode === 'create') {
        const vendor = await createVendor(companyId, formData);
        if (onSuccess) {
          onSuccess(vendor);
        } else {
          router.push(`/dashboard/${companyId}/vendors/${vendor.id}`);
        }
      } else if (vendorId) {
        const vendor = await updateVendor(vendorId, formData);
        if (onSuccess) {
          onSuccess(vendor);
        } else {
          router.push(`/dashboard/${companyId}/vendors/${vendorId}`);
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
    } else if (mode === 'edit' && vendorId) {
      router.push(`/dashboard/${companyId}/vendors/${vendorId}`);
    } else {
      router.push(`/dashboard/${companyId}/vendors`);
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
                label="Vendor Name"
                value={formData.name}
                onChange={handleChange('name')}
                error={!!fieldErrors.name}
                helperText={
                  fieldErrors.name ||
                  'Unique vendor name (e.g. "PerformCoat of Michigan LLC")'
                }
                disabled={loading}
              />
            </Grid>
          </Grid>
        </CardContent>
      </Card>

      {/* Primary Contact */}
      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom sx={{ fontWeight: 600, mb: 3 }}>
            Primary Contact
          </Typography>
          <Grid container spacing={3}>
            <Grid size={{ xs: 12, sm: 6, md: 4 }}>
              <TextField
                fullWidth
                label="Contact Name"
                value={formData.contact_name}
                onChange={handleChange('contact_name')}
                disabled={loading}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 4 }}>
              <TextField
                fullWidth
                label="Contact Phone"
                value={formData.contact_phone}
                onChange={handleChange('contact_phone')}
                disabled={loading}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 4 }}>
              <TextField
                fullWidth
                label="Contact Email"
                type="email"
                value={formData.contact_email}
                onChange={handleChange('contact_email')}
                error={!!fieldErrors.contact_email}
                helperText={fieldErrors.contact_email}
                disabled={loading}
              />
            </Grid>
          </Grid>
        </CardContent>
      </Card>

      {/* Address */}
      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom sx={{ fontWeight: 600, mb: 3 }}>
            Address
          </Typography>
          <Grid container spacing={3}>
            <Grid size={{ xs: 12 }}>
              <TextField
                fullWidth
                label="Address Line 1"
                value={formData.address_line1}
                onChange={handleChange('address_line1')}
                disabled={loading}
              />
            </Grid>
            <Grid size={{ xs: 12 }}>
              <TextField
                fullWidth
                label="Address Line 2"
                value={formData.address_line2}
                onChange={handleChange('address_line2')}
                disabled={loading}
                placeholder="Suite, unit, etc."
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <TextField
                fullWidth
                label="City"
                value={formData.city}
                onChange={handleChange('city')}
                disabled={loading}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <TextField
                fullWidth
                label="State"
                value={formData.state}
                onChange={handleChange('state')}
                disabled={loading}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <TextField
                fullWidth
                label="Postal Code"
                value={formData.postal_code}
                onChange={handleChange('postal_code')}
                disabled={loading}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <TextField
                fullWidth
                label="Country"
                value={formData.country}
                onChange={handleChange('country')}
                disabled={loading}
                placeholder="USA"
              />
            </Grid>
          </Grid>
        </CardContent>
      </Card>

      {/* Notes */}
      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom sx={{ fontWeight: 600, mb: 3 }}>
            Notes
          </Typography>
          <TextField
            fullWidth
            label="Internal Notes"
            value={formData.notes}
            onChange={handleChange('notes')}
            disabled={loading}
            multiline
            minRows={3}
            placeholder="Optional internal notes about this vendor"
          />
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
              ? 'Create Vendor'
              : 'Save Changes'}
        </Button>
      </Box>
    </Box>
  );
}
