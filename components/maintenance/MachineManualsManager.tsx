'use client';

import { useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import DeleteIcon from '@mui/icons-material/Delete';
import DescriptionIcon from '@mui/icons-material/Description';
import ImageIcon from '@mui/icons-material/Image';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import { useLoad } from '@/hooks/useLoad';
import {
  deleteWorkCenterAttachment,
  getWorkCenterAttachmentUrl,
  listWorkCenterAttachments,
  uploadWorkCenterAttachment,
} from '@/utils/workCenterAttachmentsAccess';
import type { WorkCenterAttachment } from '@/types/machineMaintenance';

/**
 * Manuals, managed from the office.
 *
 * Uploading lives HERE and not on the floor. That is the same decision as
 * machine details: somebody with a scanned PDF in front of them is doing
 * paperwork on purpose, whereas an upload control on the shop-floor sheet is the
 * first step back toward asking an operator to finish setting up a machine —
 * which §4.5 refuses. Operators read; the office files.
 */

function formatBytes(bytes: number | null): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function MachineManualsManager({
  companyId,
  workCenterId,
}: {
  companyId: string;
  workCenterId: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const {
    data: files,
    loading,
    reload,
  } = useLoad(() => listWorkCenterAttachments(workCenterId), [workCenterId], {
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not load manuals.'),
  });

  const pick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const chosen = Array.from(input.files ?? []);
    input.value = '';
    if (chosen.length === 0) return;

    setBusy(true);
    setError(null);
    try {
      for (const file of chosen) {
        await uploadWorkCenterAttachment(companyId, workCenterId, file);
      }
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to attach the file.');
    } finally {
      setBusy(false);
    }
  };

  const open = async (att: WorkCenterAttachment) => {
    try {
      window.open(await getWorkCenterAttachmentUrl(att.storage_path), '_blank', 'noopener');
    } catch {
      setError('Could not open that file.');
    }
  };

  const remove = async (att: WorkCenterAttachment) => {
    setBusy(true);
    try {
      await deleteWorkCenterAttachment(att);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete that file.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <input
        ref={inputRef}
        type="file"
        accept=".pdf,image/*"
        multiple
        hidden
        onChange={pick}
      />
      <Button
        variant="outlined"
        startIcon={busy ? <CircularProgress size={16} /> : <UploadFileIcon />}
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        sx={{ minHeight: 48 }}
      >
        Add a manual
      </Button>

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
          <CircularProgress size={20} />
        </Box>
      ) : (files ?? []).length === 0 ? null : (
        <List dense>
          {(files ?? []).map((att) => (
            <ListItem
              key={att.id}
              disablePadding
              secondaryAction={
                <IconButton
                  edge="end"
                  aria-label={`Delete ${att.file_name}`}
                  onClick={() => remove(att)}
                  disabled={busy}
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              }
            >
              <ListItemButton onClick={() => open(att)}>
                <ListItemIcon>
                  {att.kind === 'image' ? (
                    <ImageIcon color="action" />
                  ) : (
                    <DescriptionIcon color="action" />
                  )}
                </ListItemIcon>
                <ListItemText
                  primary={att.file_name}
                  secondary={
                    <Typography variant="caption" color="text.secondary">
                      {[formatBytes(att.size_bytes), att.uploaded_by_name]
                        .filter(Boolean)
                        .join(' · ')}
                    </Typography>
                  }
                />
              </ListItemButton>
            </ListItem>
          ))}
        </List>
      )}
    </Box>
  );
}
