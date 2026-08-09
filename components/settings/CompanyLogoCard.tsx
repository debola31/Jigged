'use client';

/**
 * Upload, preview and remove the company logo that heads printed quotes, packing slips and job
 * travelers.
 *
 * ## Why this did not exist before
 *
 * `companies.logo_url` has been read by two PDF generators for a long time, and there has never
 * been a way to set it. `loadLogoAsDataUrl` also read a `logos` bucket that no migration created,
 * so even a hand-set value would have failed — silently, because a missing logo must never break a
 * document. The whole feature was three quarters written and zero percent reachable.
 *
 * ## Two client-side checks that are not the real check
 *
 * Type and size are validated here so the operator gets a sentence instead of a 400, but the
 * `logos` bucket enforces both itself (`allowed_mime_types`, `file_size_limit`). That is the check
 * that counts; this one is a courtesy.
 *
 * **The image is not compressed**, unlike operator photos, which go through
 * `browser-image-compression` on the way up. A logo is already small, and re-encoding a PNG would
 * flatten the transparency that makes it sit on a white page at all.
 *
 * ## Replace is upload-then-delete, in that order
 *
 * A fresh uuid path per upload means a replacement never overwrites in place, so a failure part-way
 * leaves the *old* logo working rather than a half-written object. The stale file is removed only
 * once the new path is committed to the row, and a failure to remove it is logged, not surfaced —
 * an orphaned object costs a few KB, where a rolled-back save costs the user their logo.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import UploadIcon from '@mui/icons-material/Upload';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';

import SettingsSection from '@/components/settings/SettingsSection';
import { getCompany, updateCompanyLogo } from '@/utils/companyAccess';
import {
  deleteFileFromStorage,
  generateCompanyLogoPath,
  getSignedUrl,
  LOGO_ALLOWED_MIME,
  LOGO_MAX_BYTES,
  LOGOS_BUCKET,
  uploadFileToStorage,
} from '@/utils/storageHelpers';

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

export default function CompanyLogoCard({ companyId }: { companyId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [logoPath, setLogoPath] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        const company = await getCompany(companyId);
        if (cancelled) return;
        await loadPreview(company?.logo_url ?? null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId, loadPreview]);

  const handleFile = async (file: File) => {
    const refusal = rejectLogoFile(file);
    if (refusal) {
      setError(refusal);
      return;
    }

    setError(null);
    setBusy(true);
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
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const handleRemove = async () => {
    if (!logoPath) return;
    setError(null);
    setBusy(true);
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
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      title="Company Logo"
      description={`Printed at the top of quotes, packing slips and job travelers. PNG or JPEG, up to ${MAX_MB} MB. A wide logo is fine — it keeps its shape.`}
    >
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      ) : (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
          {/*
            Previewed on white at the same 56pt box the PDF fits it into, because that is the only
            question this preview answers: what will it look like on the page? A logo checked
            against a dark settings background is a logo nobody checked.
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

          <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
            <input
              ref={inputRef}
              type="file"
              accept={LOGO_ALLOWED_MIME.join(',')}
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
              }}
            />
            <Button
              variant="contained"
              startIcon={busy ? <CircularProgress size={16} color="inherit" /> : <UploadIcon />}
              onClick={() => inputRef.current?.click()}
              disabled={busy}
            >
              {logoPath ? 'Replace logo' : 'Upload logo'}
            </Button>
            {logoPath && (
              <Button
                variant="outlined"
                color="error"
                startIcon={<DeleteOutlineIcon />}
                onClick={handleRemove}
                disabled={busy}
              >
                Remove
              </Button>
            )}
          </Box>
        </Box>
      )}
    </SettingsSection>
  );
}
