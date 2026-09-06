'use client';

import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import DownloadIcon from '@mui/icons-material/Download';

import { useLoad } from '@/hooks/useLoad';
import { getJobAttachmentUrl } from '@/utils/jobAttachmentsAccess';
import type { JobAttachment } from '@/types/job';

/** Renders as an <img>; everything else viewable goes in an iframe. */
export function isImageAttachment(att: JobAttachment): boolean {
  const mime = att.mime_type ?? '';
  const name = att.file_name.toLowerCase();
  return mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/.test(name);
}

/** PDFs and images open in place; anything else can only be downloaded. */
export function isViewableAttachment(att: JobAttachment): boolean {
  const mime = att.mime_type ?? '';
  const name = att.file_name.toLowerCase();
  return mime === 'application/pdf' || name.endsWith('.pdf') || isImageAttachment(att);
}

/**
 * Full-screen viewer for one job attachment — the customer PO, usually.
 *
 * EXTRACTED so the two places that open a file share one implementation: the
 * attachments card on the Edit screen, and the paperclip beside Customer PO on
 * the job page. A second copy would have been the easy thing to write and the
 * expensive thing to keep — this owns the signed-URL fetch, the img/iframe
 * branch and the download, and none of that is worth having twice.
 *
 * The URL is fetched fresh each time it opens rather than cached: attachment
 * URLs are short-lived signed links, and a stale one fails as a blank frame
 * with no error to explain it.
 */
export default function JobAttachmentViewerDialog({
  attachment,
  onClose,
}: {
  /** Null closes it. Mounted by the caller either way. */
  attachment: JobAttachment | null;
  onClose: () => void;
}) {
  const [downloadError, setDownloadError] = useState<string | null>(null);

  /**
   * Keyed on the storage path, which is the primitive `useLoad` wants and is
   * fixed per attachment. Resolves to null when nothing is open, so closing
   * does not leave a stale URL behind for the next file to flash.
   */
  const path = attachment?.storage_path ?? '';
  const {
    data: url,
    loading,
    error: loadError,
  } = useLoad(() => (path ? getJobAttachmentUrl(path) : Promise.resolve(null)), [path]);

  const error = downloadError ?? (loadError ? 'Could not open the file.' : null);

  const download = async () => {
    if (!attachment) return;
    try {
      window.open(await getJobAttachmentUrl(attachment.storage_path), '_blank', 'noopener');
    } catch {
      setDownloadError('Could not open the file.');
    }
  };

  return (
    <Dialog open={attachment !== null} onClose={onClose} fullScreen>
      <DialogTitle sx={{ pr: 6 }}>
        {attachment?.file_name ?? 'Attachment'}
        <IconButton
          aria-label="Close"
          onClick={onClose}
          sx={{ position: 'absolute', right: 12, top: 12 }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0, bgcolor: 'background.default' }}>
        {error ? (
          <Box sx={{ p: 3 }}>
            <Typography color="error.light">{error}</Typography>
          </Box>
        ) : loading || !url ? (
          <Box
            sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}
          >
            <CircularProgress />
          </Box>
        ) : attachment && isImageAttachment(attachment) ? (
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              height: '100%',
              p: 2,
            }}
          >
            <Box
              component="img"
              src={url}
              alt={attachment.file_name}
              sx={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
            />
          </Box>
        ) : (
          <Box
            component="iframe"
            src={url}
            title={attachment?.file_name ?? 'Attachment'}
            sx={{ width: '100%', height: '100%', border: 0, display: 'block' }}
          />
        )}
      </DialogContent>
      <DialogActions>
        {attachment && (
          <Button startIcon={<DownloadIcon />} onClick={download}>
            Download
          </Button>
        )}
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
