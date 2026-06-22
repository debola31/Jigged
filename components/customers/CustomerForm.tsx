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
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

import type { Customer, CustomerFormData } from '@/types/customer';
import {
  EMPTY_CUSTOMER_CONTACT_FORM,
  CUSTOMER_CONTACT_ROLES,
} from '@/types/customerContact';
import type { CustomerContactFormData } from '@/types/customerContact';
import {
  createCustomer,
  updateCustomer,
  softDeleteCustomer,
  checkCustomerNameExists,
} from '@/utils/customerAccess';
import { isValidEmail, isValidPhone } from '@/lib/validators';

interface CustomerFormProps {
  mode: 'create' | 'edit';
  initialData: CustomerFormData;
  customerId?: string;
  companyId?: string;
  onSuccess?: (customer: Customer) => void;
  onCancel?: () => void;
}

/**
 * Customer form for create + edit. Mirrors VendorForm.
 *
 * Contacts and addresses are NOT edited here in edit mode — both are
 * managed via dedicated cards on the customer detail page. In create
 * mode, an embedded "Initial contact" accordion captures one optional
 * primary contact so the user can create + first-contact in one step.
 */
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
  const [contactData, setContactData] = useState<CustomerContactFormData>(
    EMPTY_CUSTOMER_CONTACT_FORM,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const handleChange =
    (field: keyof CustomerFormData) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setFormData((prev) => ({ ...prev, [field]: e.target.value }));
      if (fieldErrors[field]) {
        setFieldErrors((prev) => ({ ...prev, [field]: '' }));
      }
    };

  const handleContactChange =
    (field: keyof CustomerContactFormData) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setContactData((prev) => ({ ...prev, [field]: e.target.value }));
      if (fieldErrors[`contact_${field}`]) {
        setFieldErrors((prev) => ({ ...prev, [`contact_${field}`]: '' }));
      }
    };

  const validateForm = async (): Promise<boolean> => {
    const errors: Record<string, string> = {};

    if (!formData.name.trim()) {
      errors.name = 'Company name is required';
    }

    if (formData.name.trim() && !errors.name) {
      try {
        const exists = await checkCustomerNameExists(
          companyId,
          formData.name,
          mode === 'edit' ? customerId : undefined,
        );
        if (exists) {
          errors.name = 'A customer with this name already exists';
        }
      } catch {
        setError('Error validating customer name');
        return false;
      }
    }

    // Initial contact validation — create mode only, and only when the
    // sub-form has any of name/email/phone filled in. Empty sub-form →
    // no contact row inserted.
    if (mode === 'create') {
      const hasAnyContactField =
        contactData.name.trim() ||
        contactData.email.trim() ||
        contactData.phone.trim();

      if (hasAnyContactField) {
        if (!contactData.name.trim()) {
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
        const customer = await createCustomer(
          companyId,
          formData,
          hasContact ? { ...contactData, is_primary: true } : undefined,
        );
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
    } else if (mode === 'edit' && customerId) {
      router.push(`/dashboard/${companyId}/customers/${customerId}`);
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
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                fullWidth
                required
                label="Company Name"
                value={formData.name}
                onChange={handleChange('name')}
                error={!!fieldErrors.name}
                helperText={fieldErrors.name || ' '}
                disabled={loading}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
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

      {/* Initial contact — create mode only. Defaults to expanded; can be
          collapsed if the user plans to add contacts later from the detail page. */}
      {mode === 'create' && (
        <Accordion defaultExpanded elevation={2} sx={{ mb: 3 }}>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Box>
              <Typography variant="h6" sx={{ fontWeight: 600 }}>
                Initial Contact (optional)
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Add one primary contact now, or skip and add contacts (and
                addresses) from the customer detail page later.
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
                        role: e.target.value as CustomerContactFormData['role'],
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
          {loading
            ? 'Saving...'
            : mode === 'create'
              ? 'Create Customer'
              : 'Save Changes'}
        </Button>
      </Box>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)}>
        <DialogTitle>Delete Customer?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This will permanently delete the customer along with their contacts
            and addresses.
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
