'use client';

import { useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import Grid from '@mui/material/Grid';
import SaveIcon from '@mui/icons-material/Save';
import {
  getCompany,
  updateCompanyProfile,
  type CompanyProfilePatch,
} from '@/utils/companyAccess';
import CountrySelect from '@/components/common/CountrySelect';
import StateSelect from '@/components/common/StateSelect';
import { isValidEmail, isValidPhone, isValidPostalCode } from '@/lib/validators';

interface CompanyProfileCardProps {
  companyId: string;
}

type FormState = Record<keyof CompanyProfilePatch, string>;

const EMPTY_FORM: FormState = {
  phone: '',
  email: '',
  website: '',
  address_line1: '',
  address_line2: '',
  city: '',
  state: '',
  postal_code: '',
  country: '',
};

export default function CompanyProfileCard({ companyId }: CompanyProfileCardProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const company = await getCompany(companyId);
        if (cancelled) return;
        if (!company) {
          setError('Company not found.');
          return;
        }
        setForm({
          phone: company.phone ?? '',
          email: company.email ?? '',
          website: company.website ?? '',
          address_line1: company.address_line1 ?? '',
          address_line2: company.address_line2 ?? '',
          city: company.city ?? '',
          state: company.state ?? '',
          postal_code: company.postal_code ?? '',
          country: company.country ?? '',
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  const handleChange = (field: keyof FormState) => (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    setForm((prev) => ({ ...prev, [field]: e.target.value }));
    setSuccess(false);
  };

  // All fields are optional (blank = omit from PDF), so only validate
  // format when a value is present.
  const phoneInvalid = form.phone.trim() !== '' && !isValidPhone(form.phone);
  const emailInvalid = form.email.trim() !== '' && !isValidEmail(form.email);
  const postalInvalid = !isValidPostalCode(form.country, form.postal_code);

  const handleSave = async () => {
    if (phoneInvalid || emailInvalid || postalInvalid) {
      setError('Fix the highlighted fields before saving.');
      return;
    }
    setError(null);
    setSuccess(false);
    setSaving(true);
    try {
      await updateCompanyProfile(companyId, form);
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save company profile.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card elevation={2}>
      <CardContent sx={{ p: 3 }}>
        <Typography variant="h6" sx={{ fontWeight: 600, mb: 1 }}>
          Company Profile
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 3 }}>
          Shop contact and address info shown in the FROM block on printed quote
          PDFs. Leave fields blank to omit them from the PDF.
        </Typography>

        <Divider sx={{ mb: 3 }} />

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        {success && (
          <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess(false)}>
            Company profile saved.
          </Alert>
        )}

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        ) : (
          <>
            <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1.5 }}>
              Contact
            </Typography>
            <Grid container spacing={2} sx={{ mb: 3 }}>
              <Grid size={{ xs: 12, sm: 4 }}>
                <TextField
                  label="Phone"
                  value={form.phone}
                  onChange={handleChange('phone')}
                  fullWidth
                  size="small"
                  type="tel"
                  autoComplete="tel"
                  error={phoneInvalid}
                  helperText={phoneInvalid ? 'Enter a valid phone number' : undefined}
                />
              </Grid>
              <Grid size={{ xs: 12, sm: 4 }}>
                <TextField
                  label="Email"
                  value={form.email}
                  onChange={handleChange('email')}
                  fullWidth
                  size="small"
                  type="email"
                  autoComplete="email"
                  error={emailInvalid}
                  helperText={emailInvalid ? 'Enter a valid email address' : undefined}
                />
              </Grid>
              <Grid size={{ xs: 12, sm: 4 }}>
                <TextField
                  label="Website"
                  value={form.website}
                  onChange={handleChange('website')}
                  fullWidth
                  size="small"
                  placeholder="https://"
                  autoComplete="url"
                />
              </Grid>
            </Grid>

            <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1.5 }}>
              Address
            </Typography>
            <Grid container spacing={2}>
              <Grid size={{ xs: 12 }}>
                <TextField
                  label="Address line 1"
                  value={form.address_line1}
                  onChange={handleChange('address_line1')}
                  fullWidth
                  size="small"
                  autoComplete="address-line1"
                />
              </Grid>
              <Grid size={{ xs: 12 }}>
                <TextField
                  label="Address line 2"
                  value={form.address_line2}
                  onChange={handleChange('address_line2')}
                  fullWidth
                  size="small"
                  autoComplete="address-line2"
                />
              </Grid>
              <Grid size={{ xs: 12, sm: 6 }}>
                <TextField
                  label="City"
                  value={form.city}
                  onChange={handleChange('city')}
                  fullWidth
                  size="small"
                  autoComplete="address-level2"
                />
              </Grid>
              <Grid size={{ xs: 12, sm: 6 }}>
                <StateSelect
                  value={form.state}
                  onChange={(v) => {
                    setForm((prev) => ({ ...prev, state: v }));
                    setSuccess(false);
                  }}
                  country={form.country}
                  size="small"
                />
              </Grid>
              <Grid size={{ xs: 12, sm: 6 }}>
                <TextField
                  label="ZIP"
                  value={form.postal_code}
                  onChange={handleChange('postal_code')}
                  fullWidth
                  size="small"
                  autoComplete="postal-code"
                  error={postalInvalid}
                  helperText={postalInvalid ? 'Invalid for country' : undefined}
                />
              </Grid>
              <Grid size={{ xs: 12, sm: 6 }}>
                <CountrySelect
                  value={form.country}
                  onChange={(v) => {
                    setForm((prev) => ({ ...prev, country: v }));
                    setSuccess(false);
                  }}
                  size="small"
                />
              </Grid>
            </Grid>

            <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 3 }}>
              <Button
                variant="contained"
                startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
                onClick={handleSave}
                disabled={saving}
              >
                Save
              </Button>
            </Box>
          </>
        )}
      </CardContent>
    </Card>
  );
}
