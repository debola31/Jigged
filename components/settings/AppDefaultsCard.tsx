'use client';

import { useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import InputAdornment from '@mui/material/InputAdornment';
import SaveIcon from '@mui/icons-material/Save';
import Autocomplete from '@mui/material/Autocomplete';
import {
  getCompany,
  getCustomPaymentTerms,
  setCompanyDefaultPaymentTerms,
  updateCompanyDefaults,
} from '@/utils/companyAccess';
import {
  KNOWN_DEFAULTS,
  readCompanyDefaultPaymentTerms,
  readCompanyDefaults,
  type CompanyDefaultKey,
} from '@/lib/companyDefaults';
import { PAYMENT_TERM_PRESETS } from '@/types/quote';
import SettingsSection from '@/components/settings/SettingsSection';

interface AppDefaultsCardProps {
  companyId: string;
}

type FormState = Record<CompanyDefaultKey, string>;

/** Validate one field's string value against its descriptor's [min, max]. */
function fieldError(key: CompanyDefaultKey, raw: string): string | null {
  const descriptor = KNOWN_DEFAULTS.find((d) => d.key === key)!;
  const trimmed = raw.trim();
  if (trimmed === '') return 'Required';
  const n = Number(trimmed);
  if (!Number.isInteger(n)) return 'Whole number';
  if (n < descriptor.min || n > descriptor.max) {
    return `${descriptor.min}–${descriptor.max}`;
  }
  return null;
}

/**
 * The company's default settings: one editable row per KNOWN_DEFAULTS entry, so surfacing a new
 * numeric default is a single registry line, plus the shop's default payment terms.
 *
 * **The payment-terms row is hand-rolled beside the registry, not folded into it, and that is the
 * point of the merge.** It shipped as its own card whose docstring argued the split correctly:
 * KNOWN_DEFAULTS is numeric end to end — numeric fallback, whole-number validation, a
 * `Record<string, number>` patch, a `type="number"` input — and threading one string through it
 * would mean a discriminated union across every one of those. That argument was about the
 * *registry*, and someone read it as an argument about the *card*. A user does not know what a
 * registry is; they know quote validity and payment terms are both "what a new quote starts with"
 * and were in two boxes. The card is one; the registry stays numeric.
 *
 * Terms are free text on purpose. Shops phrase them in their own words — one told us "2% Net 30"
 * where our preset list says "2/10 Net 30" — and a quote prints whatever is stored, so forcing
 * their wording onto our vocabulary would change what the customer reads.
 *
 * Values persist to `companies.settings.defaults` and `companies.settings.default_payment_terms`;
 * both writers read-modify-write the whole settings object, which is why Save runs them in
 * sequence — see `handleSave`.
 */
export default function AppDefaultsCard({ companyId }: AppDefaultsCardProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<FormState>(() => emptyForm());
  const [terms, setTerms] = useState('');
  const [savedTerms, setSavedTerms] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const [company, customTerms] = await Promise.all([
          getCompany(companyId),
          getCustomPaymentTerms(companyId),
        ]);
        if (cancelled) return;
        setForm(toFormState(readCompanyDefaults(company)));
        setTerms(readCompanyDefaultPaymentTerms(company) ?? '');
        setSavedTerms(customTerms);
      } catch {
        if (!cancelled) setError('Failed to load settings.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  // The shop's own saved terms first, then the built-in presets — same ordering the quote form's
  // picker uses, minus the add/remove affordances (this screen sets one value; it isn't where the
  // reusable list is curated).
  const termOptions = [
    ...savedTerms.filter((t) => !PAYMENT_TERM_PRESETS.includes(t)),
    ...PAYMENT_TERM_PRESETS,
  ];

  const handleChange = (key: CompanyDefaultKey) => (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    setForm((prev) => ({ ...prev, [key]: e.target.value }));
    setSuccess(false);
  };

  const errors = KNOWN_DEFAULTS.reduce<Partial<Record<CompanyDefaultKey, string>>>(
    (acc, d) => {
      const err = fieldError(d.key, form[d.key]);
      if (err) acc[d.key] = err;
      return acc;
    },
    {},
  );
  const hasErrors = Object.keys(errors).length > 0;

  const handleSave = async () => {
    if (hasErrors) {
      setError('Fix the highlighted fields before saving.');
      return;
    }
    setError(null);
    setSuccess(false);
    setSaving(true);
    try {
      const patch: Record<string, number> = {};
      for (const d of KNOWN_DEFAULTS) {
        patch[d.key] = Number(form[d.key].trim());
      }
      // SEQUENTIAL, not Promise.all. Both of these read the whole `companies.settings` object,
      // merge their own key into it, and write it back — so running them concurrently means the
      // second read happens before the first write lands and one silently clobbers the other.
      await updateCompanyDefaults(companyId, patch);
      setTerms((await setCompanyDefaultPaymentTerms(companyId, terms)) ?? '');
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      title="Company Default Settings"
      description="Default values applied to new records. Changing one doesn't affect records you've already created."
    >
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {success && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess(false)}>
          Settings saved.
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      ) : (
        <>
          {KNOWN_DEFAULTS.map((d, i) => (
            <Box key={d.key}>
              {i > 0 && <Divider sx={{ my: 2 }} />}
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 2,
                  flexWrap: 'wrap',
                }}
              >
                <Box sx={{ flex: '1 1 260px', minWidth: 0 }}>
                  <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                    {d.label}
                  </Typography>
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    {d.description}
                  </Typography>
                </Box>
                <TextField
                  value={form[d.key]}
                  onChange={handleChange(d.key)}
                  size="small"
                  type="number"
                  inputProps={{ min: d.min, max: d.max, step: 1, 'aria-label': d.label }}
                  error={Boolean(errors[d.key])}
                  helperText={errors[d.key]}
                  sx={{ width: 160 }}
                  InputProps={{
                    endAdornment: (
                      <InputAdornment position="end">{d.unit}</InputAdornment>
                    ),
                  }}
                />
              </Box>
            </Box>
          ))}

          <Divider sx={{ my: 2 }} />
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 2,
              flexWrap: 'wrap',
            }}
          >
            <Box sx={{ flex: '1 1 260px', minWidth: 0 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                Default payment terms
              </Typography>
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                Used on a new quote when the customer has no terms of their own. Setting a
                customer&apos;s terms overrides this for them. Leave it empty if you agree terms
                individually.
              </Typography>
            </Box>
            <Autocomplete
              freeSolo
              size="small"
              options={termOptions}
              value={terms}
              onChange={(_, next) => {
                setTerms(next ?? '');
                setSuccess(false);
              }}
              onInputChange={(_, next) => {
                setTerms(next);
                setSuccess(false);
              }}
              sx={{ width: 280 }}
              renderInput={(params) => (
                <TextField
                  {...params}
                  inputProps={{ ...params.inputProps, 'aria-label': 'Default payment terms' }}
                />
              )}
            />
          </Box>

          <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 3 }}>
            <Button
              variant="contained"
              startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
              onClick={handleSave}
              disabled={saving || hasErrors}
            >
              Save
            </Button>
          </Box>
        </>
      )}
    </SettingsSection>
  );
}

function emptyForm(): FormState {
  const out = {} as FormState;
  for (const d of KNOWN_DEFAULTS) out[d.key] = String(d.fallback);
  return out;
}

function toFormState(values: Record<CompanyDefaultKey, number>): FormState {
  const out = {} as FormState;
  for (const d of KNOWN_DEFAULTS) out[d.key] = String(values[d.key]);
  return out;
}
