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

  // Normalize the incoming addresses so at most one row is_billing=true and
  // at most one row is_shipping=true. Defensive against pre-existing data
  // that pre-dates the unique partial indexes (or that came in from a
  // different code path that didn't enforce single-select). Keeps the *first*
  // occurrence — picks deterministically rather than silently losing data.
  const [formData, setFormData] = useState<CustomerFormData>(() => {
    let billingSeen = false;
    let shippingSeen = false;
    const addresses = initialData.addresses.map((a) => {
      const next = { ...a };
      if (next.is_billing) {
        if (billingSeen) next.is_billing = false;
        else billingSeen = true;
      }
      if (next.is_shipping) {
        if (shippingSeen) next.is_shipping = false;
        else shippingSeen = true;
      }
      return next;
    });
    return { ...initialData, addresses };
  });
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
   * Special-case behavior — "Used for: Billing" and "Used for: Shipping"
   * are single-select across the address list. Tagging this row as
   * billing/shipping clears the same flag on every other row, so the DB
   * invariant ("at most one billing, at most one shipping per customer")
   * is maintained by the UI before we ever try to insert.
   */
  const updateAddress = (
    index: number,
    patch: Partial<CustomerAddressFormData>,
  ) => {
    setFormData((prev) => {
      const next = prev.addresses.map((addr, i) => {
        if (i !== index) {
          const updates: Partial<CustomerAddressFormData> = {};
          if (patch.is_billing === true) updates.is_billing = false;
          if (patch.is_shipping === true) updates.is_shipping = false;
          return Object.keys(updates).length > 0 ? { ...addr, ...updates } : addr;
        }
        return { ...addr, ...patch };
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
        // New rows start un-tagged so they don't steal the billing/shipping
        // role from the existing primary address. The user opts in by
        // checking "Used for: Billing" or "Used for: Shipping" on the new
        // row, which automatically clears the flag on the previous one.
        {
          ...EMPTY_CUSTOMER_ADDRESS,
          is_billing: false,
          is_shipping: false,
        },
      ],
    }));
  };

  const removeAddress = (index: number) => {
    setFormData((prev) => ({
      ...prev,
      addresses: prev.addresses.filter((_, i) => i !== index),
    }));
  };

  const validateForm = async (): Promise<boolean> => {
    const errors: Record<string, string> = {};

    if (!formData.name.trim()) {
      errors.name = 'Company name is required';
    }

    if (formData.contact_email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.contact_email)) {
      errors.contact_email = 'Invalid email format';
    }

    // Addresses are optional. A row with no Billing/Shipping selected is
    // allowed — the customer can keep an address on file without using it
    // for either role. Quote PDFs render BILL TO from whichever address is
    // tagged is_billing, falling back to blank if none is tagged.

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
              {formData.addresses.length > 1 && (
                <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 1 }}>
                  <Tooltip title="Remove this address">
                    <IconButton
                      onClick={() => removeAddress(idx)}
                      disabled={loading}
                      size="small"
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Box>
              )}

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
                    <Radio
                      name="customer-billing-address"
                      checked={addr.is_billing}
                      onClick={() =>
                        updateAddress(idx, { is_billing: !addr.is_billing })
                      }
                      disabled={loading}
                    />
                  }
                  label="Billing"
                />
                <FormControlLabel
                  control={
                    <Radio
                      name="customer-shipping-address"
                      checked={addr.is_shipping}
                      onClick={() =>
                        updateAddress(idx, { is_shipping: !addr.is_shipping })
                      }
                      disabled={loading}
                    />
                  }
                  label="Shipping"
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
