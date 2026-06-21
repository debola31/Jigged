'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
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
import AttachFileIcon from '@mui/icons-material/AttachFile';
import DownloadIcon from '@mui/icons-material/Download';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import {
  listJobAttachments,
  uploadJobAttachment,
  deleteJobAttachment,
  getJobAttachmentUrl,
  validateAttachmentFile,
} from '@/utils/jobAttachmentsAccess';
import type { JobAttachment } from '@/types/job';

interface JobAttachmentsCardProps {
  jobId: string;
  companyId: string;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Attachments panel for the job detail page — the customer PO PDF and any other
 * reference files. Listing on mount is a plain Supabase read (no AI). Upload is
 * immediate; download opens a fresh signed URL.
 */
export default function JobAttachmentsCard({ jobId, companyId }: JobAttachmentsCardProps) {
  const [attachments, setAttachments] = useState<JobAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      setAttachments(await listJobAttachments(jobId));
    } catch (err) {
      console.error('Error loading attachments:', err);
      setError('Could not load attachments.');
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

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

  const handleDelete = async (att: JobAttachment) => {
    try {
      await deleteJobAttachment({ id: att.id, storage_path: att.storage_path });
      await refresh();
    } catch {
      setError('Could not delete the file.');
    }
  };

  return (
    <Card elevation={2}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
          <Typography variant="h6">Attachments</Typography>
          <input ref={inputRef} type="file" accept="application/pdf" hidden onChange={handleSelect} />
          <Button
            size="small"
            startIcon={uploading ? <CircularProgress size={16} /> : <AttachFileIcon />}
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
          >
            Upload PDF
          </Button>
        </Box>

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
            No attachments yet. Upload the customer PO or any reference PDF.
          </Typography>
        ) : (
          <List dense disablePadding>
            {attachments.map((att) => (
              <ListItem
                key={att.id}
                disableGutters
                secondaryAction={
                  <Box>
                    <IconButton edge="end" aria-label="Download" onClick={() => handleDownload(att)}>
                      <DownloadIcon fontSize="small" />
                    </IconButton>
                    <IconButton edge="end" aria-label="Delete" onClick={() => handleDelete(att)}>
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
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
      </CardContent>
    </Card>
  );
}
