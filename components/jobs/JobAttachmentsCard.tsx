'use client';

import { useRef, useState } from 'react';
import { useLoad } from '@/hooks/useLoad';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Tooltip from '@mui/material/Tooltip';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import VisibilityIcon from '@mui/icons-material/Visibility';
import DownloadIcon from '@mui/icons-material/Download';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import CloseIcon from '@mui/icons-material/Close';
import {
  listJobAttachments,
  uploadJobAttachment,
  deleteJobAttachment,
  getJobAttachmentUrl,
  validateAttachmentFile,
} from '@/utils/jobAttachmentsAccess';
import type { JobAttachment } from '@/types/job';

// Stable empty fallback so derived data doesn't churn while the first load runs.
const EMPTY_ATTACHMENTS: JobAttachment[] = [];

interface JobAttachmentsCardProps {
  jobId: string;
  companyId: string;
  /**
   * Read-only surface: list + view/download only, no upload or delete. Adding and
   * removing attachments live on the Edit screen (JobEditForm), so the job detail
   * page shows the files without letting them be changed in place.
   */
  readOnly?: boolean;
  /**
   * Render inline (a caption + list, no outer Card) so this can sit inside the
   * Job Details card at the top of the page instead of a separate boxed section.
   */
  embedded?: boolean;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Can this attachment be previewed inline (PDF or image)? Falls back to the
 *  filename extension when mime_type is missing. */
function isImageAttachment(att: JobAttachment): boolean {
  const mime = att.mime_type ?? '';
  const name = att.file_name.toLowerCase();
  return mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/.test(name);
}
function isViewable(att: JobAttachment): boolean {
  const mime = att.mime_type ?? '';
  const name = att.file_name.toLowerCase();
  return mime === 'application/pdf' || name.endsWith('.pdf') || isImageAttachment(att);
}

/**
 * Attachments panel for the job — the customer PO PDF and any other reference
 * files. Listing on mount is a plain Supabase read (no AI). Upload is immediate;
 * download opens a fresh signed URL.
 *
 * Two surfaces share this one component:
 * - `readOnly embedded` inside the Job Details card (the job detail page): view +
 *   download only, no add/remove.
 * - the default editable Card on the Edit screen: upload + delete + view/download.
 */
export default function JobAttachmentsCard({
  jobId,
  companyId,
  readOnly = false,
  embedded = false,
}: JobAttachmentsCardProps) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Inline preview state: the attachment being viewed + its fresh signed URL.
  const [viewing, setViewing] = useState<JobAttachment | null>(null);
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const [viewLoading, setViewLoading] = useState(false);

  const {
    data: attachmentsData,
    loading,
    reload: refresh,
  } = useLoad(() => listJobAttachments(jobId), [jobId], {
    onError: (err) => {
      console.error('Error loading attachments:', err);
      setError('Could not load attachments.');
    },
  });
  const attachments = attachmentsData ?? EMPTY_ATTACHMENTS;

  const handleSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    e.target.value = '';
    if (!file) return;
    const validationError = validateAttachmentFile(file);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setUploading(true);
    try {
      await uploadJobAttachment(companyId, jobId, file);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const handleDownload = async (att: JobAttachment) => {
    try {
      const url = await getJobAttachmentUrl(att.storage_path);
      window.open(url, '_blank', 'noopener');
    } catch {
      setError('Could not open the file.');
    }
  };

  // Open the inline viewer: fetch a fresh signed URL and show it in a dialog
  // (iframe for PDFs, <img> for images). Keeps the user on the job page.
  const handleView = async (att: JobAttachment) => {
    setViewing(att);
    setViewUrl(null);
    setViewLoading(true);
    try {
      setViewUrl(await getJobAttachmentUrl(att.storage_path));
    } catch {
      setError('Could not open the file.');
      setViewing(null);
    } finally {
      setViewLoading(false);
    }
  };

  const handleCloseViewer = () => {
    setViewing(null);
    setViewUrl(null);
  };

  const handleDelete = async (att: JobAttachment) => {
    try {
      await deleteJobAttachment({ id: att.id, storage_path: att.storage_path });
      await refresh();
    } catch {
      setError('Could not delete the file.');
    }
  };

  const header = embedded ? (
    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
      Attachments
    </Typography>
  ) : (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
      <Typography variant="h6">Attachments</Typography>
      {!readOnly && (
        <>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf"
            hidden
            onChange={handleSelect}
          />
          <Button
            size="small"
            startIcon={uploading ? <CircularProgress size={16} /> : <AttachFileIcon />}
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
          >
            Upload PDF
          </Button>
        </>
      )}
    </Box>
  );

  const content = (
    <>
      {header}

      {error && (
        <Alert severity="error" sx={{ mb: 1 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
          <CircularProgress size={20} />
        </Box>
      ) : attachments.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {readOnly ? 'None' : 'No attachments yet. Upload the customer PO or any reference PDF.'}
        </Typography>
      ) : (
        <List dense disablePadding>
          {attachments.map((att) => (
            <ListItem
              key={att.id}
              disableGutters
              secondaryAction={
                <Box>
                  {isViewable(att) && (
                    <Tooltip title="View">
                      <IconButton edge="end" aria-label="View" onClick={() => handleView(att)}>
                        <VisibilityIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                  <IconButton edge="end" aria-label="Download" onClick={() => handleDownload(att)}>
                    <DownloadIcon fontSize="small" />
                  </IconButton>
                  {!readOnly && (
                    <IconButton edge="end" aria-label="Delete" onClick={() => handleDelete(att)}>
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  )}
                </Box>
              }
            >
              <AttachFileIcon fontSize="small" color="action" sx={{ mr: 1 }} />
              <ListItemText
                primary={att.file_name}
                secondary={formatBytes(att.size_bytes)}
                slotProps={{ primary: { variant: 'body2', noWrap: true } }}
              />
            </ListItem>
          ))}
        </List>
      )}
    </>
  );

  return (
    <>
      {embedded ? (
        <Box>{content}</Box>
      ) : (
        <Card elevation={2}>
          <CardContent>{content}</CardContent>
        </Card>
      )}

      {/* Inline preview — keeps the user on the job page instead of forcing a
          download. PDFs render in an iframe, images in an <img>. */}
      <Dialog open={!!viewing} onClose={handleCloseViewer} fullScreen>
        <DialogTitle sx={{ pr: 6 }}>
          {viewing?.file_name ?? 'Attachment'}
          <IconButton
            aria-label="Close"
            onClick={handleCloseViewer}
            sx={{ position: 'absolute', right: 12, top: 12 }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers sx={{ p: 0, bgcolor: 'background.default' }}>
          {viewLoading || !viewUrl ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
              <CircularProgress />
            </Box>
          ) : viewing && isImageAttachment(viewing) ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', p: 2 }}>
              <Box
                component="img"
                src={viewUrl}
                alt={viewing.file_name}
                sx={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
              />
            </Box>
          ) : (
            <Box
              component="iframe"
              src={viewUrl}
              title={viewing?.file_name ?? 'Attachment'}
              sx={{ width: '100%', height: '100%', border: 0, display: 'block' }}
            />
          )}
        </DialogContent>
        <DialogActions>
          {viewing && (
            <Button startIcon={<DownloadIcon />} onClick={() => handleDownload(viewing)}>
              Download
            </Button>
          )}
          <Button onClick={handleCloseViewer}>Close</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
