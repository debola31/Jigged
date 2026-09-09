'use client';

import { useEffect, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import CloseIcon from '@mui/icons-material/Close';
import DownloadIcon from '@mui/icons-material/Download';

import { getLotCertificateUrl, certificatePreviewKind } from '@/utils/lotCertificatesAccess';
import type { LotCertificate } from '@/types/inventoryLocations';

interface LotCertificateViewerModalProps {
  open: boolean;
  certificate: LotCertificate | null;
  /** What the cert is against, e.g. "Heat 4471" — so the title says the material, not just a filename. */
  heatLabel?: string | null;
  onClose: () => void;
}

/**
 * Previews one mill certificate.
 *
 * A sibling of `AttachmentViewerModal` rather than a reuse of it, deliberately. That component is
 * typed on `PartAttachment` (`kind`, `storage_path`), resolves its own URL through
 * `getPartAttachmentUrl`, and dynamically imports the three.js/WASM STEP viewer. Passing a cert
 * through it would mean either faking a `PartAttachment` — and `PartAttachmentKind` has no `image`
 * member, so the lie would be in the type system — or widening it with a URL resolver and a label
 * map, which is a refactor of FilesTab and PartFilesSheet inside a feature PR, for no gain to
 * either. The branch that settles it is the image one: a phone photo of a paper cert is a
 * first-class input here and has no counterpart there.
 *
 * If a third document viewer ever appears, the extraction to
 * `DocumentViewerModal({ fileName, resolveUrl, preview })` is the right move — not before.
 *
 * The signed URL is fetched fresh on each open. The parent passes `key={certificate.id}` so a
 * different cert remounts this with the initial state, rather than resetting it in an effect.
 */
export default function LotCertificateViewerModal({
  open,
  certificate,
  heatLabel,
  onClose,
}: LotCertificateViewerModalProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !certificate) return;
    let cancelled = false;
    getLotCertificateUrl(certificate.file_path)
      .then((u) => {
        if (!cancelled) setUrl(u);
      })
      .catch(() => {
        if (!cancelled) setError('Could not open this certificate. Try again.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, certificate]);

  const handleDownload = () => {
    if (url) window.open(url, '_blank', 'noopener');
  };

  const preview = certificate ? certificatePreviewKind(certificate) : 'download';

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="lg">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 6 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography component="span" variant="h6" noWrap sx={{ display: 'block' }}>
            {certificate?.file_name ?? 'Certificate'}
          </Typography>
          {heatLabel && (
            <Typography variant="body2" color="text.secondary" noWrap>
              {heatLabel}
            </Typography>
          )}
        </Box>
        <Button size="small" startIcon={<DownloadIcon />} onClick={handleDownload} disabled={!url}>
          Download
        </Button>
        <IconButton
          aria-label="Close"
          onClick={onClose}
          sx={{ position: 'absolute', right: 8, top: 8 }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ minHeight: '60vh' }}>
        {loading ? (
          <Box
            sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}
          >
            <CircularProgress />
          </Box>
        ) : error ? (
          <Alert severity="error">{error}</Alert>
        ) : url ? (
          <CertificateBody preview={preview} url={url} onDownload={handleDownload} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function CertificateBody({
  preview,
  url,
  onDownload,
}: {
  preview: 'pdf' | 'image' | 'download';
  url: string;
  onDownload: () => void;
}) {
  if (preview === 'pdf') {
    return (
      <Box
        component="iframe"
        src={url}
        title="Certificate"
        sx={{ width: '100%', height: '75vh', border: 0 }}
      />
    );
  }

  if (preview === 'image') {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center' }}>
        <Box
          component="img"
          src={url}
          alt="Certificate"
          sx={{ maxWidth: '100%', maxHeight: '75vh', objectFit: 'contain' }}
        />
      </Box>
    );
  }

  // HEIC lands here, and it is the common case for a cert photographed on an iPhone rather than an
  // exotic one — say what to do instead of showing a broken image.
  return (
    <Box sx={{ py: 4, textAlign: 'center' }}>
      <Typography variant="body1" sx={{ mb: 2 }}>
        This file can&apos;t be shown in the browser.
      </Typography>
      <Button variant="contained" startIcon={<DownloadIcon />} onClick={onDownload}>
        Download to open
      </Button>
    </Box>
  );
}
