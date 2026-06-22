'use client';

import { useState } from 'react';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Grid from '@mui/material/Grid';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import FormControlLabel from '@mui/material/FormControlLabel';
import Checkbox from '@mui/material/Checkbox';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

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

interface CustomerContactFormProps {
  customerId: string;
  /** Provided when editing an existing contact; omitted for "Add Contact". */
  existing?: CustomerContact;
  /**
   * Called after the contact has been successfully created or updated, with the
   * saved row so callers can select it immediately (e.g. the quote form's
   * inline add). Mirrors CustomerAddressForm's onSaved contract — the dialog
   * variant (CustomerContactModal) instead calls onSaved() with no row.
   */
  onSaved: (saved: CustomerContact) => void;
  /** Called when the user cancels — returns to the contact list. */
  onCancel: () => void;
}

/**
 * Inline add / edit form for a single customer contact. Rendered in place (no
 * modal), matching the app's inline-editing convention and CustomerAddressForm.
 * The dialog variant (CustomerContactModal) is used on the customer detail page;
 * this inline variant is used inside the quote form's "+ Add new contact" flow,
 * where it must return the saved row so the new contact can be auto-selected.
 *
 * Fields and validation mirror CustomerContactModal; the access layer clears any
 * existing primary when this row is saved as primary.
 */
export default function CustomerContactForm({
  customerId,
  existing,
  onSaved,
  onCancel,
}: CustomerContactFormProps) {
  const [formData, setFormData] = useState<CustomerContactFormData>(() =>
    existing ? customerContactToFormData(existing) : EMPTY_CUSTOMER_CONTACT_FORM,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const isEdit = !!existing;

  const handleChange =
    (field: keyof CustomerContactFormData) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
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
      const saved =
        isEdit && existing
          ? await updateCustomerContact(existing.id, formData)
          : await createCustomerContact(customerId, formData);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save contact');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box>
      <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 2 }}>
        {isEdit ? 'Edit Contact' : 'Add Contact'}
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Grid container spacing={2}>
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
            <InputLabel id="customer-contact-form-role-label">Role</InputLabel>
            <Select
              labelId="customer-contact-form-role-label"
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
                fieldErrors.role_label || 'Free-text label (e.g. "Production Buyer")'
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
                  setFormData((prev) => ({ ...prev, is_primary: e.target.checked }))
                }
                disabled={loading}
              />
            }
            label="Primary contact for this customer"
          />
        </Grid>
      </Grid>

      <Stack direction="row" spacing={2} justifyContent="flex-end" sx={{ mt: 3 }}>
        <Button onClick={onCancel} disabled={loading} color="inherit">
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
      </Stack>
    </Box>
  );
}
