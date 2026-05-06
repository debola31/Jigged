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
  EMPTY_VENDOR_CONTACT_FORM,
  VENDOR_CONTACT_ROLES,
  vendorContactToFormData,
} from '@/types/vendorContact';
import type {
  VendorContact,
  VendorContactFormData,
  VendorContactRole,
} from '@/types/vendorContact';
import {
  createVendorContact,
  updateVendorContact,
} from '@/utils/vendorContactsAccess';

interface VendorContactModalProps {
  open: boolean;
  onClose: () => void;
  vendorId: string;
  /** Provided when editing an existing contact; omitted for "Add Contact". */
  existing?: VendorContact;
  /** Called after the contact has been successfully created or updated. */
  onSaved: () => void;
}

/**
 * Add / edit modal for a single vendor contact.
 *
 * Form fields:
 * - name (required)
 * - role select (with role_label sub-input rendered when role='other')
 * - email (validated when set)
 * - phone (free-text; no format validation — formats vary too much)
 * - is_primary checkbox (transactional handling lives in the access layer:
 *   if checked, any existing primary on the vendor is cleared first).
 */
export default function VendorContactModal({
  open,
  onClose,
  vendorId,
  existing,
  onSaved,
}: VendorContactModalProps) {
  const [formData, setFormData] = useState<VendorContactFormData>(
    EMPTY_VENDOR_CONTACT_FORM,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Re-seed the form whenever the modal opens (or the editing target changes).
  useEffect(() => {
    if (!open) return;
    setFormData(
      existing ? vendorContactToFormData(existing) : EMPTY_VENDOR_CONTACT_FORM,
    );
    setError(null);
    setFieldErrors({});
  }, [open, existing]);

  const isEdit = !!existing;

  const handleChange =
    (field: keyof VendorContactFormData) =>
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

    if (
      formData.email.trim() &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)
    ) {
      errors.email = 'Invalid email format';
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
        await updateVendorContact(existing.id, formData);
      } else {
        await createVendorContact(vendorId, formData);
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
              <InputLabel id="contact-modal-role-label">Role</InputLabel>
              <Select
                labelId="contact-modal-role-label"
                label="Role"
                value={formData.role}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    role: e.target.value as VendorContactRole,
                  }))
                }
                disabled={loading}
              >
                {VENDOR_CONTACT_ROLES.map((r) => (
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
                  'Free-text label (e.g. "Production Manager")'
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
              label="Phone"
              value={formData.phone}
              onChange={handleChange('phone')}
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
              label="Primary contact for this vendor"
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
