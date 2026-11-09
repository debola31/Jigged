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
import posthog from 'posthog-js';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import type { ChargeBasis } from '@/types/bom';
import {
  getCompany,
  readCompanyMaterialChargeBasis,
  setCompanyMaterialChargeBasis,
  setCompanyDefaultPaymentTerms,
  updateCompanyDefaults,
} from '@/utils/companyAccess';
import {
  KNOWN_DEFAULTS,
  readCompanyDefaultPaymentTerms,
  readCompanyDefaults,
  type CompanyDefaultKey,
} from '@/lib/companyDefaults';
import SettingsSection from '@/components/settings/SettingsSection';
import PaymentTermsPicker from '@/components/common/PaymentTermsPicker';

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
 * Shops phrase terms in their own words — one told us "2% Net 30" where our preset list says
 * "2/10 Net 30" — and a quote prints whatever is stored, so their wording must survive. It reaches
 * the field through the SHARED `PaymentTermsPicker`, not a free-text box of this card's own:
 * "Add New" takes the same arbitrary string, and the difference is that it also joins
 * `custom_payment_terms`, so the phrase the shop just made its house term is offered on every
 * quote instead of arriving there as an unrecognised value. The hand-rolled combobox this replaced
 * had neither that nor the remove control, so the one screen a shop would go to to curate its list
 * was the one screen that could not.
 *
 * **The two halves of this row commit at different times, and that is inherent rather than an
 * oversight.** Adding or removing a saved term writes `custom_payment_terms` immediately (it is a
 * list edit, and the picker owns it everywhere it appears); the chosen default only lands on Save.
 * Each writer re-reads the settings object, so the later Save carries the earlier list edit.
 *
 * Values persist to `companies.settings.defaults` and `companies.settings.default_payment_terms`;
 * both writers read-modify-write the whole settings object, which is why Save runs them in
 * sequence — see `handleSave`. The Materials choice is a real column
 * (`companies.default_material_charge_basis`), written separately.
 *
 * **There are no starting-markup fields here, on purpose.** The "Part pricing markups" pair
 * (parts you make / parts you buy) was removed on 2026-11-09: every shop had left both at 0%, so a
 * new part starts at cost and its markup is set on the part's own Pricing card.
 */
export default function AppDefaultsCard({ companyId }: AppDefaultsCardProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<FormState>(() => emptyForm());
  const [terms, setTerms] = useState('');
  const [materialBasis, setMaterialBasis] = useState<ChargeBasis>('cost');
  const [materialBasisBaseline, setMaterialBasisBaseline] = useState<ChargeBasis>('cost');
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
        setForm(toFormState(readCompanyDefaults(company)));
        setTerms(readCompanyDefaultPaymentTerms(company) ?? '');
        const basis = readCompanyMaterialChargeBasis(company);
        setMaterialBasis(basis);
        setMaterialBasisBaseline(basis);
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
      // SEQUENTIAL, not Promise.all. Both of these read the whole `companies.settings` object,
      // merge their own key into it, and write it back — so running them concurrently means the
      // second read happens before the first write lands and one silently clobbers the other.
      await updateCompanyDefaults(companyId, patch);
      setTerms((await setCompanyDefaultPaymentTerms(companyId, terms)) ?? '');
      // A real column, so this is an independent write — no settings
      // read-modify-write to serialize against.
      if (materialBasis !== materialBasisBaseline) {
        await setCompanyMaterialChargeBasis(companyId, materialBasis);
        posthog.capture('pricing defaults set', { material_basis: materialBasis });
        setMaterialBasisBaseline(materialBasis);
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
            {/* Wide enough that the "Add New" row's field, Add and Cancel sit
                on one line; the picker itself only needs ~280. */}
            <Box sx={{ width: 380, maxWidth: '100%' }}>
              <PaymentTermsPicker
                companyId={companyId}
                value={terms}
                onChange={(next) => {
                  setTerms(next);
                  setSuccess(false);
                }}
                label={null}
              />
            </Box>
          </Box>

          {/* A CHOICE, not a number, so it gets the same two-option control the
              Materials panel uses — and the same two words. A setting that
              renames the thing it defaults is a setting nobody connects to the
              screen it governs. */}
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
