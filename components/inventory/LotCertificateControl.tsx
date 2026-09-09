'use client';

import { useRef, useState } from 'react';
import posthog from 'posthog-js';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Tooltip from '@mui/material/Tooltip';
import CircularProgress from '@mui/material/CircularProgress';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import DownloadIcon from '@mui/icons-material/Download';
import IconButton from '@mui/material/IconButton';

import {
  CERT_ACCEPT_ATTR,
  getLotCertificateUrl,
  uploadLotCertificate,
  validateLotCertificateFile,
} from '@/utils/lotCertificatesAccess';
import type { LotCertificate } from '@/types/inventoryLocations';
import LotCertificateViewerModal from './LotCertificateViewerModal';
import { certificateUploadProperties } from './certificateTelemetry';

interface LotCertificateControlProps {
  companyId: string;
  lotId: string;
  /** e.g. "Heat 4471" — names the material rather than the lot id. */
  heatLabel?: string | null;
  /** Every cert on this lot, newest first. Empty is the normal state on the day material lands. */
  certificates: LotCertificate[];
  /** Where this control is rendered, for telemetry only. */
  surface: string;
  /**
   * Whether this attach is part of putting the material away, rather than chasing it later.
   *
   * The one boolean the whole feature is measured on: the objection this answered was that
   * scanning at the receiving bench is friction, so the rate of true-vs-false is the answer.
   */
  atReceipt: boolean;
  /** Re-read the certs after an upload. */
  onChanged: () => void | Promise<void>;
  onError: (message: string) => void;
}

/**
 * The cert affordance for ONE lot: view what is there, or add one.
 *
 * **Render this once per lot, never once per balance row.** A lot split across two shelves is two
 * balance rows and ONE document, so a per-row control offers two upload buttons for one cert and
 * reads as two missing certs when neither is. This is the same collapsed-vs-split-row fault
 * catalogued across six surfaces in docs/modules/inventory.md §5.6 — here it bites in the opposite
 * direction, by splitting something that is genuinely single.
 *
 * The no-cert state is a plain, unstyled affordance — not amber, not a badge, not a count of what
 * is missing. `lot_certificates`' own comment settles it: a lot with no rows is the normal state on
 * the day the material lands, and chasing it is an office task, not a dock task.
 */
export default function LotCertificateControl({
  companyId,
  lotId,
  heatLabel,
  certificates,
  surface,
  atReceipt,
  onChanged,
  onError,
}: LotCertificateControlProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [viewing, setViewing] = useState<LotCertificate | null>(null);

  const newest = certificates[0] ?? null;

  /**
   * Download without opening the viewer first.
   *
   * The viewer has its own Download, but reaching it meant opening a preview to get at the file —
   * two steps for the thing people mostly want, which is the PDF in their hands to send to a
   * customer. The signed URL is fetched fresh here for the same reason the viewer fetches its own:
   * a cached one can expire between renders.
   */
  const handleDownload = async () => {
    if (!newest) return;
    try {
      const url = await getLotCertificateUrl(newest.file_path);
      window.open(url, '_blank', 'noopener');
    } catch {
      onError('Could not open that certificate. Try again.');
    }
  };

  const handlePick = async (file: File | undefined) => {
    if (!file) return;
    const validationError = validateLotCertificateFile(file);
    if (validationError) {
      onError(validationError);
      posthog.capture('lot certificate upload failed', {
        surface,
        reason: 'rejected',
        attempt: 1,
      });
      return;
    }
    setUploading(true);
    try {
      await uploadLotCertificate(companyId, lotId, file);
      // Keys are written out LITERALLY, never spread: scripts/analyticsEventsCheck.ts reads them
      // from the object literal at the call site, so a spread would leave the documented
      // properties unverifiable while still looking correct here.
      const fileProps = certificateUploadProperties(file);
      posthog.capture('lot certificate uploaded', {
        surface,
        at_receipt: atReceipt,
        file_kind: fileProps.file_kind,
        size_bucket: fileProps.size_bucket,
        is_replacement: certificates.length > 0,
      });
      await onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not attach the certificate.');
      posthog.capture('lot certificate upload failed', {
        surface,
        reason: 'failed',
        attempt: 1,
      });
    } finally {
      setUploading(false);
    }
  };

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      <input
        ref={inputRef}
        type="file"
        accept={CERT_ACCEPT_ATTR}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Clear first so re-picking the same file fires change again.
          e.target.value = '';
          void handlePick(file);
        }}
      />

      {uploading ? (
        <CircularProgress size={20} />
      ) : newest ? (
        /*
          A Button, not a Chip.

          A clickable Chip renders a plain div here: it opens on a mouse click and is invisible to
          the keyboard and to a screen reader — the accessibility conformance the design system
          treats as a requirement rather than polish. The e2e caught it by being unable to find the
          control by role. It also makes the two states look alike, which they should: "Cert" and
          "Add cert" are the same affordance in two conditions.
        */
        <>
          <Tooltip title={`Open ${newest.file_name}`}>
            <Button
              size="small"
              startIcon={<DescriptionOutlinedIcon />}
              onClick={() => setViewing(newest)}
            >
              {certificates.length > 1 ? `Certs (${certificates.length})` : 'Cert'}
            </Button>
          </Tooltip>
          <Tooltip title={`Download ${newest.file_name}`}>
            <IconButton
              aria-label={`Download ${newest.file_name}`}
              size="small"
              onClick={handleDownload}
            >
              <DownloadIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </>
      ) : (
        <Button size="small" onClick={() => inputRef.current?.click()}>
          Add cert
        </Button>
      )}

      {viewing && (
        <LotCertificateViewerModal
          key={viewing.id}
          open
          certificate={viewing}
          heatLabel={heatLabel}
          onClose={() => setViewing(null)}
        />
      )}
    </Box>
  );
}
