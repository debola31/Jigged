'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import CloseIcon from '@mui/icons-material/Close';
import DownloadIcon from '@mui/icons-material/Download';

import { getPartAttachmentUrl } from '@/utils/partAttachmentsAccess';
import type { PartAttachment } from '@/types/part';
import { KIND_LABEL } from './attachmentKindMeta';

// The 3D engine (three.js + occt-import-js WASM) touches window/DOM and is
// several MB — load it client-side only, and only when a STEP file is opened.
const StepViewer = dynamic(() => import('./StepViewer'), {
  ssr: false,
  loading: () => (
    <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '75vh' }}>
      <CircularProgress />
    </Box>
  ),
});

interface AttachmentViewerModalProps {
  open: boolean;
  attachment: PartAttachment | null;
  onClose: () => void;
}

/**
 * Previews a part attachment by kind. PDF renders inline in an <iframe> off a
 * fresh signed URL; STEP and DWG (and any 'other') are download-only in Phase 1.
 * Phase 2 swaps the STEP branch for an in-app 3D viewer.
 *
 * The signed URL is fetched fresh on each open (never cached across opens) so a
 * large file can't 403 on a stale link mid-view.
 */
export default function AttachmentViewerModal({
  open,
  attachment,
  onClose,
}: AttachmentViewerModalProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !attachment) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setUrl(null);
    getPartAttachmentUrl(attachment.storage_path)
      .then((u) => {
        if (!cancelled) setUrl(u);
      })
      .catch(() => {
        if (!cancelled) setError('Could not open this file. Try again.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, attachment]);

  const handleDownload = () => {
    if (url) window.open(url, '_blank', 'noopener');
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="lg">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 6 }}>
        <Typography component="span" variant="h6" noWrap sx={{ flex: 1, minWidth: 0 }}>
          {attachment?.file_name ?? 'Attachment'}
        </Typography>
        {attachment && <Chip size="small" label={KIND_LABEL[attachment.kind]} />}
        <Button
          size="small"
          startIcon={<DownloadIcon />}
          onClick={handleDownload}
          disabled={!url}
        >
          Download
        </Button>
        <IconButton aria-label="Close" onClick={onClose} sx={{ position: 'absolute', right: 8, top: 8 }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ minHeight: '60vh' }}>
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
            <CircularProgress />
          </Box>
        ) : error ? (
          <Alert severity="error">{error}</Alert>
        ) : attachment && url ? (
          <ViewerBody attachment={attachment} url={url} onDownload={handleDownload} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ViewerBody({
  attachment,
  url,
  onDownload,
}: {
  attachment: PartAttachment;
  url: string;
  onDownload: () => void;
}) {
  if (attachment.kind === 'pdf') {
    return (
      <Box
        component="iframe"
        src={url}
        title={attachment.file_name}
        sx={{ width: '100%', height: '75vh', border: 0 }}
      />
    );
  }

  if (attachment.kind === 'step') {
    return <StepViewer url={url} />;
  }

  // DWG / other → download-only (no in-browser renderer).
  const reason =
    attachment.kind === 'dwg'
      ? "DWG files can't be previewed in the browser — download to open in your CAD software."
      : "This file can't be previewed in the browser — download to open it in your CAD software.";
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, py: 8 }}>
      <Typography variant="body1" color="text.secondary" sx={{ textAlign: 'center', maxWidth: 420 }}>
        {reason}
      </Typography>
      <Button variant="contained" startIcon={<DownloadIcon />} onClick={onDownload}>
        Download {KIND_LABEL[attachment.kind]}
      </Button>
    </Box>
  );
}
