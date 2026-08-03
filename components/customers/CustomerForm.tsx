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

import type { Customer, CustomerFormData, CustomerCreditStatus } from '@/types/customer';
import {
  EMPTY_CUSTOMER_CONTACT_FORM,
  CUSTOMER_CONTACT_ROLES,
} from '@/types/customerContact';
import type { CustomerContactFormData } from '@/types/customerContact';
import {
  createCustomer,
  checkCustomerNameExists,
} from '@/utils/customerAccess';
import { isValidEmail, isValidPhone } from '@/lib/validators';

interface CustomerFormProps {
  initialData: CustomerFormData;
  companyId?: string;
  onSuccess?: (customer: Customer) => void;
  onCancel?: () => void;
}

/**
 * Customer form — CREATE ONLY.
 *
 * There is no edit mode any more. A customer's own fields are edited in place
 * on the detail page (auto-save, per docs/interaction-standards.md §2), which
 * is what let /customers/{id}/edit be deleted — contacts, addresses and carrier
 * accounts were already editable there, so the customer's own fields being
 * behind a route was the one inconsistent surface.
 *
 * Do NOT restore symmetry with VendorForm by re-adding the route: vendors and
 * work centers still have edit pages and should follow customers, not the other
 * way round.
 *
 * An embedded "Initial contact" accordion captures one optional primary contact
 * so the user can create the customer and its first contact in one step.
 */
export default function CustomerForm({
  initialData,
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
          undefined,
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
    {
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
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

      {/* Terms & Lead Time — the customer's STANDING commercial defaults.
          Called "Terms", not "Standing Terms": that's the header on every quote
          and PO in this industry, and matching the shop's vocabulary is what
          makes the screen read native rather than like software.

          These are copied onto a NEW quote at create time and are editable
          there. They are never read back by an existing quote, so changing them
          here cannot rewrite a quote already sent — the quote detail page
          surfaces any difference as a chip instead. */}
      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom sx={{ fontWeight: 600, mb: 1 }}>
            Terms &amp; Lead Time
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Applied to new quotes for this customer. Changing them here never
            affects quotes you&rsquo;ve already sent. Leave blank if you have no
            standing agreement.
          </Typography>
          <Grid container spacing={3}>
            {/* Hints live in helperText, never placeholder: a greyed "Net 30"
                or "4–6 weeks" inside an empty field reads as a pre-filled value
                to this audience and would ship as real terms. See
                docs/design-system.md "Placeholders". */}
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                fullWidth
                label="Payment terms"
                value={formData.default_payment_terms}
                onChange={handleChange('default_payment_terms')}
                disabled={loading}
                helperText="Such as Net 30, or 50% deposit."
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                fullWidth
                label="Lead time"
                value={formData.default_lead_time_text}
                onChange={handleChange('default_lead_time_text')}
                disabled={loading}
                helperText="However you normally phrase it on a quote."
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              {/* FOB is about where title and risk transfer — NOT about who pays
                  the freight. That's a separate axis carried on the job and
                  shipment; the two must never share a control. */}
              <TextField
                fullWidth
                label="FOB point"
                value={formData.default_fob_point}
                onChange={handleChange('default_fob_point')}
                disabled={loading}
                helperText="Where title and risk transfer. Who pays the freight is set per order."
              />
            </Grid>
          </Grid>
        </CardContent>
      </Card>

      {/* Credit — a manual flag, set by the office when a customer is past due.
          Deliberately not a numeric limit: nothing computes it, nothing syncs
          it, and nothing anywhere in the app blocks on it. A held customer's
          quote, job and shipment all still go through, with a banner. */}
      <Card elevation={2} sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom sx={{ fontWeight: 600, mb: 1 }}>
            Credit
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Putting a customer on hold shows a warning when someone quotes or
            ships to them. It never stops the work — the decision stays yours.
          </Typography>
          <Grid container spacing={3}>
            <Grid size={{ xs: 12, sm: 5 }}>
              <FormControl fullWidth disabled={loading}>
                <InputLabel id="credit-status-label">Credit status</InputLabel>
                <Select
                  labelId="credit-status-label"
                  label="Credit status"
                  value={formData.credit_status}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      credit_status: e.target.value as CustomerCreditStatus,
                    }))
                  }
                >
                  <MenuItem value="open">Open</MenuItem>
                  <MenuItem value="hold">On hold</MenuItem>
                </Select>
              </FormControl>
            </Grid>
            {formData.credit_status === 'hold' && (
              <Grid size={{ xs: 12, sm: 7 }}>
                <TextField
                  fullWidth
                  label="Reason"
                  value={formData.credit_hold_note}
                  onChange={handleChange('credit_hold_note')}
                  disabled={loading}
                  helperText="Shown with the warning. Whatever the next person needs to know."
                />
              </Grid>
            )}
          </Grid>
        </CardContent>
      </Card>

      {/* Initial contact — create mode only. Defaults to expanded; can be
          collapsed if the user plans to add contacts later from the detail page. */}
      {(
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

      {/* Actions. No Delete here — archiving lives on the detail page, whose
          dialog names the customer and reports how many quotes and jobs
          reference it. Two archive paths with different copy was the other
          half of the inconsistency this rework removes. */}
      <Box sx={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>
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
          {loading ? 'Saving...' : 'Create Customer'}
        </Button>
      </Box>

    </Box>
  );
}
