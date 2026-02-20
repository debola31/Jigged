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
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import Grid from '@mui/material/Grid';
import type { Customer, CustomerFormData } from '@/types/customer';
import {
  createCustomer,
  updateCustomer,
  softDeleteCustomer,
  checkCustomerNameExists,
} from '@/utils/customerAccess';

interface CustomerFormProps {
  mode: 'create' | 'edit';
  initialData: CustomerFormData;
  customerId?: string;
  /** Optional: companyId override for modal usage */
  companyId?: string;
  /** Optional: Callback when customer is created/updated successfully (modal mode) */
  onSuccess?: (customer: Customer) => void;
  /** Optional: Callback when cancel is clicked (modal mode) */
  onCancel?: () => void;
}

export default function CustomerForm({
  mode,
  initialData,
  customerId,
  companyId: companyIdProp,
  onSuccess,
  onCancel,
}: CustomerFormProps) {
  const router = useRouter();
  const params = useParams();
  const companyId = companyIdProp || (params.companyId as string);

  const [formData, setFormData] = useState<CustomerFormData>(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const handleChange = (field: keyof CustomerFormData) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    setFormData((prev) => ({ ...prev, [field]: e.target.value }));
    // Clear field error when user starts typing
    if (fieldErrors[field]) {
      setFieldErrors((prev) => ({ ...prev, [field]: '' }));
    }
  };

  const validateForm = async (): Promise<boolean> => {
    const errors: Record<string, string> = {};

    // Required fields
    if (!formData.name.trim()) {
      errors.name = 'Company name is required';
    }

    // Email format
    if (formData.contact_email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.contact_email)) {
      errors.contact_email = 'Invalid email format';
    }

    // Check uniqueness of name
    if (formData.name.trim() && !errors.name) {
      try {
        const exists = await checkCustomerNameExists(
          companyId,
          formData.name,
          mode === 'edit' ? customerId : undefined
        );
        if (exists) {
          errors.name = 'A customer with this name already exists';
        }
      } catch {
        setError('Error validating customer name');
        return false;
      }
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation(); // Prevent bubbling to parent forms (e.g., QuoteForm)
    setError(null);

    const isValid = await validateForm();
    if (!isValid) return;

    setLoading(true);

    try {
      if (mode === 'create') {
        const customer = await createCustomer(companyId, formData);
        if (onSuccess) {
          onSuccess(customer);
        } else {
          router.push(`/dashboard/${companyId}/customers/${customer.id}`);
        }
      } else if (customerId) {
        const customer = await updateCustomer(customerId, formData);
        if (onSuccess) {
          onSuccess(customer);
        } else {
          router.push(`/dashboard/${companyId}/customers/${customerId}`);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!customerId) return;

    setLoading(true);
    try {
      await softDeleteCustomer(customerId);
      router.push(`/dashboard/${companyId}/customers`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
      setDeleteDialogOpen(false);
    }
  };

  const handleCancel = () => {
    if (onCancel) {
      onCancel();
    } else {
      router.push(`/dashboard/${companyId}/customers`);
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
            <Grid size={{ xs: 12, sm: 6, md: 4 }}>
              <TextField
                fullWidth
                required
                label="Company Name"
                value={formData.name}
                onChange={handleChange('name')}
                error={!!fieldErrors.name}
                helperText={fieldErrors.name || 'Unique customer name'}
                disabled={loading}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 4 }}>
              <TextField
                fullWidth
                label="Website"
                value={formData.website}
                onChange={handleChange('website')}
                disabled={loading}
                placeholder="https://example.com"
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
              />
            </Grid>
          </Grid>
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
        <DialogTitle>Delete Customer?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This will mark the customer as inactive. They will no longer appear in the active
            customer list, but their history will be preserved.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleDelete} color="error" variant="contained">
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
