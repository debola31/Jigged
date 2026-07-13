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
import { getCompany, updateCompanyDefaults } from '@/utils/companyAccess';
import {
  KNOWN_DEFAULTS,
  readCompanyDefaults,
  type CompanyDefaultKey,
} from '@/lib/companyDefaults';
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
 * "Quote & Document Defaults" settings block. Renders one editable row per
 * KNOWN_DEFAULTS entry, so surfacing a new company-configurable default is a
 * single registry line. Values persist to companies.settings.defaults via
 * updateCompanyDefaults (feature flags in the sibling `features` block are
 * preserved).
 */
export default function AppDefaultsCard({ companyId }: AppDefaultsCardProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<FormState>(() => emptyForm());
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
        const values = readCompanyDefaults(company);
        setForm(toFormState(values));
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
      await updateCompanyDefaults(companyId, patch);
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      title="Quote & Document Defaults"
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
