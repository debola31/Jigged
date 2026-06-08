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
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

import type { Vendor, VendorFormData } from '@/types/vendor';
import {
  EMPTY_VENDOR_CONTACT_FORM,
  VENDOR_CONTACT_ROLES,
} from '@/types/vendorContact';
import type { VendorContactFormData } from '@/types/vendorContact';
import {
  createVendor,
  updateVendor,
  checkVendorNameExists,
} from '@/utils/vendorsAccess';
import { isValidEmail, isValidPhone, isValidPostalCode } from '@/lib/validators';
import CountrySelect from '@/components/common/CountrySelect';
import StateSelect from '@/components/common/StateSelect';

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
 * Vendor form for create + edit.
 *
 * No capability checkboxes — what a vendor does is derived from references
 * (parts.preferred_vendor_id → "supplies materials"; work_centers.vendor_id
 * → "performs outside operations"). Storing capability flags would be a
 * second source of truth and could silently diverge from reality.
 *
 * Contact handling differs by mode:
 * - **Create mode**: an embedded "Initial contact" sub-form lets the user
 *   capture one primary contact at vendor-creation time. The user can leave
 *   it empty (just the vendor name) — the vendor is created with zero
 *   contacts and the detail page's empty-state ("No contacts yet.") shows.
 * - **Edit mode**: NO embedded contact sub-form. The Contacts card on the
 *   vendor detail page handles all contact CRUD (single source of truth for
 *   contact edits → no risk of conflicting form state).
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
  const [contactData, setContactData] = useState<VendorContactFormData>(
    EMPTY_VENDOR_CONTACT_FORM,
  );
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

  const handleContactChange =
    (field: keyof VendorContactFormData) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setContactData((prev) => ({ ...prev, [field]: e.target.value }));
      if (fieldErrors[`contact_${field}`]) {
        setFieldErrors((prev) => ({ ...prev, [`contact_${field}`]: '' }));
      }
    };

  const validateForm = async (): Promise<boolean> => {
    const errors: Record<string, string> = {};

    if (!formData.name.trim()) {
      errors.name = 'Vendor name is required';
    }

    if (
      formData.postal_code.trim() &&
      !isValidPostalCode(formData.country, formData.postal_code)
    ) {
      errors.postal_code = 'Invalid postal code for this country';
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

    // Initial contact validation only applies in create mode AND only when
    // the user actually started filling the sub-form (any of name/email/
    // phone non-empty). Empty sub-form → no contact, no validation, no
    // contact row created.
    if (mode === 'create') {
      const hasAnyContactField =
        contactData.name.trim() ||
        contactData.email.trim() ||
        contactData.phone.trim();

      if (hasAnyContactField) {
        if (!contactData.name.trim()) {
          // Mirrors the importer's missing_contact_name validation rule —
          // never create a contact with no name (would silently corrupt
          // data, see the migration's data-quality NOTICE rationale).
          errors.contact_name =
            'Contact name is required when adding a contact (or clear email/phone to skip)';
        }

        if (contactData.email.trim() && !isValidEmail(contactData.email)) {
          errors.contact_email = 'Invalid email format';
        }

        if (contactData.phone.trim() && !isValidPhone(contactData.phone)) {
          errors.contact_phone = 'Enter a valid phone number';
        }

        if (
          contactData.role === 'other' &&
          !contactData.role_label.trim()
        ) {
          errors.contact_role_label =
            'Role label is required when role is "Other"';
        }
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
        const hasContact = contactData.name.trim() !== '';
        const vendor = await createVendor(
          companyId,
          formData,
          hasContact ? { ...contactData, is_primary: true } : undefined,
        );
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
              <StateSelect
                value={formData.state}
                onChange={(v) => setFormData((prev) => ({ ...prev, state: v }))}
                country={formData.country}
                disabled={loading}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <TextField
                fullWidth
                label="Postal Code"
                value={formData.postal_code}
                onChange={handleChange('postal_code')}
                error={!!fieldErrors.postal_code}
                helperText={fieldErrors.postal_code}
                disabled={loading}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <CountrySelect
                value={formData.country}
                onChange={(v) => setFormData((prev) => ({ ...prev, country: v }))}
                disabled={loading}
              />
            </Grid>
          </Grid>
        </CardContent>
      </Card>

      {/* Initial contact — create mode only. Defaults to expanded so the
          field is visible without a click; can be collapsed if the user
          plans to add contacts later from the detail page. */}
      {mode === 'create' && (
        <Accordion defaultExpanded elevation={2} sx={{ mb: 3 }}>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Box>
              <Typography variant="h6" sx={{ fontWeight: 600 }}>
                Initial Contact (optional)
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Add one primary contact now, or skip and add contacts from the
                vendor detail page later.
              </Typography>
            </Box>
          </AccordionSummary>
          <AccordionDetails>
            <Grid container spacing={3}>
              <Grid size={{ xs: 12, sm: 6 }}>
                <TextField
                  fullWidth
                  label="Contact Name"
                  value={contactData.name}
                  onChange={handleContactChange('name')}
                  error={!!fieldErrors.contact_name}
                  helperText={fieldErrors.contact_name}
                  disabled={loading}
                />
              </Grid>
              <Grid size={{ xs: 12, sm: 6 }}>
                <FormControl fullWidth>
                  <InputLabel id="contact-role-label">Role</InputLabel>
                  <Select
                    labelId="contact-role-label"
                    label="Role"
                    value={contactData.role}
                    onChange={(e) =>
                      setContactData((prev) => ({
                        ...prev,
                        role: e.target.value as VendorContactFormData['role'],
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
              {contactData.role === 'other' && (
                <Grid size={{ xs: 12 }}>
                  <TextField
                    fullWidth
                    required
                    label="Role label"
                    value={contactData.role_label}
                    onChange={handleContactChange('role_label')}
                    error={!!fieldErrors.contact_role_label}
                    helperText={
                      fieldErrors.contact_role_label ||
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
                  value={contactData.email}
                  onChange={handleContactChange('email')}
                  error={!!fieldErrors.contact_email}
                  helperText={fieldErrors.contact_email}
                  disabled={loading}
                />
              </Grid>
              <Grid size={{ xs: 12, sm: 6 }}>
                <TextField
                  fullWidth
                  type="tel"
                  label="Phone"
                  value={contactData.phone}
                  onChange={handleContactChange('phone')}
                  error={!!fieldErrors.contact_phone}
                  helperText={fieldErrors.contact_phone}
                  disabled={loading}
                />
              </Grid>
            </Grid>
          </AccordionDetails>
        </Accordion>
      )}

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
