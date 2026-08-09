'use client';

/**
 * The shop's identity as it appears at the top of a printed document: its logo, its address, and
 * the phone number a customer would ring.
 *
 * **The logo lives here rather than in a card of its own.** It shipped as `CompanyLogoCard` for
 * about a day and that was one card too many — the settings page had grown to six, and "what does
 * my paperwork look like" was split across two of them for no reason a reader could name. A logo
 * and a return address are the same job.
 *
 * The two halves save independently on purpose: the address fields batch behind a Save button
 * because they are edited together, while uploading or removing a logo is a single deliberate act
 * that applies immediately. A logo sitting in a form waiting to be saved would be a worse lie than
 * the inconsistency.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Grid from '@mui/material/Grid';
import SaveIcon from '@mui/icons-material/Save';
import UploadIcon from '@mui/icons-material/Upload';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import {
  getCompany,
  updateCompanyLogo,
  updateCompanyProfile,
  type CompanyProfilePatch,
} from '@/utils/companyAccess';
import CountrySelect from '@/components/common/CountrySelect';
import StateSelect from '@/components/common/StateSelect';
import { isValidPhone, isValidPostalCode } from '@/lib/validators';
import SettingsSection from '@/components/settings/SettingsSection';
import {
  deleteFileFromStorage,
  generateCompanyLogoPath,
  getSignedUrl,
  LOGO_ALLOWED_MIME,
  LOGO_MAX_BYTES,
  LOGOS_BUCKET,
  uploadFileToStorage,
} from '@/utils/storageHelpers';

interface CompanyProfileCardProps {
  companyId: string;
}

type FormState = Record<keyof CompanyProfilePatch, string>;

const EMPTY_FORM: FormState = {
  phone: '',
  address_line1: '',
  address_line2: '',
  city: '',
  state: '',
  postal_code: '',
  country: '',
};

const MAX_MB = Math.round(LOGO_MAX_BYTES / (1024 * 1024));

/** The refusal an operator sees, or null if the file is acceptable. Pure, so it is testable. */
export function rejectLogoFile(file: { type: string; size: number }): string | null {
  if (!(LOGO_ALLOWED_MIME as readonly string[]).includes(file.type)) {
    return 'That file needs to be a PNG or a JPEG.';
  }
  if (file.size > LOGO_MAX_BYTES) {
    return `That file is larger than ${MAX_MB} MB. Try exporting it smaller.`;
  }
  return null;
}

export default function CompanyProfileCard({ companyId }: CompanyProfileCardProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const [logoPath, setLogoPath] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);

  const loadPreview = useCallback(async (path: string | null) => {
    setLogoPath(path);
    if (!path) {
      setPreviewUrl(null);
      return;
    }
    try {
      setPreviewUrl(await getSignedUrl(path, 3600, LOGOS_BUCKET));
    } catch {
      // A row pointing at an object we cannot read. Say so rather than showing a broken image —
      // "there is no logo" would be a lie that hides a real inconsistency.
      setPreviewUrl(null);
      setError("Your logo is on file but couldn't be loaded just now.");
    }
  }, []);

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
          address_line1: company.address_line1 ?? '',
          address_line2: company.address_line2 ?? '',
          city: company.city ?? '',
          state: company.state ?? '',
          postal_code: company.postal_code ?? '',
          country: company.country ?? '',
        });
        await loadPreview(company.logo_url ?? null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId, loadPreview]);

  const handleChange = (field: keyof FormState) => (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    setForm((prev) => ({ ...prev, [field]: e.target.value }));
    setSuccess(false);
  };

  // All fields are optional (blank = omit from the printed header), so only validate
  // format when a value is present.
  const phoneInvalid = form.phone.trim() !== '' && !isValidPhone(form.phone);
  const postalInvalid = !isValidPostalCode(form.country, form.postal_code);

  const handleSave = async () => {
    if (phoneInvalid || postalInvalid) {
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

  const handleLogoFile = async (file: File) => {
    const refusal = rejectLogoFile(file);
    if (refusal) {
      setError(refusal);
      return;
    }

    setError(null);
    setLogoBusy(true);
    const previous = logoPath;
    try {
      const path = generateCompanyLogoPath(companyId, file.name);
      await uploadFileToStorage(path, file, LOGOS_BUCKET);
      await updateCompanyLogo(companyId, path);
      await loadPreview(path);
      if (previous) {
        // Best effort: the row already points at the new file, so a stale object is litter, not a
        // correctness problem, and failing the save over it would be the worse trade.
        await deleteFileFromStorage(previous, LOGOS_BUCKET).catch((e) =>
          console.warn('Could not remove the previous logo', e),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload that logo.');
    } finally {
      setLogoBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const handleLogoRemove = async () => {
    if (!logoPath) return;
    setError(null);
    setLogoBusy(true);
    const previous = logoPath;
    try {
      // Clear the row first. If the object delete then fails, documents already print without a
      // logo — which is what was asked for — instead of the reverse, where the file is gone and
      // every PDF tries to load it.
      await updateCompanyLogo(companyId, null);
      await loadPreview(null);
      await deleteFileFromStorage(previous, LOGOS_BUCKET).catch((e) =>
        console.warn('Could not remove the logo file', e),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove that logo.');
    } finally {
      setLogoBusy(false);
    }
  };

  return (
    <SettingsSection
      title="Company Profile"
      description="Your logo and return address, printed at the top of quotes, packing slips and job travelers. Leave a field blank to omit it."
    >
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
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 3, flexWrap: 'wrap' }}>
            {/*
              Previewed on white, because that is the only question this preview answers: what will
              it look like on the page? A logo checked against a dark settings background is a logo
              nobody checked.
            */}
            <Box
              sx={{
                width: 120,
                height: 88,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                bgcolor: 'common.white',
                border: 1,
                borderColor: 'divider',
                borderRadius: 1,
                p: 1,
                flexShrink: 0,
              }}
            >
              {previewUrl ? (
                /* A short-lived signed URL from a private bucket, so next/image would need a remote
                   pattern for a host that rotates — and would then cache an image that expires. */
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={previewUrl}
                  alt="Company logo"
                  style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                />
              ) : (
                <Typography variant="caption" sx={{ color: 'grey.600', textAlign: 'center' }}>
                  No logo
                </Typography>
              )}
            </Box>

            <Box sx={{ flex: '1 1 260px', minWidth: 0 }}>
              <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mb: 1 }}>
                <input
                  ref={inputRef}
                  type="file"
                  accept={LOGO_ALLOWED_MIME.join(',')}
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleLogoFile(file);
                  }}
                />
                <Button
                  variant="outlined"
                  startIcon={
                    logoBusy ? <CircularProgress size={16} color="inherit" /> : <UploadIcon />
                  }
                  onClick={() => inputRef.current?.click()}
                  disabled={logoBusy}
                >
                  {logoPath ? 'Replace logo' : 'Upload logo'}
                </Button>
                {logoPath && (
                  <Button
                    variant="text"
                    color="error"
                    startIcon={<DeleteOutlineIcon />}
                    onClick={handleLogoRemove}
                    disabled={logoBusy}
                  >
                    Remove
                  </Button>
                )}
              </Box>
              {/*
                Guidance worth giving, because all three of these are mistakes a shop makes once and
                only discovers on a printed page:
                  - grayscale, because most shop printers are mono lasers and a logo that separates
                    only by hue turns to mud;
                  - transparent PNG, because the page is white and a baked-in white rectangle shows
                    as a box the moment anything sits behind it;
                  - wide is fine, because the aspect is preserved now — it was forced square until
                    this batch, which squashed most wordmarks.
              */}
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                PNG or JPEG, up to {MAX_MB} MB. A wide logo is fine — it keeps its shape. A PNG with
                a transparent background prints cleanest, and it&apos;s worth checking it still
                reads in black and white, since most shop printers are mono lasers.
              </Typography>
            </Box>
          </Box>

          <Divider sx={{ my: 3 }} />

          <Grid container spacing={2}>
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
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <TextField
                label="City"
                value={form.city}
                onChange={handleChange('city')}
                fullWidth
                size="small"
                autoComplete="address-level2"
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
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
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
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
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
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
    </SettingsSection>
  );
}
