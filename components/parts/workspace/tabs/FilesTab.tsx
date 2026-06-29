'use client';

import { useEffect, useRef, useState } from 'react';
import { useLoad } from '@/hooks/useLoad';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import VisibilityIcon from '@mui/icons-material/Visibility';
import DownloadIcon from '@mui/icons-material/Download';

import {
  listPartAttachments,
  uploadPartAttachment,
  deletePartAttachment,
  getPartAttachmentUrl,
  validatePartAttachmentFile,
} from '@/utils/partAttachmentsAccess';
import { getCurrentOperator } from '@/utils/operatorAccess';
import { useUserRole } from '@/hooks/useUserRole';
import DeleteIconButton from '@/components/common/DeleteIconButton';
import type { Part, PartAttachment } from '@/types/part';
import AttachmentViewerModal from './AttachmentViewerModal';
import { KIND_CHIP_COLOR, KIND_LABEL, isPreviewable } from './attachmentKindMeta';

interface FilesTabProps {
  part: Part;
  partId: string;
  companyId: string;
}

const ACCEPT = '.pdf,.step,.stp,.dwg';

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const fmtWhen = (s: string): string => new Date(s).toLocaleDateString();

// Stable empty fallback so the derived list doesn't churn while the first
// load runs.
const EMPTY_ATTACHMENTS: PartAttachment[] = [];

/**
 * Files tab — engineering attachments for a part (PDF drawings, STEP models,
 * DWG drawings). Office/admin surface (not the operator view). Listing and
 * upload are plain Supabase reads/writes (no AI). Open previews PDFs inline;
 * STEP/DWG download. Delete is gated to the uploader or a company admin (RLS
 * enforces the same rule — this just hides the affordance).
 */
export default function FilesTab({ partId, companyId }: FilesTabProps) {
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [operatorId, setOperatorId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<PartAttachment | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { isAdmin } = useUserRole();

  const {
    data: attachmentsData,
    loading,
    reload: refresh,
  } = useLoad(() => listPartAttachments(partId), [partId], {
    onError: (err) => {
      console.error('Error loading part attachments:', err);
      setError('Could not load files.');
    },
  });
  const attachments = attachmentsData ?? EMPTY_ATTACHMENTS;

  useEffect(() => {
    let cancelled = false;
    getCurrentOperator(companyId)
      .then((op) => {
        if (!cancelled) setOperatorId(op?.id ?? null);
      })
      .catch(() => {
        /* non-fatal — delete affordance just stays hidden */
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  const handleSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;

    // Validate all first so one bad file surfaces an error without a partial run.
    const rejected = files
      .map((f) => ({ name: f.name, msg: validatePartAttachmentFile(f) }))
      .filter((r) => r.msg);
    if (rejected.length > 0) {
      setError(rejected.map((r) => `${r.name}: ${r.msg}`).join(' '));
      return;
    }

    setError(null);
    setUploading(true);
    try {
      for (const file of files) {
        await uploadPartAttachment(companyId, partId, file);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const handleDownload = async (att: PartAttachment) => {
    try {
      const url = await getPartAttachmentUrl(att.storage_path);
      window.open(url, '_blank', 'noopener');
    } catch {
      setError('Could not open the file.');
    }
  };

  const handleOpen = (att: PartAttachment) => {
    if (isPreviewable(att.kind)) setViewing(att);
    else handleDownload(att);
  };

  const handleDelete = async (att: PartAttachment) => {
    try {
      await deletePartAttachment({ id: att.id, storage_path: att.storage_path });
      await refresh();
    } catch {
      setError('Could not delete the file.');
    }
  };

  const canDelete = (att: PartAttachment): boolean =>
    isAdmin || (!!operatorId && att.uploaded_by === operatorId);

  return (
    <Card elevation={2}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Files
          </Typography>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            multiple
            hidden
            onChange={handleSelect}
          />
          <Button
            variant="contained"
            size="small"
            startIcon={uploading ? <CircularProgress size={16} color="inherit" /> : <UploadFileIcon />}
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? 'Uploading…' : 'Upload files'}
          </Button>
        </Box>

        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Attach drawings (PDF), CAD models (STEP), or DWG files.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress size={24} />
          </Box>
        ) : attachments.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No files yet. Upload a drawing or CAD model to get started.
          </Typography>
        ) : (
          <List disablePadding>
            {attachments.map((att) => (
              <ListItem
                key={att.id}
                disableGutters
                secondaryAction={
                  <Box sx={{ display: 'flex', alignItems: 'center' }}>
                    <IconButton
                      aria-label={isPreviewable(att.kind) ? 'Open' : 'Download'}
                      onClick={() => handleOpen(att)}
                    >
                      {isPreviewable(att.kind) ? (
                        <VisibilityIcon fontSize="small" />
                      ) : (
                        <DownloadIcon fontSize="small" />
                      )}
                    </IconButton>
                    {canDelete(att) && (
                      <DeleteIconButton ariaLabel="Delete file" onClick={() => handleDelete(att)} />
                    )}
                  </Box>
                }
              >
                <AttachFileIcon fontSize="small" color="action" sx={{ mr: 1.5 }} />
                <Chip
                  size="small"
                  label={KIND_LABEL[att.kind]}
                  color={KIND_CHIP_COLOR[att.kind]}
                  variant="outlined"
                  sx={{ mr: 1.5, minWidth: 56 }}
                />
                <ListItemText
                  primary={att.file_name}
                  secondary={[formatBytes(att.size_bytes), att.uploaded_by_name ?? 'Unknown', fmtWhen(att.created_at)]
                    .filter(Boolean)
                    .join(' · ')}
                  slotProps={{ primary: { variant: 'body2', noWrap: true } }}
                />
              </ListItem>
            ))}
          </List>
        )}
      </CardContent>

      <AttachmentViewerModal
        // Remount per attachment so the signed-URL fetch + loading state reset
        // cleanly on each open (no reset-in-effect — see the modal's comment).
        key={viewing?.id ?? 'none'}
        open={viewing !== null}
        attachment={viewing}
        onClose={() => setViewing(null)}
      />
    </Card>
  );
}
