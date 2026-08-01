'use client';

import { useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Alert from '@mui/material/Alert';
import Autocomplete from '@mui/material/Autocomplete';
import CircularProgress from '@mui/material/CircularProgress';
import SaveIcon from '@mui/icons-material/Save';
import {
  getCompany,
  getCustomPaymentTerms,
  setCompanyDefaultPaymentTerms,
} from '@/utils/companyAccess';
import { readCompanyDefaultPaymentTerms } from '@/lib/companyDefaults';
import { PAYMENT_TERM_PRESETS } from '@/types/quote';
import SettingsSection from '@/components/settings/SettingsSection';

interface DefaultPaymentTermsCardProps {
  companyId: string;
}

/**
 * "Default Payment Terms" settings block — the terms that apply to a customer
 * the shop has no specific agreement with.
 *
 * A deliberate sibling of AppDefaultsCard rather than a row inside it: that
 * card is driven by KNOWN_DEFAULTS, which is numeric end-to-end (numeric
 * fallback, coerceInt, a `Record<string, number>` patch, a `type="number"`
 * input). Threading one string through it would mean a discriminated union
 * across every one of those. The value here persists to
 * `companies.settings.default_payment_terms`, beside `custom_payment_terms`.
 *
 * Free text on purpose. Shops phrase terms in their own words — one told us
 * "2% Net 30" where our preset list says "2/10 Net 30" — and a quote prints
 * whatever is stored, so forcing their wording onto our vocabulary would
 * change what the customer reads.
 */
export default function DefaultPaymentTermsCard({ companyId }: DefaultPaymentTermsCardProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [value, setValue] = useState('');
  const [savedTerms, setSavedTerms] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const [company, terms] = await Promise.all([
          getCompany(companyId),
          getCustomPaymentTerms(companyId),
        ]);
        if (cancelled) return;
        setValue(readCompanyDefaultPaymentTerms(company) ?? '');
        setSavedTerms(terms);
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

  // The shop's own saved terms first, then the built-in presets — same ordering
  // the quote form's picker uses, minus the add/remove affordances (this screen
  // sets one value; it isn't where the reusable list is curated).
  const options = [
    ...savedTerms.filter((t) => !PAYMENT_TERM_PRESETS.includes(t)),
    ...PAYMENT_TERM_PRESETS,
  ];

  const handleSave = async () => {
    setError(null);
    setSuccess(false);
    setSaving(true);
    try {
      const stored = await setCompanyDefaultPaymentTerms(companyId, value);
      setValue(stored ?? '');
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      title="Default Payment Terms"
      description="Used on a new quote when the customer has no terms of their own. Setting a customer's terms overrides this for that customer. Quotes you've already sent are never changed."
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
                Shop default
              </Typography>
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                Pick one of your terms or type your own. Leave it empty if you
                agree terms with every customer individually.
              </Typography>
            </Box>
            <Autocomplete
              freeSolo
              size="small"
              options={options}
              value={value}
              onChange={(_, next) => {
                setValue(next ?? '');
                setSuccess(false);
              }}
              onInputChange={(_, next) => {
                setValue(next);
                setSuccess(false);
              }}
              sx={{ width: 280 }}
              renderInput={(params) => (
                <TextField
                  {...params}
                  inputProps={{ ...params.inputProps, 'aria-label': 'Shop default payment terms' }}
                />
              )}
            />
          </Box>

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
    </SettingsSection>
  );
}
