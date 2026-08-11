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
import posthog from 'posthog-js';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import type { ChargeBasis } from '@/types/bom';
import {
  getCompany,
  getCustomPaymentTerms,
  readCompanyPricingDefaults,
  setCompanyPricingDefaults,
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
  // Strings so a half-typed "22." survives a render. Both are numeric(10,6) and
  // NOT NULL — 0 is a real value, not "unset".
  const [madeMarkup, setMadeMarkup] = useState('0');
  const [boughtMarkup, setBoughtMarkup] = useState('0');
  const [materialBasis, setMaterialBasis] = useState<ChargeBasis>('cost');
  const [pricingBaseline, setPricingBaseline] = useState({
    made: '0',
    bought: '0',
    basis: 'cost' as ChargeBasis,
  });
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
        const defaults = readCompanyPricingDefaults(company);
        setMadeMarkup(String(defaults.made));
        setBoughtMarkup(String(defaults.bought));
        setMaterialBasis(defaults.materialChargeBasis);
        setPricingBaseline({
          made: String(defaults.made),
          bought: String(defaults.bought),
          basis: defaults.materialChargeBasis,
        });
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
  const madeMarkupError = markupFieldError(madeMarkup);
  const boughtMarkupError = markupFieldError(boughtMarkup);
  const hasErrors =
    Object.keys(errors).length > 0 || madeMarkupError !== null || boughtMarkupError !== null;

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
      // Real columns, so this is an independent write — no settings
      // read-modify-write to serialize against.
      const nextMade = madeMarkup.trim();
      const nextBought = boughtMarkup.trim();
      if (
        nextMade !== pricingBaseline.made ||
        nextBought !== pricingBaseline.bought ||
        materialBasis !== pricingBaseline.basis
      ) {
        await setCompanyPricingDefaults(companyId, {
          made: Number(nextMade),
          bought: Number(nextBought),
          materialChargeBasis: materialBasis,
        });
        posthog.capture('pricing defaults set', {
          made_changed: nextMade !== pricingBaseline.made,
          bought_changed: nextBought !== pricingBaseline.bought,
          material_basis_changed: materialBasis !== pricingBaseline.basis,
          made_is_zero: Number(nextMade) === 0,
          bought_is_zero: Number(nextBought) === 0,
          material_basis: materialBasis,
        });
        setPricingBaseline({ made: nextMade, bought: nextBought, basis: materialBasis });
      }
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
                Payment terms
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
                  inputProps={{ ...params.inputProps, 'aria-label': 'Payment terms' }}
                />
              )}
            />
          </Box>

          <Divider sx={{ my: 2 }} />
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
            Part pricing markups
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
            What a new part starts at. Changing these never reprices a part you have
            already set up.
          </Typography>

          {(
            [
              {
                key: 'made' as const,
                label: 'Parts you make',
                value: madeMarkup,
                setValue: setMadeMarkup,
                error: madeMarkupError,
              },
              {
                key: 'bought' as const,
                label: 'Parts you buy',
                value: boughtMarkup,
                setValue: setBoughtMarkup,
                error: boughtMarkupError,
              },
            ]
          ).map((f) => (
            <Box
              key={f.key}
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 2,
                flexWrap: 'wrap',
                mb: 1.5,
              }}
            >
              <Box sx={{ flex: '1 1 260px', minWidth: 0 }}>
                <Typography variant="body2" sx={{ fontWeight: 500 }}>
                  {f.label}
                </Typography>
              </Box>
              <TextField
                value={f.value}
                onChange={(e) => {
                  f.setValue(e.target.value);
                  setSuccess(false);
                }}
                size="small"
                type="number"
                inputProps={{
                  min: 0,
                  step: 'any',
                  inputMode: 'decimal',
                  'aria-label': `Starting markup — ${f.label}`,
                }}
                error={Boolean(f.error)}
                helperText={f.error}
                sx={{ width: 160 }}
                InputProps={{
                  endAdornment: <InputAdornment position="end">%</InputAdornment>,
                }}
              />
            </Box>
          ))}

          {/* The third default is a CHOICE, not a percentage, so it gets the same
              two-option control the Materials panel uses — and the same two
              words. A setting that renames the thing it defaults is a setting
              nobody connects to the screen it governs. */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 2,
              flexWrap: 'wrap',
              mb: 1.5,
            }}
          >
            <Box sx={{ flex: '1 1 260px', minWidth: 0 }}>
              <Typography variant="body2" sx={{ fontWeight: 500 }}>
                Materials
              </Typography>
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                What a new part charges for the materials it consumes, bought or made.
                Change it per part any time.
              </Typography>
            </Box>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={materialBasis}
              onChange={(_, next: ChargeBasis | null) => {
                // Null is the click that would deselect the active option; there
                // is no third state.
                if (!next) return;
                setMaterialBasis(next);
                setSuccess(false);
              }}
              aria-label="Materials charge basis"
            >
              <ToggleButton value="cost">Our cost</ToggleButton>
              <ToggleButton value="price">Their marked-up price</ToggleButton>
            </ToggleButtonGroup>
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

/**
 * A number >= 0. Decimals allowed on purpose — the column is numeric(10,6),
 * deliberately not the whole-number shape KNOWN_DEFAULTS enforces, because
 * 0.01% of markup visibly moves a price. Blank is not valid: 0 is how you say
 * "sell at cost", and there is no third state.
 */
function markupFieldError(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return 'Required — use 0 to sell at cost';
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return 'Enter a number';
  if (n < 0) return 'Cannot be negative';
  return null;
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
