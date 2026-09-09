'use client';

import { useRef, useState } from 'react';
import posthog from 'posthog-js';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';

import { useLoad } from '@/hooks/useLoad';
import {
  CERT_ACCEPT_ATTR,
  UPLOAD_TIMEOUT_REASON,
  listLotCertificates,
  uploadLotCertificate,
  validateLotCertificateFile,
} from '@/utils/lotCertificatesAccess';
import type { LotCertificate } from '@/types/inventoryLocations';
import LotCertificateViewerModal from './LotCertificateViewerModal';
import { certificateUploadProperties } from './certificateTelemetry';

interface CertAfterReceiptPanelProps {
  companyId: string;
  /** The lot the receipt landed on. Non-null by construction — the parent gates on `result.lot_id`. */
  lotId: string;
  /** Telemetry only: which receiving surface this is. */
  surface: string;
  /** e.g. "Heat 4471", so the panel names the material rather than a uuid. */
  heatLabel?: string | null;
  /** Dismiss. Always available — see below. */
  onDone: () => void;
}

/**
 * Offered AFTER a receipt has already landed: attach the mill cert for the lot it created.
 *
 * **THE ORDERING IS THE FEATURE, and it is the exact inverse of `MovementPhotoField`.**
 * That component uploads BEFORE the RPC because `inventory_transactions.photo_path` is written at
 * INSERT and immutable afterwards, so the RPC must be handed a path and a failed photo aborts the
 * movement. A cert is an independent row whose only requirement is a `lot_id` — and the lot does
 * not exist until `add_stock_at_location` creates it, so upload-first is not merely unnecessary
 * here, it is impossible. That mechanical fact is what delivers the product requirement for free:
 * because the cert is a second, later write, a failed one cannot un-land the stock.
 *
 * **`Done` is always enabled and takes focus.** That single fact is the never-blocks guarantee made
 * structural rather than promised. Nothing here is red, nothing warns that no cert was attached,
 * and no state of this panel can prevent material being put away — a receiving screen that demanded
 * a scan first would be worse than no cert at all.
 *
 * The panel configures itself from what the lot already holds, which is why the RPC needs no
 * "did this create a lot?" flag: topping up a bin that already has a cert reads as a confirmation,
 * not as a prompt to attach a second one.
 */
export default function CertAfterReceiptPanel({
  companyId,
  lotId,
  surface,
  heatLabel,
  onDone,
}: CertAfterReceiptPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [viewing, setViewing] = useState<LotCertificate | null>(null);

  const { data: existing, loading, reload } = useLoad(() => listLotCertificates(lotId), [lotId]);
  const certificates = existing ?? [];
  const alreadyHasOne = certificates.length > 0;

  const handlePick = async (file: File | undefined) => {
    if (!file) return;
    const nextAttempt = attempt + 1;
    setAttempt(nextAttempt);

    const validationError = validateLotCertificateFile(file);
    if (validationError) {
      setFailure(validationError);
      posthog.capture('lot certificate upload failed', {
        surface,
        reason: 'rejected',
        attempt: nextAttempt,
      });
      return;
    }

    setUploading(true);
    setFailure(null);
    try {
      await uploadLotCertificate(companyId, lotId, file);
      // Literal keys, never a spread: scripts/analyticsEventsCheck.ts reads them from the object
      // literal at this call site and a spread would leave them unverifiable.
      const fileProps = certificateUploadProperties(file);
      posthog.capture('lot certificate uploaded', {
        surface,
        at_receipt: true,
        file_kind: fileProps.file_kind,
        size_bucket: fileProps.size_bucket,
        is_replacement: alreadyHasOne,
      });
      await reload();
      onDone();
    } catch (e) {
      setFailure(
        e instanceof Error ? e.message : 'The certificate did not upload. Try again, or add it later.',
      );
      posthog.capture('lot certificate upload failed', {
        surface,
        reason: e instanceof Error && e.name === UPLOAD_TIMEOUT_REASON ? 'timeout' : 'failed',
        attempt: nextAttempt,
      });
    } finally {
      setUploading(false);
    }
  };

  return (
    <Box>
      <input
        ref={inputRef}
        type="file"
        // No `capture` attribute, deliberately. The native sheet has to offer Files — where the
        // scanned PDF already lives, which is the whole premise — as well as the camera.
        accept={CERT_ACCEPT_ATTR}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          void handlePick(file);
        }}
      />

      {failure && (
        /*
          WARNING, not error, and the first sentence is the stock.

          The receipt succeeded; only the document did not. Painting this red would say the movement
          failed, which would be false and would send someone to re-enter stock that is already
          recorded.
        */
        <Alert severity="warning" sx={{ mb: 2 }}>
          The stock is recorded. {failure}
        </Alert>
      )}

      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {heatLabel ? `${heatLabel} — ` : ''}
        {alreadyHasOne
          ? 'already has a certificate.'
          : 'add the mill certificate now, or later from the part.'}
      </Typography>

      <Stack direction="row" spacing={1} alignItems="center">
        <Button
          // Always enabled, and focused: nothing about a certificate may stand between someone and
          // finishing a receipt.
          autoFocus
          variant="contained"
          onClick={onDone}
        >
          Done
        </Button>

        {loading ? (
          <CircularProgress size={20} />
        ) : (
          <>
            <Button disabled={uploading} onClick={() => inputRef.current?.click()}>
              {uploading
                ? 'Attaching…'
                : failure
                  ? 'Try again'
                  : alreadyHasOne
                    ? 'Add another'
                    : 'Add the mill cert (optional)'}
            </Button>
            {alreadyHasOne && (
              <Button onClick={() => setViewing(certificates[0])}>View</Button>
            )}
          </>
        )}
      </Stack>

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
