'use client';

import { useState } from 'react';
import Alert from '@mui/material/Alert';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import DescriptionIcon from '@mui/icons-material/Description';
import ImageIcon from '@mui/icons-material/Image';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { useLoad } from '@/hooks/useLoad';
import {
  getWorkCenterAttachmentUrl,
  listWorkCenterAttachments,
} from '@/utils/workCenterAttachmentsAccess';
import type { WorkCenterAttachment } from '@/types/machineMaintenance';

/**
 * A machine's manuals, opened on the floor.
 *
 * Read-only here on purpose. Uploading is office work — somebody with a spec
 * sheet and a scanned PDF doing paperwork deliberately — and putting an upload
 * control on the shop-floor sheet would be the first step toward asking an
 * operator to finish setting up a machine, which §4.5 refuses.
 *
 * Same full-screen Dialog + AppBar shape as PartFilesSheet, so the gesture is the
 * one operators already know from the part Files sheet.
 */

function formatBytes(bytes: number | null): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function kindIcon(kind: WorkCenterAttachment['kind']) {
  return kind === 'image' ? <ImageIcon color="action" /> : <DescriptionIcon color="action" />;
}

export default function MachineManualsSheet({
  open,
  onClose,
  workCenterId,
  companyId,
  machineName,
}: {
  open: boolean;
  onClose: () => void;
  workCenterId: string;
  companyId: string;
  machineName?: string | null;
}) {
  const [error, setError] = useState<string | null>(null);

  const { data: files, loading } = useLoad(
    () => (open ? listWorkCenterAttachments(workCenterId, companyId) : Promise.resolve([])),
    [open, workCenterId, companyId],
    { onError: (err) => setError(err instanceof Error ? err.message : 'Could not load manuals.') },
  );

  const openFile = async (att: WorkCenterAttachment) => {
    try {
      const url = await getWorkCenterAttachmentUrl(att.storage_path);
      window.open(url, '_blank', 'noopener');
    } catch {
      setError('Could not open that file. Try again.');
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullScreen>
      <AppBar
        position="relative"
        elevation={0}
        sx={{ bgcolor: 'rgba(17,20,57,0.98)' }}
      >
        <Toolbar>
          <Typography variant="h6" sx={{ flex: 1 }}>
            {machineName ? `${machineName} — manuals` : 'Manuals'}
          </Typography>
          <IconButton edge="end" color="inherit" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </IconButton>
        </Toolbar>
      </AppBar>

      <Box sx={{ p: 2 }}>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        ) : (
          <List>
            {(files ?? []).map((att) => (
              <ListItem key={att.id} disablePadding>
                <ListItemButton onClick={() => openFile(att)} sx={{ minHeight: 64 }}>
                  <ListItemIcon>{kindIcon(att.kind)}</ListItemIcon>
                  <ListItemText primary={att.file_name} secondary={formatBytes(att.size_bytes)} />
                  <OpenInNewIcon color="action" />
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        )}
      </Box>
    </Dialog>
  );
}
