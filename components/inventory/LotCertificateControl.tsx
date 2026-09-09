'use client';

import { useRef, useState } from 'react';
import posthog from 'posthog-js';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import CircularProgress from '@mui/material/CircularProgress';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';

import {
  CERT_ACCEPT_ATTR,
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
  onChanged,
  onError,
}: LotCertificateControlProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [viewing, setViewing] = useState<LotCertificate | null>(null);

  const newest = certificates[0] ?? null;

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
        // Attached from a read surface, days after the truck — never at the receipt itself.
        at_receipt: false,
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
        <Tooltip title={`Open ${newest.file_name}`}>
          <Chip
            size="small"
            icon={<DescriptionOutlinedIcon />}
            label={certificates.length > 1 ? `Certs (${certificates.length})` : 'Cert'}
            onClick={() => setViewing(newest)}
          />
        </Tooltip>
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
