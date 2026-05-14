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
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import Radio from '@mui/material/Radio';
import IconButton from '@mui/material/IconButton';
import Divider from '@mui/material/Divider';
import Tooltip from '@mui/material/Tooltip';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import type {
  Customer,
  CustomerAddressFormData,
  CustomerFormData,
} from '@/types/customer';
import { EMPTY_CUSTOMER_ADDRESS } from '@/types/customer';
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

  /**
   * Handle text-input changes for the top-level customer fields. Address
   * fields use updateAddress() instead since they live in a nested array.
   */
  const handleChange = (
    field: 'name' | 'website' | 'contact_name' | 'contact_phone' | 'contact_email'
  ) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    setFormData((prev) => ({ ...prev, [field]: e.target.value }));
    if (fieldErrors[field]) {
      setFieldErrors((prev) => ({ ...prev, [field]: '' }));
    }
  };

  /**
   * Patch a single field on a single address row.
   *
   * Special-case behavior:
   *   - Toggling is_default_billing on an address clears it on all other
   *     addresses (radio semantics across the list).
   *   - Same for is_default_shipping.
   *   - Turning off "Billing" automatically turns off "Default billing"
   *     for that row, since the constraint says a default-billing address
   *     must be a billing address.
   */
  const updateAddress = (
    index: number,
    patch: Partial<CustomerAddressFormData>,
  ) => {
    setFormData((prev) => {
      const next = prev.addresses.map((addr, i) => {
        if (i !== index) {
          // Other rows: clear their default flag if THIS row is becoming the default.
          const updates: Partial<CustomerAddressFormData> = {};
          if (patch.is_default_billing === true) updates.is_default_billing = false;
          if (patch.is_default_shipping === true) updates.is_default_shipping = false;
          return Object.keys(updates).length > 0 ? { ...addr, ...updates } : addr;
        }
        const merged = { ...addr, ...patch };
        // If we just turned off the role, also clear its default flag.
        if (patch.is_billing === false) merged.is_default_billing = false;
        if (patch.is_shipping === false) merged.is_default_shipping = false;
        return merged;
      });
      return { ...prev, addresses: next };
    });
    if (fieldErrors.addresses) {
      setFieldErrors((prev) => ({ ...prev, addresses: '' }));
    }
  };

  const addAddress = () => {
    setFormData((prev) => ({
      ...prev,
      addresses: [
        ...prev.addresses,
        // New row: tagged for both roles, but not default for either —
        // first-default-wins keeps the existing primary intact.
        {
          ...EMPTY_CUSTOMER_ADDRESS,
          is_default_billing: false,
          is_default_shipping: false,
        },
      ],
    }));
  };

  const removeAddress = (index: number) => {
    setFormData((prev) => {
      const removed = prev.addresses[index];
      const remaining = prev.addresses.filter((_, i) => i !== index);
      // If we removed the default-billing/shipping row, promote the first
      // eligible remaining row so the customer is never left without a
      // default billing address (which would break quote generation).
      if (removed?.is_default_billing) {
        const promote = remaining.find((a) => a.is_billing);
        if (promote) promote.is_default_billing = true;
      }
      if (removed?.is_default_shipping) {
        const promote = remaining.find((a) => a.is_shipping);
        if (promote) promote.is_default_shipping = true;
      }
      return { ...prev, addresses: remaining };
    });
  };

  const validateForm = async (): Promise<boolean> => {
    const errors: Record<string, string> = {};

    if (!formData.name.trim()) {
      errors.name = 'Company name is required';
    }

    if (formData.contact_email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.contact_email)) {
      errors.contact_email = 'Invalid email format';
    }

    // Address-set validation. Customers need at least one address tagged
    // as billing AND marked as the default billing address, or the quote
    // PDF will render a blank BILL TO block.
    if (formData.addresses.length === 0) {
      errors.addresses = 'At least one address is required';
    } else {
      const anyRoleMissing = formData.addresses.some(
        (a) => !a.is_billing && !a.is_shipping,
      );
      if (anyRoleMissing) {
        errors.addresses = 'Every address must be used for billing, shipping, or both';
      } else if (!formData.addresses.some((a) => a.is_default_billing)) {
        errors.addresses = 'Pick a default billing address';
      }
    }

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

      {/* Addresses — multiple per customer, each tagged billing/shipping */}
      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', mb: 3 }}>
            <Typography variant="h6" sx={{ fontWeight: 600, flex: 1 }}>
              Addresses
            </Typography>
            <Button
              variant="outlined"
              size="small"
              startIcon={<AddIcon />}
              onClick={addAddress}
              disabled={loading}
            >
              Add address
            </Button>
          </Box>

          {fieldErrors.addresses && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {fieldErrors.addresses}
            </Alert>
          )}

          {formData.addresses.map((addr, idx) => (
            <Box
              key={addr.id ?? `new-${idx}`}
              sx={{
                p: 2,
                mb: 2,
                border: 1,
                borderColor: 'divider',
                borderRadius: 1,
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
                <TextField
                  size="small"
                  label="Label"
                  placeholder="HQ / Warehouse / etc."
                  value={addr.label}
                  onChange={(e) => updateAddress(idx, { label: e.target.value })}
                  disabled={loading}
                  sx={{ flex: 1, maxWidth: 300 }}
                />
                <Box sx={{ flex: 1 }} />
                {formData.addresses.length > 1 && (
                  <Tooltip title="Remove this address">
                    <IconButton
                      onClick={() => removeAddress(idx)}
                      disabled={loading}
                      size="small"
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
              </Box>

              <Grid container spacing={2}>
                <Grid size={{ xs: 12 }}>
                  <TextField
                    fullWidth
                    label="Address Line 1"
                    value={addr.address_line1}
                    onChange={(e) =>
                      updateAddress(idx, { address_line1: e.target.value })
                    }
                    disabled={loading}
                  />
                </Grid>
                <Grid size={{ xs: 12 }}>
                  <TextField
                    fullWidth
                    label="Address Line 2"
                    value={addr.address_line2}
                    onChange={(e) =>
                      updateAddress(idx, { address_line2: e.target.value })
                    }
                    disabled={loading}
                    placeholder="Suite, unit, etc."
                  />
                </Grid>
                <Grid size={{ xs: 12, sm: 6, md: 3 }}>
                  <TextField
                    fullWidth
                    label="City"
                    value={addr.city}
                    onChange={(e) => updateAddress(idx, { city: e.target.value })}
                    disabled={loading}
                  />
                </Grid>
                <Grid size={{ xs: 12, sm: 6, md: 3 }}>
                  <TextField
                    fullWidth
                    label="State"
                    value={addr.state}
                    onChange={(e) => updateAddress(idx, { state: e.target.value })}
                    disabled={loading}
                  />
                </Grid>
                <Grid size={{ xs: 12, sm: 6, md: 3 }}>
                  <TextField
                    fullWidth
                    label="Postal Code"
                    value={addr.postal_code}
                    onChange={(e) =>
                      updateAddress(idx, { postal_code: e.target.value })
                    }
                    disabled={loading}
                  />
                </Grid>
                <Grid size={{ xs: 12, sm: 6, md: 3 }}>
                  <TextField
                    fullWidth
                    label="Country"
                    value={addr.country}
                    onChange={(e) =>
                      updateAddress(idx, { country: e.target.value })
                    }
                    disabled={loading}
                  />
                </Grid>
              </Grid>

              <Divider sx={{ my: 2 }} />

              <Box
                sx={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: 3,
                }}
              >
                <Typography variant="body2" color="text.secondary">
                  Used for:
                </Typography>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={addr.is_billing}
                      onChange={(e) =>
                        updateAddress(idx, { is_billing: e.target.checked })
                      }
                      disabled={loading}
                    />
                  }
                  label="Billing"
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={addr.is_shipping}
                      onChange={(e) =>
                        updateAddress(idx, { is_shipping: e.target.checked })
                      }
                      disabled={loading}
                    />
                  }
                  label="Shipping"
                />

                <Box sx={{ flex: 1 }} />

                <FormControlLabel
                  control={
                    <Radio
                      checked={addr.is_default_billing}
                      onChange={() =>
                        updateAddress(idx, { is_default_billing: true })
                      }
                      disabled={loading || !addr.is_billing}
                    />
                  }
                  label="Default billing"
                />
                <FormControlLabel
                  control={
                    <Radio
                      checked={addr.is_default_shipping}
                      onChange={() =>
                        updateAddress(idx, { is_default_shipping: true })
                      }
                      disabled={loading || !addr.is_shipping}
                    />
                  }
                  label="Default shipping"
                />
              </Box>
            </Box>
          ))}

          {formData.addresses.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
              No addresses yet — click "Add address" to add one.
            </Typography>
          )}
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
