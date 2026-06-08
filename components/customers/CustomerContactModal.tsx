'use client';

import { useState, useEffect } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import FormControlLabel from '@mui/material/FormControlLabel';
import Checkbox from '@mui/material/Checkbox';
import Grid from '@mui/material/Grid';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';

import {
  EMPTY_CUSTOMER_CONTACT_FORM,
  CUSTOMER_CONTACT_ROLES,
  customerContactToFormData,
} from '@/types/customerContact';
import type {
  CustomerContact,
  CustomerContactFormData,
  CustomerContactRole,
} from '@/types/customerContact';
import {
  createCustomerContact,
  updateCustomerContact,
} from '@/utils/customerContactsAccess';
import { isValidEmail, isValidPhone } from '@/lib/validators';

interface CustomerContactModalProps {
  open: boolean;
  onClose: () => void;
  customerId: string;
  /** Provided when editing an existing contact; omitted for "Add Contact". */
  existing?: CustomerContact;
  /** Called after the contact has been successfully created or updated. */
  onSaved: () => void;
}

/**
 * Add / edit modal for a single customer contact. Mirrors
 * VendorContactModal — see that file for the shared rationale.
 */
export default function CustomerContactModal({
  open,
  onClose,
  customerId,
  existing,
  onSaved,
}: CustomerContactModalProps) {
  const [formData, setFormData] = useState<CustomerContactFormData>(
    EMPTY_CUSTOMER_CONTACT_FORM,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setFormData(
      existing ? customerContactToFormData(existing) : EMPTY_CUSTOMER_CONTACT_FORM,
    );
    setError(null);
    setFieldErrors({});
  }, [open, existing]);

  const isEdit = !!existing;

  const handleChange =
    (field: keyof CustomerContactFormData) =>
    (
      e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => {
      setFormData((prev) => ({ ...prev, [field]: e.target.value }));
      if (fieldErrors[field]) {
        setFieldErrors((prev) => ({ ...prev, [field]: '' }));
      }
    };

  const validate = (): boolean => {
    const errors: Record<string, string> = {};

    if (!formData.name.trim()) {
      errors.name = 'Contact name is required';
    }

    if (formData.email.trim() && !isValidEmail(formData.email)) {
      errors.email = 'Invalid email format';
    }

    if (formData.phone.trim() && !isValidPhone(formData.phone)) {
      errors.phone = 'Enter a valid phone number';
    }

    if (formData.role === 'other' && !formData.role_label.trim()) {
      errors.role_label = 'Role label is required when role is "Other"';
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;
    setLoading(true);
    setError(null);
    try {
      if (isEdit && existing) {
        await updateCustomerContact(existing.id, formData);
      } else {
        await createCustomerContact(customerId, formData);
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save contact');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onClose={loading ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{isEdit ? 'Edit Contact' : 'Add Contact'}</DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        <Grid container spacing={2} sx={{ mt: 0 }}>
          <Grid size={{ xs: 12 }}>
            <TextField
              fullWidth
              required
              label="Name"
              value={formData.name}
              onChange={handleChange('name')}
              error={!!fieldErrors.name}
              helperText={fieldErrors.name}
              disabled={loading}
              autoFocus
            />
          </Grid>
          <Grid size={{ xs: 12 }}>
            <FormControl fullWidth>
              <InputLabel id="customer-contact-role-label">Role</InputLabel>
              <Select
                labelId="customer-contact-role-label"
                label="Role"
                value={formData.role}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    role: e.target.value as CustomerContactRole,
                  }))
                }
                disabled={loading}
              >
                {CUSTOMER_CONTACT_ROLES.map((r) => (
                  <MenuItem key={r.value} value={r.value}>
                    {r.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Grid>
          {formData.role === 'other' && (
            <Grid size={{ xs: 12 }}>
              <TextField
                fullWidth
                required
                label="Role label"
                value={formData.role_label}
                onChange={handleChange('role_label')}
                error={!!fieldErrors.role_label}
                helperText={
                  fieldErrors.role_label ||
                  'Free-text label (e.g. "Production Buyer")'
                }
                disabled={loading}
              />
            </Grid>
          )}
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              fullWidth
              type="email"
              label="Email"
              value={formData.email}
              onChange={handleChange('email')}
              error={!!fieldErrors.email}
              helperText={fieldErrors.email}
              disabled={loading}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              fullWidth
              type="tel"
              label="Phone"
              value={formData.phone}
              onChange={handleChange('phone')}
              error={!!fieldErrors.phone}
              helperText={fieldErrors.phone}
              disabled={loading}
            />
          </Grid>
          <Grid size={{ xs: 12 }}>
            <FormControlLabel
              control={
                <Checkbox
                  checked={formData.is_primary}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      is_primary: e.target.checked,
                    }))
                  }
                  disabled={loading}
                />
              }
              label="Primary contact for this customer"
            />
          </Grid>
        </Grid>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={loading} color="inherit">
          Cancel
        </Button>
        <Button
          onClick={handleSave}
          variant="contained"
          disabled={loading}
          startIcon={loading ? <CircularProgress size={16} color="inherit" /> : null}
        >
          {loading ? 'Saving...' : isEdit ? 'Save Changes' : 'Add Contact'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
